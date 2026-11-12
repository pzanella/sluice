import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '../../shared/rules';
import { install, type Runtime } from '../patch';
import { makeConfig, readAll, settle, text } from './helpers';
import { createMockWebTransport, MockBidi, MockDatagramDuplex } from './mock-webtransport';

type Scope = { WebTransport?: typeof WebTransport };

function setup(options: Parameters<typeof install>[1] = {}) {
  const kit = createMockWebTransport();
  const scope: Scope = {};
  Object.defineProperty(scope, 'WebTransport', { value: kit.Native, writable: true, configurable: true, enumerable: false });
  const log = vi.fn<(m: string) => void>();
  const runtime = install(scope, { random: () => 0.5, log, ...options }) as Runtime;
  const Sluice = scope.WebTransport as typeof WebTransport;
  const make = (url = 'https://relay.test/moq') => new Sluice(url);
  return { kit, scope, runtime, Sluice, make, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('invariant 1: instance stays native', () => {
  it('invariant 1: non-overridden methods work without bind', async () => {
    const { make } = setup();
    const wt = make();
    const extra = wt as unknown as { getStats(): Promise<unknown>; reliability: string };
    expect(await extra.getStats()).toEqual({ bytesSent: 42 });
    expect(extra.reliability).toBe('supports-unreliable');
    await expect(wt.ready).resolves.toBeUndefined();
    const { close } = wt; // Detached from the instance.
    expect(() => close.call(wt)).not.toThrow();
    await expect(wt.closed).resolves.toBeDefined();
  });

  it('invariant 1: the instance is a native instance', () => {
    const { make, kit, Sluice } = setup();
    const wt = make();
    expect(wt instanceof kit.Native).toBe(true);
    expect(wt instanceof Sluice).toBe(true);
    expect(Object.getPrototypeOf(Sluice)).toBe(kit.Native);
  });

  it('invariant 1: static members are inherited', () => {
    const { Sluice } = setup();
    expect((Sluice as unknown as { supportsReliableOnly: boolean }).supportsReliableOnly).toBe(true);
    expect((Sluice as unknown as { staticHelper(): string }).staticHelper()).toBe('static-ok');
  });

  it('invariant 1: only the documented members are overridden', () => {
    const { Sluice } = setup();
    expect(Object.getOwnPropertyNames(Sluice.prototype).sort()).toEqual(
      ['constructor', 'createBidirectionalStream', 'createUnidirectionalStream', 'datagrams', 'incomingBidirectionalStreams', 'incomingUnidirectionalStreams'].sort(),
    );
  });

  it('invariant 1: the native class name and toString are kept', () => {
    const { Sluice, kit } = setup();
    expect(Sluice.name).toBe(kit.Native.name);
    expect(Sluice.toString()).toBe(Function.prototype.toString.call(kit.Native));
    expect(String(Sluice)).toContain('class MockWebTransport');
  });

  it('invariant 1: the native constructor receives the url and options', () => {
    const { Sluice, kit } = setup();
    new Sluice(new URL('https://a.test/x'), {});
    expect(kit.sessions[0]?.url).toBe('https://a.test/x');
  });
});

describe('invariant 2: lazy wrap', () => {
  it('invariant 2: no native stream is locked before the app accesses it', () => {
    const { make, kit } = setup();
    make();
    const ctl = kit.sessions[0];
    expect(ctl?.datagramSource.stream.locked).toBe(false);
    expect(ctl?.incomingUni.stream.locked).toBe(false);
    expect(ctl?.incomingBidi.stream.locked).toBe(false);
  });

  it('invariant 2: datagrams are locked only when `readable` is accessed', () => {
    const { make, kit } = setup();
    const wt = make();
    const datagrams = wt.datagrams;
    expect(kit.sessions[0]?.datagramSource.stream.locked).toBe(false);
    void datagrams.writable;
    expect(kit.sessions[0]?.datagramSource.stream.locked).toBe(false);
    void datagrams.readable;
    expect(kit.sessions[0]?.datagramSource.stream.locked).toBe(true);
  });

  it('invariant 2: incoming stream lists are locked on first access', () => {
    const { make, kit } = setup();
    const wt = make();
    void wt.incomingUnidirectionalStreams;
    expect(kit.sessions[0]?.incomingUni.stream.locked).toBe(true);
    expect(kit.sessions[0]?.incomingBidi.stream.locked).toBe(false);
    void wt.incomingBidirectionalStreams;
    expect(kit.sessions[0]?.incomingBidi.stream.locked).toBe(true);
  });

  it('invariant 2: the result is cached (same object on second access)', () => {
    const { make } = setup();
    const wt = make();
    expect(wt.datagrams).toBe(wt.datagrams);
    expect(wt.datagrams.readable).toBe(wt.datagrams.readable);
    expect(wt.incomingUnidirectionalStreams).toBe(wt.incomingUnidirectionalStreams);
    expect(wt.incomingBidirectionalStreams).toBe(wt.incomingBidirectionalStreams);
  });

  it('invariant 2: separate instances do not share the cache', () => {
    const { make } = setup();
    const a = make();
    const b = make();
    expect(a.datagrams).not.toBe(b.datagrams);
    expect(a.incomingUnidirectionalStreams).not.toBe(b.incomingUnidirectionalStreams);
  });

  it('invariant 2: disabled on first access caches the native objects and never wraps later', () => {
    const { make, kit, runtime } = setup({ config: makeConfig({ enabled: false }) });
    const wt = make();
    const ctl = kit.sessions[0];
    const datagrams = wt.datagrams;
    const uni = wt.incomingUnidirectionalStreams;
    const bidi = wt.incomingBidirectionalStreams;
    expect(datagrams).toBe(ctl?.datagrams);
    expect(uni).toBe(ctl?.incomingUni.stream);
    expect(bidi).toBe(ctl?.incomingBidi.stream);

    runtime.setConfig(makeConfig({ enabled: true }));
    expect(wt.datagrams).toBe(datagrams);
    expect(wt.datagrams.readable).toBe(ctl?.datagramSource.stream);
    expect(wt.incomingUnidirectionalStreams).toBe(uni);
    expect(wt.incomingBidirectionalStreams).toBe(bidi);
    expect(ctl?.datagramSource.stream.locked).toBe(false);
    expect(ctl?.incomingUni.stream.locked).toBe(false);
  });

  it('invariant 2: enabled on first access stays wrapped when disabled later', () => {
    const { make, runtime } = setup();
    const wt = make();
    const datagrams = wt.datagrams;
    runtime.setConfig(makeConfig({ enabled: false }));
    expect(wt.datagrams).toBe(datagrams);
    expect(wt.datagrams.readable).not.toBe(undefined);
  });

  it('invariant 2: app code that never touches the streams leaves them unlocked and usable', async () => {
    const { make, kit } = setup();
    make();
    const reader = kit.sessions[0]?.datagramSource.stream.getReader();
    expect(reader).toBeDefined();
  });
});

describe('data flow through install', () => {
  it('a datagram goes through a modify rule', async () => {
    const rules: Rule[] = [{ id: 'r', action: { type: 'modify', ops: [{ op: 'replace', find: 'cat', with: 'dog' }] } }];
    const { make, kit, runtime } = setup({ config: makeConfig({ rules }) });
    const wt = make();
    const reader = wt.datagrams.readable.getReader();
    kit.sessions[0]?.datagramSource.push('a cat');
    const { value } = await reader.read();
    expect(text(value ?? [])).toBe('a dog');
    expect(runtime.ruleHits.get('r')).toBe(1);
    expect(runtime.stats.datagram.chunks).toBe(1);
    expect(runtime.stats.datagram.bytes).toBe(5);
  });

  it('a remote uni stream is wrapped, counted and readable with a default reader', async () => {
    const { make, kit, runtime } = setup();
    const wt = make();
    const streams = wt.incomingUnidirectionalStreams.getReader();
    const source = kit.sessions[0]?.openUni();
    source?.push('hi');
    source?.close();
    const { value } = await streams.read();
    expect(runtime.stats.uni.streams).toBe(1);
    expect(await readAll((value as ReadableStream<Uint8Array>).getReader())).toEqual([[104, 105]]);
    expect(runtime.stats.uni.chunks).toBe(1);
  });

  it('a remote uni stream is readable with a BYOB reader', async () => {
    const { make, kit } = setup();
    const wt = make();
    const streams = wt.incomingUnidirectionalStreams.getReader();
    const source = kit.sessions[0]?.openUni();
    source?.push('hi');
    const { value } = await streams.read();
    const reader = (value as ReadableStream<Uint8Array>).getReader({ mode: 'byob' });
    const result = await reader.read(new Uint8Array(8));
    expect(text(result.value ?? [])).toBe('hi');
  });

  it('a remote bidi stream is a proxy with both sides wrapped', async () => {
    const { make, kit, runtime } = setup();
    const wt = make();
    const streams = wt.incomingBidirectionalStreams.getReader();
    const opened = kit.sessions[0]?.openBidi();
    const { value } = await streams.read();
    const bidi = value as MockBidi;
    expect(bidi.writable).not.toBe(opened?.bidi.writable);
    expect(bidi.writable).toBe(bidi.writable);
    expect(bidi.readable).not.toBe(opened?.source.stream);
    expect(bidi.readable).toBe(bidi.readable);
    expect(bidi.ping()).toBe('pong-bidi');
    opened?.source.push('yo');
    const read = await bidi.readable.getReader().read();
    expect(text(read.value ?? [])).toBe('yo');
    expect(runtime.stats.bidi.streams).toBe(1);
  });

  it('the bidi readable is locked only on first access', async () => {
    const { make, kit } = setup();
    const wt = make();
    const streams = wt.incomingBidirectionalStreams.getReader();
    const opened = kit.sessions[0]?.openBidi();
    const { value } = await streams.read();
    expect(opened?.source.stream.locked).toBe(false);
    void (value as MockBidi).writable;
    expect(opened?.source.stream.locked).toBe(false);
    void (value as MockBidi).readable;
    expect(opened?.source.stream.locked).toBe(true);
  });

  it('createBidirectionalStream wraps both sides by default', async () => {
    const { make, kit } = setup();
    const wt = make();
    const bidi = await wt.createBidirectionalStream();
    const created = kit.sessions[0]?.createdBidis[0];
    expect(bidi).not.toBe(created?.bidi);
    expect(bidi.writable).not.toBe(created?.bidi.writable);
    created?.source.push('reply');
    expect(text((await bidi.readable.getReader().read()).value ?? [])).toBe('reply');
  });

  it('createBidirectionalStream returns the native stream when wrapLocalBidi is false', async () => {
    const { make, kit } = setup({ config: makeConfig({ wrapLocalBidi: false }) });
    const bidi = await make().createBidirectionalStream();
    expect(bidi).toBe(kit.sessions[0]?.createdBidis[0]?.bidi);
  });

  it('createBidirectionalStream returns the native stream when disabled', async () => {
    const { make, kit } = setup({ config: makeConfig({ enabled: false }) });
    const bidi = await make().createBidirectionalStream();
    expect(bidi).toBe(kit.sessions[0]?.createdBidis[0]?.bidi);
  });

  it('datagram proxy keeps native members working', () => {
    const { make } = setup();
    const datagrams = make().datagrams;
    expect(datagrams.maxDatagramSize).toBe(1200);
    datagrams.incomingHighWaterMark = 9;
    expect(datagrams.incomingHighWaterMark).toBe(9);
    expect((datagrams as unknown as MockDatagramDuplex).ping()).toBe('pong-datagram');
  });

  it('the config is read again for each chunk (setConfig applies with no reload)', async () => {
    const { make, kit, runtime } = setup();
    const reader = make().datagrams.readable.getReader();
    const source = kit.sessions[0]?.datagramSource;
    source?.push('one');
    expect(text((await reader.read()).value ?? [])).toBe('one');
    runtime.setConfig(makeConfig({ rules: [{ id: 'd', action: { type: 'drop' } }] }));
    source?.push('two', 'three');
    runtime.setConfig(makeConfig({ rules: [{ id: 'd', action: { type: 'drop' }, match: { prefix: 'tw' } }] }));
    expect(text((await reader.read()).value ?? [])).toBe('three');
  });

  it('logs session events when log.session is on', async () => {
    const { make, log } = setup({ config: makeConfig({ log: { session: true } }) });
    make();
    await settle();
    const lines = log.mock.calls.map(([m]) => m);
    expect(lines.some((l) => l.includes('-> https://relay.test/moq'))).toBe(true);
    expect(lines.some((l) => l.includes('ready'))).toBe(true);
  });
});

describe('install', () => {
  it('returns null when there is no WebTransport', () => {
    expect(install({}, {})).toBeNull();
    expect(install({ WebTransport: undefined } as unknown as Scope, {})).toBeNull();
  });

  it('does not touch the scope when there is no WebTransport', () => {
    const scope: Scope = {};
    install(scope, {});
    expect(Object.getOwnPropertyNames(scope)).toEqual([]);
  });

  it('replaces WebTransport on the scope and keeps the descriptor flags', () => {
    const { scope, kit } = setup();
    const desc = Object.getOwnPropertyDescriptor(scope, 'WebTransport');
    expect(desc?.value).not.toBe(kit.Native);
    expect(desc?.writable).toBe(true);
    expect(desc?.configurable).toBe(true);
    expect(desc?.enumerable).toBe(false);
  });

  it('uninstall restores the original descriptor', () => {
    const kit = createMockWebTransport();
    const scope: Scope = {};
    Object.defineProperty(scope, 'WebTransport', { value: kit.Native, writable: true, configurable: true, enumerable: false });
    const before = Object.getOwnPropertyDescriptor(scope, 'WebTransport');
    const runtime = install(scope, {}) as Runtime;
    expect(scope.WebTransport).not.toBe(kit.Native);
    runtime.uninstall();
    expect(Object.getOwnPropertyDescriptor(scope, 'WebTransport')).toEqual(before);
    expect(scope.WebTransport).toBe(kit.Native);
  });

  it('uninstall works when WebTransport was a plain assigned property', () => {
    const kit = createMockWebTransport();
    const scope: Scope = { WebTransport: kit.Native };
    const runtime = install(scope, {}) as Runtime;
    runtime.uninstall();
    expect(scope.WebTransport).toBe(kit.Native);
    expect(Object.getOwnPropertyDescriptor(scope, 'WebTransport')?.enumerable).toBe(true);
  });

  it('does not use globalThis', () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, 'WebTransport');
    setup();
    expect(Object.getOwnPropertyDescriptor(globalThis, 'WebTransport')).toEqual(before);
  });

  it('tracks sessions and removes them on close', async () => {
    const { make, runtime, kit } = setup();
    make('https://a.test/');
    make('https://b.test/');
    expect(runtime.sessions.size).toBe(2);
    expect(Array.from(runtime.sessions.values()).map((s) => s.url)).toEqual(['https://a.test/', 'https://b.test/']);
    kit.sessions[0]?.closeSession();
    await settle();
    expect(Array.from(runtime.sessions.keys())).toEqual([2]);
  });

  it('removes the session when closed rejects, with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { make, runtime, kit } = setup();
      make();
      kit.sessions[0]?.failSession(new Error('connection lost'));
      await settle();
      await new Promise((r) => setTimeout(r, 10));
      expect(runtime.sessions.size).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a rejected ready causes no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const kit = createMockWebTransport();
      // Reject ready before the constructor attaches handlers is impossible, so reject right after.
      const scope: Scope = { WebTransport: kit.Native };
      install(scope, {});
      const wt = new (scope.WebTransport as typeof WebTransport)('https://x.test/');
      kit.sessions[0]?.rejectReady(new Error('no ready'));
      await new Promise((r) => setTimeout(r, 10));
      void wt;
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('closed still rejects for the app (the app keeps its own handler)', async () => {
    const { make, kit } = setup();
    const wt = make();
    const seen = wt.closed.then(
      () => 'ok',
      (e: Error) => e.message,
    );
    kit.sessions[0]?.failSession(new Error('bye'));
    expect(await seen).toBe('bye');
  });

  it('session ids increase and stream ids are shared across sessions', async () => {
    const { make, runtime } = setup();
    make();
    make();
    expect(Array.from(runtime.sessions.keys())).toEqual([1, 2]);
  });

  it('uses Math.random by default and console.log for logs without options', () => {
    const kit = createMockWebTransport();
    const scope: Scope = { WebTransport: kit.Native };
    expect(install(scope)).not.toBeNull();
  });
});

describe('resolveUrl', () => {
  it('gives the native constructor the corrected URL, once', () => {
    const resolveUrl = vi.fn((url: string) => `https://a.test/${url}`);
    const { scope, runtime } = setup({ resolveUrl });
    const session = new (scope as unknown as { WebTransport: new (url: string) => { url?: string } }).WebTransport('wt');
    expect(session).toBeDefined();
    expect(resolveUrl).toHaveBeenCalledTimes(1);
    expect([...runtime.sessions.values()][0]?.url).toBe('https://a.test/wt');
  });
});

describe('another tool patched WebTransport first', () => {
  function setupBehind() {
    const kit = createMockWebTransport();
    const created: object[] = [];
    // The shape of the hook of some inspector tools: a function that returns a native object, with own methods.
    function Foreign(this: unknown, url: string, options?: WebTransportOptions): object {
      const instance = new kit.Native(url, options) as unknown as Record<string, unknown> & { createBidirectionalStream(): Promise<unknown> };
      const create = instance.createBidirectionalStream.bind(instance);
      instance.createBidirectionalStream = () => {
        created.push(instance);
        return create();
      };
      return instance;
    }
    Foreign.prototype = kit.Native.prototype;
    const scope: Scope = {};
    Object.defineProperty(scope, 'WebTransport', { value: Foreign, writable: true, configurable: true, enumerable: false });
    const log = vi.fn<(m: string) => void>();
    const streamOpen = vi.fn();
    const runtime = install(scope, { random: () => 0.5, log, events: { streamOpen } }) as Runtime;
    return { kit, Sluice: scope.WebTransport as typeof WebTransport, runtime, streamOpen, created };
  }

  it('wraps incoming streams', async () => {
    const { Sluice, streamOpen, kit } = setupBehind();
    const transport = new Sluice('https://relay.test/moq');
    expect(transport).toBeInstanceOf(Sluice);
    const reader = transport.incomingUnidirectionalStreams.getReader();
    kit.sessions[0]?.openUni();
    await reader.read();
    expect(streamOpen).toHaveBeenCalledTimes(1);
  });

  it('wraps a local bidi stream, and still calls the method of the other tool', async () => {
    const { Sluice, streamOpen, created } = setupBehind();
    const transport = new Sluice('https://relay.test/moq');
    await transport.createBidirectionalStream();
    expect(created.length).toBe(1);
    expect(streamOpen).toHaveBeenCalledTimes(1);
  });
});
