import type { Page } from '@playwright/test';
import { DEMO_URL, expect, test } from './fixtures';

type Mode = 'default' | 'byob';

interface Payload {
  kind: string;
  text?: string;
  bytes?: number[];
}

interface Demo {
  state: {
    counters: { datagrams: number; uniStreams: number; bidiStreams: number; bytes: number; errors: number };
    payloads: Payload[];
  };
  startPush(mode?: Mode): Promise<void>;
  startMoq(): Promise<void>;
  startVideo(): Promise<void>;
  echoDatagram(text: string): Promise<string>;
  echoStream(text: string, mode?: Mode): Promise<string>;
  close(): void;
  reset(): void;
  connect(path: string): WebTransport;
  readStream(stream: ReadableStream<Uint8Array>, mode?: Mode): Promise<Uint8Array>;
}

/** Not in the TypeScript DOM lib yet. */
interface ReceiveStreamLike extends ReadableStream<Uint8Array> {
  getStats(): Promise<object>;
}
interface SendStreamLike extends WritableStream<Uint8Array> {
  sendOrder: number;
}
type StreamCtor = new () => object;

declare global {
  interface Window {
    WebTransportReceiveStream?: StreamCtor;
    WebTransportSendStream?: StreamCtor;
    __demo: Demo;
  }
}

/** True when this Chromium exposes WebTransportReceiveStream and WebTransportSendStream. Set per test. */
let hasGlobals = false;

async function open(page: Page): Promise<string[]> {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(DEMO_URL);
  await page.waitForFunction(() => '__demo' in window);
  hasGlobals = await page.evaluate(() => !!window.WebTransportReceiveStream && !!window.WebTransportSendStream);
  return pageErrors;
}

for (const withExtension of [true, false]) {
  test.describe(`wrapper behaviour (withExtension=${withExtension})`, () => {
    test.use({ withExtension });

    test('datagram echo', async ({ page }) => {
      await open(page);
      expect(await page.evaluate(() => window.__demo.echoDatagram('hello datagram'))).toBe('hello datagram');
    });

    for (const mode of ['default', 'byob'] as const) {
      test(`bidi echo with ${mode} reader`, async ({ page }) => {
        await open(page);
        expect(await page.evaluate((m) => window.__demo.echoStream('hello bidi', m), mode)).toBe('hello bidi');
      });

      test(`push traffic arrives with ${mode} reader`, async ({ page }) => {
        const pageErrors = await open(page);
        await page.evaluate((m) => window.__demo.startPush(m), mode);
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const { counters, payloads } = window.__demo.state;
                return {
                  datagrams: counters.datagrams >= 2,
                  uni: counters.uniStreams >= 3,
                  bidi: counters.bidiStreams >= 1,
                  json: payloads.some((p) => p.kind === 'uni' && p.text?.startsWith('{"seq"')),
                  binary: payloads.some((p) => p.kind === 'uni' && p.bytes?.length === 256),
                  serverBidi: payloads.some((p) => p.kind === 'bidi' && p.text === 'hello from server bidi'),
                };
              }),
            { timeout: 15_000 },
          )
          .toEqual({ datagrams: true, uni: true, bidi: true, json: true, binary: true, serverBidi: true });
        const result = await page.evaluate(() => {
          const { counters, payloads } = window.__demo.state;
          const binary = payloads.find((p) => p.kind === 'uni' && p.bytes?.length === 256);
          const json = payloads.find((p) => p.kind === 'uni' && p.text?.startsWith('{"seq"'));
          return {
            errors: counters.errors,
            binaryOk: binary?.bytes?.every((b, i) => b === i) ?? false,
            jsonOk: typeof JSON.parse(json?.text ?? '{}').seq === 'number',
          };
        });
        expect(result).toEqual({ errors: 0, binaryOk: true, jsonOk: true });
        expect(pageErrors).toEqual([]);
      });
    }

    test('incoming uni stream has native types and works with both readers', async ({ page }) => {
      await open(page);
      const result = await page.evaluate(async () => {
        const out: Record<string, unknown> = {};
        const transport = window.__demo.connect('/push');
        await transport.ready;
        const reader = transport.incomingUnidirectionalStreams.getReader();
        const first = (await reader.read()).value as ReceiveStreamLike;
        // Some Chromium builds do not expose the interface global. Then only ReadableStream can be checked.
        const Receive = window.WebTransportReceiveStream;
        out.isReceiveStream = Receive ? first instanceof Receive : 'no global';
        out.isReadableStream = first instanceof ReadableStream;
        // getStats exists only where the WebTransport streams extensions ship.
        out.stats = typeof first.getStats === 'function' ? typeof (await first.getStats()) === 'object' : 'no getStats';
        const defaultReader = first.getReader();
        out.defaultRead = (await defaultReader.read()).value instanceof Uint8Array;
        defaultReader.releaseLock();
        const second = (await reader.read()).value as ReceiveStreamLike;
        const byobReader = second.getReader({ mode: 'byob' });
        const chunk = await byobReader.read(new Uint8Array(4096));
        out.byobRead = chunk.value instanceof Uint8Array && chunk.value.length > 0;
        transport.close();
        return out;
      });
      expect(result).toEqual({
        isReceiveStream: hasGlobals ? true : 'no global',
        isReadableStream: true,
        stats: hasGlobals ? true : 'no getStats',
        defaultRead: true,
        byobRead: true,
      });
    });

    test('bidi stream from createBidirectionalStream has native types and sendOrder', async ({ page }) => {
      await open(page);
      const result = await page.evaluate(async () => {
        const transport = window.__demo.connect('/echo');
        await transport.ready;
        const stream = await transport.createBidirectionalStream();
        const writable = stream.writable as SendStreamLike;
        const before = writable.sendOrder;
        if (before !== undefined) writable.sendOrder = 7;
        const Receive = window.WebTransportReceiveStream;
        const Send = window.WebTransportSendStream;
        const out = {
          isBidi: stream instanceof WebTransportBidirectionalStream,
          readable: Receive ? stream.readable instanceof Receive : 'no global',
          readableStream: stream.readable instanceof ReadableStream,
          writable: Send ? writable instanceof Send : 'no global',
          writableStream: stream.writable instanceof WritableStream,
          orderBefore: before,
          orderAfter: writable.sendOrder,
        };
        transport.close();
        return out;
      });
      expect(result).toEqual({
        isBidi: true,
        readable: hasGlobals ? true : 'no global',
        readableStream: true,
        writable: hasGlobals ? true : 'no global',
        writableStream: true,
        orderBefore: hasGlobals ? 0 : undefined,
        orderAfter: hasGlobals ? 7 : undefined,
      });
    });

    test('datagram duplex properties', async ({ page }) => {
      await open(page);
      const result = await page.evaluate(async () => {
        const transport = window.__demo.connect('/echo');
        await transport.ready;
        const datagrams = transport.datagrams;
        datagrams.incomingHighWaterMark = 5;
        const out = {
          maxSize: typeof datagrams.maxDatagramSize,
          highWaterMark: datagrams.incomingHighWaterMark,
          same: transport.datagrams === datagrams && transport.datagrams === transport.datagrams,
        };
        transport.close();
        return out;
      });
      expect(result).toEqual({ maxSize: 'number', highWaterMark: 5, same: true });
    });

    test('BYOB read with min at end of stream gives bytes then done', async ({ page }) => {
      await open(page);
      const result = await page.evaluate(async () => {
        const transport = window.__demo.connect('/echo');
        await transport.ready;
        const stream = await transport.createBidirectionalStream();
        const writer = stream.writable.getWriter();
        await writer.write(new Uint8Array([1, 2, 3]));
        await writer.close();
        const reader = stream.readable.getReader({ mode: 'byob' });
        try {
          const first = await reader.read(new Uint8Array(4096), { min: 4096 });
          const second = await reader.read(new Uint8Array(4096));
          transport.close();
          return {
            error: null,
            firstDone: first.done,
            firstBytes: Array.from(first.value ?? []),
            secondDone: second.done,
          };
        } catch (error) {
          return { error: String(error), firstDone: null, firstBytes: [], secondDone: null };
        }
      });
      expect(result.error).toBeNull();
      // Native baseline: at close the read returns the bytes with done=true, then the next read is done and empty.
      expect(result.firstBytes).toEqual([1, 2, 3]);
      expect(result.firstDone).toBe(true);
      expect(result.secondDone).toBe(true);
    });

    test('app cancel of an incoming uni stream causes no error and the session stays usable', async ({ page }) => {
      const pageErrors = await open(page);
      const result = await page.evaluate(async () => {
        const transport = window.__demo.connect('/push');
        let closedError: unknown = null;
        transport.closed.catch((error: unknown) => (closedError = error));
        await transport.ready;
        const reader = transport.incomingUnidirectionalStreams.getReader();
        const stream = (await reader.read()).value as ReadableStream<Uint8Array>;
        let cancelError: string | null = null;
        try {
          await stream.cancel('app cancel');
        } catch (error) {
          cancelError = String(error);
        }
        // The session must still deliver the next stream and datagrams.
        const next = (await reader.read()).value as ReadableStream<Uint8Array>;
        const bytes = await window.__demo.readStream(next);
        const datagram = await transport.datagrams.readable.getReader().read();
        transport.close();
        await transport.closed;
        return {
          cancelError,
          nextLength: bytes.length > 0,
          datagram: datagram.value instanceof Uint8Array,
          closedError: closedError === null ? null : String(closedError),
        };
      });
      expect(result).toEqual({ cancelError: null, nextLength: true, datagram: true, closedError: null });
      expect(pageErrors).toEqual([]);
    });

    test('close() resolves closed', async ({ page }) => {
      const pageErrors = await open(page);
      const result = await page.evaluate(async () => {
        const transport = window.__demo.connect('/echo');
        await transport.ready;
        transport.close({ closeCode: 3, reason: 'bye' });
        const info = await transport.closed;
        return { closeCode: info.closeCode, reason: info.reason };
      });
      expect(result).toEqual({ closeCode: 3, reason: 'bye' });
      expect(pageErrors).toEqual([]);
    });

    for (const kind of ['wrong hash', 'closed port'] as const) {
      test(`handshake failure (${kind}) rejects ready and closed with WebTransportError`, async ({ page }) => {
        const pageErrors = await open(page);
        const result = await page.evaluate(async (k) => {
          const config = (await (await fetch('/config.json')).json()) as { wtPort: number };
          const port = k === 'closed port' ? 1 : config.wtPort;
          const value = new Uint8Array(32).fill(1);
          const transport = new WebTransport(`https://localhost:${port}/echo`, {
            serverCertificateHashes: [{ algorithm: 'sha-256', value }],
          });
          const settle = (promise: Promise<unknown>) =>
            promise.then(
              () => 'resolved',
              (error: unknown) => (error instanceof WebTransportError ? 'WebTransportError' : String(error)),
            );
          const [ready, closed] = await Promise.all([settle(transport.ready), settle(transport.closed)]);
          // Give a late unhandled rejection time to surface.
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { ready, closed };
        }, kind);
        expect(result).toEqual({ ready: 'WebTransportError', closed: 'WebTransportError' });
        expect(pageErrors).toEqual([]);
      });
    }
  });
}

test.describe('extension only', () => {
  test.use({ withExtension: true });

  test('WebTransport is patched but looks native', async ({ page }) => {
    await open(page);
    const result = await page.evaluate(() => ({
      patched: Object.getPrototypeOf(WebTransport) !== Function.prototype,
      name: WebTransport.name,
      source: WebTransport.toString(),
    }));
    expect(result.patched).toBe(true);
    expect(result.name).toBe('WebTransport');
    expect(result.source).toMatch(/\{\s*\[native code\]\s*\}/);
  });

  test('stream is not locked before the first access and no global leaks', async ({ page }) => {
    await open(page);
    const result = await page.evaluate(async () => {
      const transport = window.__demo.connect('/echo');
      await transport.ready;
      const locked = transport.incomingUnidirectionalStreams.locked;
      transport.close();
      const w = window as unknown as Record<string, unknown>;
      return { locked, inspector: '__WT_INSPECTOR' in w, config: '__WT_INSPECTOR_CONFIG' in w };
    });
    expect(result).toEqual({ locked: false, inspector: false, config: false });
  });
});

test.describe('native only', () => {
  test.use({ withExtension: false });

  test('WebTransport is not patched', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => Object.getPrototypeOf(WebTransport) !== Function.prototype)).toBe(false);
  });
});
