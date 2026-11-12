// Reads a `.moqtrace` file (an open trace format, versions 1 and 2, with an MIT spec) and turns it into a session of the panel,
// so Monitor, Tracks and Messages show it (ADR-46). It is for analysis, not replay: the file has decoded fields, not the bytes of
// each stream. The file comes from anywhere: every value is checked, and names are only shown as text.
import type { PanelMessage, RuntimeMessage, TrafficItem } from '../shared/protocol';
import { bytesToBase64 } from '../shared/protocol';

const MAGIC = 'MOQTRACE';
const MAX_MOQTRACE_EVENTS = 200_000;
const MAX_DEPTH = 32;
const PREVIEW_BYTES = 4096;

type Cbor = number | bigint | string | boolean | null | undefined | Uint8Array | Cbor[] | { [key: string]: Cbor };

class Truncated extends Error {}

/** A small CBOR reader (RFC 8949): integers, bytes, text, arrays, maps, tags (the value is kept), simple values and floats. */
export function decodeCbor(data: Uint8Array, start = 0): { value: Cbor; next: number } {
  let at = start;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const need = (n: number): void => {
    if (at + n > data.length) throw new Truncated('the file ends inside a value');
  };
  const length = (info: number): number | bigint | null => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return data[at++] as number;
    }
    if (info === 25) {
      need(2);
      const value = view.getUint16(at);
      at += 2;
      return value;
    }
    if (info === 26) {
      need(4);
      const value = view.getUint32(at);
      at += 4;
      return value;
    }
    if (info === 27) {
      need(8);
      const value = view.getBigUint64(at);
      at += 8;
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }
    if (info === 31) return null;
    throw new Error('not valid CBOR');
  };
  const size = (value: number | bigint | null): number => {
    if (typeof value !== 'number' || value > data.length) throw new Truncated('the file ends inside a value');
    return value;
  };
  const item = (depth: number): Cbor => {
    if (depth > MAX_DEPTH) throw new Error('values nest too deep');
    need(1);
    const first = data[at++] as number;
    const major = first >> 5;
    const info = first & 0x1f;
    switch (major) {
      case 0: {
        const value = length(info);
        if (value === null) throw new Error('not valid CBOR');
        return value;
      }
      case 1: {
        const value = length(info);
        if (value === null) throw new Error('not valid CBOR');
        return typeof value === 'bigint' ? -1n - value : -1 - value;
      }
      case 2:
      case 3: {
        const count = length(info);
        let bytes: Uint8Array;
        if (count === null) {
          const parts: Uint8Array[] = [];
          for (;;) {
            need(1);
            if (data[at] === 0xff) {
              at++;
              break;
            }
            const part = item(depth + 1);
            if (!(part instanceof Uint8Array) && typeof part !== 'string') throw new Error('not valid CBOR');
            parts.push(typeof part === 'string' ? new TextEncoder().encode(part) : part);
          }
          bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
          let offset = 0;
          for (const part of parts) {
            bytes.set(part, offset);
            offset += part.length;
          }
        } else {
          const n = size(count);
          need(n);
          bytes = data.slice(at, at + n);
          at += n;
        }
        return major === 2 ? bytes : new TextDecoder().decode(bytes);
      }
      case 4: {
        const count = length(info);
        const out: Cbor[] = [];
        if (count === null) {
          for (;;) {
            need(1);
            if (data[at] === 0xff) {
              at++;
              return out;
            }
            out.push(item(depth + 1));
          }
        }
        const n = size(count);
        for (let i = 0; i < n; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const count = length(info);
        const out: { [key: string]: Cbor } = Object.create(null) as { [key: string]: Cbor };
        const pair = (): void => {
          const key = item(depth + 1);
          out[typeof key === 'string' ? key : String(key)] = item(depth + 1);
        };
        if (count === null) {
          for (;;) {
            need(1);
            if (data[at] === 0xff) {
              at++;
              return out;
            }
            pair();
          }
        }
        const n = size(count);
        for (let i = 0; i < n; i++) pair();
        return out;
      }
      case 6: {
        if (length(info) === null) throw new Error('not valid CBOR');
        return item(depth + 1);
      }
      default: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 24) {
          need(1);
          at++;
          return undefined;
        }
        if (info === 25) {
          need(2);
          const half = view.getUint16(at);
          at += 2;
          const exponent = (half >> 10) & 0x1f;
          const fraction = half & 0x3ff;
          const sign = half & 0x8000 ? -1 : 1;
          if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
          if (exponent === 31) return fraction ? NaN : sign * Infinity;
          return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
        }
        if (info === 26) {
          need(4);
          const value = view.getFloat32(at);
          at += 4;
          return value;
        }
        if (info === 27) {
          need(8);
          const value = view.getFloat64(at);
          at += 8;
          return value;
        }
        if (info < 20) return undefined;
        throw new Error('not valid CBOR');
      }
    }
  };
  const value = item(0);
  return { value, next: at };
}

interface MoqtraceSegment {
  version: number;
  header: { [key: string]: Cbor };
  events: { [key: string]: Cbor }[];
}

interface Moqtrace {
  segments: MoqtraceSegment[];
  /** The file ends inside an event: the events before the cut are kept. */
  truncated: boolean;
}

const isMagic = (data: Uint8Array, at: number): boolean => {
  if (at + 8 > data.length) return false;
  for (let i = 0; i < 8; i++) if (data[at + i] !== MAGIC.charCodeAt(i)) return false;
  return true;
};

/** Null if this is not a `.moqtrace` file of a version that Sluice reads. */
export function readMoqtrace(data: Uint8Array): Moqtrace | null {
  if (!isMagic(data, 0)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const segments: MoqtraceSegment[] = [];
  let at = 0;
  let count = 0;
  let truncated = false;
  while (at < data.length && isMagic(data, at)) {
    if (at + 16 > data.length) return segments.length > 0 ? { segments, truncated: true } : null;
    const version = view.getUint32(at + 8, true);
    if (version !== 1 && version !== 2) return null;
    const headerLength = view.getUint32(at + 12, true);
    if (at + 16 + headerLength > data.length) return segments.length > 0 ? { segments, truncated: true } : null;
    let header: Cbor;
    try {
      header = decodeCbor(data.subarray(at + 16, at + 16 + headerLength)).value;
    } catch {
      return null;
    }
    if (typeof header !== 'object' || header === null || header instanceof Uint8Array || Array.isArray(header)) return null;
    const segment: MoqtraceSegment = { version, header, events: [] };
    segments.push(segment);
    at += 16 + headerLength;
    while (at < data.length && !isMagic(data, at)) {
      try {
        const { value, next } = decodeCbor(data, at);
        at = next;
        if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array) && !Array.isArray(value)) {
          segment.events.push(value);
          if (++count >= MAX_MOQTRACE_EVENTS) return { segments, truncated: true };
        }
      } catch (err) {
        if (err instanceof Truncated) {
          truncated = true;
          at = data.length;
          break;
        }
        return null;
      }
    }
  }
  return { segments, truncated };
}

const num = (value: Cbor): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
};
const text = (value: Cbor): string | null => (typeof value === 'string' ? value.slice(0, 256) : null);
const bytes = (value: Cbor): Uint8Array | null => (value instanceof Uint8Array ? value : null);

/** A plain copy for JSON: bytes as hex, big numbers as text. */
function plain(value: Cbor, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (value instanceof Uint8Array) return Array.from(value.subarray(0, 256), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => plain(item, depth + 1));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).slice(0, 256).map(([key, item]) => [key, plain(item, depth + 1)]));
  return value ?? null;
}

const draftOf = (protocol: string | null): number | null => {
  const found = protocol ? /moq-transport-(\d{1,4})$/.exec(protocol) : null;
  return found ? Number(found[1]) : null;
};

interface ImportSummary {
  url: string;
  protocol: string;
  detail: string;
  events: number;
  objects: number;
  controls: number;
  truncated: boolean;
}

/**
 * The messages that make one session of the panel from a trace: open, streams, control messages as JSON, objects with their track,
 * and a close. Track names come from SUBSCRIBE and SUBSCRIBE_OK in the file.
 */
export function moqtraceToMessages(trace: Moqtrace, documentId: string, name: string): { messages: PanelMessage[]; summary: ImportSummary } {
  const first = trace.segments[0];
  const header = first?.header ?? {};
  const protocol = text(header.protocol ?? null) ?? 'unknown';
  const endpoint = text(header.endpoint ?? null);
  const url = endpoint ?? `moqtrace: ${name.slice(0, 120)}`;
  const draft = draftOf(protocol);
  // moq-lite has no SUBSCRIBE of type 3: Sluice writes its subscribe stream (type 2) with the same fields (ADR-57).
  const lite = protocol.startsWith('moq-lite-');
  const sessionId = 1;
  const frame = (message: RuntimeMessage): PanelMessage => ({ v: 1, type: 'frame-message', id: 0, payload: { frameId: 0, documentId, frameUrl: url, message } });
  const messages: PanelMessage[] = [];
  const open = (num(header.startTime ?? null) ?? Date.now()) as number;
  messages.push(frame({ v: 1, type: 'session-open', id: 0, payload: { sessionId, url, createdAt: open } }));
  if (draft !== null) messages.push(frame({ v: 1, type: 'moqt-version', id: 0, payload: { sessionId, draft, source: 'protocol' } }));

  // First pass: track names, and the alias of each stream.
  const byRequest = new Map<number, string>();
  const byStream = new Map<number, string>();
  const names = new Map<number, string>();
  const streamAlias = new Map<number, number>();
  for (const segment of trace.segments) {
    for (const event of segment.events) {
      const kind = num(event.e ?? null);
      const sid = num(event.sid ?? null);
      if (kind === 1 && sid !== null) {
        const alias = num(event.ta ?? null);
        if (alias !== null) streamAlias.set(sid, alias);
      }
      if (kind !== 0) continue;
      const msg = event.msg;
      if (typeof msg !== 'object' || msg === null || msg instanceof Uint8Array || Array.isArray(msg)) continue;
      const type = num(event.mt ?? null);
      const track = text(msg.track_name ?? null);
      const request = num(msg.request_id ?? msg.subscribe_id ?? null);
      const alias = num(msg.track_alias ?? null);
      if ((type === 0x03 || (lite && type === 0x02)) && track !== null) {
        if (alias !== null) names.set(alias, track);
        if (request !== null) byRequest.set(request, track);
        if (sid !== null) byStream.set(sid, track);
      } else if (type === 0x04 && alias !== null) {
        const named = (request !== null ? byRequest.get(request) : undefined) ?? (sid !== null ? byStream.get(sid) : undefined);
        if (named !== undefined) names.set(alias, named);
      }
    }
  }

  let items: TrafficItem[] = [];
  const flush = (): void => {
    if (items.length === 0) return;
    messages.push(frame({ v: 1, type: 'traffic', id: 0, payload: { items } }));
    items = [];
  };
  const opened = new Set<number>();
  /** Object headers that wait for their payload event, by stream, group and object. */
  const waiting = new Map<string, TrafficItem>();
  let objects = 0;
  let controls = 0;
  let events = 0;
  let last = open;
  let seq = 0;
  let closed: { closeCode: number; reason: string } | null = null;
  for (const segment of trace.segments) {
    const startTime = num(segment.header.startTime ?? null) ?? open;
    for (const event of segment.events) {
      events++;
      const kind = num(event.e ?? null);
      const t = num(event.t ?? null) ?? 0;
      const at = startTime + t / 1000;
      last = Math.max(last, at);
      const rawSid = num(event.sid ?? null);
      const datagram = num(event.st ?? null) === 1 || (rawSid !== null && rawSid >= 2 ** 62);
      const sid = rawSid !== null && rawSid < 2 ** 53 ? rawSid : null;
      if (kind === 1 && sid !== null && !datagram && !opened.has(sid)) {
        opened.add(sid);
        messages.push(frame({ v: 1, type: 'stream-open', id: 0, payload: { sessionId, streamId: sid, kind: 'uni', origin: num(event.d ?? null) === 0 ? 'local' : 'remote', at } }));
      } else if (kind === 0) {
        controls++;
        const type = num(event.mt ?? null);
        const json = JSON.stringify({ type: type === null ? null : `0x${type.toString(16).padStart(2, '0')}`, ...(typeof event.msg === 'object' && event.msg !== null && !(event.msg instanceof Uint8Array) && !Array.isArray(event.msg) ? (plain(event.msg) as object) : { msg: plain(event.msg ?? null) }) });
        const body = new TextEncoder().encode(json);
        items.push({
          sessionId,
          streamId: sid ?? 0,
          kind: 'bidi',
          seq: seq++,
          byteLength: bytes(event.raw ?? null)?.length ?? body.length,
          outcome: 'passed',
          modified: false,
          ...(num(event.d ?? null) === 0 ? { outgoing: true as const } : {}),
          delayMs: 0,
          preview: bytesToBase64(body.subarray(0, PREVIEW_BYTES)),
          at,
        });
      } else if (kind === 9) {
        closed = { closeCode: num(event.ec ?? null) ?? 0, reason: text(event.reason ?? null) ?? '' };
      } else if (kind === 3 || kind === 4) {
        const group = num(event.g ?? null);
        const object = num(event.o ?? null);
        if (group === null || object === null) continue;
        const key = `${String(rawSid)} ${group} ${object}`;
        const alias = sid !== null ? (streamAlias.get(sid) ?? 0) : (num(event.ta ?? null) ?? 0);
        if (kind === 3) {
          const item: TrafficItem = {
            sessionId,
            streamId: datagram ? null : sid,
            kind: datagram ? 'datagram' : 'uni',
            seq: seq++,
            byteLength: 0,
            outcome: 'passed',
            modified: false,
            moqt: { trackAlias: alias, group, subgroup: null, object, ...(names.has(alias) ? { track: names.get(alias) as string } : {}) },
            delayMs: 0,
            preview: '',
            at,
          };
          waiting.set(key, item);
          if (waiting.size > 10_000) {
            const oldest = waiting.keys().next().value as string;
            const item = waiting.get(oldest);
            waiting.delete(oldest);
            if (item) {
              items.push(item);
              objects++;
            }
          }
          continue;
        }
        const header = waiting.get(key);
        waiting.delete(key);
        const payload = bytes(event.pl ?? null);
        const item: TrafficItem = header ?? {
          sessionId,
          streamId: datagram ? null : sid,
          kind: datagram ? 'datagram' : 'uni',
          seq: seq++,
          byteLength: 0,
          outcome: 'passed',
          modified: false,
          moqt: { trackAlias: alias, group, subgroup: null, object, ...(names.has(alias) ? { track: names.get(alias) as string } : {}) },
          delayMs: 0,
          preview: '',
          at,
        };
        item.byteLength = num(event.sz ?? null) ?? payload?.length ?? 0;
        if (payload) item.preview = bytesToBase64(payload.subarray(0, PREVIEW_BYTES));
        item.at = at;
        items.push(item);
        objects++;
      }
      if (items.length >= 200) flush();
    }
  }
  // Headers with no payload event: a "headers" trace.
  for (const item of waiting.values()) {
    items.push(item);
    objects++;
  }
  flush();
  const end = num(header.endTime ?? null) ?? last;
  messages.push(frame({ v: 1, type: 'session-closed', id: 0, payload: { sessionId, closeCode: closed?.closeCode ?? 0, reason: closed?.reason || 'end of the .moqtrace file', at: end } }));
  return { messages, summary: { url, protocol, detail: text(header.detail ?? null) ?? 'unknown', events, objects, controls, truncated: trace.truncated } };
}
