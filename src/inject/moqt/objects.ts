// Finds MoQT objects in the data of a session, so rules can act on whole objects (ADR-23, ADR-27). The format changes between drafts, so
// `formatOf` gives each draft its layout. Checked against the MIT test vectors in the fixtures (see THIRD_PARTY_NOTICES.md), and draft 22 against its text.
// Fetch streams, padding and anything else that is not a subgroup or an object datagram stay in chunk mode.
import { MAX_EDITED_BYTES } from '../bytes';
import { readVarint as readQuicVarint } from './version';

export interface MoqtObjectInfo {
  trackAlias: number;
  group: number;
  subgroup: number | null; // Null on a datagram.
  object: number;
  /** The name of the track, when the control messages gave it. */
  track?: string;
  /** Video only. Not set when the frame does not say. */
  key?: boolean;
  /** Microseconds, from the frame itself. */
  mediaUs?: number;
}

/** One piece of the data, in order. `render` must be called in delivery order. It gives the bytes for the app, or null for none. */
export interface ObjectUnit {
  /** Null = raw bytes that are not an object. Rules see them as a chunk. */
  moqt: MoqtObjectInfo | null;
  /** What the rules see: the object payload, or the raw bytes. */
  payload: Uint8Array<ArrayBuffer>;
  /** True = no payload for rules: an object status, or a stream header with no object. It skips the rules. */
  bypass: boolean;
  render(final: Uint8Array<ArrayBuffer> | null): Uint8Array<ArrayBuffer> | null;
}

export interface ObjectFramer {
  push(chunk: Uint8Array<ArrayBuffer>): ObjectUnit[];
  /** The stream ended. */
  end(): ObjectUnit[];
}

type ReadInt = (data: Uint8Array, at: number) => { value: number; next: number } | null;

/**
 * Drafts 17 and later (22, section 8.1): this is not the QUIC varint. N leading 1 bits in the first byte = N more bytes, up to 0xff and 8 more bytes.
 * Null if the bytes end first. Past 2^53 the number is not exact, so callers must check it with `safe`.
 */
export function readVi64(data: Uint8Array, at: number): { value: number; next: number } | null {
  const first = data[at];
  if (first === undefined) return null;
  let extra = 0;
  while (extra < 8 && first & (0x80 >> extra)) extra++;
  if (at + extra >= data.length) return null;
  // Multiply, not shift: bit operators in JavaScript stop at 32 bits.
  let value = extra === 8 ? 0 : first & (0xff >> (extra + 1));
  for (let i = 1; i <= extra; i++) value = value * 256 + (data[at + i] as number);
  return { value, next: at + extra + 1 };
}

/** The shortest form. Only called with exact values, so 8 bytes or fewer are always enough. */
export function writeVi64(value: number): Uint8Array<ArrayBuffer> {
  let extra = 0;
  while (extra < 7 && value >= 2 ** (7 * (extra + 1))) extra++;
  const out = new Uint8Array(extra + 1);
  let rest = value;
  for (let i = extra; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] = (out[0] as number) | (0xff00 >> extra);
  return out;
}

/** RFC 9000, 16, for drafts up to 16. */
export function writeQuicVarint(value: number): Uint8Array<ArrayBuffer> {
  const size = value < 0x40 ? 1 : value < 0x4000 ? 2 : value < 0x40000000 ? 4 : 8;
  const out = new Uint8Array(size);
  let rest = value;
  for (let i = size - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] = (out[0] as number) | (Math.log2(size) << 6);
  return out;
}

/** What changes between drafts in the objects. */
interface ObjectFormat {
  draft: number;
  read: ReadInt;
  write: (value: number) => Uint8Array<ArrayBuffer>;
  /** Up to 13, an object has its own ID. From 14, a delta from the object before it. */
  deltaIds: boolean;
  validSubgroup: (type: number) => boolean;
  /** How an object holds its extensions or properties, for a stream or datagram of this type. */
  properties: (type: number) => 'none' | 'count' | 'length';
}

const noModeThree = (t: number): boolean => (t & ID_MODE_MASK) !== ID_MODE_MASK;

function formatOf(draft: number): ObjectFormat {
  const validSubgroup =
    draft <= 10
      ? (t: number) => t === 0x04
      : draft === 11
        ? (t: number) => t >= 0x08 && t <= 0x0d
        : draft <= 14
          ? (t: number) => (t >= 0x10 && t <= 0x15) || (t >= 0x18 && t <= 0x1d)
          : draft <= 17
            ? (t: number) => ((t >= 0x10 && t <= 0x1f) || (t >= 0x30 && t <= 0x3f)) && noModeThree(t)
            : (t: number) => t < 128 && (t & SUBGROUP_REQUIRED) !== 0 && noModeThree(t);
  const properties = (t: number): 'none' | 'count' | 'length' => (draft === 7 ? 'none' : draft === 8 ? 'count' : draft <= 10 || t & PROPERTIES ? 'length' : 'none');
  return {
    draft,
    read: draft >= 17 ? readVi64 : readQuicVarint,
    write: draft >= 17 ? writeVi64 : writeQuicVarint,
    deltaIds: draft >= 14,
    validSubgroup,
    properties,
  };
}

/** End of the properties that start at `at`, null if the bytes end first, or 'no' if they are too large or not valid. */
function propertiesEnd(data: Uint8Array, at: number, kind: 'none' | 'count' | 'length', read: ReadInt): number | null | 'no' {
  if (kind === 'none') return at;
  const head = read(data, at);
  if (!head) return null;
  if (head.value > MAX_EDITED_BYTES) return 'no';
  if (kind === 'length') return head.next + head.value;
  // Draft 8: a count of pairs. An even type has one integer, an odd type has a length and bytes.
  let next = head.next;
  for (let i = 0; i < head.value; i++) {
    const type = read(data, next);
    if (!type) return null;
    const value = read(data, type.next);
    if (!value) return null;
    if (type.value % 2 === 0) next = value.next;
    else {
      if (value.value > MAX_EDITED_BYTES) return 'no';
      next = value.next + value.value;
    }
  }
  return next;
}

export function join(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const EMPTY = new Uint8Array(0);

/** A varint above this is not exact as a number, so an edit could change it. Such a stream stays raw. */
const safe = (value: number): boolean => value <= Number.MAX_SAFE_INTEGER;

const PROPERTIES = 0x01;
const ID_MODE_MASK = 0x06;
const ID_MODE_FIRST_OBJECT = 0x02;
const ID_MODE_EXPLICIT = 0x04;
const SUBGROUP_REQUIRED = 0x10;
const SUBGROUP_DEFAULT_PRIORITY = 0x20;
const FIRST_OBJECT = 0x40;

interface SubgroupHeader {
  flags: number;
  trackAlias: number;
  group: number;
  /** Null when it is the ID of the first object. */
  subgroup: number | null;
  /** Null when the header has no priority field. */
  priority: number | null;
  bytes: Uint8Array;
}

type Parsed<T> = T | 'more' | 'no';

function parseSubgroupHeader(data: Uint8Array, format: ObjectFormat): Parsed<SubgroupHeader> {
  const { read: readVarint, draft } = format;
  const type = readVarint(data, 0);
  if (!type) return 'more';
  const flags = type.value;
  if (!format.validSubgroup(flags)) return 'no';
  const trackAlias = readVarint(data, type.next);
  if (!trackAlias) return 'more';
  const group = readVarint(data, trackAlias.next);
  if (!group) return 'more';
  if (!safe(trackAlias.value) || !safe(group.value)) return 'no';
  let at = group.next;
  // Up to draft 10 there is only one type, and the field is always there.
  const explicit = draft <= 10 || (flags & ID_MODE_MASK) === ID_MODE_EXPLICIT;
  let subgroup: number | null = !explicit && (flags & ID_MODE_MASK) === ID_MODE_FIRST_OBJECT ? null : 0;
  if (explicit) {
    const field = readVarint(data, at);
    if (!field) return 'more';
    if (!safe(field.value)) return 'no';
    subgroup = field.value;
    at = field.next;
  }
  let priority: number | null = null;
  // The bit means this only from draft 15.
  if (draft < 15 || !(flags & SUBGROUP_DEFAULT_PRIORITY)) {
    const byte = data[at];
    if (byte === undefined) return 'more';
    priority = byte;
    at++;
  }
  return { flags, trackAlias: trackAlias.value, group: group.value, subgroup, priority, bytes: data.slice(0, at) };
}

/**
 * A header, then objects. From draft 14 each object ID is a delta from the object before it, so a drop changes the bytes of the next object. A drop of the
 * first object can change the header. So all bytes are built at delivery, when the fate of every earlier object is known. With no change the bytes are the
 * original ones, also a varint longer than it needs.
 */
export function createSubgroupFramer(draft: number): ObjectFramer {
  const format = formatOf(draft);
  const { read: readVarint, write: writeVarint, deltaIds } = format;
  let buffer = new Uint8Array(4096);
  let start = 0;
  let end = 0;
  let raw = false;
  let header: SubgroupHeader | null = null;
  let previousId: number | null = null;
  let firstId: number | null = null;
  let lastRenderedId: number | null = null;
  let headerSent = false;
  let needed = 0; // Do not parse again before this many bytes are here: a large object comes in many chunks.

  const append = (chunk: Uint8Array): void => {
    if (end + chunk.length > buffer.length) {
      const size = end - start;
      const next = size + chunk.length > buffer.length ? new Uint8Array(Math.max(buffer.length * 2, size + chunk.length)) : buffer;
      next.set(buffer.subarray(start, end), 0);
      buffer = next;
      start = 0;
      end = size;
    }
    buffer.set(chunk, end);
    end += chunk.length;
  };

  /** Bytes for the header, once. It changes only if the first object of the stream did not reach the app. */
  const takeHeader = (firstRendered: number | null): Uint8Array => {
    if (headerSent || !header) return EMPTY;
    headerSent = true;
    if (firstId === null || firstRendered === firstId) return header.bytes;
    // Up to draft 17 the bit does not exist. Up to draft 10 the subgroup is always in the header, so nothing changes.
    if (draft <= 10) return header.bytes;
    const dropFirst = draft >= 18 ? FIRST_OBJECT : 0;
    const firstIsId = (header.flags & ID_MODE_MASK) === ID_MODE_FIRST_OBJECT;
    if (!dropFirst && !firstIsId) return header.bytes;
    if (!(header.flags & dropFirst) && !firstIsId) return header.bytes;
    let flags = header.flags & ~dropFirst;
    let subgroup = header.subgroup;
    if (firstIsId) {
      flags = (flags & ~ID_MODE_MASK) | ID_MODE_EXPLICIT;
      subgroup = firstId;
    }
    const explicit = (flags & ID_MODE_MASK) === ID_MODE_EXPLICIT;
    return join([
      writeVarint(flags),
      writeVarint(header.trackAlias),
      writeVarint(header.group),
      explicit ? writeVarint(subgroup as number) : EMPTY,
      header.priority === null ? EMPTY : Uint8Array.of(header.priority),
    ]);
  };

  const rawUnit = (bytes: Uint8Array<ArrayBuffer>): ObjectUnit => ({
    moqt: null,
    payload: bytes,
    bypass: false,
    render: (final) => {
      if (!final) return null;
      const before = takeHeader(lastRenderedId);
      return before.length ? join([before, final]) : final;
    },
  });

  /** From here on the stream is plain chunks. A drop before this point can leave one wrong object ID in them. */
  const giveUp = (): ObjectUnit[] => {
    raw = true;
    const rest = buffer.slice(start, end);
    start = end = 0;
    return rest.length ? [rawUnit(rest)] : [];
  };

  const parseObject = (hdr: SubgroupHeader, units: ObjectUnit[]): 'next' | 'more' | 'no' => {
    const data = buffer.subarray(start, end);
    const delta = readVarint(data, 0);
    if (!delta) return 'more';
    let at = delta.next;
    const after = propertiesEnd(data, at, format.properties(hdr.flags), readVarint);
    if (after === 'no') return 'no';
    if (after === null) return 'more';
    if (after > data.length) {
      needed = after;
      return 'more';
    }
    const propertiesStop = after;
    at = propertiesStop;
    const length = readVarint(data, at);
    if (!length) return 'more';
    if (length.value > MAX_EDITED_BYTES) return 'no';
    at = length.next;
    let statusEnd = at;
    if (length.value === 0) {
      const status = readVarint(data, at);
      if (!status) return 'more';
      statusEnd = status.next;
    }
    const total = statusEnd + length.value;
    if (total > data.length) {
      needed = total;
      return 'more';
    }
    if (!safe(delta.value)) return 'no';
    const id = !deltaIds || previousId === null ? delta.value : previousId + delta.value + 1;
    if (!safe(id)) return 'no';
    previousId = id;
    if (firstId === null) firstId = id;

    const original = data.slice(0, total);
    const properties = original.subarray(delta.next, propertiesStop);
    const payload = original.slice(statusEnd);
    const originalDelta = delta.value;
    const originalDeltaEnd = delta.next;
    const bypass = length.value === 0;
    const info: MoqtObjectInfo = {
      trackAlias: hdr.trackAlias,
      group: hdr.group,
      subgroup: hdr.subgroup ?? firstId,
      object: id,
    };
    const render = (final: Uint8Array<ArrayBuffer> | null): Uint8Array<ArrayBuffer> | null => {
      // An empty payload would need an object status, which a rule cannot choose: it counts as a drop.
      if (!bypass && (!final || final.length === 0)) return null;
      const before = takeHeader(id);
      const newDelta = !deltaIds || lastRenderedId === null ? id : id - lastRenderedId - 1;
      lastRenderedId = id;
      const samePayload = bypass || final === payload;
      if (newDelta === originalDelta && samePayload) return before.length ? join([before, original]) : original;
      const deltaBytes = newDelta === originalDelta ? original.subarray(0, originalDeltaEnd) : writeVarint(newDelta);
      if (bypass) return join([before, deltaBytes, original.subarray(originalDeltaEnd)]);
      const body = final as Uint8Array;
      const lengthBytes = samePayload ? original.subarray(propertiesStop, statusEnd) : writeVarint(body.length);
      return join([before, deltaBytes, properties, lengthBytes, body]);
    };
    units.push({ moqt: info, payload, bypass, render });
    start += total;
    return 'next';
  };

  return {
    push(chunk) {
      if (raw) return [rawUnit(chunk)];
      append(chunk);
      if (end - start < needed) return [];
      needed = 0;
      const units: ObjectUnit[] = [];
      if (!header) {
        const parsed = parseSubgroupHeader(buffer.subarray(start, end), format);
        if (parsed === 'more') return units;
        if (parsed === 'no') return giveUp();
        header = parsed;
        start += parsed.bytes.length;
      }
      for (;;) {
        const step = parseObject(header, units);
        if (step === 'next') continue;
        if (step === 'no') units.push(...giveUp());
        if (step === 'more' && end - start > MAX_EDITED_BYTES) units.push(...giveUp());
        return units;
      }
    },
    end() {
      if (raw) return [];
      // A stream that ended inside an object: the app gets the same bytes as with no rules, and can see the error.
      const units = giveUp();
      if (header) {
        units.push({
          moqt: null,
          payload: new Uint8Array(0),
          bypass: true,
          render: () => {
            const rest = takeHeader(lastRenderedId);
            return rest.length ? join([rest]) : null;
          },
        });
      }
      return units;
    },
  };
}

const DG_END_OF_GROUP = 0x02;
const DG_ZERO_OBJECT_ID = 0x04;
const DG_DEFAULT_PRIORITY = 0x08;
const DG_STATUS = 0x20;
const DG_KNOWN = PROPERTIES | DG_END_OF_GROUP | DG_ZERO_OBJECT_ID | DG_DEFAULT_PRIORITY | DG_STATUS;

interface ParsedDatagram {
  info: MoqtObjectInfo;
  /** Where the payload starts. */
  payloadAt: number;
  /** Where its length field starts, when the datagram has one (drafts 7, 8). */
  lengthAt: number | null;
  status: boolean;
}

interface DatagramShape {
  properties: 'none' | 'count' | 'length';
  status: boolean;
  noObjectId: boolean;
  noPriority: boolean;
}

function datagramShape(type: number, draft: number): DatagramShape | null {
  const plain = { noObjectId: false, noPriority: false };
  if (draft <= 10) {
    // Type 1 has an object, type 2 a status with no properties.
    if (type === 2 && draft >= 8) return { ...plain, properties: 'none', status: true };
    if (type !== 1) return null;
    return { ...plain, properties: draft === 7 ? 'none' : draft === 8 ? 'count' : 'length', status: false };
  }
  const properties = type & PROPERTIES ? 'length' : 'none';
  if (draft === 11) return type <= 3 ? { ...plain, properties, status: Boolean(type & 2) } : null;
  if (draft <= 13) return type <= 5 ? { ...plain, properties, status: type >= 4 } : null;
  if (draft === 14) {
    if (type > 7 && type !== 0x20 && type !== 0x21) return null;
    return { properties, status: type >= 0x20, noObjectId: Boolean(type & DG_ZERO_OBJECT_ID), noPriority: false };
  }
  if (type & ~DG_KNOWN || (type & DG_STATUS && type & DG_END_OF_GROUP)) return null;
  return { properties, status: Boolean(type & DG_STATUS), noObjectId: Boolean(type & DG_ZERO_OBJECT_ID), noPriority: Boolean(type & DG_DEFAULT_PRIORITY) };
}

/** Null if this is not a valid object datagram of this draft, such as a padding datagram. */
export function parseObjectDatagram(data: Uint8Array, draft: number): ParsedDatagram | null {
  const { read } = formatOf(draft);
  const type = read(data, 0);
  if (!type || !safe(type.value)) return null;
  const shape = datagramShape(type.value, draft);
  if (!shape) return null;
  const trackAlias = read(data, type.next);
  if (!trackAlias) return null;
  const group = read(data, trackAlias.next);
  if (!group) return null;
  let at = group.next;
  let object = 0;
  if (!shape.noObjectId) {
    const field = read(data, at);
    if (!field) return null;
    object = field.value;
    at = field.next;
  }
  if (!safe(trackAlias.value) || !safe(group.value) || !safe(object)) return null;
  if (!shape.noPriority) at++;
  const after = propertiesEnd(data, at, shape.properties, read);
  if (after === null || after === 'no') return null;
  // From draft 18 the text refuses this, and it is the same bytes in the others: a length of 0 with the bit on carries nothing.
  if (draft >= 18 && shape.properties === 'length' && after === (read(data, at) as { next: number }).next) return null;
  at = after;
  if (at > data.length) return null;
  const info: MoqtObjectInfo = { trackAlias: trackAlias.value, group: group.value, subgroup: null, object };
  if (shape.status) return { info, payloadAt: at, lengthAt: null, status: true };
  if (draft > 8) return { info, payloadAt: at, lengthAt: null, status: false };
  // Drafts 7, 8: a length, and a status if it is 0.
  const length = read(data, at);
  if (!length) return null;
  if (length.value === 0) return { info, payloadAt: length.next, lengthAt: at, status: true };
  if (length.next + length.value !== data.length) return null;
  return { info, payloadAt: length.next, lengthAt: at, status: false };
}

/** Each datagram is one whole object, or raw bytes. Only a changed payload changes the bytes. */
export function createDatagramFramer(draft: number): ObjectFramer {
  const { write } = formatOf(draft);
  return {
    push(chunk) {
      const parsed = parseObjectDatagram(chunk, draft);
      // An empty payload is valid here, and rules have nothing to read in it: it goes as it is, like a status.
      const payload = parsed && !parsed.status && parsed.payloadAt < chunk.length ? chunk.slice(parsed.payloadAt) : null;
      if (!parsed || !payload) {
        return [{ moqt: parsed ? parsed.info : null, payload: chunk, bypass: Boolean(parsed), render: (final) => final }];
      }
      return [
        {
          moqt: parsed.info,
          payload,
          bypass: false,
          render: (final) => {
            if (!final || final.length === 0) return null;
            if (final === payload) return chunk;
            if (parsed.lengthAt !== null) return join([chunk.subarray(0, parsed.lengthAt), write(final.length), final]);
            return join([chunk.subarray(0, parsed.payloadAt), final]);
          },
        },
      ];
    },
    end: () => [],
  };
}
