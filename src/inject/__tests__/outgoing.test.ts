import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Rule } from '../../shared/rules';
import { wrapWritable, type OutgoingDeps } from '../outgoing';
import { createPipeline, createStats, type ChunkContext, type PipelineResult } from '../pipeline';

function nativeSink(options: { slow?: boolean } = {}) {
  const written: number[][] = [];
  const state = { closed: false, aborted: null as unknown };
  let release: () => void = () => undefined;
  const stream = new WritableStream<Uint8Array | ArrayBuffer>({
    async write(chunk) {
      if (options.slow) await new Promise<void>((resolve) => (release = resolve));
      written.push([...(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk)]);
    },
    close() {
      state.closed = true;
    },
    abort(reason) {
      state.aborted = reason;
    },
  });
  return { stream, written, state, release: () => release() };
}

const meta = { kind: 'uni' as const, origin: 'local' as const, sessionId: 1, url: 'https://x/', streamId: 1 };

function wrap(native: WritableStream, rules: Rule[] = [], extra: Partial<OutgoingDeps> = {}) {
  const stats = createStats();
  const pipeline = createPipeline({ getConfig: () => ({ ...DEFAULT_CONFIG, rules }), stats, random: () => 0, log: () => undefined });
  const seen: { ctx: ChunkContext; result: PipelineResult }[] = [];
  const wrapped = wrapWritable(native, meta, {
    run: pipeline.run,
    onChunk: () => undefined,
    onResult: (ctx, _input, result) => seen.push({ ctx, result }),
    ...extra,
  });
  return { wrapped, seen, stats };
}

describe('wrapWritable', () => {
  it('passes the same bytes, marks them as outgoing, and closes', async () => {
    const { stream, written, state } = nativeSink();
    const { wrapped, seen } = wrap(stream);
    const writer = wrapped.getWriter();
    await writer.write(Uint8Array.of(1, 2));
    await writer.write(Uint8Array.of(3).buffer);
    await writer.close();
    expect(written).toEqual([[1, 2], [3]]);
    expect(state.closed).toBe(true);
    expect(seen[0]?.ctx.outgoing).toBe(true);
  });

  it('does not lock the native stream before the first write', async () => {
    const { stream } = nativeSink();
    const { wrapped } = wrap(stream);
    const writer = wrapped.getWriter();
    expect(stream.locked).toBe(false);
    await writer.write(Uint8Array.of(1));
    expect(stream.locked).toBe(true);
  });

  it('works with pipeTo', async () => {
    const { stream, written } = nativeSink();
    const { wrapped } = wrap(stream);
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Uint8Array.of(7));
        c.close();
      },
    });
    await source.pipeTo(wrapped);
    expect(written).toEqual([[7]]);
  });

  it('keeps the backpressure: a write waits for the native write', async () => {
    const { stream, written, release } = nativeSink({ slow: true });
    const { wrapped } = wrap(stream);
    const writer = wrapped.getWriter();
    let done = false;
    const pending = writer.write(Uint8Array.of(1)).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    release();
    await pending;
    expect(written).toEqual([[1]]);
  });

  it('applies a rule with direction out, and not one with the default', async () => {
    const { stream, written } = nativeSink();
    const out: Rule = { id: 'o', direction: 'out', match: { contains: [[9]] }, action: { type: 'modify', ops: [{ op: 'set', data: [8] }] } };
    const inward: Rule = { id: 'i', action: { type: 'drop' } };
    const { wrapped } = wrap(stream, [inward, out]);
    const writer = wrapped.getWriter();
    await writer.write(Uint8Array.of(9));
    await writer.write(Uint8Array.of(5));
    expect(written).toEqual([[8], [5]]);
  });

  it('drops a chunk with no error for the app', async () => {
    const { stream, written } = nativeSink();
    const { wrapped, stats } = wrap(stream, [{ id: 'd', direction: 'both', action: { type: 'drop' } }]);
    await wrapped.getWriter().write(Uint8Array.of(1));
    expect(written).toEqual([]);
    expect(stats.uni.dropped).toBe(1);
  });

  it('uses the edit of a hold', async () => {
    const { stream, written } = nativeSink();
    const stats = createStats();
    const pipeline = createPipeline({
      getConfig: () => ({ ...DEFAULT_CONFIG, rules: [{ id: 'h', direction: 'out', action: { type: 'hold', timeoutMs: 1000, onTimeout: 'forward' } }] }),
      stats,
      random: () => 0,
      log: () => undefined,
      canHold: () => true,
    });
    const wrapped = wrapWritable(stream, meta, {
      run: pipeline.run,
      onChunk: () => undefined,
      hold: () => ({ decision: Promise.resolve({ action: 'edit', data: Uint8Array.of(4) }), cancel: () => undefined }),
    });
    await wrapped.getWriter().write(Uint8Array.of(1));
    expect(written).toEqual([[4]]);
  });

  it('passes an abort, and a native error reaches the app', async () => {
    const { stream, state } = nativeSink();
    const { wrapped } = wrap(stream);
    const writer = wrapped.getWriter();
    await writer.write(Uint8Array.of(1));
    await writer.abort('why');
    expect(state.aborted).toBe('why');

    const failing = new WritableStream({
      write() {
        throw new Error('native');
      },
    });
    const other = wrap(failing).wrapped.getWriter();
    await expect(other.write(Uint8Array.of(1))).rejects.toThrow('native');
  });

  it('forwards members of a send stream to the native object', async () => {
    const { stream } = nativeSink();
    class SendStream extends WritableStream {}
    const native = stream as WritableStream & { sendOrder: number };
    Object.setPrototypeOf(native, SendStream.prototype);
    let order = 0;
    Object.defineProperty(SendStream.prototype, 'sendOrder', { get: () => order, set: (v: number) => (order = v), configurable: true });
    Object.defineProperty(SendStream.prototype, 'getStats', { value: () => 'stats', configurable: true });
    const wrapped = wrap(native).wrapped as WritableStream & { sendOrder: number; getStats(): string };
    wrapped.sendOrder = 5;
    expect(order).toBe(5);
    expect(wrapped.getStats()).toBe('stats');
    expect(wrapped instanceof SendStream).toBe(true);
    expect(wrapped.locked).toBe(false);
  });

  it('gives the native TypeError for a value that is not bytes', async () => {
    const native = new WritableStream({
      write(chunk) {
        if (typeof chunk === 'string') throw new TypeError('bad');
      },
    });
    await expect(wrap(native).wrapped.getWriter().write('text')).rejects.toThrow('bad');
  });
});
