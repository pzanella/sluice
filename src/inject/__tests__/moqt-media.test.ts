import { describe, expect, it } from 'vitest';
import { parseCatalog, type Rendition } from '../../shared/catalog';
import { createLiteTracker } from '../moqt/lite';
import { analyzeFrame } from '../moqt/media';

const fromHex = (hex: string): Uint8Array<ArrayBuffer> => Uint8Array.from((hex.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const legacyAvc: Rendition = { name: '2.avc3', kind: 'video', codec: 'avc3.64001f', container: 'legacy' };
const STAMP = 'c0000025c8490fd5';

function moof(trunFlags: number, firstFlags: number | null, tfhdFlags = 0, defaultFlags = 0): Uint8Array<ArrayBuffer> {
  const u32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const box = (type: string, body: number[]): number[] => [...u32(body.length + 8), ...[...type].map((c) => c.charCodeAt(0)), ...body];
  const tfhd = box('tfhd', [...u32(tfhdFlags), ...u32(1), ...(tfhdFlags & 0x20 ? u32(defaultFlags) : [])]);
  const trun = box('trun', [...u32(trunFlags), ...u32(1), ...(trunFlags & 1 ? u32(100) : []), ...(firstFlags === null ? [] : u32(firstFlags))]);
  return Uint8Array.from(box('moof', box('traf', [...tfhd, ...trun])));
}

describe('analyzeFrame', () => {
  it('reads a real keyframe head, with an IDR after SPS, PPS and SEI', () => {
    // The head of a real frame of a live H.264 stream, then the NAL units that follow the SPS in such a frame.
    const data = fromHex(`${STAMP}00000001091000000001 6764001f 0000000168eb 0000000106 05 0000000165 88`.replace(/ /g, ''));
    expect(analyzeFrame(data, legacyAvc)).toEqual({ key: true, mediaUs: 0x25c8490fd5 });
  });

  it('reads a real delta frame head', () => {
    const data = fromHex(`${STAMP}000000010930000000010601020081800000000141 9a`.replace(/ /g, ''));
    expect(analyzeFrame(data, legacyAvc).key).toBe(false);
  });

  it('reads the NAL types of HEVC', () => {
    const hevc = { ...legacyAvc, codec: 'hev1.1.6' };
    expect(analyzeFrame(fromHex(`${STAMP}000000012601`), hevc).key).toBe(true);
    expect(analyzeFrame(fromHex(`${STAMP}000000010201`), hevc).key).toBe(false);
  });

  it('gives audio its timestamp but no key, and says nothing for no catalog or a codec it does not read', () => {
    expect(analyzeFrame(fromHex(`${STAMP}0000000165`), { ...legacyAvc, kind: 'audio' })).toEqual({ mediaUs: 0x25c8490fd5 });
    expect(analyzeFrame(fromHex(`${STAMP}0000000165`), { ...legacyAvc, kind: 'audio', container: 'cmaf' })).toEqual({});
    expect(analyzeFrame(fromHex(`${STAMP}0000000165`), undefined)).toEqual({});
    expect(analyzeFrame(fromHex(`${STAMP}0000000165`), { ...legacyAvc, codec: 'av01' })).toEqual({ mediaUs: 0x25c8490fd5 });
  });

  it('says nothing about a key with no picture in the bytes', () => {
    expect(analyzeFrame(fromHex(`${STAMP}00000001091000000001 67`.replace(/ /g, '')), legacyAvc).key).toBeUndefined();
  });

  it.each([
    ['first sample flags, sync', moof(0x4, 0x02000000), true],
    ['first sample flags, not sync', moof(0x4, 0x01010000), false],
    ['with a data offset', moof(0x5, 0x01010000), false],
    ['per sample flags', moof(0x400, 0x02000000), true],
    ['the default of the tfhd', moof(0x1, null, 0x20, 0x01010000), false],
  ])('reads a moof: %s', (_name, data, key) => {
    expect(analyzeFrame(data, undefined).key).toBe(key);
  });

  it('does not throw on a cut or odd moof', () => {
    const data = moof(0x4, 0);
    for (let end = 0; end < data.length; end++) expect(() => analyzeFrame(data.subarray(0, end), undefined)).not.toThrow();
    expect(analyzeFrame(Uint8Array.of(0, 0, 0, 4, 0x6d, 0x6f, 0x6f, 0x66), undefined)).toEqual({});
  });
});

describe('catalog', () => {
  const real = '{"video":{"renditions":{"2.avc3":{"codec":"avc3.64001f","codedWidth":854,"codedHeight":480,"bitrate":2090432,"container":{"kind":"legacy"}}}},"audio":{"renditions":{"0.aac":{"codec":"mp4a.40.2","sampleRate":48000,"numberOfChannels":2,"bitrate":242818,"container":{"kind":"legacy"}}}}}';

  it('reads the renditions of a real catalog', () => {
    expect(parseCatalog(real)).toEqual([
      { name: '2.avc3', kind: 'video', codec: 'avc3.64001f', container: 'legacy', width: 854, height: 480, bitrate: 2090432 },
      { name: '0.aac', kind: 'audio', codec: 'mp4a.40.2', container: 'legacy', bitrate: 242818, sampleRate: 48000, channels: 2 },
    ]);
  });

  it.each([['{'], ['null'], ['[]'], ['{}'], ['{"video":1}'], ['{"video":{"renditions":{"x":1}}}']])('finds nothing in %s', (json) => {
    expect(parseCatalog(json)).toBeNull();
  });

  it('reads the catalog of a stream once, and marks keyframes after it', () => {
    const seen: string[] = [];
    const tracker = createLiteTracker(6, (_broadcast, json) => seen.push(json));
    const catalogTrack = { broadcast: 'b', name: 'catalog.json' };
    const bytes = new TextEncoder().encode(real);
    const video = { broadcast: 'b', name: '2.avc3' };
    const frame = fromHex(`${STAMP}0000000165`);
    expect(tracker.frameFacts(video, frame).key).toBeUndefined();
    expect(tracker.frameFacts(catalogTrack, bytes)).toEqual({});
    expect(tracker.frameFacts(catalogTrack, bytes)).toEqual({});
    expect(seen.length).toBe(1);
    expect(tracker.frameFacts(video, frame).key).toBe(true);
    expect(tracker.frameFacts({ broadcast: 'other', name: '2.avc3' }, frame).key).toBeUndefined();
  });
});
