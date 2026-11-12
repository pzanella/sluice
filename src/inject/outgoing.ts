// Wraps what the app writes: a send stream or the writable side of datagrams. See ADR-29. Rules with `direction` act here.
import type { HoldDecision, HoldOffer } from './hold';
import type { ChunkContext, PipelineResult } from './pipeline';

interface OutgoingMeta {
  kind: ChunkContext['kind'];
  sessionId: number;
  url: string;
  streamId: number | null;
  origin: 'remote' | 'local';
}

export interface OutgoingDeps {
  run: (ctx: ChunkContext) => PipelineResult;
  onChunk: (byteLength: number) => void;
  /** Called before the write, so the bytes are still readable. */
  onResult?: (ctx: ChunkContext, input: Uint8Array<ArrayBuffer>, result: PipelineResult) => void;
  /** Sees the bytes that the network gets, in order. It must copy what it keeps. */
  onSent?: (data: Uint8Array<ArrayBuffer>) => void;
  hold?: (ctx: ChunkContext, data: Uint8Array<ArrayBuffer>, offer: HoldOffer) => { decision: Promise<HoldDecision>; cancel: () => void };
}

/** Null for a value that is not bytes. The native stream then throws its own TypeError. */
function asBytes(chunk: unknown): Uint8Array<ArrayBuffer> | null {
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk) && chunk.buffer instanceof ArrayBuffer) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return null;
}

/** A send stream has more members than a WritableStream (sendOrder, sendGroup, getStats). They run on the native object. */
function forwardMembers(wrapped: object, native: object): void {
  for (let proto = Object.getPrototypeOf(native) as object | null; proto && proto !== WritableStream.prototype && proto !== Object.prototype; proto = Object.getPrototypeOf(proto) as object | null) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || Object.prototype.hasOwnProperty.call(wrapped, name)) continue;
      const member = Object.getOwnPropertyDescriptor(proto, name);
      if (!member) continue;
      if (typeof member.value === 'function') {
        Object.defineProperty(wrapped, name, { value: (...args: unknown[]) => Reflect.apply(member.value as CallableFunction, native, args) as unknown, configurable: true, writable: true });
      } else {
        Object.defineProperty(wrapped, name, {
          ...(member.get ? { get: () => Reflect.get(native, name, native) as unknown } : {}),
          ...(member.set ? { set: (value: unknown) => void Reflect.set(native, name, value, native) } : {}),
          configurable: true,
        });
      }
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function wrapWritable(native: WritableStream, meta: OutgoingMeta, deps: OutgoingDeps): WritableStream {
  let writer: WritableStreamDefaultWriter | null = null;
  let seq = 0;
  let controller!: WritableStreamDefaultController;
  const cancels = new Set<() => void>();

  // Lazy: the native stream is locked only when the app first writes, so it stays unlocked until then, as with no wrapper.
  const nativeWriter = (): WritableStreamDefaultWriter => {
    if (!writer) {
      writer = native.getWriter() as WritableStreamDefaultWriter;
      // A native error reaches the app at once, not on its next write.
      writer.closed.catch((err: unknown) => controller.error(err));
    }
    return writer;
  };

  const wrapped = new WritableStream(
    {
      start(c) {
        controller = c;
      },
      async write(chunk: unknown) {
        const out = nativeWriter();
        const bytes = asBytes(chunk);
        if (!bytes || bytes.byteLength === 0) {
          await out.ready;
          return out.write(chunk) as Promise<void>;
        }
        deps.onChunk(bytes.byteLength);
        const ctx: ChunkContext = { ...meta, outgoing: true, seq: seq++, data: bytes };
        const result = deps.run(ctx);
        let data = result.data;
        if (result.hold && deps.hold && data && data.byteLength > 0) {
          const { decision, cancel } = deps.hold(ctx, data, result.hold);
          cancels.add(cancel);
          const decided = await decision;
          cancels.delete(cancel);
          data = decided.action === 'edit' ? decided.data : decided.action === 'forward' ? data : null;
          if (decided.action !== 'gone') deps.onResult?.(ctx, bytes, { data, delayMs: result.delayMs });
        } else {
          deps.onResult?.(ctx, bytes, result);
        }
        if (!data || data.byteLength === 0) return undefined;
        if (result.delayMs > 0) await sleep(result.delayMs);
        deps.onSent?.(data);
        await out.ready;
        // The original chunk when nothing changed, so a shared or odd buffer goes as the app gave it.
        return out.write(data === bytes ? chunk : data) as Promise<void>;
      },
      close() {
        return nativeWriter().close();
      },
      abort(reason) {
        for (const cancel of cancels) cancel();
        return nativeWriter().abort(reason);
      },
    },
    // One write at a time: the promise of the app resolves when the native write does, so the backpressure stays the native one.
    { highWaterMark: 1 },
  );
  forwardMembers(wrapped, native);
  // Keeps `instanceof WebTransportSendStream` true. Stream methods check internal slots, not the prototype.
  Object.setPrototypeOf(wrapped, Object.getPrototypeOf(native) as object);
  return wrapped;
}
