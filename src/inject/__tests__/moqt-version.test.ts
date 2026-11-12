import { describe, expect, it } from 'vitest';
import { createSetupReader, parseServerSetup, versionFromProtocol } from '../moqt/version';

/** The version number of a draft, as an 8-byte varint: 0xff000000 + N needs more than 30 bits. */
const version = (draft: number): number[] => [0xc0, 0, 0, 0, 0xff, 0, 0, draft];
const setup = (draft: number) => ({ draft, source: 'setup' });

describe('MoQT version', () => {
  it.each([
    ['moqt-15', 15],
    ['moqt-23', 23],
    ['moqt', null],
  ])('from the protocol %s', (protocol, draft) => {
    expect(versionFromProtocol(protocol)).toEqual({ draft, source: 'protocol' });
  });

  it('moql: moq-lite with its version in the setup (ADR-52)', () => {
    expect(versionFromProtocol('moql')).toEqual({ draft: null, lite: 0, source: 'protocol' });
  });

  it.each([[''], ['h3'], ['moqt-'], ['moqt-x'], ['moq-00'], ['MOQT-15'], ['moqt-99999'], [undefined], [15]])('not from the protocol %s', (protocol) => {
    expect(versionFromProtocol(protocol)).toBeNull();
  });

  it.each([
    ['draft 14: type, 16-bit length', [0x21, 0x00, 0x09, ...version(14), 0], setup(14)],
    ['draft 12', [0x21, 0x00, 0x09, ...version(12), 0], setup(12)],
    ['draft 11: varint length', [0x21, 0x09, ...version(11), 0], setup(11)],
    ['draft 10: two-byte type', [0x40, 0x41, 0x09, ...version(10), 0], setup(10)],
    ['draft 9', [0x40, 0x41, 0x09, ...version(9), 0], setup(9)],
  ])('from SERVER_SETUP, %s', (_name, bytes, expected) => {
    expect(parseServerSetup(Uint8Array.from(bytes))).toEqual(expected);
  });

  it.each([
    ['other data', [0x47, 0x45, 0x54, 0x20]],
    ['varint length with 14', [0x21, 0x09, ...version(14), 0]],
    ['a type 0x41 with 14', [0x40, 0x41, 0x09, ...version(14), 0]],
    ['a version that is not a draft', [0x21, 0x00, 0x09, 0xc0, 0, 0, 0, 0xfe, 0, 0, 14, 0]],
    ['a length shorter than the version', [0x21, 0x00, 0x01, ...version(14), 0]],
    ['text that starts with !', [...new TextEncoder().encode('!hello world, this is not a setup')]],
  ])('not from %s', (_name, bytes) => {
    expect(parseServerSetup(Uint8Array.from(bytes))).toBe('no');
  });

  it('collects across chunks, also one byte at a time', () => {
    const read = createSetupReader();
    const bytes = [0x21, 0x00, 0x09, ...version(14), 0];
    const results = bytes.map((byte) => read(Uint8Array.of(byte)));
    expect(results[0]).toBe('more');
    expect(results).toContainEqual(setup(14));
  });

  it('stops waiting after a few bytes', () => {
    const read = createSetupReader();
    // Type 0x21, then a length, and a version that says it needs more bytes than arrive.
    expect(read(Uint8Array.of(0x21))).toBe('more');
    expect(read(new Uint8Array(100).fill(0xff))).toBe('no');
  });
});
