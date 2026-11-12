// Demo app for tests and QA. It uses only the public WebTransport API, as a real app does,
// and it must work the same with and without the extension.

const config = await (await fetch('/config.json')).json();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_PAYLOADS = 50;

const newCounters = () => ({ datagrams: 0, uniStreams: 0, bidiStreams: 0, bytes: 0, errors: 0 });

const state = {
  /** @type {WebTransport | null} */
  transport: null,
  counters: newCounters(),
  /** Last received items, newest last: { kind, text | bytes }. */
  payloads: [],
  /** Datagram latency in ms: receive time minus server time. Same machine, so the clocks agree. */
  latency: { last: null, avg: null, samples: 0 },
};

function connect(path, protocols) {
  const hash = Uint8Array.from(config.certHash.match(/../g), (byte) => parseInt(byte, 16));
  return new WebTransport(`https://localhost:${config.wtPort}${path}`, {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }],
    ...(protocols ? { protocols } : {}),
  });
}

const varint = (value) => (value < 0x40 ? [value] : [0x40 | (value >> 8), value & 0xff]);
const text = (value) => {
  const bytes = [...encoder.encode(value)];
  return [...varint(bytes.length), ...bytes];
};
/** moq-lite: a SUBSCRIBE stream is type 2, a size, then the ID, the broadcast, the track and a priority. */
const subscribe = (id, track) => {
  const body = [...varint(id), ...text('demo'), ...text(track), 0];
  return Uint8Array.from([2, ...varint(body.length), ...body]);
};

/** Reads a whole byte stream with a default or BYOB reader. Returns all the bytes. */
async function readStream(stream, mode = 'default') {
  const parts = [];
  if (mode === 'byob') {
    const reader = stream.getReader({ mode: 'byob' });
    let buffer = new ArrayBuffer(4096);
    for (;;) {
      const { value, done } = await reader.read(new Uint8Array(buffer));
      if (done) break;
      parts.push(value.slice());
      buffer = value.buffer; // The read transfers the buffer: use the one it gave back.
    }
  } else {
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  }
  const total = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    total.set(part, offset);
    offset += part.length;
  }
  return total;
}

function record(kind, bytes) {
  state.counters.bytes += bytes.length;
  const text = decoder.decode(bytes);
  // Replacement characters mean the payload is not text.
  const item = text.includes('�') ? { kind, bytes: Array.from(bytes) } : { kind, text };
  state.payloads.push(item);
  if (state.payloads.length > MAX_PAYLOADS) state.payloads.shift();
  render();
}

function recordLatency(bytes) {
  let sentAt;
  try {
    sentAt = JSON.parse(decoder.decode(bytes)).ts;
  } catch {
    return; // Not a timed message.
  }
  if (typeof sentAt !== 'number') return;
  const { latency } = state;
  latency.last = Date.now() - sentAt;
  latency.samples++;
  latency.avg = (latency.avg ?? 0) + (latency.last - (latency.avg ?? 0)) / latency.samples;
}

function render() {
  document.getElementById('counters').textContent = JSON.stringify({ ...state.counters, latency: state.latency }, null, 2);
  document.getElementById('payloads').textContent = state.payloads
    .slice(-10)
    .map((item) => `${item.kind}: ${item.text ?? `${item.bytes.length} binary bytes`}`)
    .join('\n');
}

async function consumeDatagrams(transport) {
  const reader = transport.datagrams.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    state.counters.datagrams++;
    recordLatency(value);
    record('datagram', value);
  }
}

async function consumeUni(transport, mode) {
  const reader = transport.incomingUnidirectionalStreams.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    state.counters.uniStreams++;
    record('uni', await readStream(value, mode));
  }
}

async function consumeBidi(transport, mode) {
  const reader = transport.incomingBidirectionalStreams.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    state.counters.bidiStreams++;
    record('bidi', await readStream(value.readable, mode));
  }
}

/** A session that ends is normal here: count only errors while it is still the current one. */
const guard = (transport, promise) =>
  promise.catch(() => {
    if (state.transport === transport) state.counters.errors++;
    render();
  });

const demo = {
  state,

  /** Opens /push and reads all its traffic. mode: 'default' | 'byob' for streams. */
  async startPush(mode = 'default') {
    demo.close();
    const transport = connect('/push');
    state.transport = transport;
    await transport.ready;
    guard(transport, consumeDatagrams(transport));
    guard(transport, consumeUni(transport, mode));
    guard(transport, consumeBidi(transport, mode));
    render();
  },

  /** A small MoQ player: opens /moq with moq-lite-04, subscribes to the catalog, video and audio, and reads every group. */
  async startMoq() {
    demo.close();
    const transport = connect('/moq', ['moq-lite-04']);
    state.transport = transport;
    await transport.ready;
    for (const [id, track] of ['catalog.json', 'video', 'audio'].entries()) {
      const stream = await transport.createBidirectionalStream();
      const writer = stream.writable.getWriter();
      await writer.write(subscribe(id, track));
      writer.releaseLock();
    }
    const reader = transport.incomingUnidirectionalStreams.getReader();
    guard(
      transport,
      (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          state.counters.uniStreams++;
          // A reset stream is an error of this player, as in a real one.
          void readStream(value).then(
            (bytes) => {
              state.counters.bytes += bytes.length;
              render();
            },
            () => {
              state.counters.errors++;
              render();
            },
          );
        }
      })(),
    );
    render();
  },

  /** A <video> that plays a moving canvas, for the Playback card of the Monitor. Returns when it plays. */
  async startVideo() {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext('2d');
    let n = 0;
    setInterval(() => {
      context.fillStyle = `hsl(${(n += 7) % 360} 70% 50%)`;
      context.fillRect(0, 0, 160, 90);
    }, 40);
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = canvas.captureStream(25);
    document.body.append(video);
    await video.play();
  },

  /** Sends a datagram on /echo and returns the text that comes back. */
  async echoDatagram(text) {
    const transport = connect('/echo');
    await transport.ready;
    const reader = transport.datagrams.readable.getReader();
    const writer = transport.datagrams.writable.getWriter();
    await writer.write(encoder.encode(text));
    const { value } = await reader.read();
    transport.close();
    return decoder.decode(value);
  },

  /** Sends text on a new bidi stream of /echo and returns the text that comes back. */
  async echoStream(text, mode = 'default') {
    const transport = connect('/echo');
    await transport.ready;
    const stream = await transport.createBidirectionalStream();
    const writer = stream.writable.getWriter();
    await writer.write(encoder.encode(text));
    await writer.close();
    const bytes = await readStream(stream.readable, mode);
    transport.close();
    return decoder.decode(bytes);
  },

  close() {
    state.transport?.close();
    state.transport = null;
    render();
  },

  reset() {
    state.counters = newCounters();
    state.payloads = [];
    state.latency = { last: null, avg: null, samples: 0 };
    render();
  },

  connect,
  readStream,
};

window.__demo = demo;

document.getElementById('push-default').addEventListener('click', () => demo.startPush('default'));
document.getElementById('push-byob').addEventListener('click', () => demo.startPush('byob'));
document.getElementById('moq').addEventListener('click', () => demo.startMoq());
document.getElementById('close').addEventListener('click', () => demo.close());
