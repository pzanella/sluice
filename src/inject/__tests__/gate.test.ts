// Invariant 10: the first read of the pump waits at the gate, and nothing there can get stuck.
import { describe, expect, it, vi } from 'vitest';
import { wrapByteStream, type ByteStreamDeps } from '../byte-stream';

const meta = { kind: 'uni', origin: 'remote', sessionId: 1, url: 'https://a.test/', streamId: 1 } as const;

function setup(chunks: number[][] = [[1, 2]]) {
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const run = vi.fn<ByteStreamDeps['run']>((ctx) => ({ data: ctx.data, delayMs: 0 }));
  const cancelled = vi.fn();
  let fail: (err: unknown) => void = () => undefined;
  const native = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      fail = (err) => controller.error(err);
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
    },
    cancel: cancelled,
  });
  const deps: ByteStreamDeps = { run, onChunk: () => undefined, maxDelayedBytes: () => 1024, preserveOrder: () => true, gate: () => gate };
  return { wrapped: wrapByteStream(native, meta, deps), openGate, run, cancelled, fail: (err: unknown) => fail(err) };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('gate', () => {
  it('no chunk runs before the gate opens', async () => {
    const { wrapped, openGate, run } = setup();
    const read = wrapped.getReader().read();
    await tick();
    expect(run).not.toHaveBeenCalled();
    openGate();
    expect(Array.from((await read).value ?? [])).toEqual([1, 2]);
    expect(run).toHaveBeenCalledOnce();
  });

  it('a cancel while waiting reaches the native stream, and the pump does not read after it', async () => {
    const { wrapped, openGate, run, cancelled } = setup();
    await wrapped.cancel('stop');
    expect(cancelled).toHaveBeenCalledWith('stop');
    openGate();
    await tick();
    expect(run).not.toHaveBeenCalled();
  });

  it('a native error while waiting reaches the app at once', async () => {
    const { wrapped, fail } = setup([]);
    const read = wrapped.getReader().read();
    fail(new Error('reset'));
    await expect(read).rejects.toThrow('reset');
  });

  it('a BYOB read waits too, and works', async () => {
    const { wrapped, openGate } = setup();
    const read = wrapped.getReader({ mode: 'byob' }).read(new Uint8Array(8));
    await tick();
    openGate();
    expect(Array.from((await read).value ?? [])).toEqual([1, 2]);
  });
});
