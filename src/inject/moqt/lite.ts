// moq-lite, versions 3 to 6 (ADR-28, ADR-30). It is not an IETF draft and has no test vectors: layouts were read in the open-source reference implementation of moq-lite (MIT or Apache-2.0)
// and checked on real traffic. All these versions use QUIC varints. Version 7 does not, so it stays in chunks with any later one.
import { LITE_VERSIONS } from '../../shared/rules';
import { parseCatalog, type Rendition } from '../../shared/catalog';
import { MAX_EDITED_BYTES } from '../bytes';
import { analyzeFrame, type FrameFacts } from './media';
import { join, writeQuicVarint, type ObjectFramer, type ObjectUnit } from './objects';
import { readVarint } from './version';

export { LITE_VERSIONS };

const STREAM_SUBSCRIBE = 2;
const STREAM_TRACK = 6;
const DATA_GROUP = 0;
const MAX_CONTROL_BYTES = 8 * 1024;
const MAX_CATALOG_BYTES = 256 * 1024;

const safe = (value: number): boolean => value <= Number.MAX_SAFE_INTEGER;
const decoder = new TextDecoder();

type Read = { value: number; next: number } | null;

function readText(data: Uint8Array, at: number): { value: string; next: number } | null {
  const length = readVarint(data, at);
  if (!length || length.value > MAX_CONTROL_BYTES || length.next + length.value > data.length) return null;
  return { value: decoder.decode(data.subarray(length.next, length.next + length.value)), next: length.next + length.value };
}

interface LiteTrack {
  broadcast: string;
  name: string;
}

export interface LiteTracker {
  version: number;
  /** What the app wrote on a stream that it opened. */
  sent(streamId: number, data: Uint8Array): void;
  /** What came back on that stream. */
  received(streamId: number, data: Uint8Array): void;
  track(subscribe: number): LiteTrack | undefined;
  /** Undefined until the server says. Versions before 5 have no timescale, so no timestamps. */
  timescale(track: LiteTrack): number | undefined;
  groupFramer(): ObjectFramer;
  /** From the first bytes of a uni stream: true for a group of a media track, false for a catalog or a setup, null if not known. */
  isMedia(first: Uint8Array): boolean | null;
  /** What a frame says about itself. A frame of a catalog track also updates the catalog. */
  frameFacts(track: LiteTrack | undefined, payload: Uint8Array): FrameFacts;
}

const trackKey = (track: LiteTrack): string => `${track.broadcast}\u0000${track.name}`;

export function createLiteTracker(version: number, onCatalog?: (broadcast: string, json: string) => void): LiteTracker {
  const renditions = new Map<string, Map<string, Rendition>>();
  const lastCatalog = new Map<string, string>();
  const subscribes = new Map<number, LiteTrack>();
  const timescales = new Map<string, number>();
  const asked = new Map<number, LiteTrack>();
  const sentBytes = new Map<number, Uint8Array>();
  const receivedBytes = new Map<number, Uint8Array>();
  const done = new Set<number>();

  /** The message after the type: a size, then the fields. Null until it is all here. */
  const body = (data: Uint8Array, at: number): { from: number; to: number } | null => {
    const size = readVarint(data, at);
    if (!size || size.next + size.value > data.length) return null;
    return { from: size.next, to: size.next + size.value };
  };

  const parseSent = (streamId: number, data: Uint8Array): boolean => {
    const type = readVarint(data, 0);
    if (!type) return false;
    if (type.value !== STREAM_SUBSCRIBE && type.value !== STREAM_TRACK) return true;
    const range = body(data, type.next);
    if (!range) return false;
    const fields = data.subarray(0, range.to);
    let at = range.from;
    let id: Read = null;
    if (type.value === STREAM_SUBSCRIBE) {
      id = readVarint(fields, at);
      if (!id) return true;
      at = id.next;
    }
    const broadcast = readText(fields, at);
    if (!broadcast) return true;
    const name = readText(fields, broadcast.next);
    if (!name) return true;
    const track = { broadcast: broadcast.value, name: name.value };
    if (id) subscribes.set(id.value, track);
    else asked.set(streamId, track);
    return true;
  };

  const parseInfo = (track: LiteTrack, data: Uint8Array): boolean => {
    const range = body(data, 0);
    if (!range) return false;
    const fields = data.subarray(0, range.to);
    // Priority, then an order flag up to version 5.
    const maxAge = readVarint(fields, range.from + (version <= 5 ? 2 : 1));
    if (!maxAge) return true;
    const scale = readVarint(fields, maxAge.next);
    if (scale) timescales.set(trackKey(track), scale.value);
    return true;
  };

  const collect = (store: Map<number, Uint8Array>, streamId: number, data: Uint8Array): Uint8Array => {
    const next = join([store.get(streamId) ?? new Uint8Array(0), data.subarray(0, MAX_CONTROL_BYTES)]);
    store.set(streamId, next);
    return next;
  };

  const tracker: LiteTracker = {
    version,
    sent(streamId, data) {
      if (done.has(streamId)) return;
      const all = collect(sentBytes, streamId, data);
      if (parseSent(streamId, all) || all.length >= MAX_CONTROL_BYTES) {
        done.add(streamId);
        sentBytes.delete(streamId);
      }
    },
    received(streamId, data) {
      const track = asked.get(streamId);
      if (!track) return;
      const all = collect(receivedBytes, streamId, data);
      if (parseInfo(track, all) || all.length >= MAX_CONTROL_BYTES) {
        asked.delete(streamId);
        receivedBytes.delete(streamId);
      }
    },
    track: (subscribe) => subscribes.get(subscribe),
    timescale: (track) => (version < 5 ? 0 : timescales.get(trackKey(track))),
    groupFramer: () => createGroupFramer(tracker),
    isMedia(first) {
      const type = readVarint(first, 0);
      if (!type) return null;
      if (type.value !== DATA_GROUP) return false;
      const size = readVarint(first, type.next);
      const id = size && readVarint(first, size.next);
      if (!id) return null;
      const track = subscribes.get(id.value);
      return track ? !track.name.includes('catalog') : null;
    },
    frameFacts(track, payload) {
      if (!track) return {};
      if (track.name.includes('catalog') && payload[0] === 0x7b && payload.length <= MAX_CATALOG_BYTES) {
        const json = decoder.decode(payload);
        if (lastCatalog.get(track.broadcast) !== json) {
          const list = parseCatalog(json);
          if (list) {
            lastCatalog.set(track.broadcast, json);
            renditions.set(track.broadcast, new Map(list.map((rendition) => [rendition.name, rendition])));
            onCatalog?.(track.broadcast, json);
          }
        }
        return {};
      }
      return analyzeFrame(payload, renditions.get(track.broadcast)?.get(track.name));
    },
  };
  return tracker;
}

const unzigzag = (value: number): number => (value % 2 === 0 ? value / 2 : -(value + 1) / 2);
const zigzag = (value: number): number => (value >= 0 ? value * 2 : -value * 2 - 1);

/**
 * A uni stream: a type, a header of a known size, then frames: a size and a payload, with a timestamp delta first if the track has a timescale.
 * A frame has no ID: its number is its place in the group. A drop moves its delta to the next frame, so timestamps stay right.
 */
function createGroupFramer(tracker: LiteTracker): ObjectFramer {
  let buffer = new Uint8Array(0);
  let raw = false;
  let header: Uint8Array | null = null;
  let headerSent = false;
  let subscribe = 0;
  let group = 0;
  let scale = 0;
  let track: LiteTrack | undefined;
  let index = 0;
  let timestamp = 0;
  let renderedTimestamp = 0;

  const rawUnit = (bytes: Uint8Array<ArrayBuffer>): ObjectUnit => ({
    moqt: null,
    payload: bytes,
    bypass: false,
    render: (final) => {
      if (!final) return null;
      const before = header && !headerSent ? header : null;
      headerSent = true;
      return before ? join([before, final]) : final;
    },
  });

  const giveUp = (): ObjectUnit[] => {
    raw = true;
    const rest = buffer;
    buffer = new Uint8Array(0);
    return rest.length ? [rawUnit(rest.slice())] : [];
  };

  const parseHeader = (): 'next' | 'more' | 'no' => {
    const type = readVarint(buffer, 0);
    if (!type) return 'more';
    if (type.value !== DATA_GROUP) return 'no';
    const size = readVarint(buffer, type.next);
    if (!size) return 'more';
    if (size.value > MAX_CONTROL_BYTES) return 'no';
    const end = size.next + size.value;
    if (end > buffer.length) return 'more';
    const id = readVarint(buffer, size.next);
    if (!id || id.next > end || !safe(id.value)) return 'no';
    const sequence = readVarint(buffer, id.next);
    if (!sequence || sequence.next > end || !safe(sequence.value)) return 'no';
    track = tracker.track(id.value);
    const known = track ? tracker.timescale(track) : undefined;
    // With no known timescale, the layout of a frame is a guess. A wrong guess must never change the bytes.
    if (known === undefined) return 'no';
    scale = known;
    subscribe = id.value;
    group = sequence.value;
    header = buffer.slice(0, end);
    buffer = buffer.slice(end);
    return 'next';
  };

  const parseFrame = (units: ObjectUnit[]): 'next' | 'more' | 'no' => {
    const data = buffer;
    let at = 0;
    let delta = 0;
    let deltaEnd = 0;
    if (scale !== 0) {
      const field = readVarint(data, 0);
      if (!field) return 'more';
      if (!safe(field.value)) return 'no';
      delta = unzigzag(field.value);
      at = deltaEnd = field.next;
    }
    const size = readVarint(data, at);
    if (!size) return 'more';
    if (size.value > MAX_EDITED_BYTES) return 'no';
    const total = size.next + size.value;
    if (total > data.length) {
      if (data.length > MAX_EDITED_BYTES * 2) return 'no';
      return 'more';
    }
    timestamp += delta;
    if (!Number.isSafeInteger(timestamp)) return 'no';
    const stamp = timestamp;
    const original = data.slice(0, total);
    const payload = original.slice(size.next);
    const object = index++;
    const empty = size.value === 0;
    const found = empty ? {} : tracker.frameFacts(track, payload);
    // With a timescale, the timestamp of the frame itself, when the payload did not give one (ADR-50).
    const facts = found.mediaUs === undefined && scale > 0 ? { ...found, mediaUs: Math.round((stamp * 1_000_000) / scale) } : found;
    units.push({
      moqt: { trackAlias: subscribe, group, subgroup: null, object, ...(track ? { track: track.name } : {}), ...facts },
      payload,
      bypass: empty,
      render: (final) => {
        if (!empty && (!final || final.length === 0)) return null;
        const before = header && !headerSent ? header : new Uint8Array(0);
        headerSent = true;
        const newDelta = stamp - renderedTimestamp;
        const sameDelta = scale === 0 || newDelta === delta;
        renderedTimestamp = stamp;
        if (sameDelta && (empty || final === payload)) return before.length ? join([before, original]) : original;
        const stampBytes = scale === 0 ? new Uint8Array(0) : sameDelta ? original.subarray(0, deltaEnd) : writeQuicVarint(zigzag(newDelta));
        const body = empty ? new Uint8Array(0) : (final as Uint8Array);
        const sizeBytes = empty || final === payload ? original.subarray(deltaEnd, size.next) : writeQuicVarint(body.length);
        return join([before, stampBytes, sizeBytes, body]);
      },
    });
    buffer = data.slice(total);
    return 'next';
  };

  return {
    push(chunk) {
      if (raw) return [rawUnit(chunk)];
      buffer = join([buffer, chunk]);
      const units: ObjectUnit[] = [];
      if (!header) {
        const step = parseHeader();
        if (step === 'more') return units;
        if (step === 'no') return giveUp();
      }
      for (;;) {
        const step = parseFrame(units);
        if (step === 'next') continue;
        if (step === 'no') units.push(...giveUp());
        return units;
      }
    },
    end() {
      if (raw) return [];
      const units = giveUp();
      if (header) {
        units.push({
          moqt: null,
          payload: new Uint8Array(0),
          bypass: true,
          render: () => {
            if (!header || headerSent) return null;
            headerSent = true;
            return header.slice();
          },
        });
      }
      return units;
    },
  };
}
