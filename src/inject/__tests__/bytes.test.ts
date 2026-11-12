import { describe, expect, it } from 'vitest';
import { decodeText, hex, indexOfBytes, patternToBytes, replaceBytes, startsWith } from '../bytes';

const b = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
const s = (a: Uint8Array): string => new TextDecoder().decode(a);

describe('patternToBytes', () => {
  it('encodes a string as UTF-8', () => {
    expect(Array.from(patternToBytes('aé'))).toEqual([0x61, 0xc3, 0xa9]);
  });
  it('copies a number list', () => {
    const list = [1, 2, 3];
    const out = patternToBytes(list);
    list[0] = 9;
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});

describe('decodeText', () => {
  it('turns invalid bytes into U+FFFD and does not throw', () => {
    expect(decodeText(Uint8Array.of(0xff, 0x61))).toBe('�a');
  });
});

describe('startsWith', () => {
  it('matches a prefix', () => expect(startsWith(b('hello'), b('he'))).toBe(true));
  it('rejects a longer prefix', () => expect(startsWith(b('he'), b('hello'))).toBe(false));
  it('treats an empty prefix as a match', () => expect(startsWith(b('x'), b(''))).toBe(true));
  it('rejects a different prefix', () => expect(startsWith(b('hello'), b('hi'))).toBe(false));
});

describe('indexOfBytes', () => {
  it('finds a needle in the middle', () => expect(indexOfBytes(b('abcdef'), b('cd'))).toBe(2));
  it('returns -1 when absent', () => expect(indexOfBytes(b('abcdef'), b('xy'))).toBe(-1));
  it('returns `from` for an empty needle', () => {
    expect(indexOfBytes(b('abc'), b(''))).toBe(0);
    expect(indexOfBytes(b('abc'), b(''), 2)).toBe(2);
  });
  it('returns -1 when the needle is longer than the data', () => {
    expect(indexOfBytes(b('ab'), b('abc'))).toBe(-1);
  });
  it('finds a needle at the very end', () => expect(indexOfBytes(b('abcd'), b('cd'))).toBe(2));
  it('finds a needle at the very start', () => expect(indexOfBytes(b('abcd'), b('ab'))).toBe(0));
  it('does not match past the end on a partial match', () => {
    expect(indexOfBytes(b('abca'), b('abcd'))).toBe(-1);
    expect(indexOfBytes(b('xxab'), b('abc'))).toBe(-1);
  });
  it('skips a false start and finds the real match', () => {
    expect(indexOfBytes(b('aaab'), b('aab'))).toBe(1);
  });
  it('respects `from`', () => {
    expect(indexOfBytes(b('abab'), b('ab'), 1)).toBe(2);
    expect(indexOfBytes(b('abab'), b('ab'), 3)).toBe(-1);
  });
  it('handles empty data', () => {
    expect(indexOfBytes(b(''), b('a'))).toBe(-1);
  });
  it('finds zero bytes', () => {
    expect(indexOfBytes(Uint8Array.of(1, 0, 0, 2), Uint8Array.of(0, 2))).toBe(2);
  });
});

describe('replaceBytes', () => {
  it('throws before it allocates past the limit', () => {
    expect(() => replaceBytes(b('aaaa'), b('a'), b('xx'), 7)).toThrow(RangeError);
    expect(s(replaceBytes(b('aaaa'), b('a'), b('xx'), 8))).toBe('xxxxxxxx');
    expect(s(replaceBytes(b('aaaa'), b('aa'), b(''), 0))).toBe('');
  });

  it('can shrink an input that is above the limit', () => {
    expect(s(replaceBytes(b('aaaa'), b('aa'), b('x'), 3))).toBe('xx');
  });


  it('returns the same array for an empty find', () => {
    const data = b('abc');
    const out = replaceBytes(data, b(''), b('x'));
    expect(s(out)).toBe('abc');
    expect(out).toBe(data);
  });
  it('returns the same array when nothing matches', () => {
    const data = b('abc');
    const out = replaceBytes(data, b('zz'), b('x'));
    expect(s(out)).toBe('abc');
    expect(out).toBe(data);
  });
  it('replaces every match', () => {
    expect(s(replaceBytes(b('a-b-c'), b('-'), b('+')))).toBe('a+b+c');
  });
  it('handles overlapping matches left to right without reuse', () => {
    expect(s(replaceBytes(b('aaa'), b('aa'), b('b')))).toBe('ba');
    expect(s(replaceBytes(b('aaaa'), b('aa'), b('b')))).toBe('bb');
  });
  it('does not rescan the replacement', () => {
    expect(s(replaceBytes(b('ab'), b('a'), b('aa')))).toBe('aab');
  });
  it('can delete with an empty replacement', () => {
    expect(s(replaceBytes(b('a1b1'), b('1'), b('')))).toBe('ab');
  });
  it('can grow and shrink the payload', () => {
    expect(replaceBytes(b('ab'), b('ab'), b('xyz')).length).toBe(3);
    expect(replaceBytes(b('abab'), b('ab'), b('x')).length).toBe(2);
  });
  it('replaces at the start and at the end', () => {
    expect(s(replaceBytes(b('abXab'), b('ab'), b('_')))).toBe('_X_');
  });
  it('handles an empty input', () => {
    expect(replaceBytes(b(''), b('a'), b('b')).length).toBe(0);
  });
});

describe('hex', () => {
  it('prints bytes in two-digit hex', () => {
    expect(hex(Uint8Array.of(0, 15, 255))).toBe('00 0f ff');
  });
  it('returns an empty string for empty data', () => {
    expect(hex(new Uint8Array(0))).toBe('');
  });
  it('shows no suffix when the data fits', () => {
    expect(hex(new Uint8Array(48))).not.toContain('...');
  });
  it('truncates and reports the hidden byte count', () => {
    const out = hex(new Uint8Array(100), 4);
    expect(out).toBe('00 00 00 00 ...(+96B)');
  });
  it('breaks lines every 16 bytes', () => {
    const out = hex(new Uint8Array(20), 20);
    expect(out.split('\n')).toHaveLength(2);
    expect(out.split('\n')[0]?.split(' ')).toHaveLength(16);
  });
  it('shows nothing but the count when max is 0', () => {
    expect(hex(new Uint8Array(3), 0)).toBe(' ...(+3B)');
  });
});
