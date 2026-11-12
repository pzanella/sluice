import { vi } from 'vitest';
import { DEFAULT_CONFIG, type RuntimeConfig } from '../../shared/rules';
import type { ByteStreamDeps, StreamMeta } from '../byte-stream';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function makeConfig(over: DeepPartial<RuntimeConfig> = {}): RuntimeConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  const { log, datagram, stream, ...rest } = over;
  return {
    ...base,
    ...(rest as Partial<RuntimeConfig>),
    log: { ...base.log, ...log },
    datagram: { ...base.datagram, ...datagram },
    stream: { ...base.stream, ...stream },
  };
}

export const meta: StreamMeta = { kind: 'uni', origin: 'remote', sessionId: 1, url: 'https://example.test/', streamId: 1 };

export function makeDeps(over: Partial<ByteStreamDeps> = {}): ByteStreamDeps {
  return {
    run: (ctx) => ({ data: ctx.data, delayMs: 0 }),
    onChunk: () => undefined,
    maxDelayedBytes: () => 1_000_000,
    preserveOrder: () => true,
    ...over,
  };
}

/** Let promise callbacks run. Works with real and fake timers. */
export async function settle(): Promise<void> {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<number[][]> {
  const out: number[][] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out.push(Array.from(value));
  }
}

export const text = (bytes: Uint8Array | number[]): string => new TextDecoder().decode(Uint8Array.from(bytes));
