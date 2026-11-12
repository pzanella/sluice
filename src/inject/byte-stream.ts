// Wraps a native byte ReadableStream in a new `type: 'bytes'` stream that goes through the pipeline.
// The app can use default and BYOB readers. See the skill `wt-wrapper-invariants`.
import type { ConnectionAction, TrafficKind } from '../shared/rules';
import type { InjectFailure } from '../shared/protocol';
import type { HoldDecision, HoldOffer } from './hold';
import type { ObjectFramer, ObjectUnit } from './moqt/objects';
import type { ChunkContext, PipelineResult } from './pipeline';

export interface StreamMeta {
  kind: TrafficKind;
  origin: 'remote' | 'local';
  sessionId: number;
  url: string;
  streamId: number | null;
}

export interface ByteStreamDeps {
  run: (ctx: ChunkContext) => PipelineResult;
  onChunk: (byteLength: number) => void;
  /** Called before the chunk is delivered, so `input` and the result are still readable. */
  onResult?: (ctx: ChunkContext, input: Uint8Array<ArrayBuffer>, result: PipelineResult) => void;
  maxDelayedBytes: () => number;
  /** Only datagrams can be reordered, and only if the config allows it. */
  preserveOrder: () => boolean;
  /** The first read waits for this, so saved rules apply from the first chunk. It must have a timeout. */
  gate?: () => Promise<void>;
  /** Asked at the first chunk of a stream and at each datagram. With a framer the rules see objects, not chunks. */
  framer?: () => ObjectFramer | null;
  /** With none, the stream has a budget of its own. */
  budget?: DelayBudget;
  /** What the network delivered, before any rule. It must copy what it keeps. */
  onRaw?: (data: Uint8Array<ArrayBuffer> | null, fin: boolean) => void;
  /** Gives the caller a way to deliver a chunk from the panel. It returns why not, or null. */
  exposeInject?: (inject: (data: Uint8Array<ArrayBuffer>) => InjectFailure | null) => void;
  /** A rule asked for a stall, a close or a reset. A reset is done here: the stream errors for the app (ADR-41). */
  onConnection?: (ctx: ChunkContext, action: ConnectionAction) => void;
  /** Waits for the user. The queue behind this has a timer, so the decision always comes. */
  hold?: (ctx: ChunkContext, data: Uint8Array<ArrayBuffer>, offer: HoldOffer) => { decision: Promise<HoldDecision>; cancel: () => void };
}

/**
 * Delayed bytes of one session, shared by all its streams. A limit per stream would let the server choose how much memory
 * delays hold, because it chooses how many streams there are.
 */
export class DelayBudget {
  private used = 0;
  private readonly waiters = new Set<() => void>();

  isOver(limit: number): boolean {
    return this.used > limit;
  }

  add(bytes: number): void {
    this.used += bytes;
  }

  /** Wakes the pumps of all streams: any of them can be waiting for what this stream frees. */
  release(bytes: number): void {
    this.used -= bytes;
    for (const wake of this.waiters) wake();
  }

  get waiting(): number {
    return this.waiters.size;
  }

  subscribe(wake: () => void): () => void {
    this.waiters.add(wake);
    return () => this.waiters.delete(wake);
  }
}

type NativeStream = ReadableStream<Uint8Array<ArrayBuffer>> & { getStats?: () => Promise<unknown> };

// Above zero, so the stream calls pull() when the queue becomes empty, also with no read pending.
// The pump needs this to resume, and to close as soon as the app has read the last byte.
const HIGH_WATER_MARK = 1;
/** An app that stopped reading must not make injected messages fill the memory. */
const MAX_INJECT_QUEUE_BYTES = 1024 * 1024;
const MAX_INJECT_WAITING_STREAMS = 64;

/** What the app sees when a stream is reset: a WebTransportError with the code, where the browser has it. */
function streamError(code: number): Error {
  const Ctor = (globalThis as { WebTransportError?: new (message?: string, init?: { source?: string; streamErrorCode?: number }) => Error }).WebTransportError;
  if (Ctor) {
    try {
      return new Ctor('Sluice reset the stream', { source: 'stream', streamErrorCode: code });
    } catch {
      // An older constructor. The plain error below still ends the stream.
    }
  }
  return Object.assign(new Error('Sluice reset the stream'), { name: 'WebTransportError', source: 'stream', streamErrorCode: code });
}

export function wrapByteStream(native: NativeStream, meta: StreamMeta, deps: ByteStreamDeps): ReadableStream<Uint8Array> {
  // Called only on the first access by the app, so the lock is never seen before that.
  const reader = native.getReader();
  let controller!: ReadableByteStreamController;
  let dead = false; // Closed, cancelled or errored.
  let seq = 0;
  let wakePump: (() => void) | null = null;
  let chain: Promise<void> = Promise.resolve(); // Ordered deliveries.
  let inflight = 0; // Ordered deliveries not done yet.
  let lastDue = 0;
  const budget = deps.budget ?? new DelayBudget(); // Bytes held by delays. They count for backpressure.
  const sleeps = new Map<ReturnType<typeof setTimeout>, () => void>();
  const pendingUnordered = new Set<Promise<void>>();
  const holdCancels = new Set<() => void>();
  let orderedHolds = 0;
  // Streams only: chunks that came due while the app has not read the queue. See ADR-26.
  let waiting: Uint8Array<ArrayBuffer>[] = [];
  let waitingBytes = 0;

  let unsubscribe: (() => void) | null = null;

  const wake = (): void => {
    const resume = wakePump;
    wakePump = null;
    unsubscribe?.();
    unsubscribe = null;
    resume?.();
  };

  /** Resolves early if the stream dies, so nothing waits on a timer that was cleared. */
  const sleep = (ms: number): Promise<void> =>
    ms <= 0 || dead
      ? Promise.resolve()
      : new Promise((resolve) => {
          const id = setTimeout(() => {
            sleeps.delete(id);
            resolve();
          }, ms);
          sleeps.set(id, resolve);
        });

  const shutdown = (): void => {
    dead = true;
    for (const [id, resolve] of sleeps) {
      clearTimeout(id);
      resolve();
    }
    sleeps.clear();
    for (const cancel of holdCancels) cancel();
    holdCancels.clear();
    budget.release(waitingBytes);
    waiting = [];
    waitingBytes = 0;
    wake();
  };

  const flushWaiting = (): void => {
    if (waiting.length === 0 || queuedBytes() > 0) return;
    const merged = new Uint8Array(waitingBytes);
    let at = 0;
    for (const part of waiting) {
      merged.set(part, at);
      at += part.byteLength;
    }
    budget.release(waitingBytes);
    waiting = [];
    waitingBytes = 0;
    controller.enqueue(merged);
  };

  /**
   * A default reader gets queued chunks one by one, so a slow app with a delay on would get many tiny chunks (ADR-7). So a chunk
   * that comes due while the queue has data waits here, and the next read gets them as one. The bytes and their order do not change.
   */
  const emit = (out: Uint8Array<ArrayBuffer>): void => {
    flushWaiting();
    if (meta.kind !== 'datagram' && (queuedBytes() > 0 || waiting.length > 0)) {
      waiting.push(out);
      waitingBytes += out.byteLength;
      budget.add(out.byteLength);
      return;
    }
    controller.enqueue(out); // Transfers the buffer: never read `out` after this.
  };

  type Render = ObjectUnit['render'];

  const deliver = (data: Uint8Array<ArrayBuffer>, byteLength: number, render?: Render): void => {
    budget.release(byteLength);
    if (dead) return;
    try {
      // At delivery and not before: a held object can still be dropped, and that changes the bytes of the next one.
      const out = render ? render(data) : data;
      if (out && out.byteLength > 0) emit(out);
    } catch (err) {
      // Not closed or cancelled, or `dead` would be true: a chunk is lost, so the app must know.
      fail(err);
    }
    wake();
  };

  function schedule(data: Uint8Array<ArrayBuffer>, delayMs: number, render?: Render): void {
    const byteLength = data.byteLength;
    const unordered = meta.kind === 'datagram' && !deps.preserveOrder();

    if (unordered && delayMs > 0) {
      budget.add(byteLength);
      const pending: Promise<void> = sleep(delayMs).then(() => {
        pendingUnordered.delete(pending);
        deliver(data, byteLength, render);
      });
      pendingUnordered.add(pending);
      return;
    }

    if (delayMs <= 0 && (unordered || inflight === 0)) {
      const out = render ? render(data) : data;
      if (out && out.byteLength > 0) emit(out);
      return;
    }

    // Ordered: deliver at max(now + delay, last due time), so no chunk passes another one.
    const due = Math.max(performance.now() + delayMs, lastDue);
    lastDue = due;
    inflight++;
    budget.add(byteLength);
    chain = chain
      .then(() => sleep(due - performance.now()))
      .then(() => {
        inflight--;
        deliver(data, byteLength, render);
      });
  }

  /** Its bytes count as delayed, so a long hold cannot make the pump read without limit. */
  function holdChunk(
    hold: NonNullable<ByteStreamDeps['hold']>,
    ctx: ChunkContext,
    input: Uint8Array<ArrayBuffer>,
    data: Uint8Array<ArrayBuffer>,
    delayMs: number,
    offer: HoldOffer,
    render?: Render,
  ): void {
    const byteLength = data.byteLength;
    const ordered = !(meta.kind === 'datagram' && !deps.preserveOrder());
    let decidedAt = 0;
    budget.add(byteLength);
    if (ordered) orderedHolds++;
    const { decision, cancel } = hold(ctx, data, offer);
    holdCancels.add(cancel);
    const decided = decision.then((result) => {
      holdCancels.delete(cancel);
      decidedAt = performance.now();
      if (ordered) {
        orderedHolds--;
        wake();
      }
      const final = result.action === 'edit' ? result.data : result.action === 'forward' ? data : null;
      // Now and not on arrival, so the list shows what really happened. `input` stays readable until the delivery.
      if (result.action !== 'gone') deps.onResult?.(ctx, input, { data: final, delayMs });
      return final;
    });
    const finish = (final: Uint8Array<ArrayBuffer> | null): void => {
      if (final) return deliver(final, byteLength, render);
      budget.release(byteLength);
      wake();
    };
    if (!ordered) {
      const pending: Promise<void> = decided.then(async (final) => {
        if (final) await sleep(delayMs);
        pendingUnordered.delete(pending);
        finish(final);
      });
      pendingUnordered.add(pending);
      return;
    }
    // In the chain, so no chunk passes a held one. The delay of the rule starts after the decision.
    inflight++;
    chain = chain
      .then(() => decided)
      .then(async (final) => {
        // From the decision: each chunk waiting for the one before it would add up the delays.
        if (final) await sleep(decidedAt + delayMs - performance.now());
        inflight--;
        finish(final);
      });
  }

  const queuedBytes = (): number => {
    const desired = controller.desiredSize;
    return desired === null ? 0 : HIGH_WATER_MARK - desired;
  };

  const overThreshold = (): boolean => {
    // Read native only when the queue is empty. While the app is slow, data stays in the browser:
    // - a native read then returns what arrived, up to its own cap, so the app gets it one read late
    //   but in one chunk. A default reader gets queued chunks one by one, so reading each arrival
    //   gives a slow app many tiny chunks. This still happens while a delay is active (ADR-7);
    // - datagrams stay in the native queue, so incomingHighWaterMark and incomingMaxAge keep working.
    // Delayed bytes block only past the limit. Blocking on any delayed byte would limit the rate to
    // one chunk per delay.
    // While a chunk of this stream is held, the rest stays in the browser. The QUIC flow control then slows this stream only.
    // Reading on would fill the budget of the session, and a hold on one stream would stop them all.
    return orderedHolds > 0 || queuedBytes() > 0 || budget.isOver(deps.maxDelayedBytes());
  };

  // Only while waiting: a stream that its app left behind must not stay in the budget until the session ends.
  const waitForWake = (): Promise<void> =>
    new Promise((resolve) => {
      wakePump = resolve;
      unsubscribe = budget.subscribe(wake);
    });

  const fail = (err: unknown): void => {
    if (dead) return;
    shutdown();
    try {
      controller.error(err);
    } catch {
      // Already errored.
    }
    // For a local failure the native stream is still open: release it. No effect if it already failed.
    reader.cancel(err).catch(() => undefined);
  };

  /** Ends the stream for the app with a stream error, as a reset by the server would, and stops the server stream. */
  const reset = (code: number): boolean => {
    if (dead) return false;
    fail(streamError(code));
    return true;
  };

  /** One chunk, or the payload of one object. */
  function handle(input: Uint8Array<ArrayBuffer>, unit?: ObjectUnit): void {
    const ctx: ChunkContext = { ...meta, seq: seq++, data: input, ...(unit?.moqt ? { moqt: unit.moqt } : {}) };
    const result = deps.run(ctx);
    if (result.connection) {
      deps.onConnection?.(ctx, result.connection);
      if (result.connection.type === 'reset-stream' && meta.kind !== 'datagram') {
        deps.onResult?.(ctx, input, result);
        reset(result.connection.code);
        return;
      }
    }
    if (result.hold && deps.hold && result.data && result.data.byteLength > 0) {
      holdChunk(deps.hold, ctx, input, result.data, result.delayMs, result.hold, unit?.render);
      return;
    }
    deps.onResult?.(ctx, input, result);
    // Byte streams throw a TypeError on empty chunks.
    if (!result.data || result.data.byteLength === 0) return;
    schedule(result.data, result.delayMs, unit?.render);
  }

  function handleUnits(units: ObjectUnit[]): void {
    for (const unit of units) {
      if (unit.bypass) schedule(unit.payload, 0, unit.render);
      else handle(unit.payload, unit);
    }
  }

  async function pump(): Promise<void> {
    let streamFramer: ObjectFramer | null | undefined;
    const isDatagram = meta.kind === 'datagram';
    try {
      if (deps.gate) await deps.gate();
      for (;;) {
        while (!dead && overThreshold()) {
          // Released by pull() when the app reads, or by a delivery. The QUIC flow control of the
          // browser then slows the peer, as it does with no wrapper.
          await waitForWake();
        }
        if (dead) return;

        const { value, done } = await reader.read();
        if (dead) return;
        if (done) {
          deps.onRaw?.(null, true);
          if (streamFramer) handleUnits(streamFramer.end());
          break;
        }
        if (!value || value.byteLength === 0) continue;

        deps.onRaw?.(value, false);
        deps.onChunk(value.byteLength);
        // A stream must be parsed from its start, so it keeps the choice of its first chunk. Each datagram stands alone.
        if (isDatagram || streamFramer === undefined) streamFramer = deps.framer?.() ?? null;
        if (streamFramer) handleUnits(streamFramer.push(value));
        else handle(value);
      }
      // FIN from the native stream: deliver what is still delayed, then close.
      // A loop: an inject can join the chain during the wait.
      while (inflight > 0 || pendingUnordered.size > 0) {
        await chain;
        await Promise.all(pendingUnordered);
      }
      // Close only on an empty queue. With bytes queued, a BYOB read with `min` that cannot be met
      // would error the stream and lose those bytes.
      while (!dead && (queuedBytes() > 0 || waiting.length > 0)) await waitForWake();
      if (dead) return;
      shutdown();
      controller.close();
      // A pending BYOB read resolves as done only after respond(0).
      controller.byobRequest?.respond(0);
    } catch (err) {
      fail(err);
    }
  }

  const source: UnderlyingByteSource = {
    type: 'bytes',
    start(c) {
      controller = c;
      deps.exposeInject?.((data) => {
        if (dead) return 'closed';
        // The budget matters only for what joins the chain. Other streams can fill it while the app reads this one well.
        if (queuedBytes() + data.byteLength > MAX_INJECT_QUEUE_BYTES || (inflight > 0 && budget.isOver(deps.maxDelayedBytes()))) return 'full';
        const ctx: ChunkContext = { ...meta, seq: seq++, data, injected: true };
        // Before the delivery, as it takes the buffer.
        deps.onResult?.(ctx, data, { data, delayMs: 0 });
        try {
          // In the order of the others, behind what still waits.
          schedule(data, 0);
          return null;
        } catch {
          return 'closed';
        }
      });
      // A native error reaches the app at once, even when the pump waits on backpressure.
      reader.closed.catch(fail);
      void pump();
    },
    pull() {
      try {
        flushWaiting();
      } catch (err) {
        fail(err);
      }
      wake();
    },
    cancel(reason) {
      // Same as with the native stream: this sends STOP_SENDING to the server.
      shutdown();
      return reader.cancel(reason);
    },
  };
  const wrapped = new ReadableStream(source, { highWaterMark: HIGH_WATER_MARK });

  // Keeps `instanceof WebTransportReceiveStream` true. Stream methods check internal slots, not the prototype.
  Object.setPrototypeOf(wrapped, Object.getPrototypeOf(native));
  // WebTransportReceiveStream.getStats() in Chromium.
  if (typeof native.getStats === 'function') {
    Object.defineProperty(wrapped, 'getStats', { value: () => native.getStats?.(), configurable: true });
  }
  return wrapped;
}

/**
 * A stream that the server never sent: one chunk, then the end. In Chromium 156 a native one is a plain ReadableStream, with
 * no `getStats` and no global `WebTransportReceiveStream`. A browser with that global gets the same shape as its native one.
 */
export function syntheticReceiveStream(data: Uint8Array<ArrayBuffer>, prototype: object | undefined): ReadableStream<Uint8Array> {
  const byteLength = data.byteLength;
  const stream = new ReadableStream(
    {
      type: 'bytes',
      start(controller) {
        controller.enqueue(data);
      },
      // Close only on an empty queue. With bytes queued, a BYOB read with `min` that cannot be met would error the stream.
      pull(controller) {
        controller.close();
        controller.byobRequest?.respond(0);
      },
    },
    { highWaterMark: HIGH_WATER_MARK },
  );
  if (prototype) {
    Object.setPrototypeOf(stream, prototype);
    // The native method needs a native stream.
    Object.defineProperty(stream, 'getStats', { value: () => Promise.resolve({ bytesReceived: byteLength, bytesRead: byteLength }), configurable: true });
  }
  return stream;
}

/** Wraps a stream of streams (incoming*Streams). A new stream is accepted only when the app asks for it. */
export function wrapStreamOfStreams<T, U>(
  native: ReadableStream<T>,
  wrapOne: (item: T) => U,
  /** Gives the caller a way to add a stream from the panel. It returns why not, or null. */
  exposeInject?: (inject: (item: U) => InjectFailure | null) => void,
): ReadableStream<U> {
  const reader = native.getReader();
  let lastPull: Promise<void> = Promise.resolve();
  return new ReadableStream<U>(
    {
      start(controller) {
        exposeInject?.((item) => {
          try {
            if ((controller.desiredSize ?? 0) <= -MAX_INJECT_WAITING_STREAMS) return 'full';
            controller.enqueue(item);
            return null;
          } catch {
            return 'closed';
          }
        });
        const close = (): void => {
          try {
            controller.close();
          } catch {
            // Already closed or cancelled.
          }
        };
        // Report the end of the native stream at once, not on the next read of the app.
        // The last item may still be on its way from a read that is done, so wait for that pull.
        reader.closed.then(
          () => lastPull.then(close, close),
          (err: unknown) => controller.error(err),
        );
      },
      pull(controller) {
        lastPull = reader.read().then(({ value, done }) => {
          // On `done`, the handler of reader.closed above does the close.
          if (done) return;
          try {
            controller.enqueue(wrapOne(value));
          } catch (err) {
            // Error first: the cancel resolves reader.closed, and the close handler must not win.
            controller.error(err);
            reader.cancel(err).catch(() => undefined);
          }
        });
        return lastPull;
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
