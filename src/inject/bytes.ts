// Binary helpers. No dependencies.
import type { BytePattern } from '../shared/rules';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8'); // Not fatal: invalid bytes become U+FFFD.

export function patternToBytes(pattern: BytePattern): Uint8Array<ArrayBuffer> {
  return typeof pattern === 'string' ? encoder.encode(pattern) : Uint8Array.from(pattern);
}

export function decodeText(data: Uint8Array): string {
  return decoder.decode(data);
}

export function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  return prefix.every((byte, i) => data[i] === byte);
}

/** Finds a byte sequence. Returns -1 if it is not there. An empty needle is found at `from`. */
export function indexOfBytes(data: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from;
  const first = needle[0] as number;
  const last = data.length - needle.length;
  for (let i = data.indexOf(first, from); i !== -1 && i <= last; i = data.indexOf(first, i + 1)) {
    let j = 1;
    while (j < needle.length && data[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

/** Limit for one edited payload. A chain of `replace` ops can double the size at each op. */
export const MAX_EDITED_BYTES = 16 * 1024 * 1024;

/**
 * Replaces every match. Returns a new array, so the input buffer is left alone. With no match it returns `data`
 * itself, so a caller can see that nothing changed.
 * Throws a RangeError if the result grows past `maxSize`. The size is known before any allocation: running out of memory ends the tab,
 * and no try/catch can stop that.
 */
export function replaceBytes(
  data: Uint8Array<ArrayBuffer>,
  find: Uint8Array,
  replacement: Uint8Array,
  maxSize = MAX_EDITED_BYTES,
): Uint8Array<ArrayBuffer> {
  if (find.length === 0) return data;
  const growth = replacement.length - find.length;
  const matches: number[] = [];
  let size = data.length;
  for (let i = indexOfBytes(data, find); i !== -1; i = indexOfBytes(data, find, i + find.length)) {
    matches.push(i);
    size += growth;
    // Only growth can pass the limit: a smaller result is never worse than the input.
    if (growth > 0 && size > maxSize) throw new RangeError(`edited payload is above ${maxSize} bytes`);
  }
  if (matches.length === 0) return data;
  const out = new Uint8Array(size);
  let start = 0;
  let offset = 0;
  for (const i of matches) {
    out.set(data.subarray(start, i), offset);
    offset += i - start;
    out.set(replacement, offset);
    offset += replacement.length;
    start = i + find.length;
  }
  out.set(data.subarray(start), offset);
  return out;
}

/** Short hex dump for logs. */
export function hex(data: Uint8Array, max = 48): string {
  const shown = Math.min(data.length, max);
  const lines: string[] = [];
  for (let i = 0; i < shown; i += 16) {
    const line = data.subarray(i, Math.min(i + 16, shown));
    lines.push(Array.from(line, (b) => b.toString(16).padStart(2, '0')).join(' '));
  }
  const rest = data.length - shown;
  return lines.join('\n') + (rest > 0 ? ` ...(+${rest}B)` : '');
}
