import { describe, expect, it } from 'vitest';
import { decodePreview, formatBytes, hexToBytes, listTarget, toHex, toJson, toText, visible, visibleLines } from '../format';

describe('format', () => {
  it('decodes base64, and a bad value gives no bytes', () => {
    expect(toText(decodePreview(btoa('hi')))).toBe('hi');
    expect(decodePreview('!!!')).toEqual(new Uint8Array());
  });

  it('hex has offset, hex and ASCII columns', () => {
    const bytes = Uint8Array.from({ length: 17 }, (_, i) => 0x41 + i);
    expect(toHex(bytes).split('\n')).toEqual([
      '00000000  41 42 43 44 45 46 47 48 49 4a 4b 4c 4d 4e 4f 50  ABCDEFGHIJKLMNOP',
      `00000010  51${' '.repeat(45)}  Q`,
    ]);
  });

  it('hex shows control bytes as dots', () => {
    expect(toHex(Uint8Array.from([0, 0x7f, 0xff]))).toMatch(/ \.\.\.$/);
  });

  it('hex of nothing is empty', () => {
    expect(toHex(new Uint8Array())).toBe('');
  });

  it.each([
    ['big numbers', '{"id":12345678901234567890,"big":9007199254740993}', '{\n  "id": 12345678901234567890,\n  "big": 9007199254740993\n}'],
    ['number forms', '[1.10,1E3,-0]', '[\n  1.10,\n  1E3,\n  -0\n]'],
    ['repeated keys', '{"a":1,"a":2}', '{\n  "a": 1,\n  "a": 2\n}'],
    ['structure inside a string', '{"a":"{,:[\\"]}"}', '{\n  "a": "{,:[\\"]}"\n}'],
    ['escapes', '"\\u202e\\n"', '"\\u202e\\n"'],
    ['empty containers with space', '{"a":[ ],"b":{\n}}', '{\n  "a": [],\n  "b": {}\n}'],
    ['space on the wire', ' { "a" : [ 1 , 2 ] } ', '{\n  "a": [\n    1,\n    2\n  ]\n}'],
    ['a plain value', 'null', 'null'],
  ])('json keeps what was on the wire: %s', (_name, input, text) => {
    expect(toJson(new TextEncoder().encode(input))).toEqual({ ok: true, text, flat: false });
  });

  it('hex for an edit goes both ways, and bad hex is refused', () => {
    const bytes = Uint8Array.from({ length: 17 }, (_, i) => i * 15);
    const text = toHex(bytes, false);
    expect(text.split('\n')).toHaveLength(2);
    expect(hexToBytes(text)).toEqual(bytes);
    expect(hexToBytes('')).toEqual(new Uint8Array());
    expect(hexToBytes('abc')).toBeNull();
    expect(hexToBytes('zz')).toBeNull();
  });

  it('json handles deep nesting', () => {
    const deep = `${'['.repeat(5000)}${']'.repeat(5000)}`;
    expect(toJson(new TextEncoder().encode(deep))).toEqual({ ok: true, text: deep, flat: true });
    const small = `${'['.repeat(50)}${']'.repeat(50)}`;
    expect(toJson(new TextEncoder().encode(small))).toMatchObject({ ok: true, flat: false });
  });

  it('shows the blank and invisible characters that a page could hide text with', () => {
    expect(visible('a\uffa0b\u034fc\u{e0100}d')).toBe('a\\u{ffa0}b\\u{34f}c\\u{e0100}d');
  });

  it.each([
    ['ArrowDown', 3, 4],
    ['ArrowDown', 9, 9],
    ['ArrowDown', -1, 0],
    ['ArrowUp', 3, 2],
    ['ArrowUp', 0, 0],
    ['ArrowUp', -1, 0],
    ['PageDown', 3, 7],
    ['PageDown', 8, 9],
    ['PageDown', -1, 4],
    ['PageUp', 6, 2],
    ['PageUp', 1, 0],
    ['Home', 5, 0],
    ['End', 5, 9],
    ['a', 5, null],
  ])('list key %s from row %i goes to %s', (key, at, target) => {
    expect(listTarget(key, at, 10, 4)).toBe(target);
  });

  it('json is pretty, or says no', () => {
    expect(toJson(new TextEncoder().encode('{"a":1}'))).toEqual({ ok: true, text: '{\n  "a": 1\n}', flat: false });
    expect(toJson(new TextEncoder().encode('{"a"'))).toEqual({ ok: false });
  });

  it('shows invisible characters that could fake the text', () => {
    expect(visible('live\u202eevil')).toBe('live\\u{202e}evil');
    expect(visible('a\nb\u0000\u2028')).toBe('a\\u{a}b\\u{0}\\u{2028}');
    expect(visible('plain é € ✓ 😀')).toBe('plain é € ✓ 😀');
    expect(visible('a\u00a0b\u3164c\u2800d\ufe0fe')).toBe('a\\u{a0}b\\u{3164}c\\u{2800}d\\u{fe0f}e');
  });

  it('keeps line breaks and tabs in many lines, and nothing else', () => {
    expect(visibleLines('a\n\tb\r\nc\u202e')).toBe('a\n\tb\r\nc\\u{202e}');
  });

  it('formats sizes', () => {
    expect([formatBytes(5), formatBytes(2048), formatBytes(3 * 1024 * 1024)]).toEqual(['5 B', '2.0 KiB', '3.0 MiB']);
  });
});
