import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Rule, type RuntimeConfig } from '../../shared/rules';
import { validateRules } from '../../shared/validate';
import { wrapByteStream, type ByteStreamDeps } from '../byte-stream';
import { createDatagramFramer as newDatagramFramer, createSubgroupFramer as newSubgroupFramer, type ObjectFramer } from '../moqt/objects';

const createSubgroupFramer = (): ObjectFramer => newSubgroupFramer(22);
const createDatagramFramer = (): ObjectFramer => newDatagramFramer(22);
import { createPipeline, createStats, type PipelineResult } from '../pipeline';

const HEADER = [0x54, 1, 7, 2, 9];
const object = (delta: number, ...payload: number[]): number[] => [delta, payload.length, ...payload];

function source(chunks: number[][]): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
}

async function run(rules: Rule[], chunks: number[][], framer: (() => ObjectFramer) | null, extra: Partial<ByteStreamDeps> = {}, kind: 'uni' | 'datagram' = 'uni') {
  const config: RuntimeConfig = { ...DEFAULT_CONFIG, rules };
  const stats = createStats();
  const pipeline = createPipeline({ getConfig: () => config, stats, random: () => 0, log: () => undefined, canHold: () => true });
  const seen: PipelineResult[] = [];
  const stream = wrapByteStream(source(chunks), { kind, origin: 'remote', sessionId: 1, url: 'https://x/', streamId: kind === 'uni' ? 1 : null }, {
    run: pipeline.run,
    onChunk: () => undefined,
    onResult: (_ctx, _input, result) => seen.push(result),
    maxDelayedBytes: () => 1e6,
    preserveOrder: () => true,
    ...(framer ? { framer } : {}),
    ...extra,
  });
  const reader = stream.getReader();
  const out: number[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(...value);
  }
  return { out, stats, seen, pipeline };
}

const dropRule = (moqt: NonNullable<NonNullable<Rule['match']>['moqt']>): Rule => ({ id: 'r', match: { moqt }, action: { type: 'drop' } });

describe('rules on MoQT objects', () => {
  const stream = [...HEADER, ...object(0, 10), ...object(0, 11), ...object(0, 12)];

  it('drops one object by its ID, across chunks, and keeps the next ID right', async () => {
    const { out, stats } = await run([dropRule({ objectMin: 1, objectMax: 1 })], [stream.slice(0, 7), stream.slice(7)], createSubgroupFramer);
    expect(out).toEqual([...HEADER, ...object(0, 10), ...object(1, 12)]);
    expect(stats.uni.dropped).toBe(1);
  });

  it('drops a whole group, and leaves the header', async () => {
    const { out } = await run([dropRule({ groupMin: 7, groupMax: 7 })], [stream], createSubgroupFramer);
    expect(out).toEqual([0x14, 1, 7, 2, 9]);
  });

  it.each([[{ trackAlias: 2 }], [{ groupMin: 8 }], [{ groupMax: 6 }], [{ subgroup: 3 }], [{ objectMin: 5 }]])('does not match with %j', async (moqt) => {
    const { out } = await run([dropRule(moqt)], [stream], createSubgroupFramer);
    expect(out).toEqual(stream);
  });

  it('never matches a plain chunk', async () => {
    const { out } = await run([dropRule({ groupMin: 0 })], [stream], null);
    expect(out).toEqual(stream);
  });

  it('applies a modify to the payload, and writes the new length', async () => {
    const rule: Rule = { id: 'r', match: { moqt: { objectMin: 1, objectMax: 1 } }, action: { type: 'modify', ops: [{ op: 'set', data: [1, 2, 3] }] } };
    const { out } = await run([rule], [stream], createSubgroupFramer);
    expect(out).toEqual([...HEADER, ...object(0, 10), ...object(0, 1, 2, 3), ...object(0, 12)]);
  });

  it('shows other rules the payload, not the chunk', async () => {
    const rule: Rule = { id: 'r', match: { prefix: [11] }, action: { type: 'drop' } };
    const { out } = await run([dropRule({ groupMin: 99 }), rule], [stream], createSubgroupFramer);
    expect(out).toEqual([...HEADER, ...object(0, 10), ...object(1, 12)]);
  });

  it('keeps the order and the IDs with a delay', async () => {
    const delayed: Rule = { id: 'd', match: { moqt: { objectMin: 0, objectMax: 0 } }, action: { type: 'delay', delayMs: 20 } };
    const { out } = await run([delayed, dropRule({ objectMin: 1, objectMax: 1 })], [stream], createSubgroupFramer);
    expect(out).toEqual([...HEADER, ...object(0, 10), ...object(1, 12)]);
  });

  it('builds later bytes only after a hold is decided', async () => {
    const hold: Rule = { id: 'h', match: { moqt: { objectMin: 0, objectMax: 0 } }, action: { type: 'hold', timeoutMs: 1000, onTimeout: 'forward' } };
    const { out } = await run([hold], [stream], createSubgroupFramer, {
      hold: () => ({ decision: new Promise((resolve) => setTimeout(() => resolve({ action: 'drop' }), 10)), cancel: () => undefined }),
    });
    // Object 0 was dropped after objects 1 and 2 were read, so the first of them must state its ID.
    expect(out).toEqual([0x14, 1, 7, 2, 9, ...object(1, 11), ...object(0, 12)]);
  });

  it('uses the edit of a hold', async () => {
    const hold: Rule = { id: 'h', match: { moqt: { objectMin: 0, objectMax: 0 } }, action: { type: 'hold', timeoutMs: 1000, onTimeout: 'forward' } };
    const { out } = await run([hold], [stream], createSubgroupFramer, {
      hold: () => ({ decision: Promise.resolve({ action: 'edit', data: Uint8Array.of(7, 7) }), cancel: () => undefined }),
    });
    expect(out).toEqual([...HEADER, ...object(0, 7, 7), ...object(0, 11), ...object(0, 12)]);
  });

  it('drops and edits datagrams', async () => {
    const dgram = [0, 1, 2, 3, 9, 0xaa];
    expect((await run([dropRule({ groupMin: 2 })], [dgram], createDatagramFramer, {}, 'datagram')).out).toEqual([]);
    expect((await run([dropRule({ groupMin: 3 })], [dgram], createDatagramFramer, {}, 'datagram')).out).toEqual(dgram);
    const edit: Rule = { id: 'r', match: { moqt: { objectMin: 3 } }, action: { type: 'modify', ops: [{ op: 'set', data: [1] }] } };
    expect((await run([edit], [dgram], createDatagramFramer, {}, 'datagram')).out).toEqual([0, 1, 2, 3, 9, 1]);
  });

  it('gives the app each byte with BYOB too', async () => {
    const framed = wrapByteStream(source([stream]), { kind: 'uni', origin: 'remote', sessionId: 1, url: 'https://x/', streamId: 1 }, {
      run: (ctx) => ({ data: ctx.data, delayMs: 0 }),
      onChunk: () => undefined,
      maxDelayedBytes: () => 1e6,
      preserveOrder: () => true,
      framer: createSubgroupFramer,
    });
    const reader = framed.getReader({ mode: 'byob' });
    const out: number[] = [];
    for (;;) {
      const { value, done } = await reader.read(new Uint8Array(4));
      if (done) break;
      out.push(...value);
    }
    expect(out).toEqual(stream);
  });
});

describe('validation of match.moqt', () => {
  const base = (moqt: unknown): unknown => [{ id: 'r', match: { moqt }, action: { type: 'drop' } }];

  it('takes valid fields', () => {
    expect(validateRules(base({ trackAlias: 0, groupMin: 1, groupMax: 2, subgroup: 3, objectMin: 4, objectMax: 5 })).ok).toBe(true);
  });

  it.each([[{}], [{ group: 1 }], [{ groupMin: -1 }], [{ objectMax: 1.5 }], [{ groupMin: 2, groupMax: 1 }], [{ objectMin: 2, objectMax: 1 }], [{ trackAlias: '1' }], [1]])('refuses %j', (moqt) => {
    expect(validateRules(base(moqt)).ok).toBe(false);
  });
});
