import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PanelMessage, TraceFile, TrafficItem } from '../../shared/protocol';
import { canExportMoqtrace, encodeCbor, traceToMoqtrace } from '../moqtrace-export';
import { decodeCbor, moqtraceToMessages, readMoqtrace } from '../moqtrace';

const b64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes));
const text = (value: string): number[] => [value.length, ...Array.from(value, (c) => c.charCodeAt(0))];

/** moq-lite 4 (no timescale): a SUBSCRIBE stream, and a group with one frame of one byte. */
const subscribe = (id: number, track: string): number[] => {
  const body = [id, ...text('live'), ...text(track), 0];
  return [2, body.length, ...body];
};
const group = (id: number, sequence: number, payload: number): number[] => [0, 2, id, sequence, 1, payload];

const lite: TraceFile = {
  format: 'sluice-trace',
  version: 1,
  url: 'https://relay.test:4443/moq/path?jwt=secret',
  protocol: 'moq-lite-04',
  startedAt: 1_767_225_600_000,
  close: { t: 900.4, closeCode: 7, reason: 'bye' },
  events: [
    { t: 0, kind: 'bidi', streamId: 1, origin: 'local', data: null, fin: false, sent: b64(subscribe(0, 'video')) },
    { t: 1.6, kind: 'bidi', streamId: 1, origin: 'local', data: b64([0x56]), fin: false },
    { t: 30, kind: 'uni', streamId: 3, origin: 'remote', data: b64(group(0, 7, 0x76)), fin: true },
    { t: 40, kind: 'uni', streamId: 7, origin: 'remote', data: b64(group(0, 8, 0x77)), fin: false },
  ],
};

const objectsOf = (messages: PanelMessage[]): TrafficItem[] =>
  messages.flatMap((message) => {
    const inner = message.type === 'frame-message' ? message.payload.message : null;
    return inner?.type === 'traffic' ? inner.payload.items.filter((item) => item.moqt) : [];
  });

describe('CBOR writer', () => {
  it('writes what the reader reads back, also numbers past 2^32 and 2^53', () => {
    const value = { a: 0, b: 23, c: 24, d: 255, e: 65_536, f: 2 ** 32 + 5, g: 2n ** 62n, h: -3, i: 'text ü', j: new Uint8Array([1, 2]), k: [true, false, []], l: {} };
    const { value: back, next } = decodeCbor(encodeCbor(value));
    const bytes = encodeCbor(value);
    expect(next).toBe(bytes.length);
    expect(back).toEqual({ ...value, g: 2n ** 62n });
  });

  it('refuses a number that is not whole, as the format asks for integers', () => {
    expect(() => encodeCbor({ t: 1.5 })).toThrow();
  });
});

describe('.moqtrace export (ADR-57)', () => {
  it('writes a moq-lite recording that the reader turns back into the same tracks, objects and close', () => {
    const file = traceToMoqtrace(lite);
    expect(file).not.toBeNull();
    const read = readMoqtrace(file as Uint8Array);
    expect(read?.segments).toHaveLength(1);
    const segment = read?.segments[0];
    expect(segment?.version).toBe(2);
    expect(segment?.header).toMatchObject({ protocol: 'moq-lite-04', perspective: 'client', detail: 'full', startTime: 1_767_225_600_000, endTime: 1_767_225_600_900, endpoint: 'relay.test:4443', source: 'sluice' });
    // Times are whole ms, and events are numbered in order.
    expect(segment?.events.map((event) => event.n)).toEqual(segment?.events.map((_, i) => i));
    expect(segment?.events.every((event) => Number.isInteger(event.t))).toBe(true);
    const { messages, summary } = moqtraceToMessages(read as NonNullable<typeof read>, 'doc', 'x.moqtrace');
    expect(summary.objects).toBe(2);
    expect(summary.controls).toBe(1);
    const objects = objectsOf(messages);
    expect(objects.map((item) => [item.moqt?.track, item.moqt?.group, item.moqt?.object, item.byteLength])).toEqual([
      ['video', 7, 0, 1],
      ['video', 8, 0, 1],
    ]);
    const closed = messages.at(-1);
    expect(closed?.type === 'frame-message' && closed.payload.message.type === 'session-closed' ? closed.payload.message.payload : null).toMatchObject({ closeCode: 7, reason: 'bye' });
  });

  it('never writes the path or the query of the URL, where a token can be', () => {
    const file = traceToMoqtrace(lite) as Uint8Array;
    const all = new TextDecoder().decode(file);
    expect(all).not.toContain('secret');
    expect(all).not.toContain('/moq/path');
  });

  it('keeps the whole payload of each object', () => {
    const big = Array.from({ length: 300 }, (_, i) => i & 0xff);
    const trace: TraceFile = { ...lite, events: [lite.events[0] as TraceFile['events'][number], { t: 5, kind: 'uni', streamId: 3, origin: 'remote', data: b64([0, 2, 0, 1, 0x41, 0x2c, ...big]), fin: true }] };
    const segment = readMoqtrace(traceToMoqtrace(trace) as Uint8Array)?.segments[0];
    const payload = segment?.events.find((event) => event.e === 4);
    expect(payload?.sz).toBe(300);
    expect([...(payload?.pl as Uint8Array)]).toEqual(big);
  });

  it('opens a stream with its track when the first frame comes in several chunks', () => {
    const trace: TraceFile = {
      ...lite,
      events: [
        lite.events[0] as TraceFile['events'][number],
        { t: 5, kind: 'uni', streamId: 3, origin: 'remote', data: b64([0, 2, 0, 1, 3, 0x61]), fin: false },
        { t: 6, kind: 'uni', streamId: 3, origin: 'remote', data: b64([0x62, 0x63]), fin: true },
      ],
    };
    const read = readMoqtrace(traceToMoqtrace(trace) as Uint8Array);
    expect(read?.segments[0]?.events.find((event) => event.e === 1)).toMatchObject({ sid: 3, ta: 0, g: 1 });
    const objects = objectsOf(moqtraceToMessages(read as NonNullable<typeof read>, 'doc', 'x').messages);
    expect(objects.map((item) => [item.moqt?.track, item.byteLength])).toEqual([['video', 3]]);
  });

  it('writes the control messages of IETF MoQT with the fields that Sluice reads (draft 16)', () => {
    const u16 = (n: number): number[] => [n >> 8, n & 0xff];
    const subBody = [1, 1, ...text('live'), ...text('video'), 0x80];
    const okBody = [1, 9];
    const trace: TraceFile = {
      format: 'sluice-trace',
      version: 1,
      url: 'https://relay.test/moq',
      protocol: 'moqt-16',
      close: null,
      events: [
        { t: 0, kind: 'bidi', streamId: 0, origin: 'local', data: null, fin: false, sent: b64([3, ...u16(subBody.length), ...subBody]) },
        { t: 3, kind: 'bidi', streamId: 0, origin: 'local', data: b64([4, ...u16(okBody.length), ...okBody]), fin: false },
      ],
    };
    expect(canExportMoqtrace(trace)).toBe(true);
    const segment = readMoqtrace(traceToMoqtrace(trace) as Uint8Array)?.segments[0];
    expect(segment?.header.protocol).toBe('moq-transport-16');
    const controls = segment?.events.filter((event) => event.e === 0) ?? [];
    expect(controls.map((event) => [event.d, event.mt, event.msg])).toEqual([
      [0, 3, { request_id: 1, track_namespace: ['live'], track_name: 'video' }],
      [1, 4, { request_id: 1, track_alias: 9 }],
    ]);
    expect(controls[1]?.t).toBe(3);
    expect([...(controls[1]?.raw as Uint8Array)]).toEqual([4, 0, 2, 1, 9]);
  });

  it('writes a real draft-22 recording: streams, objects with their group, and stream ends', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../inject/__tests__/fixtures/draft22-subgroup-recording.json', import.meta.url), 'utf8')) as TraceFile;
    const trace = { ...fixture, protocol: 'moqt-22' };
    const read = readMoqtrace(traceToMoqtrace(trace) as Uint8Array);
    const events = read?.segments[0]?.events ?? [];
    const payloads = events.filter((event) => event.e === 4);
    expect(payloads.length).toBeGreaterThan(5);
    expect(events.filter((event) => event.e === 3)).toHaveLength(payloads.length);
    expect(events.some((event) => event.e === 2)).toBe(true);
    const { summary } = moqtraceToMessages(read as NonNullable<typeof read>, 'doc', 'x');
    expect(summary.objects).toBe(payloads.length);
  });

  it('gives datagrams IDs from 2^62 up, as the format asks', () => {
    // Draft 16 object datagram: type 0x00, alias 9, group 8, object 0, priority, payload.
    const trace: TraceFile = { format: 'sluice-trace', version: 1, url: 'https://relay.test/moq', protocol: 'moqt-16', close: null, events: [{ t: 1, kind: 'datagram', streamId: null, origin: 'remote', data: b64([0x00, 9, 8, 0, 0x80, 0x61]), fin: false }] };
    const events = readMoqtrace(traceToMoqtrace(trace) as Uint8Array)?.segments[0]?.events ?? [];
    const open = events.find((event) => event.e === 1);
    expect(open).toMatchObject({ sid: 2n ** 62n, st: 1, ta: 9, g: 8 });
    expect(events.find((event) => event.e === 4)?.sid).toBe(2n ** 62n);
  });

  it('takes the version from the protocol that the page offered, when the server chose none', () => {
    const offered: TraceFile = { ...lite, offered: 'moq-lite-04' };
    delete offered.protocol;
    expect(canExportMoqtrace(offered)).toBe(true);
    expect(readMoqtrace(traceToMoqtrace(offered) as Uint8Array)?.segments[0]?.header.protocol).toBe('moq-lite-04');
  });

  it('writes nothing for a session that is not MoQ', () => {
    const trace: TraceFile = { format: 'sluice-trace', version: 1, url: 'https://echo.test/', protocol: 'echo', close: null, events: [{ t: 1, kind: 'datagram', streamId: null, origin: 'remote', data: b64([1]), fin: false }] };
    expect(canExportMoqtrace(trace)).toBe(false);
    expect(traceToMoqtrace(trace)).toBeNull();
  });

  it('a recording with no start time takes the time of the export', () => {
    const old: TraceFile = { ...lite };
    delete old.startedAt;
    const before = Date.now();
    const start = readMoqtrace(traceToMoqtrace(old) as Uint8Array)?.segments[0]?.header.startTime as number;
    expect(start).toBeGreaterThanOrEqual(before);
  });
});
