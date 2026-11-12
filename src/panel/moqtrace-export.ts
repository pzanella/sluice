// Writes a recording as a `.moqtrace` file (version 2 of the open trace format that `moqtrace.ts` reads), so other tools can
// analyse it (ADR-57). The bytes of the recording go through the same parsers as in the page: control messages with the fields
// that Sluice reads, streams, objects with their whole payload, datagrams and the close. Pure code: it only builds bytes.
import { base64ToBytes, type TraceFile } from '../shared/protocol';
import { createIetfTracker, type ControlMessage } from '../inject/moqt/control';
import { createLiteTracker } from '../inject/moqt/lite';
import { createDatagramFramer, createSubgroupFramer, type ObjectFramer, type ObjectUnit } from '../inject/moqt/objects';
import { readRequest } from '../inject/moqt/request';
import { parseServerSetup, versionFromProtocol } from '../inject/moqt/version';

const MAGIC = 'MOQTRACE';
const FORMAT_VERSION = 2;
/** Datagrams have no stream: the format gives them IDs from 2^62 up, out of the range of QUIC stream IDs. */
const DATAGRAM_SID = 2n ** 62n;

/** The event types of the format that a recording can fill. */
const EVENT = { control: 0, streamOpen: 1, streamClose: 2, objectHeader: 3, objectPayload: 4, sessionClosed: 9 } as const;
/** Direction: 0 = sent by the app (this side), 1 = received. */
const SENT = 0;
const RECEIVED = 1;
/** Stream types of the format. */
const SUBGROUP = 0;
const DATAGRAM = 1;
/** moq-lite: a stream of the app that starts with this type asks for a track. */
const LITE_SUBSCRIBE = 2;

type Value = number | bigint | string | boolean | Uint8Array | Value[] | { [key: string]: Value };

/** A small CBOR writer (RFC 8949): what the format uses. Numbers must be whole: times are rounded before. */
export function encodeCbor(value: Value): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  const head = (major: number, length: number | bigint): void => {
    const n = BigInt(length);
    if (n < 24n) out.push((major << 5) | Number(n));
    else if (n < 0x100n) out.push((major << 5) | 24, Number(n));
    else if (n < 0x10000n) out.push((major << 5) | 25, Number(n >> 8n), Number(n & 0xffn));
    else if (n < 0x100000000n) {
      out.push((major << 5) | 26);
      for (let shift = 24n; shift >= 0n; shift -= 8n) out.push(Number((n >> shift) & 0xffn));
    } else {
      out.push((major << 5) | 27);
      for (let shift = 56n; shift >= 0n; shift -= 8n) out.push(Number((n >> shift) & 0xffn));
    }
  };
  const bytes = (data: Uint8Array): void => {
    for (const byte of data) out.push(byte);
  };
  const item = (v: Value): void => {
    if (typeof v === 'boolean') out.push(v ? 0xf5 : 0xf4);
    else if (typeof v === 'number' || typeof v === 'bigint') {
      if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('only whole numbers are written');
      const n = BigInt(v);
      if (n >= 0n) head(0, n);
      else head(1, -1n - n);
    } else if (typeof v === 'string') {
      const data = new TextEncoder().encode(v);
      head(3, data.length);
      bytes(data);
    } else if (v instanceof Uint8Array) {
      head(2, v.length);
      bytes(v);
    } else if (Array.isArray(v)) {
      head(4, v.length);
      v.forEach(item);
    } else {
      const entries = Object.entries(v);
      head(5, entries.length);
      for (const [key, inner] of entries) {
        item(key);
        item(inner);
      }
    }
  };
  item(value);
  return new Uint8Array(out);
}

interface Session {
  protocol: string;
  framer: () => ObjectFramer;
  datagrams: ObjectFramer | null;
  /** Feeds a stream that the app opened: what it wrote first, then what came back. */
  control: (streamId: number, sent: Uint8Array | null, received: Uint8Array | null) => void;
}

/** What makes a file of this recording. Null if it is not MoQ, or of a version that Sluice cannot cut into objects. */
function sessionOf(trace: TraceFile, emit: (event: Record<string, Value>) => void): Session | null {
  // The protocol that the server chose, or the one that the page offered when the server chose none.
  const named = [trace.protocol, trace.offered].find((protocol) => versionFromProtocol(protocol) !== null);
  let version = versionFromProtocol(named);
  if (!version) {
    // Drafts before 15 say their version only in SERVER_SETUP, on the first stream that the app opened.
    const first = trace.events.find((event) => event.kind === 'bidi' && event.origin === 'local' && event.data);
    const found = first?.data ? parseServerSetup(base64ToBytes(first.data)) : 'no';
    version = typeof found === 'object' ? found : null;
  }
  if (version?.lite !== undefined && version.lite >= 3 && version.lite <= 6) {
    const lite = createLiteTracker(version.lite);
    return {
      protocol: named ?? `moq-lite-${String(version.lite).padStart(2, '0')}`,
      framer: () => lite.groupFramer(),
      datagrams: null,
      control: (streamId, sent, received) => {
        if (sent) {
          lite.sent(streamId, sent);
          const request = readRequest(sent, true);
          const [broadcast, track] = request.names?.split('\u0000') ?? [];
          const msg: Record<string, Value> =
            request.type === LITE_SUBSCRIBE && request.subscribeId !== null && broadcast !== undefined && track !== undefined
              ? { request_id: request.subscribeId, track_namespace: [broadcast], track_name: track, track_alias: request.subscribeId }
              : {};
          emit({ e: EVENT.control, sid: streamId, d: SENT, mt: request.type ?? 0, msg, raw: sent });
        }
        if (received) lite.received(streamId, received);
      },
    };
  }
  const draft = version?.draft;
  if (draft === undefined || draft === null || draft < 7 || draft > 23) return null;
  const ietf = createIetfTracker(draft, (message: ControlMessage) =>
    emit({ e: EVENT.control, sid: message.streamId, d: message.local ? SENT : RECEIVED, mt: message.type, msg: message.fields, raw: message.raw }),
  );
  return {
    protocol: `moq-transport-${draft}`,
    framer: () => createSubgroupFramer(draft),
    datagrams: createDatagramFramer(draft),
    control: (streamId, sent, received) => {
      if (sent) ietf.sent(streamId, sent);
      if (received) ietf.received(streamId, received);
    },
  };
}

/** True if Sluice can write this recording as a `.moqtrace` file. */
export function canExportMoqtrace(trace: TraceFile): boolean {
  return sessionOf(trace, () => undefined) !== null;
}

/** The `.moqtrace` file of a recording, or null if it is not MoQ of a version that Sluice reads. */
export function traceToMoqtrace(trace: TraceFile): Uint8Array<ArrayBuffer> | null {
  const events: Record<string, Value>[] = [];
  let t = 0;
  const emit = (event: Record<string, Value>): void => {
    events.push({ n: events.length, t, ...event });
  };
  const session = sessionOf(trace, emit);
  if (!session) return null;

  const framers = new Map<number, ObjectFramer>();
  const opened = new Set<number>();
  let datagrams = 0;
  let last = 0;
  const objects = (sid: number | bigint, units: ObjectUnit[]): void => {
    for (const unit of units) {
      if (!unit.moqt || unit.bypass) continue;
      const { group: g, object: o } = unit.moqt;
      emit({ e: EVENT.objectHeader, sid, g, o, os: 0 });
      emit({ e: EVENT.objectPayload, sid, g, o, sz: unit.payload.length, pl: unit.payload });
    }
  };
  for (const event of trace.events) {
    t = Math.max(0, Math.round(event.t));
    last = Math.max(last, t);
    const data = event.data ? base64ToBytes(event.data) : null;
    const sid = event.streamId;
    if (event.kind === 'datagram') {
      if (!data || !session.datagrams) continue;
      const units = session.datagrams.push(data);
      const info = units.find((unit) => unit.moqt)?.moqt;
      if (!info) continue;
      const id = DATAGRAM_SID + BigInt(datagrams++);
      emit({ e: EVENT.streamOpen, sid: id, d: RECEIVED, st: DATAGRAM, ta: info.trackAlias, g: info.group });
      objects(id, units);
    } else if (event.kind === 'bidi' && sid !== null) {
      if (event.origin !== 'local') continue;
      const sent = !opened.has(sid) && event.sent ? base64ToBytes(event.sent) : null;
      opened.add(sid);
      session.control(sid, sent, data);
      if (event.fin) emit({ e: EVENT.streamClose, sid, ec: 0 });
    } else if (event.kind === 'uni' && sid !== null) {
      let framer = framers.get(sid);
      if (!framer) {
        framer = session.framer();
        framers.set(sid, framer);
      }
      const units = [...(data ? framer.push(data) : []), ...(event.fin ? framer.end() : [])];
      const info = units.find((unit) => unit.moqt)?.moqt;
      // The open says the track, which is known with the first whole object: a big first frame comes in many chunks.
      if (!opened.has(sid) && (info || event.fin)) {
        opened.add(sid);
        emit({
          e: EVENT.streamOpen,
          sid,
          d: event.origin === 'local' ? SENT : RECEIVED,
          st: SUBGROUP,
          ...(info ? { ta: info.trackAlias, g: info.group, ...(info.subgroup !== null ? { sg: info.subgroup } : {}) } : {}),
        });
      }
      objects(sid, units);
      if (event.fin) {
        emit({ e: EVENT.streamClose, sid, ec: 0 });
        framers.delete(sid);
      }
    }
  }
  if (trace.close) {
    t = Math.max(last, Math.round(trace.close.t));
    last = t;
    emit({ e: EVENT.sessionClosed, ec: trace.close.closeCode, reason: trace.close.reason });
  }

  const startTime = trace.startedAt ?? Date.now();
  let endpoint = '';
  try {
    // Only host and port: the path and the query of a URL can hold a token.
    endpoint = new URL(trace.url).host;
  } catch {
    // Not a URL: no endpoint.
  }
  const header = encodeCbor({
    protocol: session.protocol,
    perspective: 'client',
    detail: 'full',
    startTime,
    endTime: startTime + last,
    transport: 'webtransport',
    source: 'sluice',
    ...(endpoint ? { endpoint } : {}),
  });
  const body = events.map((event) => encodeCbor(event));
  const size = 16 + header.length + body.reduce((sum, part) => sum + part.length, 0);
  const file = new Uint8Array(size);
  const view = new DataView(file.buffer);
  for (let i = 0; i < MAGIC.length; i++) file[i] = MAGIC.charCodeAt(i);
  view.setUint32(8, FORMAT_VERSION, true);
  view.setUint32(12, header.length, true);
  file.set(header, 16);
  let at = 16 + header.length;
  for (const part of body) {
    file.set(part, at);
    at += part.length;
  }
  return file;
}
