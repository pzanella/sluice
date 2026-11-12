import { describe, expect, it } from 'vitest';
import { syntheticReceiveStream, wrapByteStream, wrapStreamOfStreams } from '../byte-stream';
import type { ChunkContext, PipelineResult } from '../pipeline';

const meta = { kind: 'datagram', origin: 'remote', sessionId: 1, url: 'https://a.test', streamId: null } as const;

function setup(delayMs = 0) {
  let enqueue!: (value: Uint8Array<ArrayBuffer>) => void;
  let close!: () => void;
  const native = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      enqueue = (value) => controller.enqueue(value);
      close = () => controller.close();
    },
  });
  let inject!: (data: Uint8Array<ArrayBuffer>) => string | null;
  const seen: [ChunkContext, PipelineResult][] = [];
  const stream = wrapByteStream(native, meta, {
    run: (ctx) => ({ data: ctx.data, delayMs }),
    onChunk: () => undefined,
    onResult: (ctx, _input, result) => seen.push([{ ...ctx }, result]),
    maxDelayedBytes: () => 1024,
    preserveOrder: () => true,
    exposeInject: (next) => {
      inject = next;
    },
  });
  return { stream, inject: (data: Uint8Array<ArrayBuffer>) => inject(data), enqueue: (value: Uint8Array<ArrayBuffer>) => enqueue(value), close: () => close(), seen };
}

describe('inject in a stream', () => {
  it('reaches a waiting read, and is marked', async () => {
    const { stream, inject, seen } = setup();
    const reader = stream.getReader();
    const pending = reader.read();
    expect(inject(Uint8Array.of(7))).toBeNull();
    expect((await pending).value).toEqual(Uint8Array.of(7));
    expect(seen[0]?.[0].injected).toBe(true);
  });

  it('stays behind a chunk that is still delayed', async () => {
    const { stream, inject, enqueue } = setup(20);
    const reader = stream.getReader();
    enqueue(Uint8Array.of(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(inject(Uint8Array.of(2))).toBeNull();
    expect((await reader.read()).value).toEqual(Uint8Array.of(1));
    expect((await reader.read()).value).toEqual(Uint8Array.of(2));
  });

  it('says no after the stream ended, or the app cancelled', async () => {
    const a = setup();
    const reader = a.stream.getReader();
    a.close();
    expect((await reader.read()).done).toBe(true);
    expect(a.inject(Uint8Array.of(1))).toBe('closed');
    const b = setup();
    await b.stream.cancel('stop');
    expect(b.inject(Uint8Array.of(1))).toBe('closed');
  });

  it('an app that stopped reading cannot make it fill the memory', () => {
    const { inject } = setup();
    expect(inject(new Uint8Array(1024 * 1024 - 1))).toBeNull();
    expect(inject(new Uint8Array(64 * 1024))).toBe('full');
  });

  it('a stream end waits for an inject that joined late', async () => {
    const { stream, inject, enqueue, close } = setup(20);
    const reader = stream.getReader();
    enqueue(Uint8Array.of(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    close();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(inject(Uint8Array.of(2))).toBeNull();
    expect((await reader.read()).value).toEqual(Uint8Array.of(1));
    expect((await reader.read()).value).toEqual(Uint8Array.of(2));
    expect((await reader.read()).done).toBe(true);
  });
});

describe('inject of a new stream', () => {
  it('adds it to the stream of streams, and says no after the end', async () => {
    let close!: () => void;
    const native = new ReadableStream<string>({
      start(controller) {
        close = () => controller.close();
      },
    });
    let inject!: (item: string) => string | null;
    const streams = wrapStreamOfStreams(native, (item) => item, (next) => {
      inject = next;
    });
    const reader = streams.getReader();
    const pending = reader.read();
    expect(inject('made')).toBeNull();
    expect((await pending).value).toBe('made');
    close();
    expect((await reader.read()).done).toBe(true);
    expect(inject('late')).toBe('closed');
  });

  it('has a limit on streams that the app does not take', () => {
    const native = new ReadableStream<string>();
    let inject!: (item: string) => string | null;
    wrapStreamOfStreams(native, (item) => item, (next) => {
      inject = next;
    });
    for (let i = 0; i < 64; i++) expect(inject('s')).toBeNull();
    expect(inject('s')).toBe('full');
  });

  it('a BYOB read with min on a short message gets the bytes and the end, with no error', async () => {
    const byob = syntheticReceiveStream(Uint8Array.of(1, 2), undefined).getReader({ mode: 'byob' });
    const { value, done } = await byob.read(new Uint8Array(4), { min: 4 });
    expect(done).toBe(true);
    expect(value).toEqual(Uint8Array.of(1, 2));
  });

  it('a synthetic stream gives one chunk, then the end, to both readers', async () => {
    const reader = syntheticReceiveStream(Uint8Array.of(1, 2), undefined).getReader();
    expect((await reader.read()).value).toEqual(Uint8Array.of(1, 2));
    expect((await reader.read()).done).toBe(true);

    const byob = syntheticReceiveStream(Uint8Array.of(1, 2, 3), undefined).getReader({ mode: 'byob' });
    expect((await byob.read(new Uint8Array(2))).value).toEqual(Uint8Array.of(1, 2));
    expect((await byob.read(new Uint8Array(2))).value).toEqual(Uint8Array.of(3));
    expect((await byob.read(new Uint8Array(2))).done).toBe(true);
  });

  it('has the shape of a native stream of the browser', async () => {
    expect('getStats' in syntheticReceiveStream(Uint8Array.of(1), undefined)).toBe(false);
    const native = Object.create(ReadableStream.prototype) as object;
    const stream = syntheticReceiveStream(Uint8Array.of(1, 2), native) as ReadableStream & { getStats(): Promise<unknown> };
    expect(Object.getPrototypeOf(stream)).toBe(native);
    expect(await stream.getStats()).toEqual({ bytesReceived: 2, bytesRead: 2 });
  });
});
