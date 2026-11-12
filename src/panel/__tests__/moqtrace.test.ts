// The MIT conformance corpus of the .moqtrace format (see THIRD_PARTY_NOTICES.md): each file must read as its manifest says (ADR-46).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeCbor, moqtraceToMessages, readMoqtrace } from '../moqtrace';
import { PanelStore } from '../store';

const dir = join(__dirname, 'fixtures/trace-corpus');
interface Case {
  id: string;
  files: { name: string }[];
  version: number;
  segments: number;
  truncated: boolean;
  protocol: string;
  eventCount: number;
  eventTypes: Record<string, number>;
}
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { cases: Case[] };
const files = manifest.cases.flatMap((entry) => entry.files.map((file) => [`${entry.id}/${file.name}`, entry] as const));

describe('.moqtrace corpus', () => {
  it.each(files)('%s reads as the manifest says', (path, entry) => {
    const trace = readMoqtrace(readFileSync(join(dir, path)));
    if (!trace) throw new Error('not read');
    expect(trace.segments).toHaveLength(entry.segments);
    expect(trace.truncated).toBe(entry.truncated);
    expect(trace.segments[0]?.version).toBe(entry.version);
    expect(trace.segments[0]?.header.protocol).toBe(entry.protocol);
    const events = trace.segments.flatMap((segment) => segment.events);
    expect(events).toHaveLength(entry.eventCount);
    const types: Record<string, number> = {};
    for (const event of events) types[String(event.e)] = (types[String(event.e)] ?? 0) + 1;
    expect(types).toEqual(entry.eventTypes);
  });

  it.each(files)('%s becomes a session of the panel', (path) => {
    const trace = readMoqtrace(readFileSync(join(dir, path)));
    if (!trace) throw new Error('not read');
    const { messages, summary } = moqtraceToMessages(trace, 'import-1', path);
    const store = new PanelStore();
    for (const message of messages) store.handle(message);
    const session = [...store.sessions.values()][0];
    expect(session?.closed).not.toBeNull();
    expect(store.rows.length).toBe(Math.min(summary.objects + summary.controls, 5000));
  });

  it('refuses a file that is not a .moqtrace', () => {
    expect(readMoqtrace(new TextEncoder().encode('{"format":"sluice-trace"}'))).toBeNull();
  });

  it('reads CBOR: integers, text, bytes, arrays, maps, floats and indefinite lengths', () => {
    const value = decodeCbor(Uint8Array.of(0xa3, 0x61, 0x61, 0x19, 0x01, 0x00, 0x61, 0x62, 0x9f, 0x20, 0xf9, 0x3c, 0x00, 0xff, 0x61, 0x63, 0x42, 1, 2)).value;
    expect(value).toEqual({ a: 256, b: [-1, 1], c: Uint8Array.of(1, 2) });
  });
});
