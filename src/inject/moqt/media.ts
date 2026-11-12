// Finds keyframes and media time in a frame, from its first bytes. Pure code, for the hot path: it reads at most SCAN_BYTES, and copies nothing.
import type { Rendition } from '../../shared/catalog';
import { readVarint } from './version';

const SCAN_BYTES = 16 * 1024;
const NON_SYNC = 0x10000;

export interface FrameFacts {
  key?: boolean;
  /** Microseconds, from the frame itself. */
  mediaUs?: number;
}

/** A `moof` box: the sync flag of the first sample of the first `traf`. Null if the flags are not there. */
function cmafKey(data: Uint8Array): boolean | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u32 = (at: number): number => (at + 4 <= data.length ? view.getUint32(at) : -1);
  const type = (at: number): string => String.fromCharCode(data[at + 4] ?? 0, data[at + 5] ?? 0, data[at + 6] ?? 0, data[at + 7] ?? 0);
  const size = u32(0);
  if (size < 16 || type(0) !== 'moof') return null;
  const moofEnd = Math.min(size, data.length);
  for (let at = 8; at + 8 <= moofEnd; ) {
    const trafSize = u32(at);
    if (trafSize < 8) return null;
    if (type(at) === 'traf') {
      const trafEnd = Math.min(at + trafSize, moofEnd);
      let defaultFlags: number | null = null;
      for (let box = at + 8; box + 12 <= trafEnd; ) {
        const boxSize = u32(box);
        if (boxSize < 8) return null;
        const flags = u32(box + 8) & 0xffffff;
        if (type(box) === 'tfhd') {
          // Track ID, then the fields that the flags name, in order.
          let field = box + 16;
          if (flags & 0x1) field += 8;
          if (flags & 0x2) field += 4;
          if (flags & 0x8) field += 4;
          if (flags & 0x10) field += 4;
          if (flags & 0x20) defaultFlags = u32(field);
        } else if (type(box) === 'trun') {
          // Sample count, then the data offset and the first sample flags, if the flags name them.
          let field = box + 16;
          if (flags & 0x1) field += 4;
          if (flags & 0x4) return !(u32(field) & NON_SYNC);
          if (flags & 0x400) {
            if (flags & 0x100) field += 4;
            if (flags & 0x200) field += 4;
            return !(u32(field) & NON_SYNC);
          }
          return defaultFlags === null ? null : !(defaultFlags & NON_SYNC);
        }
        box += boxSize;
      }
      return null;
    }
    at += trafSize;
  }
  return null;
}

/** Annex-B: the first picture NAL unit says. Null if none is in the bytes that were read. */
function annexBKey(data: Uint8Array, hevc: boolean): boolean | null {
  const end = Math.min(data.length, SCAN_BYTES) - 3;
  for (let at = 0; at < end; at++) {
    if (data[at] !== 0 || data[at + 1] !== 0 || data[at + 2] !== 1) continue;
    const head = data[at + 3] as number;
    at += 2;
    if (hevc) {
      const type = (head >> 1) & 0x3f;
      if (type >= 16 && type <= 21) return true;
      if (type <= 9) return false;
    } else {
      const type = head & 0x1f;
      if (type === 5) return true;
      if (type >= 1 && type <= 4) return false;
    }
  }
  return null;
}

/** `rendition` comes from the catalog. With none, or with a codec that is not read here, a frame says nothing. */
export function analyzeFrame(payload: Uint8Array, rendition: Rendition | undefined): FrameFacts {
  if (rendition?.kind === 'audio') {
    // Audio has no key frames, but the legacy container gives it a timestamp too, for latency and A/V drift (ADR-50).
    if (rendition.container !== 'legacy') return {};
    const stamp = readVarint(payload, 0);
    return stamp && stamp.value <= Number.MAX_SAFE_INTEGER ? { mediaUs: stamp.value } : {};
  }
  const moof = cmafKey(payload.subarray(0, SCAN_BYTES));
  if (moof !== null) return { key: moof };
  if (!rendition || rendition.container !== 'legacy') return {};
  // A timestamp in microseconds, then the frame.
  const stamp = readVarint(payload, 0);
  if (!stamp) return {};
  const facts: FrameFacts = stamp.value <= Number.MAX_SAFE_INTEGER ? { mediaUs: stamp.value } : {};
  const { codec } = rendition;
  const avc = codec.startsWith('avc');
  const hevc = codec.startsWith('hev') || codec.startsWith('hvc');
  if (!avc && !hevc) return facts;
  const key = annexBKey(payload.subarray(stamp.next), hevc);
  return key === null ? facts : { ...facts, key };
}
