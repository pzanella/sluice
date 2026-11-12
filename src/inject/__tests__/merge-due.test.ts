import { describe, expect, it } from 'vitest';
import { DelayBudget, wrapByteStream } from '../byte-stream';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends `count` chunks of `size` bytes, each `gap` ms after the last. */
function source(count: number, size: number, gap = 1): ReadableStream<Uint8Array<ArrayBuffer>> {
  let n = 0;
  return new ReadableStream({
    async pull(controller) {
      if (n >= count) return controller.close();
      if (gap) await sleep(gap);
      controller.enqueue(new Uint8Array(size).fill(n++ % 251));
    },
  });
}

function wrap(native: ReadableStream<Uint8Array<ArrayBuffer>>, kind: 'uni' | 'datagram', delayMs: number, budget = new DelayBudget()) {
  return wrapByteStream(native, { kind, origin: 'remote', sessionId: 1, url: 'https://x/', streamId: kind === 'uni' ? 1 : null }, {
    run: (ctx) => ({ data: ctx.data, delayMs }),
    onChunk: () => undefined,
    maxDelayedBytes: () => 1e7,
    preserveOrder: () => true,
    budget,
  });
}

const expected = (count: number, size: number): number[] => {
  const out: number[] = [];
  for (let n = 0; n < count; n++) for (let i = 0; i < size; i++) out.push(n % 251);
  return out;
};

async function readAll(stream: ReadableStream<Uint8Array>, pause: number) {
  const reader = stream.getReader();
  const out: number[] = [];
  let reads = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return { out, reads };
    reads++;
    out.push(...value);
    if (pause) await sleep(pause);
  }
}

describe('merge of due chunks (ADR-26)', () => {
  it('gives a slow reader fewer, larger chunks, with the same bytes', async () => {
    const { out, reads } = await readAll(wrap(source(40, 100), 'uni', 30), 15);
    expect(out).toEqual(expected(40, 100));
    expect(reads).toBeLessThan(40);
  });

  it('gives a fast reader all bytes, and closes', async () => {
    const { out } = await readAll(wrap(source(30, 50), 'uni', 5), 0);
    expect(out).toEqual(expected(30, 50));
  });

  it('never merges datagrams', async () => {
    const { reads, out } = await readAll(wrap(source(20, 10), 'datagram', 10), 15);
    expect(reads).toBe(20);
    expect(out).toEqual(expected(20, 10));
  });

  it('works with BYOB and a small buffer', async () => {
    const reader = wrap(source(20, 100), 'uni', 20).getReader({ mode: 'byob' });
    const out: number[] = [];
    for (;;) {
      await sleep(5);
      const { value, done } = await reader.read(new Uint8Array(64));
      if (done) break;
      out.push(...value);
    }
    expect(out).toEqual(expected(20, 100));
  });

  it('frees the budget when the app cancels', async () => {
    const budget = new DelayBudget();
    const stream = wrap(source(50, 100), 'uni', 5, budget);
    const reader = stream.getReader();
    await reader.read();
    await sleep(60);
    await reader.cancel();
    await sleep(20);
    expect(budget.isOver(0)).toBe(false);
  });

  it('frees the budget at the end', async () => {
    const budget = new DelayBudget();
    await readAll(wrap(source(20, 100), 'uni', 10, budget), 5);
    expect(budget.isOver(0)).toBe(false);
  });
});
