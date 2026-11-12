import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../shared/rules';
import { parseRuntimeMessage, PROTOCOL_LIMITS, type RuntimeMessage } from '../../shared/protocol';
import { createChannel, type ChannelEnv } from '../channel';
import type { ChunkContext } from '../pipeline';
import { createStats } from '../pipeline';
import type { Runtime, SessionInfo } from '../patch';

const session: SessionInfo = { id: 1, url: '/wt', createdAt: 5 };

function setup() {
  const sent: RuntimeMessage[] = [];
  const invalid: unknown[] = [];
  let toMain: (detail: unknown) => void = () => undefined;
  const env: ChannelEnv = {
    dispatch: (type, detail) => {
      expect(type).toBe('sluice:n:to-bridge');
      const parsed = parseRuntimeMessage(JSON.parse(detail));
      if (parsed.ok) sent.push(parsed.value);
      else invalid.push(parsed.errors);
    },
    listen: (type, handler) => {
      expect(type).toBe('sluice:n:to-main');
      toMain = handler;
    },
    setTimeout: (run, ms) => void setTimeout(run, ms),
    setInterval: (run, ms) => setInterval(run, ms) as unknown as number,
    clearInterval: (id) => clearInterval(id),
    now: () => 7,
    stringify: JSON.stringify,
    parse: JSON.parse,
    absoluteUrl: (url) => new URL(url, 'https://site.test/app/').href,
  };
  const channel = createChannel('n', env);
  const runtime = {
    sessions: new Map([[1, session]]),
    stats: createStats(),
    ruleHits: new Map([['r', 2]]),
    disabledRules: () => ['slow'],
    setConfig: vi.fn(),
    setHolding: vi.fn(),
    announceHolds: vi.fn(),
    resolveHold: vi.fn(),
    inject: vi.fn(() => 'not-read'),
  } as unknown as Runtime;
  channel.attach(runtime);
  const control = (type: string, payload: unknown): void => toMain(JSON.stringify({ v: 1, type, id: 1, payload }));
  return { sent, invalid, channel, runtime, control, toMain: (detail: unknown) => toMain(detail) };
}

const chunk = (seq = 0, data: number[] = [1, 2, 3]): ChunkContext => ({
  kind: 'datagram',
  origin: 'remote',
  sessionId: 1,
  url: '/wt',
  streamId: null,
  seq,
  data: Uint8Array.from(data),
});

describe('channel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it('always sends session events, with an absolute URL', () => {
    const { sent, invalid, channel } = setup();
    channel.events.sessionOpen(session);
    channel.events.sessionClosed(session, { closeCode: 3, reason: 'bye' });
    channel.events.sessionClosed(session, null);
    expect(invalid).toEqual([]);
    expect(sent.map((m) => m.payload)).toEqual([
      { sessionId: 1, url: 'https://site.test/wt', createdAt: 5 },
      { sessionId: 1, closeCode: 3, reason: 'bye', at: 7 },
      { sessionId: 1, closeCode: null, reason: '', at: 7 },
    ]);
  });

  it('shortens values that the validator would reject', () => {
    const { sent, channel } = setup();
    channel.events.sessionOpen({ ...session, url: `https://a.test/${'x'.repeat(PROTOCOL_LIMITS.url)}` });
    channel.events.sessionClosed(session, { closeCode: 0, reason: 'x'.repeat(PROTOCOL_LIMITS.closeReason + 5) });
    expect(sent).toHaveLength(2);
  });

  it('sends no payload bytes and no streams until capture is on', () => {
    const { sent, channel } = setup();
    const ctx = chunk();
    channel.events.chunk(ctx, ctx.data, { data: ctx.data, delayMs: 0 });
    channel.events.streamOpen(session, 2, 'uni', 'remote');
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([]);
  });

  it('on capture, announces live sessions, batches traffic and sends stats', () => {
    const { sent, invalid, channel, control } = setup();
    control('set-capture', { traffic: true, previewBytes: 2 });
    expect(sent.map((m) => m.type)).toEqual(['session-open']);
    const ctx = chunk();
    channel.events.chunk(ctx, ctx.data, { data: ctx.data, delayMs: 4 });
    channel.events.chunk(chunk(1), ctx.data, { data: null, delayMs: 0 });
    const edited = Uint8Array.from([9, 9, 9]);
    channel.events.chunk(chunk(2), ctx.data, { data: edited, delayMs: 0 });
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(invalid).toEqual([]);
    const traffic = sent[1];
    if (traffic?.type !== 'traffic') throw new Error('no traffic');
    expect(traffic.payload.items.map((i) => [i.outcome, i.modified, i.delayMs, i.preview, i.byteLength])).toEqual([
      ['passed', false, 4, 'AQI=', 3],
      ['dropped', false, 0, 'AQI=', 3],
      ['passed', true, 0, 'CQk=', 3],
    ]);
    vi.advanceTimersByTime(900);
    const stats = sent.at(-1);
    if (stats?.type !== 'stats') throw new Error('no stats');
    expect(stats.payload.ruleHits).toEqual([{ id: 'r', count: 2 }]);
    expect(stats.payload.disabledRules).toEqual(['slow']);
  });

  it('announces live sessions again for a second panel, with one stats timer', () => {
    const { sent, control } = setup();
    control('set-capture', { traffic: true, previewBytes: 1 });
    control('set-capture', { traffic: true, previewBytes: 1 });
    expect(sent.filter((m) => m.type === 'session-open')).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(sent.filter((m) => m.type === 'stats')).toHaveLength(1);
  });

  it('sends a burst in batches, with no loss', () => {
    const { sent, channel, control } = setup();
    control('set-capture', { traffic: true, previewBytes: 1 });
    for (let i = 0; i < PROTOCOL_LIMITS.batch * 3; i++) {
      const ctx = chunk(i);
      channel.events.chunk(ctx, ctx.data, { data: ctx.data, delayMs: 0 });
    }
    vi.advanceTimersByTime(1000);
    const items = sent.flatMap((m) => (m.type === 'traffic' ? m.payload.items : []));
    expect(items).toHaveLength(PROTOCOL_LIMITS.batch * 3);
    const stats = sent.at(-1);
    if (stats?.type !== 'stats') throw new Error('no stats');
    expect(stats.payload.captureDropped).toBe(0);
  });

  it('counts what does not fit in the queue, and reports it', () => {
    const { sent, channel, control } = setup();
    control('set-capture', { traffic: true, previewBytes: 1 });
    for (let i = 0; i < 2005; i++) {
      const ctx = chunk(i);
      channel.events.chunk(ctx, ctx.data, { data: ctx.data, delayMs: 0 });
    }
    vi.advanceTimersByTime(10_000);
    const stats = sent.at(-1);
    if (stats?.type !== 'stats') throw new Error('no stats');
    expect(stats.payload.captureDropped).toBe(5);
  });

  it('stops traffic and stats, and clears the queue, when capture goes off', () => {
    const { sent, channel, control } = setup();
    control('set-capture', { traffic: true, previewBytes: 1 });
    const ctx = chunk();
    channel.events.chunk(ctx, ctx.data, { data: ctx.data, delayMs: 0 });
    control('set-capture', { traffic: false, previewBytes: 1 });
    const count = sent.length;
    vi.advanceTimersByTime(5000);
    expect(sent).toHaveLength(count);
    channel.events.chunk(ctx, ctx.data, { data: ctx.data, delayMs: 0 });
    vi.advanceTimersByTime(5000);
    expect(sent).toHaveLength(count);
  });

  it('keeps working if the page breaks stringify', () => {
    const { sent, channel, control } = setup();
    const toJSON = (): never => {
      throw new Error('hostile');
    };
    control('set-capture', { traffic: true, previewBytes: 1 });
    const count = sent.length;
    Object.defineProperty(Object.prototype, 'toJSON', { value: toJSON, configurable: true });
    try {
      const ctx = chunk();
      channel.events.chunk(ctx, ctx.data, { data: ctx.data, delayMs: 0 });
      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    } finally {
      delete (Object.prototype as { toJSON?: unknown }).toJSON;
    }
    const ctx = chunk(1);
    channel.events.chunk(ctx, ctx.data, { data: ctx.data, delayMs: 0 });
    vi.advanceTimersByTime(100);
    expect(sent.slice(count).some((m) => m.type === 'traffic')).toBe(true);
  });

  it('the gate opens when the worker answers', async () => {
    const { channel, control } = setup();
    let open = false;
    void channel.gate().then(() => (open = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(open).toBe(false);
    control('set-capture', { traffic: false, previewBytes: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(open).toBe(true);
  });

  it('the gate opens after a timeout if nobody answers', async () => {
    const { channel } = setup();
    let open = false;
    void channel.gate().then(() => (open = true));
    await vi.advanceTimersByTimeAsync(499);
    expect(open).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toBe(true);
  });

  it('applies only a valid config', () => {
    const { runtime, control, toMain } = setup();
    control('set-config', { config: { ...DEFAULT_CONFIG, maxDelayedBytes: -1 }, targetOrigin: 'https://a.test' });
    toMain('not json');
    toMain({ an: 'object' });
    toMain(null);
    expect(runtime.setConfig).not.toHaveBeenCalled();
    control('set-config', { config: DEFAULT_CONFIG, targetOrigin: 'https://a.test' });
    expect(runtime.setConfig).toHaveBeenCalledWith(DEFAULT_CONFIG);
  });

  it('holds only with a panel, and asks for the holds again for a panel that connects', () => {
    const { runtime, control } = setup();
    control('set-capture', { traffic: true, previewBytes: 8 });
    expect(runtime.setHolding).toHaveBeenLastCalledWith(true);
    expect(runtime.announceHolds).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    try {
      control('set-capture', { traffic: false, previewBytes: 8 });
      expect(runtime.setHolding).toHaveBeenLastCalledWith(true);
      vi.advanceTimersByTime(1000);
      expect(runtime.setHolding).toHaveBeenLastCalledWith(false);
      // A panel that comes back in time keeps the holds.
      control('set-capture', { traffic: true, previewBytes: 8 });
      control('set-capture', { traffic: false, previewBytes: 8 });
      control('set-capture', { traffic: true, previewBytes: 8 });
      vi.advanceTimersByTime(1000);
      expect(runtime.setHolding).toHaveBeenLastCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a decision for this frame only, and decodes an edit', () => {
    const { runtime, control } = setup();
    control('hold-resolve', { holdId: 1, workerId: 3, action: 'forward', data: null });
    expect(runtime.resolveHold).not.toHaveBeenCalled();
    control('hold-resolve', { holdId: 1, workerId: null, action: 'drop', data: null });
    expect(runtime.resolveHold).toHaveBeenLastCalledWith(1, { action: 'drop' });
    control('hold-resolve', { holdId: 2, workerId: null, action: 'edit', data: btoa('hi') });
    expect(runtime.resolveHold).toHaveBeenLastCalledWith(2, { action: 'edit', data: new TextEncoder().encode('hi') });
  });

  it('injects for this frame only, and answers with the result', () => {
    const { runtime, control, sent, channel } = setup();
    const passed = vi.fn();
    channel.onControl(passed);
    control('inject', { injectId: 5, sessionId: 1, workerId: 2, kind: 'datagram', data: btoa('a') });
    expect(runtime.inject).not.toHaveBeenCalled();
    // The frame passes on what is for a worker.
    expect(passed).toHaveBeenCalledTimes(1);
    control('inject', { injectId: 5, sessionId: 1, workerId: null, kind: 'uni', data: btoa('a') });
    expect(runtime.inject).toHaveBeenCalledWith(1, 'uni', new TextEncoder().encode('a'));
    expect(sent.at(-1)).toMatchObject({ type: 'inject-result', payload: { injectId: 5, failure: 'not-read' } });
  });
});
