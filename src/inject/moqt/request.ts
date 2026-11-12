// The first message that the app wrote on a stream it opened: what it asks for. A replay uses it to give the app the recorded
// stream that answers the same request (ADR-43), and an export uses it for the track names of moq-lite. Pure code.
import { readVarint } from './version';

/** What a request of the app is about: a moq-lite SUBSCRIBE (type 2) or TRACK (type 6), or only its type and its text. */
export interface Request {
  type: number | null;
  /** moq-lite SUBSCRIBE only. */
  subscribeId: number | null;
  names: string | null;
  text: string;
}

const textOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ' '))
    .join('')
    .split(/\s+/)
    .filter((part) => part.length >= 3)
    .join(' ');

function readText(data: Uint8Array, at: number): { value: string; next: number } | null {
  const length = readVarint(data, at);
  if (!length || length.next + length.value > data.length || length.value > 1024) return null;
  return { value: new TextDecoder().decode(data.subarray(length.next, length.next + length.value)), next: length.next + length.value };
}

/** Reads the first message the app wrote on a stream. Layouts of moq-lite 3 to 6 (ADR-30). */
export function readRequest(bytes: Uint8Array, lite: boolean): Request {
  const type = readVarint(bytes, 0);
  const request: Request = { type: type?.value ?? null, subscribeId: null, names: null, text: textOf(bytes) };
  if (!lite || !type || (type.value !== 2 && type.value !== 6)) return request;
  const size = readVarint(bytes, type.next);
  if (!size) return request;
  let at = size.next;
  if (type.value === 2) {
    const id = readVarint(bytes, at);
    if (!id) return request;
    request.subscribeId = id.value;
    at = id.next;
  }
  const broadcast = readText(bytes, at);
  const track = broadcast && readText(bytes, broadcast.next);
  if (track && broadcast) request.names = `${broadcast.value}\u0000${track.value}`;
  return request;
}
