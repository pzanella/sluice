import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wrapByteStream } from '../byte-stream';
import { createHoldQueue, MAX_HELD, type HeldChunk, type HoldOffer } from '../hold';
import type { ChunkContext, PipelineResult } from '../pipeline';

const ctx = (): ChunkContext => ({ kind: 'uni', origin: 'remote', sessionId: 1, url: 'https://a.test', streamId: 1, seq: 0, data: new Uint8Array(1) });
const offer = (onTimeout: HoldOffer['onTimeout'] = 'forward', timeoutMs = 1000): HoldOffer => ({ ruleId: 'r', timeoutMs, onTimeout });

function queue() {
  const announced: HeldChunk[] = [];
  const ended: [number, string][] = [];
  const holds = createHoldQueue({
    announce: (chunk) => announced.push(chunk),
    ended: (id, outcome) => ended.push([id, outcome]),
    setTimeout,
    clearTimeout,
    now: () => Date.now(),
  });
  holds.setActive(true);
  return { holds, announced, ended };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('hold queue', () => {
  it('accepts nothing with no panel', () => {
    const { holds } = queue();
    holds.setActive(false);
    expect(holds.accepting()).toBe(false);
  });

  it.each([
    ['forward', 'forward', 'timeout-forwarded'],
    ['drop', 'drop', 'timeout-dropped'],
  ] as const)('on timeout with %s', async (onTimeout, action, outcome) => {
    const { holds, ended } = queue();
    const { decision } = holds.hold(ctx(), new Uint8Array(1), offer(onTimeout));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await decision).toEqual({ action });
    expect(ended).toEqual([[1, outcome]]);
  });

  it('a decision stops the timer, and counts once', async () => {
    const { holds, ended } = queue();
    const { decision } = holds.hold(ctx(), new Uint8Array(1), offer('drop'));
    holds.resolve(1, { action: 'forward' });
    holds.resolve(1, { action: 'drop' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await decision).toEqual({ action: 'forward' });
    expect(ended).toEqual([[1, 'forwarded']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an unknown id does nothing, and an empty edit is a drop', async () => {
    const { holds, ended } = queue();
    holds.resolve(99, { action: 'forward' });
    expect(ended).toEqual([]);
    const { decision } = holds.hold(ctx(), new Uint8Array(1), offer());
    holds.resolve(1, { action: 'edit', data: new Uint8Array() });
    expect(await decision).toEqual({ action: 'drop' });
  });

  it('a panel that leaves ends all holds with the action of each', async () => {
    const { holds } = queue();
    const a = holds.hold(ctx(), new Uint8Array(1), offer('forward'));
    const b = holds.hold(ctx(), new Uint8Array(1), offer('drop'));
    holds.setActive(false);
    expect(await a.decision).toEqual({ action: 'forward' });
    expect(await b.decision).toEqual({ action: 'drop' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('has a limit, and a new panel gets the time that is left', async () => {
    const { holds, announced } = queue();
    for (let i = 0; i < MAX_HELD; i++) holds.hold(ctx(), new Uint8Array(1), offer());
    expect(holds.accepting()).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    announced.length = 0;
    holds.announceAll();
    expect(announced).toHaveLength(MAX_HELD);
    expect(announced[0]?.timeoutMs).toBe(600);
  });

  it('cancel gives gone', async () => {
    const { holds, ended } = queue();
    const { decision, cancel } = holds.hold(ctx(), new Uint8Array(1), offer());
    cancel();
    expect(await decision).toEqual({ action: 'gone' });
    expect(ended).toEqual([[1, 'gone']]);
  });
});

describe('held chunks in a stream', () => {
  const bytes = (value: number): Uint8Array<ArrayBuffer> => Uint8Array.of(value);

  /** Holds the chunks with the given values. The test decides each with `decide`. */
  function setup(chunks: number[], held: number[], kind: ChunkContext['kind'] = 'uni', preserveOrder = true, reads: number[] = []) {
    let close!: () => void;
    let failNative!: (err: unknown) => void;
    const cancelled = vi.fn();
    const native = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        for (const value of chunks) controller.enqueue(bytes(value));
        close = () => controller.close();
        failNative = (err) => controller.error(err);
      },
      cancel: cancelled,
    });
    const holds = createHoldQueue({ announce: () => undefined, ended: () => undefined, setTimeout, clearTimeout, now: () => Date.now() });
    holds.setActive(true);
    const results: PipelineResult[] = [];
    const stream = wrapByteStream(
      native,
      { kind, origin: 'remote', sessionId: 1, url: 'https://a.test', streamId: kind === 'datagram' ? null : 1 },
      {
        run: (c) => (reads.push(c.data[0] as number), held.includes(c.data[0] as number)) ? { data: c.data, delayMs: 0, hold: offer('forward', 10_000) } : { data: c.data, delayMs: 0 },
        onChunk: () => undefined,
        // A copy: the delivery takes the buffer.
        onResult: (_c, _i, result) => results.push({ ...result, data: result.data && result.data.slice() }),
        maxDelayedBytes: () => 1024,
        preserveOrder: () => preserveOrder,
        hold: holds.hold,
      },
    );
    return { stream, holds, results, close: () => close(), fail: (err: unknown) => failNative(err), cancelled };
  }

  const read = async (stream: ReadableStream<Uint8Array>): Promise<number[]> => {
    const reader = stream.getReader();
    const out: number[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return out;
      out.push(...value);
    }
  };

  it('no chunk passes a held one, and the stream closes only after it', async () => {
    const { stream, holds, close } = setup([1, 2, 3], [1]);
    const all = read(stream);
    await vi.advanceTimersByTimeAsync(10);
    close();
    await vi.advanceTimersByTimeAsync(10);
    holds.resolve(1, { action: 'forward' });
    expect(await all).toEqual([1, 2, 3]);
  });

  it('an edit replaces the chunk, on a plain buffer. A drop removes it, and the rest goes on', async () => {
    const { stream, holds, close, results } = setup([1, 2, 3], [1, 2]);
    const all = read(stream);
    await vi.advanceTimersByTimeAsync(10);
    close();
    holds.resolve(1, { action: 'edit', data: Uint8Array.of(9, 9) });
    await vi.advanceTimersByTimeAsync(10);
    holds.resolve(2, { action: 'drop' });
    expect(await all).toEqual([9, 9, 3]);
    expect(results.map((r) => r.data && [...r.data])).toEqual([[9, 9], null, [3]]);
  });

  it('reads no more of this stream while a chunk is held, so it uses no budget of the session', async () => {
    const reads: number[] = [];
    const { stream, holds, close } = setup([1, 2, 3], [1], 'uni', true, reads);
    const all = read(stream);
    await vi.advanceTimersByTimeAsync(10);
    expect(reads).toEqual([1]);
    holds.resolve(1, { action: 'forward' });
    await vi.advanceTimersByTimeAsync(10);
    expect(reads).toEqual([1, 2, 3]);
    close();
    expect(await all).toEqual([1, 2, 3]);
  });

  it('a delay runs from the decision', async () => {
    const native = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(bytes(1));
        controller.enqueue(bytes(2));
        controller.close();
      },
    });
    const holds = createHoldQueue({ announce: () => undefined, ended: () => undefined, setTimeout, clearTimeout, now: () => Date.now() });
    holds.setActive(true);
    const stream = wrapByteStream(
      native,
      { kind: 'uni', origin: 'remote', sessionId: 1, url: 'https://a.test', streamId: 1 },
      {
        run: (c) => (c.data[0] === 1 ? { data: c.data, delayMs: 100, hold: offer('forward', 10_000) } : { data: c.data, delayMs: 100 }),
        onChunk: () => undefined,
        maxDelayedBytes: () => 1024,
        preserveOrder: () => true,
        hold: holds.hold,
      },
    );
    const reader = stream.getReader();
    const first = reader.read();
    await vi.advanceTimersByTimeAsync(5000);
    holds.resolve(1, { action: 'forward' });
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).value).toEqual(Uint8Array.of(1));
  });

  it('a BYOB read with min gets edited bytes, and the end', async () => {
    const { stream, holds, close } = setup([1], [1]);
    const reader = stream.getReader({ mode: 'byob' });
    const pending = reader.read(new Uint8Array(8), { min: 8 });
    await vi.advanceTimersByTimeAsync(10);
    close();
    holds.resolve(1, { action: 'edit', data: Uint8Array.of(7, 7) });
    const { value } = await pending;
    expect(value).toEqual(Uint8Array.of(7, 7));
  });

  it('with reordering allowed, a datagram can pass a held one', async () => {
    const { stream, holds, close } = setup([1, 2], [1], 'datagram', false);
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual(Uint8Array.of(2));
    holds.resolve(1, { action: 'forward' });
    expect((await reader.read()).value).toEqual(Uint8Array.of(1));
    close();
    expect((await reader.read()).done).toBe(true);
  });

  it('time running out frees the stream', async () => {
    const { stream, close } = setup([1], [1]);
    const all = read(stream);
    await vi.advanceTimersByTimeAsync(10);
    close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await all).toEqual([1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the app cancelling ends the hold and its timer, with no result to report', async () => {
    const { stream, results, cancelled } = setup([1], [1]);
    const reader = stream.getReader();
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(10);
    await reader.cancel('stop');
    expect((await pending).done).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(results).toEqual([]);
    expect(cancelled).toHaveBeenCalled();
  });

  it('a native error reaches the app at once, with a chunk still held', async () => {
    const { stream, fail } = setup([1], [1]);
    const reader = stream.getReader();
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(10);
    fail(new Error('boom'));
    await expect(pending).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
