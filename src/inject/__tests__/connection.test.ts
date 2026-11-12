// Actions on the connection: stall, close, reset, from a rule or from the panel (ADR-41).
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionAction, Rule } from '../../shared/rules';
import { install, type Runtime } from '../patch';
import { makeConfig } from './helpers';
import { createMockWebTransport } from './mock-webtransport';

function setup(rules: Rule[] = []) {
  const kit = createMockWebTransport();
  const scope: { WebTransport?: typeof WebTransport } = {};
  Object.defineProperty(scope, 'WebTransport', { value: kit.Native, writable: true, configurable: true });
  const actions: [ConnectionAction, number | null][] = [];
  const runtime = install(scope, {
    config: makeConfig({ rules }),
    random: () => 0.5,
    log: () => undefined,
    events: { connectionAction: (_session, action, streamId) => actions.push([action, streamId]) },
  }) as Runtime;
  const Sluice = scope.WebTransport as typeof WebTransport;
  return { kit, runtime, wt: new Sluice('https://relay.test/moq'), actions };
}

const control = (kit: { sessions: unknown[] }) => {
  const session = kit.sessions[0];
  if (!session) throw new Error('no session');
  return session as ReturnType<typeof createMockWebTransport>['sessions'][number];
};

const uniReader = async (wt: WebTransport) => {
  const streams = wt.incomingUnidirectionalStreams.getReader();
  const { value } = await streams.read();
  return (value as ReadableStream<Uint8Array>).getReader();
};

describe('stall', () => {
  it('from the panel: the app gets nothing for the time, then all of it in order', async () => {
    const { kit, runtime, wt, actions } = setup();
    const source = control(kit).openUni();
    const reader = await uniReader(wt);
    expect(runtime.connection(1, { type: 'stall', durationMs: 80 })).toBe(true);
    const started = performance.now();
    source.push([1], [2]);
    const first = await reader.read();
    expect(performance.now() - started).toBeGreaterThanOrEqual(70);
    expect([...(first.value as Uint8Array)]).toEqual([1]);
    expect([...((await reader.read()).value as Uint8Array)]).toEqual([2]);
    expect(actions).toEqual([[{ type: 'stall', durationMs: 80 }, null]]);
  });

  it('from a rule: a match during the stall does not make it longer', async () => {
    const { kit, wt, actions } = setup([{ id: 's', on: ['uni'], action: { type: 'stall', durationMs: 60 } }]);
    const source = control(kit).openUni();
    const reader = await uniReader(wt);
    const started = performance.now();
    source.push([1], [2], [3]);
    for (let i = 0; i < 3; i++) await reader.read();
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(50);
    expect(took).toBeLessThan(150);
    expect(actions).toHaveLength(1);
  });
});

describe('close', () => {
  it('from the panel: the session closes', async () => {
    const { runtime, wt, actions } = setup();
    expect(runtime.connection(1, { type: 'close-session', closeCode: 7, reason: 'test' })).toBe(true);
    await expect(wt.closed).resolves.toBeDefined();
    expect(actions[0]?.[0]).toEqual({ type: 'close-session', closeCode: 7, reason: 'test' });
  });

  it('from a rule: the matching chunk does not reach the app, and the session closes', async () => {
    const { kit, wt } = setup([{ id: 'c', match: { contains: ['bye'] }, action: { type: 'close-session', closeCode: 1, reason: 'r' } }]);
    const source = control(kit).openUni();
    const reader = await uniReader(wt);
    source.push('hello', 'bye');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('hello');
    await expect(wt.closed).resolves.toBeDefined();
  });

  it('says no for a session that does not exist', () => {
    const { runtime } = setup();
    expect(runtime.connection(9, { type: 'close-session', closeCode: 0, reason: '' })).toBe(false);
  });
});

describe('reset', () => {
  it('from a rule: the stream of the match errors, and the chunks before it arrived', async () => {
    const { kit, wt } = setup([{ id: 'r', on: ['uni'], match: { contains: ['x'] }, action: { type: 'reset-stream', code: 9 } }]);
    const source = control(kit).openUni();
    const reader = await uniReader(wt);
    source.push('a', 'x');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('a');
    await expect(reader.read()).rejects.toMatchObject({ streamErrorCode: 9 });
  });

  it('a rule does nothing to a datagram', async () => {
    const { kit, wt } = setup([{ id: 'r', action: { type: 'reset-stream', code: 9 } }]);
    const reader = wt.datagrams.readable.getReader();
    control(kit).datagramSource.push('d');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('d');
  });
});

vi.setConfig({ testTimeout: 5000 });

describe('timeline (ADR-47)', () => {
  function withTimeline(timeline: NonNullable<ReturnType<typeof makeConfig>['timeline']>) {
    const kit = createMockWebTransport();
    const scope: { WebTransport?: typeof WebTransport } = {};
    Object.defineProperty(scope, 'WebTransport', { value: kit.Native, writable: true, configurable: true });
    const actions: ConnectionAction[] = [];
    install(scope, { config: { ...makeConfig(), timeline }, random: () => 0.5, log: () => undefined, events: { connectionAction: (_s, action) => actions.push(action) } });
    const Sluice = scope.WebTransport as typeof WebTransport;
    return { kit, wt: new Sluice('https://relay.test/moq'), actions };
  }

  it('runs each step at its time from the open of the session', async () => {
    const { wt, actions } = withTimeline([
      { atMs: 20, action: { type: 'network', dropRate: 0, delayMs: 30, jitterMs: 0 } },
      { atMs: 40, action: { type: 'stall', durationMs: 50 } },
      { atMs: 80, action: { type: 'close-session', closeCode: 3, reason: 'end of test' } },
    ]);
    await expect(wt.closed).resolves.toBeDefined();
    expect(actions.map((action) => action.type)).toEqual(['network', 'stall', 'close-session']);
  });

  it('a network step delays what the app gets from then on', async () => {
    const { kit, wt } = withTimeline([{ atMs: 0, action: { type: 'network', dropRate: 0, delayMs: 60, jitterMs: 0 } }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const source = control(kit).openUni();
    const reader = await uniReader(wt);
    const started = performance.now();
    source.push([1]);
    await reader.read();
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('stops when the session closes', async () => {
    const { wt, actions } = withTimeline([{ atMs: 60, action: { type: 'stall', durationMs: 10 } }]);
    wt.close();
    await wt.closed;
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(actions).toEqual([]);
  });
});

describe('bandwidth cap (ADR-48)', () => {
  it('spaces chunks as a link of that rate, in order', async () => {
    const kit = createMockWebTransport();
    const scope: { WebTransport?: typeof WebTransport } = {};
    Object.defineProperty(scope, 'WebTransport', { value: kit.Native, writable: true, configurable: true });
    install(scope, { config: { ...makeConfig(), bandwidth: { kbps: 800, queueMs: 1000 } }, random: () => 0.5, log: () => undefined });
    const wt = new (scope.WebTransport as typeof WebTransport)('https://relay.test/moq');
    const source = control(kit).openUni();
    const reader = await uniReader(wt);
    const started = performance.now();
    // 3 chunks of 2000 bytes at 800 kbit/s: 20 ms each on the link.
    source.push(new Uint8Array(2000), new Uint8Array(2000), new Uint8Array(2000));
    let got = 0;
    while (got < 6000) got += ((await reader.read()).value as Uint8Array).length;
    expect(performance.now() - started).toBeGreaterThanOrEqual(55);
  });

  it('loses datagrams that would wait longer than the queue', async () => {
    const kit = createMockWebTransport();
    const scope: { WebTransport?: typeof WebTransport } = {};
    Object.defineProperty(scope, 'WebTransport', { value: kit.Native, writable: true, configurable: true });
    install(scope, { config: { ...makeConfig(), bandwidth: { kbps: 80, queueMs: 50 } }, random: () => 0.5, log: () => undefined });
    const wt = new (scope.WebTransport as typeof WebTransport)('https://relay.test/moq');
    const reader = wt.datagrams.readable.getReader();
    // 1000 bytes at 80 kbit/s is 100 ms: after the first, the queue is longer than 50 ms.
    for (let i = 0; i < 5; i++) control(kit).datagramSource.push(new Uint8Array(1000).fill(i));
    const first = (await reader.read()).value as Uint8Array;
    expect(first[0]).toBe(0);
    const next = await Promise.race([reader.read().then(() => 'got'), new Promise((resolve) => setTimeout(() => resolve('lost'), 250))]);
    expect(next).toBe('lost');
  });
});
