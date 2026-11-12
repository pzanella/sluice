// Finds the MoQT version of a session, as formats change between drafts (see the skill `moqt-framing`). Layouts were read from
// the draft texts on 2026-11-06, not from memory (ADR-21). Pure code: no page global, no dependency.

export interface MoqtVersion {
  /** Null for the final version of the protocol, and for moq-lite. */
  draft: number | null;
  /** Set for moq-lite, which is not an IETF draft (ADR-28). */
  lite?: number;
  source: 'protocol' | 'setup';
}

/** Drafts 15 and later: `moqt-N` in the WebTransport protocol, or `moqt` for the final version. */
export function versionFromProtocol(protocol: unknown): MoqtVersion | null {
  if (protocol === 'moqt') return { draft: null, source: 'protocol' };
  // `moql` is moq-lite with its version in the setup, read nowhere here yet. Version 0 says so (ADR-52).
  if (protocol === 'moql') return { draft: null, lite: 0, source: 'protocol' };
  if (typeof protocol !== 'string') return null;
  const lite = /^moq-lite-(\d{2})(-wip)?$/.exec(protocol);
  if (lite) return { draft: null, lite: Number(lite[1]), source: 'protocol' };
  const found = /^moqt-(\d{1,4})$/.exec(protocol);
  return found ? { draft: Number(found[1]), source: 'protocol' } : null;
}

/** Drafts 15 and later: the protocol the page offered, if the server did not name one and it offered only one MoQT draft. */
export function versionFromOffer(protocols: unknown): MoqtVersion | null {
  if (!Array.isArray(protocols)) return null;
  const found = protocols.map(versionFromProtocol).filter((version) => version !== null);
  return found.length === 1 ? (found[0] as MoqtVersion) : null;
}

/** QUIC variable-length integer (RFC 9000, 16). Null if the bytes end first. */
export function readVarint(data: Uint8Array, at: number): { value: number; next: number } | null {
  const first = data[at];
  if (first === undefined) return null;
  const size = 1 << (first >> 6);
  if (at + size > data.length) return null;
  let value = first & 0x3f;
  // Multiply, not shift: bit operators in JavaScript stop at 32 bits. Past 2^53 this is not exact, and no field here is that large.
  for (let i = 1; i < size; i++) value = value * 256 + (data[at + i] as number);
  return { value, next: at + size };
}

/** Version numbers of drafts: 0xff000000 + draft. */
const DRAFT_BASE = 0xff000000;
const draftOf = (version: number): number | null => (version > DRAFT_BASE && version <= DRAFT_BASE + 0xff ? version - DRAFT_BASE : null);

const TYPE_DRAFT_9_10 = 0x41;
const TYPE_DRAFT_11_14 = 0x21;
/** The largest SERVER_SETUP header that this needs: type, length, version. */
const ENOUGH_BYTES = 8 + 8 + 8;

type Parsed = MoqtVersion | 'more' | 'no';

function fromVersionField(data: Uint8Array, at: number, length: number, inRange: (draft: number) => boolean): Parsed {
  const version = readVarint(data, at);
  if (!version) return 'more';
  if (version.next - at > length) return 'no';
  const draft = draftOf(version.value);
  return draft !== null && inRange(draft) ? { draft, source: 'setup' } : 'no';
}

/**
 * Drafts 7 to 14: the first bytes that the server sends on the first bidi stream of the client are SERVER_SETUP. Any other session
 * can send anything there, so the version must be a draft number that has that layout.
 * - 7 to 10: type 0x41, length (varint), version.
 * - 11: type 0x21, then a length that the draft text gives as a varint and the MIT test vectors as 16 bits. Both are read: the version is an exact number.
 * - 12 to 14: type 0x21, length (16 bits), version.
 */
export function parseServerSetup(data: Uint8Array): Parsed {
  const type = readVarint(data, 0);
  if (!type) return 'more';
  if (type.value !== TYPE_DRAFT_9_10 && type.value !== TYPE_DRAFT_11_14) return 'no';
  const varintLength = readVarint(data, type.next);
  if (!varintLength) return 'more';
  if (type.value === TYPE_DRAFT_9_10) return fromVersionField(data, varintLength.next, varintLength.value, (draft) => draft >= 7 && draft <= 10);
  const asVarint = fromVersionField(data, varintLength.next, varintLength.value, (draft) => draft === 11);
  if (typeof asVarint === 'object') return asVarint;
  if (type.next + 2 > data.length) return 'more';
  const length16 = (data[type.next] as number) * 256 + (data[type.next + 1] as number);
  const as16 = fromVersionField(data, type.next + 2, length16, (draft) => draft >= 11 && draft <= 14);
  return typeof as16 === 'object' || as16 === 'more' ? as16 : asVarint;
}

/** Collects the first bytes of a stream, across chunks. It returns a result once. */
export function createSetupReader(): (chunk: Uint8Array) => Parsed {
  let held = new Uint8Array(0);
  return (chunk) => {
    const part = chunk.subarray(0, ENOUGH_BYTES - held.length);
    const next = new Uint8Array(held.length + part.length);
    next.set(held);
    next.set(part, held.length);
    held = next;
    const parsed = parseServerSetup(held);
    return parsed === 'more' && held.length >= ENOUGH_BYTES ? 'no' : parsed;
  };
}
