// How payload bytes are shown. Pure functions, and all output is plain text.
import { base64ToBytes } from '../shared/protocol';

export function decodePreview(preview: string): Uint8Array {
  try {
    return base64ToBytes(preview);
  } catch {
    return new Uint8Array();
  }
}

const decoder = new TextDecoder('utf-8');

export const toText = (bytes: Uint8Array): string => decoder.decode(bytes);

/** True when the start of a payload is not text: control bytes, or bytes that are not UTF-8. Media frames are. */
export function looksBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 256);
  if (head.length === 0) return false;
  let odd = 0;
  for (const byte of head) if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) odd++;
  for (const char of decoder.decode(head)) if (char === '\uFFFD') odd++;
  return odd / head.length > 0.1;
}

/**
 * Shows invisible characters as `\u{202e}`. Page text could use them to change what a row seems to say: U+202E shows
 * "evil" as "live". Use this for every page value on screen.
 */
export const visible = (text: string): string =>
  // Also the characters that look blank: a page could push the end of a text out of sight with them.
  text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u3164\u2800]|[\ufe00-\ufe0f]/gu, (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`);

/** Same, for many lines: line breaks and tabs stay. */
export const visibleLines = (text: string): string => text.split(/(\r?\n|\t)/).map((part, i) => (i % 2 ? part : visible(part))).join('');

/** Null if the text is not pairs of hex digits. Space between bytes is fine. */
export function hexToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  const digits = text.replace(/\s+/g, '');
  if (digits.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(digits)) return null;
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Offset, hex and ASCII columns, 16 bytes in each line. With no columns: only the hex bytes, to edit them. */
export function toHex(bytes: Uint8Array, columns = true): string {
  if (!columns) {
    const pairs = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
    const lines: string[] = [];
    for (let i = 0; i < pairs.length; i += 16) lines.push(pairs.slice(i, i + 16).join(' '));
    return lines.join('\n');
  }
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const line = bytes.subarray(i, i + 16);
    const hex = Array.from(line, (byte) => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = Array.from(line, (byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
  }
  return lines.join('\n');
}

/** `flat`: too large with indent, so this is the text as it came. */
type JsonView = { ok: true; text: string; flat: boolean } | { ok: false };

/** Indent grows with the square of the depth: 4 KiB of `[[[[` would be 8 MB. */
const MAX_JSON_VIEW_CHARS = 1024 * 1024;

/**
 * Adds line breaks and indent to valid JSON, and changes no value. Parsing and printing would change what was on the wire:
 * a 64-bit id loses digits, `1.10` becomes `1.1`, and a repeated key disappears.
 */
function indentJson(json: string): string | null {
  const out: string[] = [];
  let depth = 0;
  let size = json.length;
  const newLine = (): void => {
    size += 1 + 2 * depth;
    if (size <= MAX_JSON_VIEW_CHARS) out.push('\n', '  '.repeat(depth));
  };
  for (let i = 0; i < json.length; i++) {
    const char = json.charAt(i);
    if (char === '"') {
      const start = i;
      for (i++; json.charAt(i) !== '"'; i++) if (json.charAt(i) === '\\') i++;
      out.push(json.slice(start, i + 1));
    } else if (char === '{' || char === '[') {
      out.push(char);
      let next = i + 1;
      while (' \t\r\n'.includes(json.charAt(next))) next++;
      if (json.charAt(next) === '}' || json.charAt(next) === ']') {
        out.push(json.charAt(next));
        i = next;
      } else {
        depth++;
        newLine();
      }
    } else if (char === '}' || char === ']') {
      depth--;
      newLine();
      out.push(char);
    } else if (char === ',') {
      out.push(char);
      newLine();
    } else if (char === ':') {
      out.push(': ');
    } else if (!' \t\r\n'.includes(char)) {
      out.push(char);
    }
  }
  return size > MAX_JSON_VIEW_CHARS ? null : out.join('');
}

export function toJson(bytes: Uint8Array): JsonView {
  const text = toText(bytes);
  try {
    JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const indented = indentJson(text);
  return indented === null ? { ok: true, text, flat: true } : { ok: true, text: indented, flat: false };
}

/** The row a key moves to in a list. Null for a key that does not move. With nothing selected, `at` is -1. */
export function listTarget(key: string, at: number, count: number, pageRows: number): number | null {
  const last = count - 1;
  switch (key) {
    case 'ArrowDown':
      return Math.min(last, at + 1);
    case 'ArrowUp':
      return Math.max(0, at - 1);
    case 'PageDown':
      return Math.min(last, Math.max(at, 0) + pageRows);
    case 'PageUp':
      return Math.max(0, at - pageRows);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

export function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KiB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MiB`;
}

export const formatTime = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour12: false });

/** With no query: a token is often there. */
export function hostAndPath(url: string | null): string {
  if (!url) return 'Unknown session';
  try {
    const { host, pathname } = new URL(url);
    return visible(host + pathname);
  } catch {
    return visible(url);
  }
}
