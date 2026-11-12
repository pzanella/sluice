// Regression tests for the problems found in the protocol review of the port.
import { describe, expect, it, vi } from 'vitest';
import type { Rule } from '../../shared/rules';
import { wrapByteStream, wrapStreamOfStreams } from '../byte-stream';
import { install, type Runtime } from '../patch';
import { createPipeline, createStats } from '../pipeline';
import { proxyPlatform } from '../proxy';
import { makeConfig, makeDeps, meta, settle } from './helpers';
import { createMockWebTransport, NativeSource } from './mock-webtransport';

const hasBeenSettled = async (promise: Promise<unknown>): Promise<boolean> => {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await settle();
  return settled;
};

describe('a failure inside Sluice', () => {
  it('a bad rule is skipped and the payload is not changed', () => {
    const badRule = { id: 'bad', match: { contains: 5 }, action: { type: 'drop' } } as unknown as Rule;
    const log = vi.fn<(m: string) => void>();
    const pipeline = createPipeline({
      getConfig: () => makeConfig({ rules: [badRule] }),
      stats: createStats(),
      random: () => 0.5,
      log,
    });
    const data = Uint8Array.from([1, 2]);
    const result = pipeline.run({ ...meta, seq: 0, data });
    expect(result.data).toBe(data);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"bad" failed'));
  });

  it('a bad rule is reported once, not for each chunk, and a null rule does not throw', () => {
    const rules = [{ id: 'bad', match: { contains: 5 }, action: { type: 'drop' } }, null] as unknown as Rule[];
    const log = vi.fn<(m: string) => void>();
    const pipeline = createPipeline({ getConfig: () => makeConfig({ rules }), stats: createStats(), random: () => 0.5, log });
    const run = () => pipeline.run({ ...meta, seq: 0, data: Uint8Array.from([1]) });
    run();
    run();
    expect(run().data).not.toBeNull();
    expect(log).toHaveBeenCalledTimes(2); // One line for each of the two bad rules.
  });

  it('an error when wrapping an incoming item also releases the native stream', async () => {
    let cancelled = false;
    const native = new ReadableStream<string>({
      start: (c) => c.enqueue('item'),
      cancel: () => void (cancelled = true),
    });
    const boom = new Error('boom');
    const wrapped = wrapStreamOfStreams(native, () => {
      throw boom;
    });
    await expect(wrapped.getReader().read()).rejects.toBe(boom);
    await settle();
    expect(cancelled).toBe(true);
  });

  it('an error in the pipeline also releases the native stream', async () => {
    const src = new NativeSource().push([1]);
    const boom = new Error('boom');
    const wrapped = wrapByteStream(src.stream, meta, makeDeps({ run: () => { throw boom; } }));
    await expect(wrapped.getReader().read()).rejects.toBe(boom);
    await settle();
    expect(src.cancelled).toBe(true);
  });

  it('a chunk that cannot be enqueued after a delay errors the stream, it is not lost silently', async () => {
    const shared = new Uint8Array(new SharedArrayBuffer(4)) as unknown as Uint8Array<ArrayBuffer>;
    const src = new NativeSource().push([1]);
    src.close();
    const wrapped = wrapByteStream(src.stream, meta, makeDeps({ run: () => ({ data: shared, delayMs: 1 }) }));
    await expect(wrapped.getReader().read()).rejects.toBeInstanceOf(TypeError);
  });
});

describe('end of a byte stream with bytes still queued', () => {
  it('a BYOB read with min gets the last bytes and done, and does not error', async () => {
    const src = new NativeSource().push([1, 2, 3, 4]);
    src.close();
    const wrapped = wrapByteStream(src.stream, meta, makeDeps());
    await settle(); // The pump reads ahead and sees the FIN.
    const reader = wrapped.getReader({ mode: 'byob' });
    const read = reader.read as unknown as (
      view: Uint8Array,
      options: { min: number },
    ) => Promise<ReadableStreamReadResult<Uint8Array>>;
    const { value, done } = await read.call(reader, new Uint8Array(8), { min: 8 });
    expect(done).toBe(true);
    expect(Array.from(value ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('reader.closed resolves when the last chunk is read, with no extra read', async () => {
    const src = new NativeSource().push([1]);
    src.close();
    const wrapped = wrapByteStream(src.stream, meta, makeDeps());
    await settle();
    const reader = wrapped.getReader();
    expect(await hasBeenSettled(reader.closed)).toBe(false);
    await reader.read();
    expect(await hasBeenSettled(reader.closed)).toBe(true);
  });
});

describe('datagram read-ahead', () => {
  const datagramMeta = { ...meta, kind: 'datagram' as const, streamId: null };

  it('a slow app leaves datagrams in the native queue', async () => {
    const src = new NativeSource().push([1], [2], [3]);
    const wrapped = wrapByteStream(src.stream, datagramMeta, makeDeps());
    await settle();
    expect(src.served).toBe(1);

    const reader = wrapped.getReader();
    expect(Array.from((await reader.read()).value ?? [])).toEqual([1]);
    await settle();
    expect(src.served).toBe(2);
  });

  it('delayed datagrams do not limit the rate to one for each delay', async () => {
    vi.useFakeTimers();
    try {
      const src = new NativeSource().push([1], [2], [3]);
      wrapByteStream(src.stream, datagramMeta, makeDeps({ run: (ctx) => ({ data: ctx.data, delayMs: 1000 }) }));
      await settle();
      expect(src.served).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stream of streams', () => {
  const nativeOf = () => {
    let controller!: ReadableStreamDefaultController<string>;
    const stream = new ReadableStream<string>({ start: (c) => void (controller = c) }, { highWaterMark: 0 });
    return { stream, controller };
  };

  it('a native error is seen at once, with no read pending', async () => {
    const { stream, controller } = nativeOf();
    const reader = wrapStreamOfStreams(stream, (x) => x).getReader();
    const reason = new Error('session lost');
    controller.error(reason);
    await expect(reader.closed).rejects.toBe(reason);
  });

  it('a native close is seen at once, with no read pending', async () => {
    const { stream, controller } = nativeOf();
    const reader = wrapStreamOfStreams(stream, (x) => x).getReader();
    controller.close();
    await expect(reader.closed).resolves.toBeUndefined();
  });

  it('the last item is not lost when the native stream closes right after it', async () => {
    const { stream, controller } = nativeOf();
    const reader = wrapStreamOfStreams(stream, (x) => `wrapped ${x}`).getReader();
    controller.enqueue('last');
    controller.close();
    expect(await reader.read()).toEqual({ value: 'wrapped last', done: false });
    expect((await reader.read()).done).toBe(true);
  });
});

describe('constructor URL', () => {
  it('converts the URL once, so the session URL is the one that was used', () => {
    const kit = createMockWebTransport();
    const scope: { WebTransport?: typeof WebTransport } = { WebTransport: kit.Native };
    const runtime = install(scope) as Runtime;
    const Sluice = scope.WebTransport as typeof WebTransport;
    let calls = 0;
    const url = { toString: () => (++calls === 1 ? 'https://real.test/' : 'https://other.test/') };
    new Sluice(url as unknown as string);
    expect(calls).toBe(1);
    expect(kit.sessions[0]?.url).toBe('https://real.test/');
    expect([...runtime.sessions.values()][0]?.url).toBe('https://real.test/');
  });

  it('a Symbol throws a TypeError and no session is made', () => {
    const kit = createMockWebTransport();
    const scope: { WebTransport?: typeof WebTransport } = { WebTransport: kit.Native };
    install(scope);
    const Sluice = scope.WebTransport as typeof WebTransport;
    expect(() => new Sluice(Symbol('x') as unknown as string)).toThrow(TypeError);
    expect(kit.sessions).toHaveLength(0);
  });
});

describe('master switch', () => {
  function setup() {
    const kit = createMockWebTransport();
    const scope: { WebTransport?: typeof WebTransport } = { WebTransport: kit.Native };
    const runtime = install(scope) as Runtime;
    const Sluice = scope.WebTransport as typeof WebTransport;
    const wt = new Sluice('https://relay.test/');
    const session = kit.sessions[0];
    if (!session) throw new Error('no session');
    return { runtime, wt, session };
  }

  it('disabled after the proxy exists: a readable not yet accessed stays native', () => {
    const { runtime, wt, session } = setup();
    const duplex = wt.datagrams;
    runtime.setConfig(makeConfig({ enabled: false }));
    expect(duplex.readable).toBe(session.datagramSource.stream);
  });

  it('disabled: a new incoming stream stays native and is not locked', async () => {
    const { runtime, wt, session } = setup();
    const reader = wt.incomingUnidirectionalStreams.getReader();
    runtime.setConfig(makeConfig({ enabled: false }));
    const source = session.openUni();
    const { value } = await reader.read();
    expect(value).toBe(source.stream);
    expect((value as ReadableStream).locked).toBe(false);
    expect(runtime.stats.uni.streams).toBe(0);
  });
});

describe('platform shape', () => {
  it('a wrapped stream keeps the class of the native stream', async () => {
    class ReceiveStream extends ReadableStream<Uint8Array<ArrayBuffer>> {
      getStats(): Promise<string> {
        return Promise.resolve('stats');
      }
    }
    const native = new ReceiveStream({ type: 'bytes', start: (c: ReadableByteStreamController) => c.enqueue(Uint8Array.from([7])) } as never);
    const wrapped = wrapByteStream(native, meta, makeDeps());
    expect(wrapped).toBeInstanceOf(ReceiveStream);
    expect(await (wrapped as ReceiveStream).getStats()).toBe('stats');
    expect(Array.from((await wrapped.getReader().read()).value ?? [])).toEqual([7]);
  });

  it('a function set through the proxy replaces the old one', () => {
    const proxy = proxyPlatform<{ f?: () => number }>({}, {});
    proxy.f = () => 1;
    expect(proxy.f()).toBe(1);
    proxy.f = () => 2;
    expect(proxy.f()).toBe(2);
  });
});
