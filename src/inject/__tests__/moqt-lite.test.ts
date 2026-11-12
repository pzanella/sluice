import { describe, expect, it } from 'vitest';
import { createLiteTracker } from '../moqt/lite';
import type { ObjectFramer, ObjectUnit } from '../moqt/objects';
import { versionFromProtocol } from '../moqt/version';

const text = (value: string): number[] => [value.length, ...new TextEncoder().encode(value)];
const bytes = (...values: number[]): Uint8Array<ArrayBuffer> => Uint8Array.from(values);
const message = (...body: number[]): number[] => [body.length, ...body];

function run(framer: ObjectFramer, chunks: Uint8Array<ArrayBuffer>[], decide: (u: ObjectUnit) => Uint8Array<ArrayBuffer> | null = (u) => u.payload) {
  const units: ObjectUnit[] = [];
  const out: number[] = [];
  const take = (list: ObjectUnit[]): void => {
    for (const unit of list) {
      units.push(unit);
      const rendered = unit.render(unit.bypass ? unit.payload : decide(unit));
      if (rendered) out.push(...rendered);
    }
  };
  for (const chunk of chunks) take(framer.push(chunk));
  take(framer.end());
  return { units, objects: units.filter((u) => u.moqt), out };
}

function tracker(version: number, timescale?: number) {
  const t = createLiteTracker(version);
  // SUBSCRIBE on stream 2: id 7, broadcast, track, priority.
  t.sent(2, bytes(2, ...message(7, ...text('bbb'), ...text('video'), 0)));
  if (timescale !== undefined) {
    // TRACK on stream 4, and TRACK_INFO back: priority, order flag up to version 5, max age, timescale.
    t.sent(4, bytes(6, ...message(...text('bbb'), ...text('video'))));
    t.received(4, bytes(...message(0, ...(version <= 5 ? [0] : []), 5, timescale)));
  }
  return t;
}

describe('moq-lite', () => {
  it('finds the version in the protocol of the session', () => {
    expect(versionFromProtocol('moq-lite-06')).toEqual({ draft: null, lite: 6, source: 'protocol' });
    expect(versionFromProtocol('moq-lite-07-wip')).toEqual({ draft: null, lite: 7, source: 'protocol' });
    expect(versionFromProtocol('moq-lite')).toBeNull();
  });

  it('reads the head of a real lite-04 catalog stream', () => {
    // From a recording of moq-lab: group 5 of subscribe 0, then a frame of 2461 bytes.
    const t = createLiteTracker(4);
    t.sent(2, bytes(2, ...message(0, ...text('bbb'), ...text('catalog.json'), 0)));
    const payload = new Array<number>(2461).fill(0x7b);
    const { objects, out } = run(t.groupFramer(), [bytes(0x00, 0x02, 0x00, 0x05, 0x49, 0x9d, ...payload)]);
    expect(objects[0]?.moqt).toEqual({ trackAlias: 0, group: 5, subgroup: null, object: 0, track: 'catalog.json' });
    expect(objects[0]?.payload.length).toBe(2461);
    expect(out.length).toBe(6 + 2461);
  });

  it('reads frames with no timestamps, in any split, with the same bytes', () => {
    const data = [0, ...message(7, 9), 2, 1, 2, 1, 3];
    for (const size of [1, 2, data.length]) {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      for (let at = 0; at < data.length; at += size) chunks.push(Uint8Array.from(data.slice(at, at + size)));
      const { objects, out } = run(tracker(4).groupFramer(), chunks);
      expect(objects.map((u) => [...u.payload])).toEqual([[1, 2], [3]]);
      expect(objects.map((u) => u.moqt?.object)).toEqual([0, 1]);
      expect(objects[0]?.moqt).toMatchObject({ group: 9, track: 'video' });
      expect(out).toEqual(data);
    }
  });

  it.each([[5], [6]])('reads the timestamps of version %d, and gives a dropped delta to the next frame', (version) => {
    // Deltas: +10 (zigzag 20), +4 (8), +6 (12).
    const data = [0, ...message(7, 9), 20, 1, 0xa, 8, 1, 0xb, 12, 1, 0xc];
    const kept = run(tracker(version, 44).groupFramer(), [Uint8Array.from(data)]);
    expect(kept.out).toEqual(data);
    const dropped = run(tracker(version, 44).groupFramer(), [Uint8Array.from(data)], (u) => (u.moqt?.object === 1 ? null : u.payload));
    expect(dropped.out).toEqual([0, ...message(7, 9), 20, 1, 0xa, 20, 1, 0xc]);
  });

  it('reads a timescale of 0 as no timestamps', () => {
    const data = [0, ...message(7, 9), 1, 0xa];
    const { objects } = run(tracker(5, 0).groupFramer(), [Uint8Array.from(data)]);
    expect(objects.map((u) => [...u.payload])).toEqual([[0xa]]);
  });

  it('writes the new size after an edit', () => {
    const data = [0, ...message(7, 9), 2, 1, 2];
    const { out } = run(tracker(4).groupFramer(), [Uint8Array.from(data)], () => bytes(5, 6, 7));
    expect(out).toEqual([0, ...message(7, 9), 3, 5, 6, 7]);
  });

  it('sends the header alone when all frames are dropped', () => {
    const data = [0, ...message(7, 9), 1, 1];
    expect(run(tracker(4).groupFramer(), [Uint8Array.from(data)], () => null).out).toEqual([0, ...message(7, 9)]);
  });

  it.each([
    ['a subscribe that is not known', [0, ...message(99, 1), 1, 1]],
    ['a setup stream', [1, 2, 3, 4]],
    ['another type', [9, 1, 1]],
  ])('keeps the bytes of %s, with no objects', (_name, data) => {
    const { objects, out } = run(tracker(4).groupFramer(), [Uint8Array.from(data), bytes(5)]);
    expect(objects.length).toBe(0);
    expect(out).toEqual([...data, 5]);
  });

  it('keeps the bytes when the timescale is not known', () => {
    const data = [0, ...message(7, 9), 20, 1, 0xa];
    const { objects, out } = run(tracker(5).groupFramer(), [Uint8Array.from(data)]);
    expect(objects.length).toBe(0);
    expect(out).toEqual(data);
  });

  it('gives the bytes of a stream that ended inside a frame', () => {
    const data = [0, ...message(7, 9), 5, 1];
    const { out } = run(tracker(4).groupFramer(), [Uint8Array.from(data)]);
    expect(out).toEqual(data);
  });

  it('reads control messages that come in pieces', () => {
    const t = createLiteTracker(6);
    const subscribe = [2, ...message(1, ...text('b'), ...text('t'), 0)];
    for (const byte of subscribe) t.sent(2, bytes(byte));
    expect(t.track(1)).toEqual({ broadcast: 'b', name: 't' });
    t.sent(4, bytes(6, ...message(...text('b'), ...text('t'))));
    const info = message(0, 5, 44);
    for (const byte of info) t.received(4, bytes(byte));
    expect(t.timescale({ broadcast: 'b', name: 't' })).toBe(44);
  });
});
