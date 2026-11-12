// Runs the MIT test vectors (see THIRD_PARTY_NOTICES.md) on all drafts that Sluice can read.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OBJECT_DRAFTS } from '../../shared/rules';
import { createDatagramFramer, createSubgroupFramer, parseObjectDatagram, type ObjectFramer, type ObjectUnit } from '../moqt/objects';
import { parseServerSetup, versionFromOffer } from '../moqt/version';

interface VectorObject { object_id?: string; payload_hex?: string; payload?: string }
interface Vector {
  id: string;
  hex: string;
  error?: string;
  decoded?: { track_alias?: string; group_id?: string; subgroup_id?: string; object_id?: string; payload_hex?: string; objects?: VectorObject[] };
}

const root = new URL('./fixtures/ietf-object-vectors/', import.meta.url);
const load = (draft: string, name: string): Vector[] => {
  const file = new URL(`draft${draft}/${name}.json`, root);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { vectors: Vector[] }).vectors : [];
};
const fromHex = (hex: string): Uint8Array<ArrayBuffer> => Uint8Array.from((hex.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const toHex = (data: Uint8Array): string => [...data].map((b) => b.toString(16).padStart(2, '0')).join('');

function run(framer: ObjectFramer, chunks: Uint8Array<ArrayBuffer>[], decide: (unit: ObjectUnit) => Uint8Array<ArrayBuffer> | null = (u) => u.payload) {
  const units: ObjectUnit[] = [];
  const out: string[] = [];
  const take = (list: ObjectUnit[]): void => {
    for (const unit of list) {
      units.push(unit);
      const rendered = unit.render(unit.bypass ? unit.payload : decide(unit));
      if (rendered) out.push(toHex(rendered));
    }
  };
  for (const chunk of chunks) take(framer.push(chunk));
  take(framer.end());
  return { objects: units.filter((u) => u.moqt), output: out.join('') };
}

const drafts = readdirSync(root).filter((name) => name.startsWith('draft')).map((name) => name.slice(5));

it('has vectors for each draft that Sluice can read', () => {
  expect(drafts.map(Number)).toEqual([...OBJECT_DRAFTS]);
});

describe.each(drafts)('draft %s', (name) => {
  const draft = Number(name);

  const subgroups = load(name, 'subgroup');
  const good = subgroups.filter((v) => v.decoded?.objects);
  it('has subgroup vectors', () => {
    expect(good.length).toBeGreaterThan(0);
  });

  it.each(good.map((v) => [v.id, v] as const))('subgroup %s: fields, and the same bytes', (_id, vector) => {
    const data = fromHex(vector.hex);
    const { objects, output } = run(createSubgroupFramer(draft), [data]);
    expect(output).toBe(vector.hex.toLowerCase());
    const expected = vector.decoded?.objects ?? [];
    expect(objects.map((u) => String(u.moqt?.object))).toEqual(expected.map((o) => o.object_id));
    expect(objects.map((u) => toHex(u.payload))).toEqual(expected.map((o) => o.payload_hex ?? ''));
    if (objects[0]) {
      expect(String(objects[0].moqt?.trackAlias)).toBe(vector.decoded?.track_alias);
      expect(String(objects[0].moqt?.group)).toBe(vector.decoded?.group_id);
      if (vector.decoded?.subgroup_id !== undefined) expect(String(objects[0].moqt?.subgroup)).toBe(vector.decoded.subgroup_id);
    }
  });

  it.each(good.map((v) => [v.id, v] as const))('subgroup %s: byte by byte', (_id, vector) => {
    const data = fromHex(vector.hex);
    const chunks = [...data].map((byte) => Uint8Array.of(byte));
    const { objects, output } = run(createSubgroupFramer(draft), chunks);
    expect(output).toBe(vector.hex.toLowerCase());
    expect(objects.length).toBe(vector.decoded?.objects?.length);
  });

  const several = good.filter((v) => (v.decoded?.objects?.length ?? 0) > 1);
  it.each(several.map((v) => [v.id, v] as const))('subgroup %s: after a drop, the app reads right IDs', (_id, vector) => {
    const all = vector.decoded?.objects ?? [];
    const ids = all.map((o) => o.object_id);
    // An object status skips the rules, so only objects with a payload can be dropped.
    for (const dropped of all.filter((o) => o.payload_hex).map((o) => o.object_id)) {
      const { output } = run(createSubgroupFramer(draft), [fromHex(vector.hex)], (u) => (String(u.moqt?.object) === dropped ? null : u.payload));
      const again = run(createSubgroupFramer(draft), [fromHex(output)]);
      expect(again.objects.map((u) => String(u.moqt?.object))).toEqual(ids.filter((id) => id !== dropped));
      if (vector.decoded?.subgroup_id !== undefined && again.objects[0]) {
        expect(String(again.objects[0].moqt?.subgroup)).toBe(vector.decoded.subgroup_id);
      }
    }
  });

  it.each(subgroups.filter((v) => v.error).map((v) => [v.id, v] as const))('subgroup %s: not valid, and the bytes do not change', (_id, vector) => {
    expect(run(createSubgroupFramer(draft), [fromHex(vector.hex)]).output).toBe(vector.hex.toLowerCase());
  });

  const datagrams = [...load(name, 'datagram'), ...load(name, 'datagram-status')];
  it.each(datagrams.filter((v) => v.decoded).map((v) => [v.id, v] as const))('datagram %s: fields, and the same bytes', (_id, vector) => {
    const data = fromHex(vector.hex);
    const parsed = parseObjectDatagram(data, draft);
    expect(parsed).not.toBeNull();
    expect(String(parsed?.info.trackAlias)).toBe(vector.decoded?.track_alias);
    expect(String(parsed?.info.group)).toBe(vector.decoded?.group_id);
    expect(String(parsed?.info.object)).toBe(vector.decoded?.object_id ?? '0');
    if (!parsed?.status) expect(toHex(data.subarray(parsed?.payloadAt))).toBe(vector.decoded?.payload_hex ?? '');
    expect(run(createDatagramFramer(draft), [data]).output).toBe(vector.hex.toLowerCase());
  });

  it.each(datagrams.filter((v) => v.error).map((v) => [v.id, v] as const))('datagram %s: not valid, and the bytes do not change', (_id, vector) => {
    expect(run(createDatagramFramer(draft), [fromHex(vector.hex)]).output).toBe(vector.hex.toLowerCase());
  });
});

describe('finding the draft', () => {
  it.each([
    [7, '40410cc0000000ff00000701000103'],
    [8, '404109c0000000ff00000800'],
    [9, '404109c0000000ff00000900'],
    [10, '404109c0000000ff00000a00'],
    [11, '210009c0000000ff00000b00'],
    [12, '210009c0000000ff00000c00'],
    [14, '210009c0000000ff00000e00'],
  ])('reads draft %d from the SERVER_SETUP of the vectors', (draft, hex) => {
    expect(parseServerSetup(fromHex(hex))).toEqual({ draft, source: 'setup' });
  });

  it('uses the protocol that the page offered, only if it is one', () => {
    expect(versionFromOffer(['moqt-16'])).toEqual({ draft: 16, source: 'protocol' });
    expect(versionFromOffer(['moqt-16', 'moqt-18'])).toBeNull();
    expect(versionFromOffer(['moq-00'])).toBeNull();
    expect(versionFromOffer(undefined)).toBeNull();
    expect(versionFromOffer('moqt-16')).toBeNull();
  });
});
