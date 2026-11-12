import { describe, expect, it } from 'vitest';
import { parsePanelRequest, parseRuntimeMessage, parseTrace, type TraceEvent, type TraceFile } from '../../shared/protocol';
import { createRecorder, MAX_HEAD_BYTES, MAX_HEAD_GAP_MS, MAX_RECORD_BYTES } from '../recorder';
import { createReplaySession } from '../replay';
import { install as patchInstall, type Runtime } from '../patch';
import { createMockWebTransport } from './mock-webtransport';

const event = (t: number, kind: TraceEvent['kind'], streamId: number | null, data: string | null, fin = false, origin: TraceEvent['origin'] = 'remote'): TraceEvent => ({
  t, kind, streamId, origin, data: data === null ? null : btoa(data), fin,
});
const file = (events: TraceEvent[], close: TraceFile['close'] = null): TraceFile => ({ format: 'sluice-trace', version: 1, url: 'https://a.test/x', close, events });
const env = { setTimeout, clearTimeout, now: () => performance.now() };
const text = (value: unknown): string => new TextDecoder().decode(value as Uint8Array);

describe('replay session', () => {
  it('plays datagrams and a uni stream, then the recorded close', async () => {
    const session = createReplaySession(file([event(0, 'datagram', null, 'a'), event(1, 'uni', 7, 'b'), event(2, 'uni', 7, null, true)], { t: 5, closeCode: 3, reason: 'bye' }), env);
    await session.ready;
    const datagrams = session.datagrams.readable.getReader();
    expect(text((await datagrams.read()).value)).toBe('a');
    const { value } = await (session.incomingUnidirectionalStreams.getReader().read() as Promise<{ value: ReadableStream }>);
    const reader = value.getReader();
    expect(text((await reader.read()).value)).toBe('b');
    expect((await reader.read()).done).toBe(true);
    expect(await session.closed).toEqual({ closeCode: 3, reason: 'bye' });
    expect((await datagrams.read()).done).toBe(true);
  });

  it('gives local streams in the recorded order, and writes go nowhere', async () => {
    const session = createReplaySession(file([event(0, 'bidi', 4, 'first', false, 'local'), event(1, 'bidi', 9, 'second', false, 'local')]), env);
    const a = session.createBidirectionalStream();
    const b = session.createBidirectionalStream();
    const writer = a.writable.getWriter();
    await writer.write(new Uint8Array(1));
    expect(text((await a.readable.getReader().read()).value)).toBe('first');
    expect(text((await b.readable.getReader().read()).value)).toBe('second');
    session.close();
  });

  it('the app closing stops the timers and closes all', async () => {
    const session = createReplaySession(file([event(60_000, 'datagram', null, 'late')]), env);
    const reader = session.datagrams.readable.getReader();
    session.close({ closeCode: 1, reason: 'x' });
    expect((await reader.read()).done).toBe(true);
    expect(await session.closed).toEqual({ closeCode: 1, reason: 'x' });
  });
});

describe('recorder', () => {
  const session = { id: 1, url: 'https://a.test/', startedAt: 0 };
  it('keeps the start and a copy of what comes while on, and stops at the limit', () => {
    const recorder = createRecorder(() => 5);
    const base = { kind: 'datagram', streamId: null, origin: 'remote', fin: false } as const;
    recorder.add(session, { ...base, data: Uint8Array.of(1) });
    recorder.start();
    const data = Uint8Array.of(2);
    recorder.add(session, { ...base, data });
    expect(data.byteLength).toBe(1);
    recorder.add(session, { ...base, data: new Uint8Array(MAX_RECORD_BYTES) });
    recorder.sessionClosed(session, { closeCode: 4, reason: 'r' });
    const out = recorder.stop();
    expect(out.events).toHaveLength(2);
    expect(out.events[0]).toMatchObject({ t: 5, data: Uint8Array.of(1) });
    expect(out.events[1]).toMatchObject({ data: Uint8Array.of(2) });
    expect(out.truncated).toBe(true);
    expect(out.sessions[0]?.close).toMatchObject({ closeCode: 4, reason: 'r' });
    expect(recorder.on).toBe(false);
  });
});

describe('trace checks', () => {
  it('a file from anywhere must be a valid recording', () => {
    expect(parseTrace(file([event(0, 'datagram', null, 'a')])).ok).toBe(true);
    expect(parseTrace({ ...file([]), format: 'x' }).ok).toBe(false);
    expect(parseTrace({ ...file([]), url: 'javascript:alert(1)' }).ok).toBe(false);
    expect(parseTrace(file([event(0, 'datagram', 3, 'a')])).ok).toBe(false);
    expect(parseTrace(file([{ ...event(0, 'uni', 1, 'a'), data: '!' }])).ok).toBe(false);
    expect(parseTrace({ ...file([]), startedAt: 1_767_225_600_000 }).ok).toBe(true);
    expect(parseTrace({ ...file([]), startedAt: -1 }).ok).toBe(false);
    expect(parseTrace({ ...file([]), startedAt: 1.5 }).ok).toBe(false);
    expect(parseTrace({ ...file([]), offered: 'moq-lite-04' }).ok).toBe(true);
    expect(parseTrace({ ...file([]), offered: 4 }).ok).toBe(false);
  });
  it('a page cannot send commands as a report, and the panel sends only what it may', () => {
    const wrap = (type: string, payload: unknown) => ({ v: 1, type, id: 1, payload });
    expect(parseRuntimeMessage(wrap('record', { recordId: 1, on: true })).ok).toBe(false);
    expect(parseRuntimeMessage(wrap('replay-started', { url: 'https://a.test/' })).ok).toBe(true);
    expect(parsePanelRequest(wrap('record', { recordId: 1, on: true })).ok).toBe(true);
    expect(parsePanelRequest(wrap('replay-clear', {})).ok).toBe(true);
    expect(parsePanelRequest(wrap('replay-arm', { replayId: 1, url: 'https://a.test/', close: null, events: [event(0, 'datagram', null, 'a')], last: true })).ok).toBe(true);
  });
});

describe('a replay of a MoQ player (ADR-33)', () => {
  const trace = (events: TraceFile['events'], url = 'https://relay.test/moq'): TraceFile => ({
    format: 'sluice-trace',
    version: 1,
    url,
    protocol: 'moq-lite-06',
    close: null,
    events,
  });
  const env = { setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id), now: () => Date.now() };
  const b64 = (...bytes: number[]): string => btoa(String.fromCharCode(...bytes));

  it('gives the app its streams in the order of opening, also those with no answer', async () => {
    const session = createReplaySession(
      trace([
        { t: 0, kind: 'bidi', streamId: 5, origin: 'local', data: null, fin: false },
        { t: 0, kind: 'bidi', streamId: 6, origin: 'local', data: null, fin: false },
        { t: 0, kind: 'bidi', streamId: 7, origin: 'local', data: null, fin: false },
        { t: 1, kind: 'bidi', streamId: 7, origin: 'local', data: b64(7), fin: false },
        { t: 2, kind: 'bidi', streamId: 5, origin: 'local', data: b64(5), fin: false },
      ]),
      env,
    );
    const first = session.createBidirectionalStream().readable.getReader();
    session.createBidirectionalStream();
    const third = session.createBidirectionalStream().readable.getReader();
    expect([...((await first.read()).value as Uint8Array)]).toEqual([5]);
    expect([...((await third.read()).value as Uint8Array)]).toEqual([7]);
    session.close();
  });

  function install(armed: TraceFile) {
    const kit = createMockWebTransport();
    const scope: { WebTransport?: typeof WebTransport } = {};
    Object.defineProperty(scope, 'WebTransport', { value: kit.Native, writable: true, configurable: true });
    const runtime = patchInstall(scope, { random: () => 0.5, log: () => undefined }) as Runtime;
    runtime.armReplay(armed);
    return { kit, Sluice: scope.WebTransport as typeof WebTransport };
  }

  it('plays on a session with another token, and gives the recorded protocol', () => {
    const { kit, Sluice } = install(trace([]));
    const session = new Sluice('https://relay.test/moq?jwt=new') as WebTransport & { protocol: string };
    expect(session.protocol).toBe('moq-lite-06');
    expect(kit.sessions[0]?.url).toBe('https://127.0.0.1:9/');
  });

  it('plays behind another tool that patched first, with its own method on the object', async () => {
    const kit = createMockWebTransport();
    function Foreign(url: string, options?: WebTransportOptions): object {
      const instance = new kit.Native(url, options) as unknown as Record<string, unknown>;
      instance.createBidirectionalStream = () => Promise.reject(new Error('The WebTransport connection is not open.'));
      instance.createUnidirectionalStream = () => Promise.reject(new Error('The WebTransport connection is not open.'));
      return instance;
    }
    Foreign.prototype = kit.Native.prototype;
    const scope: { WebTransport?: typeof WebTransport } = {};
    Object.defineProperty(scope, 'WebTransport', { value: Foreign, writable: true, configurable: true });
    const runtime = patchInstall(scope, { random: () => 0.5, log: () => undefined }) as Runtime;
    runtime.armReplay(trace([{ t: 0, kind: 'bidi', streamId: 5, origin: 'local', data: b64(5), fin: false }]));
    const session = new (scope.WebTransport as typeof WebTransport)('https://relay.test/moq?jwt=new');
    const stream = await session.createBidirectionalStream();
    await session.createUnidirectionalStream();
    expect([...((await stream.readable.getReader().read()).value as Uint8Array)]).toEqual([5]);
    const stats = await (session as unknown as { getStats(): Promise<{ bytesSent: number }> }).getStats();
    expect(stats.bytesSent).toBe(0);
  });

  it('says when it ends, and keeps the session open', async () => {
    let ended = 0;
    const replay = createReplaySession(trace([{ t: 0, kind: 'datagram', streamId: null, origin: 'remote', data: b64(1), fin: false }]), { ...env, onEnd: () => ended++ });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ended).toBe(1);
    expect(replay.progress().ended).toBe(true);
    let closed = false;
    void replay.closed.then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    replay.close();
  });

  function installWith(armed: TraceFile, end: 'hold' | 'loop' | 'live') {
    const kit = createMockWebTransport();
    const scope: { WebTransport?: typeof WebTransport } = {};
    Object.defineProperty(scope, 'WebTransport', { value: kit.Native, writable: true, configurable: true });
    const runtime = patchInstall(scope, { random: () => 0.5, log: () => undefined }) as Runtime;
    runtime.armReplay(armed, { end, overlay: false });
    return { kit, runtime, Sluice: scope.WebTransport as typeof WebTransport };
  }

  it.each([
    ['hold', ['https://127.0.0.1:9/', 'https://127.0.0.1:9/']],
    ['loop', ['https://127.0.0.1:9/', 'https://127.0.0.1:9/']],
    ['live', ['https://127.0.0.1:9/', 'https://relay.test/moq?jwt=b']],
  ] as const)('with %s at the end, a second session goes to %j', (end, urls) => {
    const { kit, Sluice } = installWith(trace([]), end);
    new Sluice('https://relay.test/moq?jwt=a');
    new Sluice('https://relay.test/moq?jwt=b');
    expect(kit.sessions.map((s) => s.url)).toEqual(urls);
  });

  it('with hold, a new session of the app plays the recording again, not nothing', async () => {
    const { Sluice } = installWith(trace([{ t: 0, kind: 'bidi', streamId: 5, origin: 'local', data: b64(9), fin: false }]), 'hold');
    const read = async (session: WebTransport): Promise<number[]> => {
      const reader = (await session.createBidirectionalStream()).readable.getReader();
      return [...((await reader.read()).value as Uint8Array)];
    };
    const one = new Sluice('https://relay.test/moq?jwt=a');
    expect(await read(one)).toEqual([9]);
    const two = new Sluice('https://relay.test/moq?jwt=b');
    expect(await read(two)).toEqual([9]);
    one.close();
    two.close();
  });

  it('keeps one box on the page for all sessions that play, and removes it when the last one stops', async () => {
    const hosts: { removed: boolean }[] = [];
    const element = (): object => ({
      style: {},
      textContent: '',
      attachShadow: () => ({ append: () => undefined }),
      append: () => undefined,
      remove(this: { removed: boolean }) {
        this.removed = true;
      },
    });
    const fake = {
      documentElement: { append: (host: { removed: boolean }) => hosts.push(host) },
      createElement: () => ({ ...element(), removed: false }),
    };
    const scopeDoc = globalThis as { document?: unknown };
    scopeDoc.document = fake;
    try {
      const kit = createMockWebTransport();
      const scope: { WebTransport?: typeof WebTransport } = {};
      Object.defineProperty(scope, 'WebTransport', { value: kit.Native, writable: true, configurable: true });
      const runtime = patchInstall(scope, { random: () => 0.5, log: () => undefined }) as Runtime;
      runtime.armReplay(trace([]), { end: 'hold', overlay: true });
      const Sluice = scope.WebTransport as typeof WebTransport;
      const one = new Sluice('https://relay.test/moq?jwt=a');
      const two = new Sluice('https://relay.test/moq?jwt=b');
      expect(hosts).toHaveLength(1);
      one.close();
      await one.closed;
      expect(hosts[0]?.removed).toBe(false);
      two.close();
      await two.closed;
      expect(hosts[0]?.removed).toBe(true);
    } finally {
      delete scopeDoc.document;
    }
  });

  it('stops: the session that plays closes, and the next one goes live', async () => {
    const { kit, runtime, Sluice } = installWith(trace([]), 'hold');
    const playing = new Sluice('https://relay.test/moq?jwt=a');
    runtime.armReplay(null);
    const info = await playing.closed;
    expect(info.reason).toBe('Sluice stopped the replay');
    new Sluice('https://relay.test/moq?jwt=b');
    expect(kit.sessions.at(-1)?.url).toBe('https://relay.test/moq?jwt=b');
  });

  it('stays live for another place', () => {
    const { kit, Sluice } = install(trace([]));
    new Sluice('https://relay.test/other?jwt=new');
    expect(kit.sessions[0]?.url).toBe('https://relay.test/other?jwt=new');
  });
});

describe('recording an open session (ADR-34)', () => {
  const session = { id: 1, url: 'https://x/', startedAt: 0 };
  const bytes = (n: number): Uint8Array<ArrayBuffer> => new Uint8Array(n);
  const add = (recorder: ReturnType<typeof createRecorder>, data: Uint8Array<ArrayBuffer> | null, streamId = 1): void =>
    recorder.add(session, { kind: 'uni', streamId, origin: 'remote', data, fin: false });

  it('holds the start of the session, then what came next, with no long wait', () => {
    let time = 0;
    const recorder = createRecorder(() => time);
    add(recorder, bytes(4));
    time = 10;
    add(recorder, bytes(4));
    time = 1000;
    add(recorder, bytes(4)); // Past the point that a recording sees, and in the start.
    time = 5000;
    recorder.start();
    time = 5100;
    add(recorder, bytes(4), 2);
    const { events } = recorder.stop();
    // The start plays with gaps of at most MAX_HEAD_GAP_MS, so the media does not wait (ADR-39).
    expect(events.map((e) => e.t)).toEqual([0, 10, 10 + MAX_HEAD_GAP_MS, 10 + MAX_HEAD_GAP_MS + 100]);
    expect(events.map((e) => e.streamId)).toEqual([1, 1, 1, 2]);
  });

  it('keeps whole streams of the start only, and uses it for the next recording', () => {
    const recorder = createRecorder(() => 0);
    recorder.add(session, { kind: 'uni', streamId: 1, origin: 'remote', data: bytes(4), fin: true });
    recorder.add(session, { kind: 'uni', streamId: 2, origin: 'remote', data: bytes(MAX_HEAD_BYTES), fin: false });
    recorder.start();
    // Stream 2 did not fit, so the rest of it is not wanted either.
    recorder.add(session, { kind: 'uni', streamId: 2, origin: 'remote', data: bytes(1), fin: true });
    expect(recorder.stop().events.map((e) => e.streamId)).toEqual([1]);
    recorder.start();
    expect(recorder.stop().events.map((e) => e.streamId)).toEqual([1]);
  });

  it('keeps no media in the start, and skips a media stream that began before the recording (ADR-35)', () => {
    const recorder = createRecorder(() => 0);
    recorder.add(session, { kind: 'bidi', streamId: 1, origin: 'local', data: bytes(2), fin: false });
    recorder.add(session, { kind: 'uni', streamId: 2, origin: 'remote', data: bytes(9), fin: false }, true);
    recorder.start();
    recorder.add(session, { kind: 'uni', streamId: 2, origin: 'remote', data: bytes(9), fin: true }, true);
    recorder.add(session, { kind: 'uni', streamId: 3, origin: 'remote', data: bytes(9), fin: false }, true);
    recorder.add(session, { kind: 'bidi', streamId: 1, origin: 'local', data: bytes(2), fin: false });
    expect(recorder.stop().events.map((e) => e.streamId)).toEqual([1, 3, 1]);
  });

  it('lets go of a session that closed', () => {
    const recorder = createRecorder(() => 0);
    add(recorder, bytes(1));
    recorder.sessionClosed(session, { closeCode: 0, reason: '' });
    recorder.start();
    expect(recorder.stop().events.length).toBe(0);
  });
});

describe('the summary of a recording (ADR-37)', () => {
  const session = { id: 1, url: 'https://x/', startedAt: 0 };
  const uni = (streamId: number) => ({ kind: 'uni', streamId, origin: 'remote' });

  it('counts groups, frames, key frames and media time of each track, from Start to Stop', () => {
    let time = 0;
    const recorder = createRecorder(() => time);
    recorder.start();
    recorder.add(session, { kind: 'uni', streamId: 1, origin: 'remote', data: new Uint8Array(4), fin: false });
    recorder.note(1, uni(1), { track: 'video', trackAlias: 0, group: 7, key: true, mediaUs: 0 }, 100);
    recorder.note(1, uni(1), { track: 'video', trackAlias: 0, group: 7, mediaUs: 40_000 }, 50);
    recorder.note(1, uni(2), { track: 'video', trackAlias: 0, group: 8, key: true, mediaUs: 2_000_000 }, 100);
    recorder.note(1, uni(3), { track: 'audio', trackAlias: 1, group: 3 }, 10);
    time = 10_000;
    const { sessions } = recorder.stop();
    expect(sessions[0]?.summary).toEqual({
      recordedMs: 10_000,
      tracks: [
        { name: 'video', groups: 2, firstGroup: 7, lastGroup: 8, frames: 3, keyframes: 2, bytes: 250, mediaMs: 2000, alias: 0 },
        { name: 'audio', groups: 1, firstGroup: 3, lastGroup: 3, frames: 1, keyframes: 0, bytes: 10, alias: 1 },
      ],
    });
  });

  it('does not count objects while it does not record', () => {
    const recorder = createRecorder(() => 0);
    recorder.note(1, uni(1), { track: 'video', trackAlias: 0, group: 1 }, 1);
    recorder.start();
    recorder.add(session, { kind: 'uni', streamId: 2, origin: 'remote', data: new Uint8Array(1), fin: false });
    expect(recorder.stop().sessions[0]?.summary?.tracks).toEqual([]);
  });

  it('a file keeps its summary, and a bad summary is refused', () => {
    const file = { format: 'sluice-trace', version: 1, url: 'https://x/', close: null, events: [], summary: { recordedMs: 5, tracks: [] } };
    expect(parseTrace(file).ok).toBe(true);
    expect(parseTrace({ ...file, summary: { recordedMs: 'x', tracks: [] } }).ok).toBe(false);
  });
});

describe('a replay answers the requests of the app (ADR-43)', () => {
  const env = { setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id), now: () => Date.now() };
  const b64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes));
  const text = (value: string): number[] => [value.length, ...Array.from(value, (c) => c.charCodeAt(0))];
  const subscribe = (id: number, track: string): number[] => {
    const body = [id, ...text('b'), ...text(track), 0];
    return [2, body.length, ...body];
  };
  const group = (id: number, sequence: number, payload: number): number[] => [0, 2, id, sequence, 1, payload];
  const trace: TraceFile = {
    format: 'sluice-trace',
    version: 1,
    url: 'https://relay.test/moq',
    protocol: 'moq-lite-06',
    close: null,
    events: [
      { t: 0, kind: 'bidi', streamId: 1, origin: 'local', data: null, fin: false, sent: b64(subscribe(0, 'catalog.json')) },
      { t: 0, kind: 'bidi', streamId: 2, origin: 'local', data: null, fin: false, sent: b64(subscribe(1, 'video')) },
      { t: 1, kind: 'bidi', streamId: 2, origin: 'local', data: b64([0x56]), fin: false },
      { t: 1, kind: 'bidi', streamId: 1, origin: 'local', data: b64([0x43]), fin: false },
      { t: 30, kind: 'uni', streamId: 3, origin: 'remote', data: b64(group(1, 7, 0x76)), fin: true },
    ],
  };
  const write = async (stream: WebTransportBidirectionalStream, bytes: number[]): Promise<void> => {
    const writer = stream.writable.getWriter();
    await writer.write(Uint8Array.from(bytes));
    writer.releaseLock();
  };
  const first = async (readable: ReadableStream<Uint8Array>): Promise<number[]> => [...((await readable.getReader().read()).value as Uint8Array)];
  const firstBytes = first;

  it('gives each stream the answer to the same track, in any order, and puts the new subscribe IDs in group headers', async () => {
    const session = createReplaySession(trace, env);
    const video = session.createBidirectionalStream();
    const catalog = session.createBidirectionalStream();
    await write(video, subscribe(9, 'video'));
    await write(catalog, subscribe(8, 'catalog.json'));
    expect(await first(video.readable)).toEqual([0x56]);
    expect(await first(catalog.readable)).toEqual([0x43]);
    const uni = (await session.incomingUnidirectionalStreams.getReader().read()).value as ReadableStream<Uint8Array>;
    expect(await first(uni)).toEqual(group(9, 7, 0x76));
    session.close();
  });

  it('gives no groups of a recorded track that the app did not ask for now, even when its ID is the ID of a track now', async () => {
    // Recorded: catalog 0, video 1, then the player went to another quality, hd 2. Now the player starts on hd with ID 1.
    const qualities: TraceFile = {
      ...trace,
      events: [
        { t: 0, kind: 'bidi', streamId: 1, origin: 'local', data: null, fin: false, sent: b64(subscribe(0, 'catalog.json')) },
        { t: 0, kind: 'bidi', streamId: 2, origin: 'local', data: null, fin: false, sent: b64(subscribe(1, 'video')) },
        { t: 0, kind: 'bidi', streamId: 4, origin: 'local', data: null, fin: false, sent: b64(subscribe(2, 'hd')) },
        { t: 30, kind: 'uni', streamId: 3, origin: 'remote', data: b64(group(1, 7, 0x76)), fin: true },
        { t: 31, kind: 'uni', streamId: 7, origin: 'remote', data: b64(group(2, 7, 0x68)), fin: false },
        { t: 32, kind: 'uni', streamId: 7, origin: 'remote', data: b64([1, 0x69]), fin: true },
      ],
    };
    const session = createReplaySession(qualities, env);
    await write(session.createBidirectionalStream(), subscribe(0, 'catalog.json'));
    await write(session.createBidirectionalStream(), subscribe(1, 'hd'));
    const streams = session.incomingUnidirectionalStreams.getReader();
    const uni = (await streams.read()).value as ReadableStream<Uint8Array>;
    expect(await first(uni)).toEqual(group(1, 7, 0x68));
    const next = await Promise.race([streams.read().then(() => 'another'), new Promise((resolve) => setTimeout(() => resolve('none'), 60))]);
    expect(next).toBe('none');
    session.close();
  });

  it('a group that comes before the app asked for its track waits, and goes to the app when it asks (ADR-59)', async () => {
    const early: TraceFile = { ...trace, events: [...trace.events.slice(0, 2), { t: 2, kind: 'uni', streamId: 3, origin: 'remote', data: b64(group(1, 7, 0x76)), fin: true }] };
    const session = createReplaySession(early, env);
    await write(session.createBidirectionalStream(), subscribe(0, 'catalog.json'));
    const streams = session.incomingUnidirectionalStreams.getReader();
    const next = streams.read();
    // The group is due now, but the app asks for video only later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await Promise.race([next.then(() => 'got'), Promise.resolve('waits')])).toBe('waits');
    await write(session.createBidirectionalStream(), subscribe(5, 'video'));
    const uni = (await next).value as ReadableStream<Uint8Array>;
    expect(await first(uni)).toEqual(group(5, 7, 0x76));
    session.close();
  });

  it('a player that starts again on a quality with no recorded groups gets the recorded quality of the same kind (ADR-59)', async () => {
    // The player asked for 0.avc3 at the start, then played 1.avc3 while the recording ran: the recording has groups of 1.avc3 only.
    const abr: TraceFile = {
      ...trace,
      events: [
        { t: 0, kind: 'bidi', streamId: 1, origin: 'local', data: null, fin: false, sent: b64(subscribe(0, 'catalog.json')) },
        { t: 0, kind: 'bidi', streamId: 2, origin: 'local', data: null, fin: false, sent: b64(subscribe(1, '0.avc3')) },
        { t: 0, kind: 'bidi', streamId: 4, origin: 'local', data: null, fin: false, sent: b64(subscribe(2, '1.avc3')) },
        { t: 30, kind: 'uni', streamId: 3, origin: 'remote', data: b64(group(2, 7, 0x76)), fin: true },
      ],
    };
    const session = createReplaySession(abr, env);
    await write(session.createBidirectionalStream(), subscribe(0, 'catalog.json'));
    await write(session.createBidirectionalStream(), subscribe(1, '0.avc3'));
    const uni = (await session.incomingUnidirectionalStreams.getReader().read()).value as ReadableStream<Uint8Array>;
    expect(await first(uni)).toEqual(group(1, 7, 0x76));
    session.close();
  });

  it('a group of a track with no request in the recording goes to a request of the same kind, by the track in the summary', async () => {
    const noRequest: TraceFile = {
      ...trace,
      summary: { recordedMs: 100, tracks: [{ name: '1.avc3', groups: 1, firstGroup: 7, lastGroup: 7, frames: 1, keyframes: 1, bytes: 1, alias: 4 }] },
      events: [
        { t: 0, kind: 'bidi', streamId: 1, origin: 'local', data: null, fin: false, sent: b64(subscribe(0, 'catalog.json')) },
        { t: 30, kind: 'uni', streamId: 3, origin: 'remote', data: b64(group(4, 7, 0x76)), fin: true },
      ],
    };
    const session = createReplaySession(noRequest, env);
    await write(session.createBidirectionalStream(), subscribe(0, 'catalog.json'));
    await write(session.createBidirectionalStream(), subscribe(1, '0.avc3'));
    const uni = (await session.incomingUnidirectionalStreams.getReader().read()).value as ReadableStream<Uint8Array>;
    expect(await first(uni)).toEqual(group(1, 7, 0x76));
    session.close();
  });

  it('follows a quality change of the recording: the player gets the next quality on the subscription it has (ADR-59)', async () => {
    // Recorded: 2.avc3 first, then the player went to 1.avc3. Now the player asks for 2.avc3 only.
    const change: TraceFile = {
      ...trace,
      events: [
        { t: 0, kind: 'bidi', streamId: 1, origin: 'local', data: null, fin: false, sent: b64(subscribe(0, 'catalog.json')) },
        { t: 0, kind: 'bidi', streamId: 2, origin: 'local', data: null, fin: false, sent: b64(subscribe(1, '2.avc3')) },
        { t: 0, kind: 'bidi', streamId: 4, origin: 'local', data: null, fin: false, sent: b64(subscribe(2, '1.avc3')) },
        { t: 30, kind: 'uni', streamId: 3, origin: 'remote', data: b64(group(1, 7, 0x62)), fin: true },
        { t: 40, kind: 'uni', streamId: 7, origin: 'remote', data: b64(group(2, 8, 0x61)), fin: true },
      ],
    };
    const session = createReplaySession(change, env);
    await write(session.createBidirectionalStream(), subscribe(0, 'catalog.json'));
    await write(session.createBidirectionalStream(), subscribe(5, '2.avc3'));
    const streams = session.incomingUnidirectionalStreams.getReader();
    expect(await first((await streams.read()).value as ReadableStream<Uint8Array>)).toEqual(group(5, 7, 0x62));
    expect(await first((await streams.read()).value as ReadableStream<Uint8Array>)).toEqual(group(5, 8, 0x61));
    session.close();
  });

  it('gives no answer to a request that was not recorded, and does not close that stream', async () => {
    const session = createReplaySession(trace, env);
    const other = session.createBidirectionalStream();
    await write(other, subscribe(3, 'audio'));
    const read = other.readable.getReader().read();
    const result = await Promise.race([read.then(() => 'got'), new Promise((resolve) => setTimeout(() => resolve('waits'), 60))]);
    expect(result).toBe('waits');
    session.close();
  });

  it('a request made again gets the same answer, and the groups go to the new subscription (ADR-56)', async () => {
    const session = createReplaySession(trace, env);
    const first = session.createBidirectionalStream();
    await write(first, subscribe(9, 'video'));
    expect(await firstBytes(first.readable)).toEqual([0x56]);
    const again = session.createBidirectionalStream();
    await write(again, subscribe(12, 'video'));
    expect(await firstBytes(again.readable)).toEqual([0x56]);
    const uni = (await session.incomingUnidirectionalStreams.getReader().read()).value as ReadableStream<Uint8Array>;
    expect(await firstBytes(uni)).toEqual(group(12, 7, 0x76));
    session.close();
  });

  it('reads moq-lite from the protocol that the page offered, when the server chose none', async () => {
    const offered: TraceFile = { ...trace, offered: 'moq-lite-06' };
    delete offered.protocol;
    const session = createReplaySession(offered, env);
    const video = session.createBidirectionalStream();
    await write(video, subscribe(12, 'video'));
    const uni = (await session.incomingUnidirectionalStreams.getReader().read()).value as ReadableStream<Uint8Array>;
    expect(await firstBytes(uni)).toEqual(group(12, 7, 0x76));
    session.close();
  });

  it('the copy for a request made again ends with the recorded answer', async () => {
    const ending: TraceFile = { ...trace, events: trace.events.map((event) => (event.streamId === 2 && event.data ? { ...event, fin: true } : event)) };
    const session = createReplaySession(ending, env);
    const first = session.createBidirectionalStream();
    await write(first, subscribe(9, 'video'));
    const again = session.createBidirectionalStream();
    await write(again, subscribe(12, 'video'));
    const reader = again.readable.getReader();
    expect([...((await reader.read()).value ?? [])]).toEqual([0x56]);
    expect((await reader.read()).done).toBe(true);
    session.close();
  });

  it('a request made again after the recorded answer ended gets it whole, then the end', async () => {
    const ending: TraceFile = { ...trace, events: trace.events.map((event) => (event.streamId === 2 && event.data ? { ...event, fin: true } : event)) };
    const session = createReplaySession(ending, env);
    const first = session.createBidirectionalStream();
    await write(first, subscribe(9, 'video'));
    const firstReader = first.readable.getReader();
    await firstReader.read();
    expect((await firstReader.read()).done).toBe(true);
    const again = session.createBidirectionalStream();
    await write(again, subscribe(12, 'video'));
    const reader = again.readable.getReader();
    expect([...((await reader.read()).value ?? [])]).toEqual([0x56]);
    expect((await reader.read()).done).toBe(true);
    session.close();
  });

  it('a track of the same kind that was not recorded gets the recorded one (another quality)', async () => {
    const quality: TraceFile = {
      ...trace,
      events: trace.events.map((event) => (event.streamId === 2 && event.sent ? { ...event, sent: b64(subscribe(1, 'v.avc3')) } : event)),
    };
    const session = createReplaySession(quality, env);
    const other = session.createBidirectionalStream();
    await write(other, subscribe(4, 'hd.avc3'));
    expect(await firstBytes(other.readable)).toEqual([0x56]);
    const uni = (await session.incomingUnidirectionalStreams.getReader().read()).value as ReadableStream<Uint8Array>;
    expect(await firstBytes(uni)).toEqual(group(4, 7, 0x76));
    session.close();
  });

  it('waits for a request written in several writes', async () => {
    const session = createReplaySession(trace, env);
    const video = session.createBidirectionalStream();
    const [type, ...rest] = subscribe(4, 'video');
    await write(video, [type as number]);
    await write(video, rest);
    expect(await first(video.readable)).toEqual([0x56]);
    session.close();
  });

  it('a stream that writes nothing gets the next recorded stream in order', async () => {
    const session = createReplaySession(trace, env);
    const silent = session.createBidirectionalStream();
    expect(await first(silent.readable)).toEqual([0x43]);
    session.close();
  });
});

describe('what the app asked, in a recording', () => {
  it('keeps the first bytes the app wrote on each stream it opened, on the first event of that stream', () => {
    const recorder = createRecorder(() => 0);
    const session = { id: 1, url: 'https://x/', startedAt: 0 };
    recorder.add(session, { kind: 'bidi', streamId: 4, origin: 'local', data: null, fin: false });
    recorder.sent(1, 4, Uint8Array.of(2, 3));
    recorder.sent(1, 4, Uint8Array.of(5));
    recorder.start();
    recorder.add(session, { kind: 'bidi', streamId: 4, origin: 'local', data: Uint8Array.of(9), fin: false });
    const { events } = recorder.stop();
    expect(events[0]?.sent).toEqual(Uint8Array.of(2, 3, 5));
    expect(events[1]?.sent).toBeUndefined();
  });
});

describe('a replay is not recorded', () => {
  it('a recording started while a replay plays holds no data of the replay', async () => {
    const kit = createMockWebTransport();
    const scope: { WebTransport?: typeof WebTransport } = {};
    Object.defineProperty(scope, 'WebTransport', { value: kit.Native, writable: true, configurable: true });
    const runtime = patchInstall(scope, { random: () => 0.5, log: () => undefined }) as Runtime;
    const b64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes));
    runtime.armReplay({ format: 'sluice-trace', version: 1, url: 'https://relay.test/moq', close: null, events: [{ t: 5, kind: 'uni', streamId: 1, origin: 'remote', data: b64([1, 2]), fin: true }] }, { end: 'hold', overlay: false });
    runtime.startRecording();
    const wt = new (scope.WebTransport as typeof WebTransport)('https://relay.test/moq');
    const uni = (await wt.incomingUnidirectionalStreams.getReader().read()).value as ReadableStream<Uint8Array>;
    await uni.getReader().read();
    expect(runtime.stopRecording().events).toEqual([]);
    wt.close();
  });
});
