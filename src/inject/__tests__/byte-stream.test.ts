import { afterEach, describe, expect, it, vi } from 'vitest';
import { DelayBudget, wrapByteStream, wrapStreamOfStreams, type ByteStreamDeps, type StreamMeta } from '../byte-stream';
import { makeDeps, meta, readAll, settle } from './helpers';
import { NativeSource } from './mock-webtransport';

afterEach(() => {
  vi.useRealTimers();
});

const wrap = (src: NativeSource, deps = makeDeps(), m: StreamMeta = meta) =>
  wrapByteStream(src.stream, m, deps);

/** Run function with a delay for each chunk, picked by seq. */
const delaysBySeq = (delays: number[]) => (ctx: { seq: number; data: Uint8Array<ArrayBuffer> }) => ({
  data: ctx.data,
  delayMs: delays[ctx.seq] ?? 0,
});

describe('invariant 3: byte stream', () => {
  it('invariant 3: wrapped stream is a byte stream that supports a default reader', async () => {
    const src = new NativeSource().push('ab', 'cd');
    src.close();
    const reader = wrap(src).getReader();
    expect(await readAll(reader)).toEqual([[97, 98], [99, 100]]);
  });

  it('invariant 3: a BYOB reader works on the wrapped stream', async () => {
    const src = new NativeSource().push([1, 2, 3, 4]);
    const reader = wrap(src).getReader({ mode: 'byob' });
    const { value, done } = await reader.read(new Uint8Array(16));
    expect(done).toBe(false);
    expect(Array.from(value ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('invariant 3: a BYOB reader reads a chunk larger than its buffer in parts', async () => {
    const src = new NativeSource().push([1, 2, 3, 4, 5]);
    src.close();
    const reader = wrap(src).getReader({ mode: 'byob' });
    const got: number[] = [];
    for (;;) {
      const { value, done } = await reader.read(new Uint8Array(2));
      if (done) break;
      got.push(...value);
    }
    expect(got).toEqual([1, 2, 3, 4, 5]);
  });

  it('invariant 3: a pending BYOB read resolves done on close (respond(0))', async () => {
    const src = new NativeSource();
    const reader = wrap(src).getReader({ mode: 'byob' });
    const pending = reader.read(new Uint8Array(8));
    await settle();
    src.close();
    const result = await pending;
    expect(result.done).toBe(true);
    expect(result.value?.byteLength).toBe(0);
  });

  it('invariant 3: after data and close, the next BYOB read is done', async () => {
    const src = new NativeSource().push('xy');
    src.close();
    const reader = wrap(src).getReader({ mode: 'byob' });
    const first = await reader.read(new Uint8Array(8));
    expect(first.done).toBe(false);
    const second = await reader.read(new Uint8Array(8));
    expect(second.done).toBe(true);
  });

  it('invariant 3: zero-length native chunks are skipped', async () => {
    const run = vi.fn((ctx: { data: Uint8Array<ArrayBuffer> }) => ({ data: ctx.data, delayMs: 0 }));
    const src = new NativeSource(false);
    src.pushEmpty().push('a').pushEmpty().push('b');
    src.close();
    const out = await readAll(wrap(src, makeDeps({ run })).getReader());
    expect(out).toEqual([[97], [98]]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('invariant 3: zero-length native chunks do not call onChunk', async () => {
    const onChunk = vi.fn();
    const src = new NativeSource(false);
    src.pushEmpty().push('abc');
    src.close();
    await readAll(wrap(src, makeDeps({ onChunk })).getReader());
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith(3);
  });

  it('invariant 3: rule output with empty data is skipped and the stream keeps working', async () => {
    const run = (ctx: { seq: number; data: Uint8Array<ArrayBuffer> }) => ({
      data: ctx.seq === 0 ? new Uint8Array(0) : ctx.data,
      delayMs: 0,
    });
    const src = new NativeSource().push('a', 'b');
    src.close();
    expect(await readAll(wrap(src, makeDeps({ run })).getReader())).toEqual([[98]]);
  });

  it('invariant 3: null rule output (drop) is skipped', async () => {
    const run = (ctx: { seq: number; data: Uint8Array<ArrayBuffer> }) => ({
      data: ctx.seq === 1 ? null : ctx.data,
      delayMs: 0,
    });
    const src = new NativeSource().push('a', 'b', 'c');
    src.close();
    expect(await readAll(wrap(src, makeDeps({ run })).getReader())).toEqual([[97], [99]]);
  });

  it('invariant 3: a rule can change the chunk size', async () => {
    const run = () => ({ data: Uint8Array.of(9, 9, 9, 9, 9, 9), delayMs: 0 });
    const src = new NativeSource().push('a');
    src.close();
    expect(await readAll(wrap(src, makeDeps({ run })).getReader())).toEqual([[9, 9, 9, 9, 9, 9]]);
  });

  it('invariant 3: seq counts only real chunks and starts at 0', async () => {
    const seqs: number[] = [];
    const run = (ctx: { seq: number; data: Uint8Array<ArrayBuffer> }) => {
      seqs.push(ctx.seq);
      return { data: ctx.data, delayMs: 0 };
    };
    const src = new NativeSource(false);
    src.push('a').pushEmpty().push('b');
    src.close();
    await readAll(wrap(src, makeDeps({ run })).getReader());
    expect(seqs).toEqual([0, 1]);
  });

  it('invariant 3: getStats of the native stream is forwarded', async () => {
    const src = new NativeSource();
    const native = Object.assign(src.stream, { getStats: () => Promise.resolve({ bytesReceived: 7 }) });
    const wrapped = wrapByteStream(native, meta, makeDeps()) as ReadableStream<Uint8Array> & {
      getStats?: () => Promise<unknown>;
    };
    expect(await wrapped.getStats?.()).toEqual({ bytesReceived: 7 });
  });
});

describe('invariant 4: backpressure', () => {
  const chunk = '1234'; // 4 bytes

  it('invariant 4: the pump reads one chunk ahead and stops when the app does not read', async () => {
    const src = new NativeSource();
    for (let i = 0; i < 20; i++) src.push(chunk);
    wrap(src);
    await settle();
    expect(src.served).toBe(1);
    await settle();
    expect(src.served).toBe(1);
  });

  it('invariant 4: the pump resumes when the app reads, with no read pending after it', async () => {
    const src = new NativeSource();
    for (let i = 0; i < 20; i++) src.push(chunk);
    const reader = wrap(src).getReader();
    await settle();
    await reader.read();
    await settle();
    expect(src.served).toBe(2);
  });

  it('bytes that arrive while the app is slow come in one read, not in many tiny chunks', async () => {
    // A native byte stream merges nothing by itself, so model the browser: one read returns all that arrived.
    let pending: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    const native = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(c) {
        if (pending.length > 0) {
          c.enqueue(pending);
          pending = new Uint8Array(0);
        }
      },
    });
    const arrive = (n: number) => void (pending = new Uint8Array(pending.length + n));
    arrive(100);
    const reader = wrapByteStream(native, meta, makeDeps()).getReader();
    await settle();
    arrive(100);
    arrive(100);
    arrive(100);
    expect((await reader.read()).value?.length).toBe(100);
    await settle();
    expect((await reader.read()).value?.length).toBe(300);
  });

  it('invariant 4: a pending read is served with no wait on the queue rule', async () => {
    const src = new NativeSource();
    const reader = wrap(src).getReader();
    const read = reader.read();
    await settle();
    src.push(chunk);
    expect(Array.from((await read).value ?? [])).toHaveLength(4);
  });

  it('invariant 4: the limit on delayed bytes is read again at each check', async () => {
    vi.useFakeTimers();
    let limit = 10;
    const src = new NativeSource();
    for (let i = 0; i < 20; i++) src.push(chunk);
    const reader = wrap(src, makeDeps({ maxDelayedBytes: () => limit, run: delaysBySeq(Array(20).fill(1000)) })).getReader();
    await settle();
    expect(src.served).toBe(3);
    limit = 1_000_000;
    const read = reader.read();
    await vi.advanceTimersByTimeAsync(1000);
    await read;
    await vi.advanceTimersByTimeAsync(0);
    expect(src.served).toBeGreaterThan(3);
  });

  it('invariant 4: bytes held by delays count against the threshold', async () => {
    vi.useFakeTimers();
    const src = new NativeSource();
    for (let i = 0; i < 20; i++) src.push(chunk);
    wrap(src, makeDeps({ maxDelayedBytes: () => 10, run: delaysBySeq(Array(20).fill(1000)) }));
    await settle();
    // Nothing is queued for the app yet, but 12 bytes wait in timers.
    expect(src.served).toBe(3);
  });

  it('invariant 4: delayed bytes are released from the count when delivered', async () => {
    vi.useFakeTimers();
    const src = new NativeSource();
    for (let i = 0; i < 20; i++) src.push(chunk);
    const reader = wrap(src, makeDeps({ maxDelayedBytes: () => 10, run: delaysBySeq(Array(20).fill(1000)) })).getReader();
    await settle();
    expect(src.served).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    // Two reads: the first chunk, then the other two as one (ADR-26).
    for (let i = 0; i < 2; i++) await reader.read();
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(0);
    expect(src.served).toBeGreaterThan(3);
    void next;
  });
});

describe('delay budget of a session', () => {
  const chunk = (size: number): Uint8Array<ArrayBuffer> => new Uint8Array(size).fill(1);

  const setupStream = (budget: DelayBudget, delayMs: number) => {
    let controller!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    let pulls = 0;
    const native = new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        start(c) {
          controller = c;
        },
        pull() {
          pulls++;
        },
      },
      { highWaterMark: 0 },
    );
    const run = vi.fn<ByteStreamDeps['run']>((ctx) => ({ data: ctx.data, delayMs }));
    const wrapped = wrapByteStream(native, meta, makeDeps({ run, maxDelayedBytes: () => 100, budget }));
    return { wrapped, run, send: (size: number) => controller.enqueue(chunk(size)), pulls: () => pulls };
  };

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));

  it('bytes that one stream delays stop the other streams of the session', async () => {
    const budget = new DelayBudget();
    const a = setupStream(budget, 40);
    const b = setupStream(budget, 40);
    a.send(150);
    await tick();
    // The read of b was already pending, so one chunk passes: the limit can be passed by one chunk for each stream.
    b.send(10);
    await tick();
    b.send(10);
    await tick();
    expect(a.run).toHaveBeenCalledOnce();
    expect(b.run).toHaveBeenCalledOnce();
  });

  it('a stream waiting for the budget wakes when another stream frees it', async () => {
    const budget = new DelayBudget();
    const a = setupStream(budget, 30);
    const b = setupStream(budget, 0);
    // Someone must read b: a chunk still in its queue would also stop its pump, whatever the budget says.
    void b.wrapped.pipeTo(new WritableStream());
    a.send(150);
    await tick();
    b.send(10);
    await tick();
    b.send(10);
    await tick();
    expect(b.run).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(b.run).toHaveBeenCalledTimes(2));
  });

  it('a stream waits in the budget only while it waits, and leaves on cancel', async () => {
    const budget = new DelayBudget();
    const a = setupStream(budget, 0);
    await tick();
    expect(budget.waiting).toBe(0);
    a.send(10);
    await tick();
    expect(budget.waiting).toBe(1);
    await a.wrapped.cancel();
    expect(budget.waiting).toBe(0);
  });

  it('a cancelled stream gives back what it held', async () => {
    const budget = new DelayBudget();
    const a = setupStream(budget, 60_000);
    a.send(150);
    await tick();
    expect(budget.isOver(100)).toBe(true);
    await a.wrapped.cancel();
    await vi.waitFor(() => expect(budget.isOver(100)).toBe(false));
  });

  it('a stream with no budget of the session has its own', async () => {
    const first = setupStream(new DelayBudget(), 40);
    const second = setupStream(new DelayBudget(), 0);
    first.send(150);
    await tick();
    second.send(10);
    await vi.waitFor(() => expect(second.run).toHaveBeenCalledOnce());
  });
});

describe('invariant 5: order', () => {
  it('invariant 5: stream chunks stay in order with jitter (first chunk is the slowest)', async () => {
    vi.useFakeTimers();
    const src = new NativeSource().push('a', 'b', 'c', 'd');
    src.close();
    const reader = wrap(src, makeDeps({ run: delaysBySeq([400, 10, 300, 20]) })).getReader();
    const done = readAll(reader);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toEqual([[97], [98], [99], [100]]);
  });

  it('invariant 5: a delayed chunk blocks the following undelayed chunk on streams', async () => {
    vi.useFakeTimers();
    const src = new NativeSource().push('a', 'b');
    src.close();
    const reader = wrap(src, makeDeps({ run: delaysBySeq([100, 0]) })).getReader();
    const first = reader.read();
    await vi.advanceTimersByTimeAsync(50);
    let settled = false;
    void first.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    expect(Array.from((await first).value ?? [])).toEqual([97]);
    expect(Array.from((await reader.read()).value ?? [])).toEqual([98]);
  });

  it('invariant 5: streams stay in order even when preserveOrder is false', async () => {
    vi.useFakeTimers();
    const src = new NativeSource().push('a', 'b');
    src.close();
    const deps = makeDeps({ run: delaysBySeq([100, 10]), preserveOrder: () => false });
    const done = readAll(wrap(src, deps, { ...meta, kind: 'bidi' }).getReader());
    await vi.advanceTimersByTimeAsync(500);
    expect(await done).toEqual([[97], [98]]);
  });

  it('invariant 5: datagrams stay in order by default even with jitter', async () => {
    vi.useFakeTimers();
    const src = new NativeSource().push('a', 'b', 'c');
    src.close();
    const deps = makeDeps({ run: delaysBySeq([300, 10, 100]), preserveOrder: () => true });
    const done = readAll(wrap(src, deps, { ...meta, kind: 'datagram', streamId: null }).getReader());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toEqual([[97], [98], [99]]);
  });

  it('invariant 5: datagrams reorder with delay > 0 and preserveOrder false', async () => {
    vi.useFakeTimers();
    const src = new NativeSource().push('a', 'b', 'c');
    src.close();
    const deps = makeDeps({ run: delaysBySeq([300, 10, 100]), preserveOrder: () => false });
    const done = readAll(wrap(src, deps, { ...meta, kind: 'datagram', streamId: null }).getReader());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await done).toEqual([[98], [99], [97]]);
  });

  it('invariant 5: with preserveOrder false, an undelayed datagram passes a delayed one', async () => {
    vi.useFakeTimers();
    const src = new NativeSource().push('a', 'b');
    src.close();
    const deps = makeDeps({ run: delaysBySeq([100, 0]), preserveOrder: () => false });
    const done = readAll(wrap(src, deps, { ...meta, kind: 'datagram', streamId: null }).getReader());
    await vi.advanceTimersByTimeAsync(500);
    expect(await done).toEqual([[98], [97]]);
  });

  it('invariant 5: with preserveOrder false and no delay, order is kept', async () => {
    const src = new NativeSource().push('a', 'b', 'c');
    src.close();
    const deps = makeDeps({ preserveOrder: () => false });
    expect(await readAll(wrap(src, deps, { ...meta, kind: 'datagram', streamId: null }).getReader())).toEqual([
      [97],
      [98],
      [99],
    ]);
  });
});

describe('invariant 6: end of stream', () => {
  it('invariant 6: FIN waits for delayed deliveries', async () => {
    vi.useFakeTimers();
    const src = new NativeSource().push('a', 'b');
    src.close();
    const reader = wrap(src, makeDeps({ run: delaysBySeq([100, 200]) })).getReader();
    let ended = false;
    const all = readAll(reader).then((r) => {
      ended = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(await all).toEqual([[97], [98]]);
  });

  it('invariant 6: FIN waits for delayed datagrams that can be reordered', async () => {
    vi.useFakeTimers();
    const src = new NativeSource().push('a');
    src.close();
    const deps = makeDeps({ run: delaysBySeq([100]), preserveOrder: () => false });
    const all = readAll(wrap(src, deps, { ...meta, kind: 'datagram', streamId: null }).getReader());
    await vi.advanceTimersByTimeAsync(200);
    expect(await all).toEqual([[97]]);
  });

  it('invariant 6: FIN with no data closes the stream', async () => {
    const src = new NativeSource();
    src.close();
    expect(await readAll(wrap(src).getReader())).toEqual([]);
  });

  it('invariant 6: a native error reaches the app at once', async () => {
    const src = new NativeSource();
    const reader = wrap(src).getReader();
    const read = reader.read();
    await settle();
    const boom = new Error('boom');
    src.error(boom);
    await expect(read).rejects.toBe(boom);
  });

  it('invariant 6: a native error reaches the app while delays are pending', async () => {
    vi.useFakeTimers();
    const src = new NativeSource().push('a', 'b');
    const reader = wrap(src, makeDeps({ run: delaysBySeq([10_000, 10_000]) })).getReader();
    await settle();
    const boom = new Error('late boom');
    src.error(boom);
    // No timer advance: the error must not wait for the delays.
    await expect(reader.read()).rejects.toBe(boom);
  });

  it('invariant 6: a native error reaches the app while the pump waits on backpressure', async () => {
    const src = new NativeSource();
    for (let i = 0; i < 10; i++) src.push('1234');
    const reader = wrap(src).getReader();
    await settle();
    expect(src.served).toBe(1);
    const boom = new Error('blocked boom');
    src.error(boom);
    await settle(); // The error crosses a few promise hops, so give it one tick.
    await expect(reader.read()).rejects.toBe(boom);
  });

  it('invariant 6: after a native error no timer is left', async () => {
    vi.useFakeTimers();
    const src = new NativeSource().push('a', 'b', 'c');
    wrap(src, makeDeps({ run: delaysBySeq([1000, 1000, 1000]) }));
    await settle();
    src.error(new Error('x'));
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('invariant 6: a rule that throws errors the app stream', async () => {
    const boom = new Error('rule crashed');
    const src = new NativeSource().push('a');
    const reader = wrap(src, makeDeps({ run: () => { throw boom; } })).getReader();
    await expect(reader.read()).rejects.toBe(boom);
  });
});

describe('invariant 7: app cancel', () => {
  it('invariant 7: the cancel reason reaches the native reader', async () => {
    const src = new NativeSource();
    const reader = wrap(src).getReader();
    await settle();
    const reason = new Error('app is done');
    await reader.cancel(reason);
    expect(src.cancelled).toBe(true);
    expect(src.cancelReason).toBe(reason);
  });

  it('invariant 7: cancel works while the pump waits on backpressure', async () => {
    const src = new NativeSource();
    for (let i = 0; i < 10; i++) src.push('1234');
    const reader = wrap(src, makeDeps({ maxDelayedBytes: () => 10 })).getReader();
    await settle();
    await reader.cancel('stop');
    expect(src.cancelReason).toBe('stop');
  });

  it('invariant 7: timers are cleared and nothing is delivered after cancel (one pending chunk)', async () => {
    vi.useFakeTimers();
    const src = new NativeSource().push('a');
    const stream = wrap(src, makeDeps({ run: delaysBySeq([1000]) }));
    const reader = stream.getReader();
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    await reader.cancel('x');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await reader.read()).done).toBe(true);
  });

  it('invariant 7: timers are cleared after cancel (many pending ordered chunks)', async () => {
    vi.useFakeTimers();
    const src = new NativeSource().push('a', 'b', 'c', 'd');
    const reader = wrap(src, makeDeps({ run: delaysBySeq([1000, 1000, 1000, 1000]) })).getReader();
    await settle();
    await reader.cancel('x');
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('invariant 7: timers are cleared after cancel (delayed datagrams that can be reordered)', async () => {
    vi.useFakeTimers();
    const src = new NativeSource().push('a', 'b', 'c');
    const deps = makeDeps({ run: delaysBySeq([1000, 2000, 3000]), preserveOrder: () => false });
    const reader = wrap(src, deps, { ...meta, kind: 'datagram', streamId: null }).getReader();
    await settle();
    expect(vi.getTimerCount()).toBe(3);
    await reader.cancel('x');
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('invariant 7: native chunks after cancel are not read', async () => {
    const src = new NativeSource();
    const reader = wrap(src).getReader();
    await settle();
    await reader.cancel('x');
    const before = src.served;
    src.push('late');
    await settle();
    expect(src.served).toBe(before);
  });
});

describe('wrapStreamOfStreams', () => {
  it('wraps each item when the app asks for it', async () => {
    const items = new ReadableStream<number>({
      start(c) {
        c.enqueue(1);
        c.enqueue(2);
        c.close();
      },
    });
    const reader = wrapStreamOfStreams(items, (n) => n * 10).getReader();
    expect((await reader.read()).value).toBe(10);
    expect((await reader.read()).value).toBe(20);
    expect((await reader.read()).done).toBe(true);
  });

  it('does not accept streams before the app reads (highWaterMark 0)', async () => {
    const pulls = vi.fn();
    const items = new ReadableStream<number>(
      {
        pull(c) {
          pulls();
          c.enqueue(1);
        },
      },
      { highWaterMark: 0 },
    );
    wrapStreamOfStreams(items, (n) => n);
    await settle();
    // The wrapper holds one pending read on the source, but it does not pull more.
    expect(pulls.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('forwards cancel with the reason', async () => {
    const cancel = vi.fn();
    const items = new ReadableStream<number>({ cancel });
    await wrapStreamOfStreams(items, (n) => n).cancel('why');
    expect(cancel).toHaveBeenCalledWith('why');
  });

  it('forwards a native error', async () => {
    const boom = new Error('boom');
    const items = new ReadableStream<number>({ start: (c) => c.error(boom) });
    await expect(wrapStreamOfStreams(items, (n) => n).getReader().read()).rejects.toBe(boom);
  });
});
