"""Local WebTransport test server (HTTP/3) and static host for the demo app.

Endpoints:
  /echo  echoes datagrams and bidi streams
  /push  sends JSON datagrams, uni streams (JSON and binary) and one server-opened bidi stream
  /moq   a small moq-lite-04 publisher: a catalog.json, a video track (one group per second, the first frame a key frame)
         and an audio track. It answers SUBSCRIBE streams of the client. The media bytes are fake.

A new self-signed certificate is made at each start. The client uses it through
serverCertificateHashes, so no CA and no insecure browser flags are needed.
"""

import argparse
import asyncio
import datetime
import hashlib
import http.server
import json
import tempfile
import threading
import time
from functools import partial
from pathlib import Path

from aioquic.asyncio import QuicConnectionProtocol, serve
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import DatagramReceived, HeadersReceived, WebTransportStreamDataReceived
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import ConnectionTerminated, ProtocolNegotiated, QuicEvent
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

DEMO_DIR = Path(__file__).parent / "demo"
DATAGRAM_INTERVAL_S = 0.1
UNI_STREAM_INTERVAL_S = 0.5
BINARY_PAYLOAD = bytes(range(256))
MOQ_BROADCAST = "demo"
MOQ_CATALOG = json.dumps(
    {
        "video": {"renditions": {"video": {"codec": "avc1.64001f", "container": {"kind": "legacy"}, "codedWidth": 1280, "codedHeight": 720, "bitrate": 1500000}}},
        "audio": {"renditions": {"audio": {"codec": "mp4a.40.2", "container": {"kind": "legacy"}, "sampleRate": 48000, "numberOfChannels": 2, "bitrate": 128000}}},
    }
).encode()
VIDEO_FRAMES_PER_GROUP = 25
VIDEO_FRAME_S = 0.04
AUDIO_FRAMES_PER_GROUP = 50
AUDIO_FRAME_S = 0.02


def varint(value: int) -> bytes:
    """QUIC variable-length integer (RFC 9000, section 16)."""
    if value < 0x40:
        return bytes([value])
    if value < 0x4000:
        return (value | 0x4000).to_bytes(2, "big")
    if value < 0x40000000:
        return (value | 0x80000000).to_bytes(4, "big")
    return (value | 0xC000000000000000).to_bytes(8, "big")


def read_varint(data: bytes, at: int) -> tuple[int, int] | None:
    if at >= len(data):
        return None
    size = 1 << (data[at] >> 6)
    if at + size > len(data):
        return None
    value = data[at] & 0x3F
    for byte in data[at + 1 : at + size]:
        value = value * 256 + byte
    return value, at + size


def parse_subscribe(data: bytes) -> tuple[int, str] | None:
    """moq-lite: type 2, a size, then the subscribe ID, the broadcast and the track. None until it is all here."""
    kind = read_varint(data, 0)
    size = kind and read_varint(data, kind[1])
    if not kind or not size or kind[0] != 2 or size[1] + size[0] > len(data):
        return None
    sub_id = read_varint(data, size[1])
    if not sub_id:
        return None
    at = sub_id[1]
    texts = []
    for _ in range(2):
        length = read_varint(data, at)
        if not length:
            return None
        texts.append(data[length[1] : length[1] + length[0]].decode())
        at = length[1] + length[0]
    return sub_id[0], texts[1]


def make_certificate(directory: Path) -> tuple[Path, Path, str]:
    """Self-signed ECDSA P-256. serverCertificateHashes allows at most 14 days of validity."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(hours=1))
        .not_valid_after(now + datetime.timedelta(days=13))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
        .sign(key, hashes.SHA256())
    )
    cert_path = directory / "cert.pem"
    key_path = directory / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return cert_path, key_path, hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest()


class WebTransportProtocol(QuicConnectionProtocol):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._http: H3Connection | None = None
        self._path_by_session: dict[int, str] = {}
        self._push_tasks: list[asyncio.Task] = []
        self._moq_requests: dict[int, bytes] = {}
        self._moq_done: set[int] = set()

    def quic_event_received(self, event: QuicEvent) -> None:
        if isinstance(event, ProtocolNegotiated) and event.alpn_protocol in H3_ALPN:
            self._http = H3Connection(self._quic, enable_webtransport=True)
        elif isinstance(event, ConnectionTerminated):
            for task in self._push_tasks:
                task.cancel()
        if self._http:
            for http_event in self._http.handle_event(event):
                self._handle_http_event(http_event)
        self.transmit()

    def _handle_http_event(self, event) -> None:
        if isinstance(event, HeadersReceived):
            self._handle_connect(event)
        elif isinstance(event, DatagramReceived):
            if self._path_by_session.get(event.stream_id) == "/echo":
                self._http.send_datagram(event.stream_id, event.data)
        elif isinstance(event, WebTransportStreamDataReceived):
            if self._path_by_session.get(event.session_id) == "/moq":
                self._moq_request(event)
            elif self._path_by_session.get(event.session_id) == "/echo":
                # Echo on the same stream: only client-opened bidi streams can do this.
                try:
                    self._quic.send_stream_data(event.stream_id, event.data, event.stream_ended)
                except (RuntimeError, ValueError):
                    pass  # The client reset the stream. This is normal in tests of cancel.

    def _handle_connect(self, event: HeadersReceived) -> None:
        headers = dict(event.headers)
        path = headers.get(b":path", b"").decode().split("?")[0]
        is_webtransport = headers.get(b":method") == b"CONNECT" and headers.get(b":protocol") == b"webtransport"
        if not is_webtransport or path not in ("/echo", "/push", "/moq"):
            self._http.send_headers(event.stream_id, [(b":status", b"404")], end_stream=True)
            return
        self._http.send_headers(
            event.stream_id,
            [(b":status", b"200"), (b"sec-webtransport-http3-draft", b"draft02")],
        )
        self._path_by_session[event.stream_id] = path
        if path == "/push":
            self._push_tasks.append(asyncio.ensure_future(self._push(event.stream_id)))

    def _moq_request(self, event: WebTransportStreamDataReceived) -> None:
        if event.stream_id in self._moq_done:
            return
        data = self._moq_requests.get(event.stream_id, b"") + event.data
        found = parse_subscribe(data)
        if not found:
            self._moq_requests[event.stream_id] = data
            return
        self._moq_requests.pop(event.stream_id, None)
        self._moq_done.add(event.stream_id)
        sub_id, track = found
        self._push_tasks.append(asyncio.ensure_future(self._moq_track(event.session_id, sub_id, track)))

    def _group(self, session_id: int, sub_id: int, sequence: int) -> int:
        stream_id = self._http.create_webtransport_stream(session_id, is_unidirectional=True)
        header = varint(sub_id) + varint(sequence)
        self._quic.send_stream_data(stream_id, varint(0) + varint(len(header)) + header)
        return stream_id

    def _frame(self, stream_id: int, payload: bytes, end: bool) -> None:
        self._quic.send_stream_data(stream_id, varint(len(payload)) + payload, end_stream=end)
        self.transmit()

    async def _moq_track(self, session_id: int, sub_id: int, track: str) -> None:
        if track == "catalog.json":
            stream_id = self._group(session_id, sub_id, 0)
            self._frame(stream_id, MOQ_CATALOG, True)
            return
        video = track == "video"
        count, step = (VIDEO_FRAMES_PER_GROUP, VIDEO_FRAME_S) if video else (AUDIO_FRAMES_PER_GROUP, AUDIO_FRAME_S)
        sequence = 0
        start = time.monotonic()
        while True:
            stream_id = self._group(session_id, sub_id, sequence)
            for index in range(count):
                micros = round((time.monotonic() - start) * 1_000_000)
                if video:
                    # Annex-B: NAL type 5 (IDR) starts a group, NAL type 1 follows.
                    nal = b"\x00\x00\x00\x01" + (b"\x65" + b"\x88" * 3000 if index == 0 else b"\x41" + b"\x9a" * 600)
                else:
                    nal = b"\x21" * 180
                self._frame(stream_id, varint(micros) + nal, index == count - 1)
                await asyncio.sleep(step)
            sequence += 1

    def _send_stream(self, session_id: int, payload: bytes, unidirectional: bool) -> None:
        stream_id = self._http.create_webtransport_stream(session_id, is_unidirectional=unidirectional)
        self._quic.send_stream_data(stream_id, payload, end_stream=True)

    async def _push(self, session_id: int) -> None:
        self._send_stream(session_id, b"hello from server bidi", unidirectional=False)
        self.transmit()
        seq = 0
        ticks_per_stream = round(UNI_STREAM_INTERVAL_S / DATAGRAM_INTERVAL_S)
        while True:
            message = json.dumps({"seq": seq, "ts": time.time() * 1000}).encode()
            self._http.send_datagram(session_id, message)
            if seq % ticks_per_stream == 0:
                is_json = (seq // ticks_per_stream) % 2 == 0
                self._send_stream(session_id, message if is_json else BINARY_PAYLOAD, unidirectional=True)
            self.transmit()
            seq += 1
            await asyncio.sleep(DATAGRAM_INTERVAL_S)


def serve_demo(port: int, config: dict) -> None:
    """Static host for the demo. http://localhost is a secure context, so TLS is not needed here."""

    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/config.json":
                body = json.dumps(config).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            super().do_GET()

        def log_message(self, format, *args):
            pass

    handler = partial(Handler, directory=str(DEMO_DIR))
    server = http.server.ThreadingHTTPServer(("localhost", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wt-port", type=int, default=4433)
    parser.add_argument("--http-port", type=int, default=8080)
    args = parser.parse_args()

    configuration = QuicConfiguration(is_client=False, alpn_protocols=H3_ALPN, max_datagram_frame_size=65536)
    with tempfile.TemporaryDirectory() as directory:
        cert_path, key_path, cert_hash = make_certificate(Path(directory))
        configuration.load_cert_chain(cert_path, key_path)

    # Chromium can pick either address for "localhost". Loopback only: this server is for local tests.
    bound = 0
    for host in ("127.0.0.1", "::1"):
        try:
            await serve(host, args.wt_port, configuration=configuration, create_protocol=WebTransportProtocol)
            bound += 1
        except OSError as error:
            print(f"cannot bind {host}: {error}", flush=True)
    if bound == 0:
        raise SystemExit("no loopback address is available")
    serve_demo(args.http_port, {"wtPort": args.wt_port, "certHash": cert_hash})
    print(f"demo: http://localhost:{args.http_port}/  webtransport: https://localhost:{args.wt_port}/", flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
