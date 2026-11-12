// Track names for IETF MoQT, drafts 7 to 23 (ADR-45). Objects carry only a track alias. SUBSCRIBE gives the name, and the alias
// comes in SUBSCRIBE (drafts 7 to 11), in SUBSCRIBE_OK with the request ID (12 to 16), or in SUBSCRIBE_OK on the same request
// stream (17 and later). Layouts checked with the MIT test vectors in the fixtures (see THIRD_PARTY_NOTICES.md).
import { readVi64 } from './objects';
import { readVarint } from './version';

const SUBSCRIBE = 0x03;
const SUBSCRIBE_OK = 0x04;
/** More than any control message that Sluice reads needs. A stream with more stops being read. */
const MAX_STREAM_BYTES = 64 * 1024;
const MAX_TEXT = 4096;
const MAX_TUPLE = 32;
const MAX_NAMES = 4096;

type ReadInt = (data: Uint8Array, at: number) => { value: number; next: number } | null;

export interface IetfTracker {
  /** What the app wrote on a stream it opened. */
  sent(streamId: number, data: Uint8Array): void;
  /** What came back on that stream. */
  received(streamId: number, data: Uint8Array): void;
  /** The name of a track by its alias, once SUBSCRIBE (and its answer) went by. */
  nameOf(alias: number): string | undefined;
}

const decoder = new TextDecoder();

/** One whole control message, for a tool that lists them (the `.moqtrace` export). `fields` has what Sluice reads of it. */
export interface ControlMessage {
  local: boolean;
  streamId: number;
  type: number;
  /** The whole message: type, length and body. */
  raw: Uint8Array;
  fields: Record<string, number | string | string[]>;
}

export function createIetfTracker(draft: number, onMessage?: (message: ControlMessage) => void): IetfTracker {
  const readInt: ReadInt = draft >= 17 ? readVi64 : readVarint;
  const readLength: ReadInt =
    draft >= 11 && draft <= 22
      ? (data, at) => (at + 2 <= data.length ? { value: ((data[at] as number) << 8) | (data[at + 1] as number), next: at + 2 } : null)
      : readInt;
  const names = new Map<number, string>();
  const byRequest = new Map<number, string>();
  const byStream = new Map<number, string>();
  const buffers = new Map<string, Uint8Array>();
  const stopped = new Set<string>();

  const remember = (map: Map<number, string>, key: number, name: string): void => {
    if (map.size >= MAX_NAMES && !map.has(key)) return;
    map.set(key, name);
  };

  const readText = (data: Uint8Array, at: number): { value: string; next: number } | null => {
    const length = readInt(data, at);
    if (!length || length.value > MAX_TEXT || length.next + length.value > data.length) return null;
    return { value: decoder.decode(data.subarray(length.next, length.next + length.value)), next: length.next + length.value };
  };

  /** SUBSCRIBE: the IDs that come first in this draft, the namespace (a tuple), then the name. */
  const subscribe = (streamId: number, body: Uint8Array): ControlMessage['fields'] => {
    const fields: ControlMessage['fields'] = {};
    const first = readInt(body, 0);
    if (!first) return fields;
    fields.request_id = first.value;
    let at = first.next;
    let alias: number | null = null;
    if (draft <= 11) {
      const value = readInt(body, at);
      if (!value) return fields;
      alias = value.value;
      fields.track_alias = alias;
      at = value.next;
    } else if (draft === 17) {
      // Required Request ID Delta.
      const value = readInt(body, at);
      if (!value) return fields;
      at = value.next;
    }
    const count = readInt(body, at);
    if (!count || count.value > MAX_TUPLE) return fields;
    at = count.next;
    const namespace: string[] = [];
    for (let i = 0; i < count.value; i++) {
      const part = readText(body, at);
      if (!part) return fields;
      namespace.push(part.value);
      at = part.next;
    }
    fields.track_namespace = namespace;
    const name = readText(body, at);
    if (!name) return fields;
    fields.track_name = name.value;
    if (alias !== null) remember(names, alias, name.value);
    else if (draft >= 17) remember(byStream, streamId, name.value);
    else remember(byRequest, first.value, name.value);
    return fields;
  };

  const subscribeOk = (streamId: number, body: Uint8Array): ControlMessage['fields'] => {
    if (draft <= 11) return {};
    if (draft >= 17) {
      const alias = readInt(body, 0);
      const name = byStream.get(streamId);
      if (alias && name !== undefined) remember(names, alias.value, name);
      return alias ? { track_alias: alias.value } : {};
    }
    const request = readInt(body, 0);
    const alias = request && readInt(body, request.next);
    const name = request ? byRequest.get(request.value) : undefined;
    if (alias && name !== undefined) remember(names, alias.value, name);
    return request && alias ? { request_id: request.value, track_alias: alias.value } : {};
  };

  const feed = (key: string, streamId: number, data: Uint8Array, local: boolean): void => {
    if (stopped.has(key)) return;
    const before = buffers.get(key) ?? new Uint8Array(0);
    let all = new Uint8Array(before.length + data.length);
    all.set(before);
    all.set(data, before.length);
    for (;;) {
      const type = readInt(all, 0);
      const length = type && readLength(all, type.next);
      if (!type || !length) break;
      const end = length.next + length.value;
      if (length.value > MAX_STREAM_BYTES) {
        stopped.add(key);
        buffers.delete(key);
        return;
      }
      if (end > all.length) break;
      const body = all.subarray(length.next, end);
      let fields: ControlMessage['fields'] = {};
      if (local && type.value === SUBSCRIBE) fields = subscribe(streamId, body);
      else if (!local && type.value === SUBSCRIBE_OK) fields = subscribeOk(streamId, body);
      onMessage?.({ local, streamId, type: type.value, raw: all.slice(0, end), fields });
      all = all.slice(end);
    }
    if (all.length > MAX_STREAM_BYTES) {
      // Not control messages, such as objects: stop reading this stream.
      stopped.add(key);
      buffers.delete(key);
      return;
    }
    buffers.set(key, all);
  };

  return {
    sent: (streamId, data) => feed(`out ${streamId}`, streamId, data, true),
    received: (streamId, data) => feed(`in ${streamId}`, streamId, data, false),
    nameOf: (alias) => names.get(alias),
  };
}
