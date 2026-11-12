import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDatagramFramer, createSubgroupFramer, parseObjectDatagram, readVi64 as readVarint, writeVi64 as writeVarint, type ObjectFramer, type ObjectUnit } from '../moqt/objects';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/draft22-subgroup-recording.json', import.meta.url), 'utf8')) as {
  events: { kind: string; streamId: number; data: string | null }[];
};
const realStreams = new Map<number, Uint8Array<ArrayBuffer>[]>();
for (const e of fixture.events) {
  // Stream 1 is the control stream.
  if (e.kind !== 'uni' || e.streamId === 1 || !e.data) continue;
  const list = realStreams.get(e.streamId) ?? [];
  list.push(Uint8Array.from(Buffer.from(e.data, 'base64')));
  realStreams.set(e.streamId, list);
}

const bytes = (...values: number[]): Uint8Array<ArrayBuffer> => Uint8Array.from(values);
const concat = (parts: Uint8Array[]): number[] => parts.flatMap((part) => [...part]);

function runAll(framer: ObjectFramer, chunks: Uint8Array<ArrayBuffer>[], decide: (unit: ObjectUnit) => Uint8Array<ArrayBuffer> | null = (u) => u.payload) {
  const units: ObjectUnit[] = [];
  const out: Uint8Array[] = [];
  const take = (list: ObjectUnit[]): void => {
    for (const unit of list) {
      units.push(unit);
      const rendered = unit.render(unit.bypass ? unit.payload : decide(unit));
      if (rendered) out.push(rendered);
    }
  };
  for (const chunk of chunks) take(framer.push(chunk));
  take(framer.end());
  return { units, objects: units.filter((u) => u.moqt), output: concat(out) };
}

// Header: flags 0x54 = explicit subgroup and FIRST_OBJECT, alias 1, group 7, subgroup 2, priority 9.
const HEADER = [0x54, 1, 7, 2, 9];
const object = (delta: number, ...payload: number[]): number[] => [delta, payload.length, ...payload];

describe('subgroup framer', () => {
  it('reads the recording of a real draft 22 stream, and changes no byte', () => {
    expect(realStreams.size).toBeGreaterThan(3);
    let total = 0;
    for (const chunks of realStreams.values()) {
      const { objects, output } = runAll(createSubgroupFramer(22), chunks);
      expect(output).toEqual(concat(chunks));
      // The test stopped during the last stream, so it can have fewer.
      expect(objects.map((u) => u.moqt?.object)).toEqual([0, 1, 2, 3, 4].slice(0, objects.length));
      total += objects.length;
      expect(objects.every((u) => u.payload.length === 100)).toBe(true);
    }
    expect(total).toBe(26);
    const first = runAll(createSubgroupFramer(22), [...realStreams.values()][0] as Uint8Array<ArrayBuffer>[]);
    expect(first.objects[0]?.moqt).toEqual({ trackAlias: 0, group: 58, subgroup: 0, object: 0 });
  });

  it('gives the same objects for any split of the bytes', () => {
    const all = Uint8Array.from(concat([...realStreams.values()][0] as Uint8Array[]));
    for (const size of [1, 2, 3, 7, 101, all.length]) {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      for (let at = 0; at < all.length; at += size) chunks.push(all.slice(at, at + size));
      const { objects, output } = runAll(createSubgroupFramer(22), chunks);
      expect(objects.length).toBe(5);
      expect(output).toEqual([...all]);
    }
  });

  it('keeps later object IDs right after a drop', () => {
    const data = bytes(...HEADER, ...object(0, 10), ...object(0, 11), ...object(0, 12));
    const { output } = runAll(createSubgroupFramer(22), [data], (u) => (u.moqt?.object === 1 ? null : u.payload));
    expect(output).toEqual([...HEADER, ...object(0, 10), ...object(1, 12)]);
    const { objects } = runAll(createSubgroupFramer(22), [Uint8Array.from(output)]);
    expect(objects.map((u) => u.moqt?.object)).toEqual([0, 2]);
  });

  it('clears FIRST_OBJECT when the first object is dropped', () => {
    const data = bytes(...HEADER, ...object(0, 10), ...object(0, 11));
    const { output } = runAll(createSubgroupFramer(22), [data], (u) => (u.moqt?.object === 0 ? null : u.payload));
    expect(output).toEqual([0x14, 1, 7, 2, 9, ...object(1, 11)]);
  });

  it('states the subgroup ID when it was the ID of a dropped first object', () => {
    // 0x52: subgroup ID = first object ID. Objects 5 and 6.
    const data = bytes(0x52, 1, 7, 9, ...object(5, 10), ...object(0, 11));
    const kept = runAll(createSubgroupFramer(22), [data]);
    expect(kept.objects[1]?.moqt?.subgroup).toBe(5);
    const { output } = runAll(createSubgroupFramer(22), [data], (u) => (u.moqt?.object === 5 ? null : u.payload));
    expect(output).toEqual([0x14, 1, 7, 5, 9, ...object(6, 11)]);
  });

  it('sends the header alone when all objects are dropped', () => {
    const { output } = runAll(createSubgroupFramer(22), [bytes(...HEADER, ...object(0, 10))], () => null);
    expect(output).toEqual([0x14, 1, 7, 2, 9]);
  });

  it('writes the new length after an edit, and keeps properties', () => {
    // 0x55: with properties.
    const data = bytes(0x55, 1, 7, 2, 9, 0, 2, 0xaa, 0xbb, 1, 10);
    const { output } = runAll(createSubgroupFramer(22), [data], () => bytes(1, 2, 3));
    expect(output).toEqual([0x55, 1, 7, 2, 9, 0, 2, 0xaa, 0xbb, 3, 1, 2, 3]);
  });

  it('treats an edit to nothing as a drop', () => {
    const { output } = runAll(createSubgroupFramer(22), [bytes(...HEADER, ...object(0, 10))], () => new Uint8Array(0));
    expect(output).toEqual([0x14, 1, 7, 2, 9]);
  });

  it('sends a status object past the rules, with a right ID', () => {
    // Length 0, status 3.
    const data = bytes(...HEADER, ...object(0, 10), 0, 0, 3);
    const seen: (number | undefined)[] = [];
    const { output } = runAll(createSubgroupFramer(22), [data], (u) => {
      seen.push(u.moqt?.object);
      return null;
    });
    expect(seen).toEqual([0]);
    expect(output).toEqual([0x14, 1, 7, 2, 9, 1, 0, 3]);
  });

  it('keeps a varint that is longer than it needs to be', () => {
    const data = bytes(0x80, 0x54, 1, 7, 2, 9, 0x80, 0, 1, 10);
    expect(runAll(createSubgroupFramer(22), [data]).output).toEqual([...data]);
  });

  it('gives the bytes of a stream that ended inside an object', () => {
    const data = bytes(...HEADER, ...object(0, 10), 0, 5, 1, 2);
    const { objects, output } = runAll(createSubgroupFramer(22), [data]);
    expect(objects.length).toBe(1);
    expect(output).toEqual([...data]);
  });

  it.each([
    ['a fetch stream', [0x05, 1, 2, 3]],
    ['a reserved subgroup ID mode', [0x56, 1, 7, 9, 0, 1, 10]],
    ['flags above one byte', [0x80, 0x90, 1, 7, 9]],
    ['a padding stream', [...writeVarint(0x132b3e28), 0, 0]],
  ])('leaves %s as raw bytes', (_name, values) => {
    const data = Uint8Array.from(values);
    const { units, output } = runAll(createSubgroupFramer(22), [data, bytes(1, 2)]);
    expect(units.every((u) => u.moqt === null)).toBe(true);
    expect(output).toEqual([...data, 1, 2]);
  });

  it('stays raw when a value is too large to be exact', () => {
    const data = bytes(0x54, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 7, 2, 9);
    const { units, output } = runAll(createSubgroupFramer(22), [data]);
    expect(units.every((u) => u.moqt === null)).toBe(true);
    expect(output).toEqual([...data]);
  });

  it('stays raw when an object is too large to hold', () => {
    const data = bytes(...HEADER, 0, 0xf0, 0x10, 0, 0, 1, 1);
    const { objects, output } = runAll(createSubgroupFramer(22), [data]);
    expect(objects.length).toBe(0);
    expect(output).toEqual([...data]);
  });
});

describe('datagram framer', () => {
  it('reads the fields', () => {
    // 0x00: all fields present. Alias 1, group 2, object 3, priority 9.
    expect(parseObjectDatagram(bytes(0, 1, 2, 3, 9, 0xaa), 22)).toEqual({ info: { trackAlias: 1, group: 2, subgroup: null, object: 3 }, payloadAt: 5, lengthAt: null, status: false });
    // 0x0c: no object ID, no priority.
    expect(parseObjectDatagram(bytes(0x0c, 1, 2, 0xaa), 22)?.info.object).toBe(0);
    // 0x01: with properties.
    expect(parseObjectDatagram(bytes(1, 1, 2, 3, 9, 1, 0xee, 0xaa), 22)?.payloadAt).toBe(7);
  });

  it.each([
    ['bit 4', [0x10, 1, 2, 3, 9]],
    ['an unknown bit', [0x40, 1, 2, 3, 9]],
    ['STATUS with END_OF_GROUP', [0x22, 1, 2, 3, 9, 0]],
    ['properties of length 0', [1, 1, 2, 3, 9, 0]],
    ['properties past the end', [1, 1, 2, 3, 9, 5, 1]],
    ['too few bytes', [0]],
  ])('refuses %s', (_name, values) => {
    expect(parseObjectDatagram(Uint8Array.from(values), 22)).toBeNull();
  });

  it('changes only the payload', () => {
    const data = bytes(0, 1, 2, 3, 9, 0xaa);
    expect(runAll(createDatagramFramer(22), [data]).output).toEqual([...data]);
    expect(runAll(createDatagramFramer(22), [data], () => bytes(1, 2)).output).toEqual([0, 1, 2, 3, 9, 1, 2]);
    expect(runAll(createDatagramFramer(22), [data], () => null).output).toEqual([]);
  });

  it('passes a status datagram past the rules, and a padding datagram as raw', () => {
    const status = runAll(createDatagramFramer(22), [bytes(0x20, 1, 2, 3, 9, 3)], () => null);
    expect(status.output).toEqual([0x20, 1, 2, 3, 9, 3]);
    const padding = Uint8Array.from([...writeVarint(0x132b3e29), 0]);
    const raw = runAll(createDatagramFramer(22), [padding]);
    expect(raw.units[0]?.moqt).toBeNull();
    expect(raw.output).toEqual([...padding]);
  });
});

describe('vi64', () => {
  // The first rows are from Table 4 of draft 22.
  it.each([[0, [0]], [37, [0x25]], [127, [0x7f]], [128, [0x80, 0x80]], [15293, [0xbb, 0xbd]], [16384, [0xc0, 0x40, 0]], [494878333, [0xf0, 0x1d, 0x7f, 0x3e, 0x7d]]])('writes and reads %d', (value, out) => {
    expect([...writeVarint(value)]).toEqual(out);
    expect(readVarint(Uint8Array.from(out), 0)).toEqual({ value, next: out.length });
  });

  it('reads the longest form, and needs all its bytes', () => {
    expect(readVarint(bytes(0xff, 0, 0, 0, 0, 0, 0, 0, 9, 7), 0)).toEqual({ value: 9, next: 9 });
    expect(readVarint(bytes(0xff, 0, 0), 0)).toBeNull();
    expect(readVarint(bytes(0x80), 0)).toBeNull();
    expect(readVarint(bytes(), 0)).toBeNull();
  });

  it('reads any longer form of a value', () => {
    expect(readVarint(bytes(0xc0, 0, 0), 0)?.value).toBe(0);
  });
});
