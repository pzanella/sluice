import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type Rule, type RuntimeConfig, type TrafficKind } from '../../shared/rules';
import { createPipeline, createStats, REGEX_INPUT_BYTES, SLOW_REGEX_MS, type ChunkContext } from '../pipeline';
import { makeConfig } from './helpers';

function setup(config: RuntimeConfig, random: () => number = () => 0.5) {
  const stats = createStats();
  const log = vi.fn<(m: string) => void>();
  let current = config;
  const pipeline = createPipeline({ getConfig: () => current, stats, random, log });
  return { pipeline, stats, log, set: (c: RuntimeConfig) => void (current = c) };
}

function ctx(data: string | number[] = 'hello', over: Partial<ChunkContext> = {}): ChunkContext {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : Uint8Array.from(data);
  return { kind: 'uni', origin: 'remote', sessionId: 1, url: 'https://example.test/path', streamId: 1, seq: 0, data: bytes, ...over };
}

const drop = (id: string, extra: Partial<Rule> = {}): Rule => ({ id, action: { type: 'drop' }, ...extra });
const str = (d: Uint8Array | null): string => (d ? new TextDecoder().decode(d) : '<null>');

// These tests grow a payload to the 16 MiB limit, byte by byte, which takes seconds on a busy machine.
const SLOW_TEST_MS = 60_000;

describe('pipeline match conditions', () => {
  const dropped = (rule: Rule, c: ChunkContext): boolean => {
    const { pipeline } = setup(makeConfig({ rules: [rule] }));
    return pipeline.run(c).data === null;
  };

  it('with no match, a rule applies to every chunk', () => {
    expect(dropped(drop('r'), ctx())).toBe(true);
  });
  it('with an empty match, a rule applies to every chunk', () => {
    expect(dropped(drop('r', { match: {} }), ctx())).toBe(true);
  });
  it('minSize', () => {
    expect(dropped(drop('r', { match: { minSize: 5 } }), ctx('hello'))).toBe(true);
    expect(dropped(drop('r', { match: { minSize: 6 } }), ctx('hello'))).toBe(false);
  });
  it('maxSize', () => {
    expect(dropped(drop('r', { match: { maxSize: 5 } }), ctx('hello'))).toBe(true);
    expect(dropped(drop('r', { match: { maxSize: 4 } }), ctx('hello'))).toBe(false);
  });
  it('sessionUrl is a substring test', () => {
    expect(dropped(drop('r', { match: { sessionUrl: '/path' } }), ctx())).toBe(true);
    expect(dropped(drop('r', { match: { sessionUrl: 'other' } }), ctx())).toBe(false);
  });
  it('prefix with a string', () => {
    expect(dropped(drop('r', { match: { prefix: 'he' } }), ctx('hello'))).toBe(true);
    expect(dropped(drop('r', { match: { prefix: 'el' } }), ctx('hello'))).toBe(false);
  });
  it('prefix with a byte list', () => {
    expect(dropped(drop('r', { match: { prefix: [1, 2] } }), ctx([1, 2, 3]))).toBe(true);
    expect(dropped(drop('r', { match: { prefix: [2, 3] } }), ctx([1, 2, 3]))).toBe(false);
  });
  it('contains matches if any pattern is found (OR)', () => {
    const rule = drop('r', { match: { contains: ['zzz', 'ell'] } });
    expect(dropped(rule, ctx('hello'))).toBe(true);
    expect(dropped(drop('r', { match: { contains: ['zzz', 'yyy'] } }), ctx('hello'))).toBe(false);
    expect(dropped(drop('r', { match: { contains: [[0x6c, 0x6c]] } }), ctx('hello'))).toBe(true);
  });
  it('an empty contains list never matches', () => {
    expect(dropped(drop('r', { match: { contains: [] } }), ctx('hello'))).toBe(false);
  });
  it('regex is tested on the decoded text', () => {
    expect(dropped(drop('r', { match: { regex: '^h.l+o$' } }), ctx('hello'))).toBe(true);
    expect(dropped(drop('r', { match: { regex: '^x' } }), ctx('hello'))).toBe(false);
  });
  it('regexFlags are used', () => {
    expect(dropped(drop('r', { match: { regex: 'HELLO' } }), ctx('hello'))).toBe(false);
    expect(dropped(drop('r', { match: { regex: 'HELLO', regexFlags: 'i' } }), ctx('hello'))).toBe(true);
  });
  it('all conditions must be true (AND)', () => {
    const match = { prefix: 'he', minSize: 3, contains: ['llo'] };
    expect(dropped(drop('r', { match }), ctx('hello'))).toBe(true);
    expect(dropped(drop('r', { match: { ...match, maxSize: 2 } }), ctx('hello'))).toBe(false);
  });
  it('an invalid regex never matches and does not throw', () => {
    const { pipeline } = setup(makeConfig({ rules: [drop('r', { match: { regex: '(' } })] }));
    expect(() => pipeline.run(ctx())).not.toThrow();
    expect(str(pipeline.run(ctx()).data)).toBe('hello');
    expect(pipeline.ruleHits.size).toBe(0);
  });
  it('a regex with the g flag gives the same answer on repeated chunks', () => {
    const { pipeline } = setup(makeConfig({ rules: [drop('r', { match: { regex: 'ell', regexFlags: 'g' } })] }));
    const answers = [1, 2, 3, 4].map(() => pipeline.run(ctx('hello')).data === null);
    expect(answers).toEqual([true, true, true, true]);
    expect(pipeline.ruleHits.get('r')).toBe(4);
  });
  it('a regex with the y flag gives the same answer on repeated chunks', () => {
    const { pipeline } = setup(makeConfig({ rules: [drop('r', { match: { regex: 'hel', regexFlags: 'y' } })] }));
    expect([1, 2, 3].map(() => pipeline.run(ctx('hello')).data === null)).toEqual([true, true, true]);
  });
});

describe('pipeline rule conditions', () => {
  it('`on` limits the rule to listed kinds', () => {
    const { pipeline } = setup(makeConfig({ rules: [drop('r', { on: ['datagram', 'bidi'] })] }));
    const kinds: TrafficKind[] = ['datagram', 'uni', 'bidi'];
    expect(kinds.map((kind) => pipeline.run(ctx('x', { kind })).data === null)).toEqual([true, false, true]);
  });
  it('enabled: false skips the rule', () => {
    const { pipeline } = setup(makeConfig({ rules: [drop('r', { enabled: false })] }));
    expect(str(pipeline.run(ctx()).data)).toBe('hello');
    expect(pipeline.ruleHits.has('r')).toBe(false);
  });
  it('enabled: true or missing applies the rule', () => {
    const { pipeline } = setup(makeConfig({ rules: [drop('r', { enabled: true })] }));
    expect(pipeline.run(ctx()).data).toBeNull();
  });
  it('probability uses the injected random', () => {
    const rules = [drop('r', { probability: 0.6 })];
    expect(setup(makeConfig({ rules }), () => 0.5).pipeline.run(ctx()).data).toBeNull();
    expect(setup(makeConfig({ rules }), () => 0.7).pipeline.run(ctx()).data).not.toBeNull();
  });
  it('probability 0 never applies and probability 1 always applies', () => {
    expect(setup(makeConfig({ rules: [drop('r', { probability: 0 })] }), () => 0).pipeline.run(ctx()).data).not.toBeNull();
    expect(setup(makeConfig({ rules: [drop('r', { probability: 1 })] }), () => 0.999).pipeline.run(ctx()).data).toBeNull();
  });
  it('random is used for probability only after other conditions pass', () => {
    const random = vi.fn(() => 0.1);
    const { pipeline } = setup(makeConfig({ rules: [drop('r', { on: ['uni'], probability: 0.5 })] }), random);
    pipeline.run(ctx('x', { kind: 'bidi' }));
    expect(random).not.toHaveBeenCalled();
    pipeline.run(ctx('x', { kind: 'uni' }));
    expect(random).toHaveBeenCalledTimes(1);
  });
  it('final stops the rules after a matching rule', () => {
    const rules: Rule[] = [
      { id: 'a', action: { type: 'delay', delayMs: 10 }, final: true },
      drop('b'),
    ];
    const { pipeline } = setup(makeConfig({ rules }));
    const result = pipeline.run(ctx());
    expect(result.data).not.toBeNull();
    expect(result.delayMs).toBe(10);
    expect(pipeline.ruleHits.has('b')).toBe(false);
  });
  it('without final, later rules still run', () => {
    const rules: Rule[] = [{ id: 'a', action: { type: 'delay', delayMs: 10 } }, drop('b')];
    const { pipeline } = setup(makeConfig({ rules }));
    expect(pipeline.run(ctx()).data).toBeNull();
    expect(pipeline.ruleHits.get('a')).toBe(1);
  });
  it('a final rule that does not match does not stop later rules', () => {
    const rules: Rule[] = [
      { id: 'a', match: { prefix: 'zz' }, action: { type: 'log' }, final: true },
      drop('b'),
    ];
    expect(setup(makeConfig({ rules })).pipeline.run(ctx()).data).toBeNull();
  });
  it('rules run in order and later rules see modified data', () => {
    const rules: Rule[] = [
      { id: 'a', action: { type: 'modify', ops: [{ op: 'set', data: 'secret' }] } },
      drop('b', { match: { contains: ['secret'] } }),
    ];
    expect(setup(makeConfig({ rules })).pipeline.run(ctx()).data).toBeNull();
  });
});

describe('pipeline actions', () => {
  it('drop returns null data, counts and logs when logging is on', () => {
    const { pipeline, stats, log } = setup(makeConfig({ log: { uni: true }, rules: [drop('r')] }));
    const result = pipeline.run(ctx());
    expect(result).toEqual({ data: null, delayMs: 0 });
    expect(stats.uni.dropped).toBe(1);
    expect(log.mock.calls.some(([m]) => m.includes('DROP r'))).toBe(true);
  });
  it('delay adds to the base delay', () => {
    const config = makeConfig({ stream: { delayMs: 5 }, rules: [{ id: 'r', action: { type: 'delay', delayMs: 20 } }] });
    const { pipeline, stats } = setup(config);
    expect(pipeline.run(ctx()).delayMs).toBe(25);
    expect(stats.uni.delayed).toBe(1);
  });
  it('datagrams use the datagram base delay', () => {
    const config = makeConfig({ datagram: { delayMs: 7 }, stream: { delayMs: 100 } });
    expect(setup(config).pipeline.run(ctx('x', { kind: 'datagram' })).delayMs).toBe(7);
  });
  it('jitter uses random and spreads both ways', () => {
    const config = makeConfig({ stream: { delayMs: 100, jitterMs: 10 } });
    expect(setup(config, () => 1).pipeline.run(ctx()).delayMs).toBe(110);
    expect(setup(config, () => 0).pipeline.run(ctx()).delayMs).toBe(90);
    expect(setup(config, () => 0.5).pipeline.run(ctx()).delayMs).toBe(100);
  });
  it('delay never goes below zero', () => {
    const config = makeConfig({ stream: { delayMs: 5, jitterMs: 50 } });
    expect(setup(config, () => 0).pipeline.run(ctx()).delayMs).toBe(0);
  });
  it('rule delay jitter uses random', () => {
    const rules: Rule[] = [{ id: 'r', action: { type: 'delay', delayMs: 100, jitterMs: 20 } }];
    expect(setup(makeConfig({ rules }), () => 1).pipeline.run(ctx()).delayMs).toBe(120);
  });
  it('a zero delay does not count as delayed', () => {
    const { pipeline, stats } = setup(makeConfig());
    pipeline.run(ctx());
    expect(stats.uni.delayed).toBe(0);
  });
  it('modify set replaces the payload', () => {
    const rules: Rule[] = [{ id: 'r', action: { type: 'modify', ops: [{ op: 'set', data: [1, 2] }] } }];
    const { pipeline, stats } = setup(makeConfig({ rules }));
    expect(Array.from(pipeline.run(ctx()).data ?? [])).toEqual([1, 2]);
    expect(stats.uni.modified).toBe(1);
  });
  it('modify replace changes every match and leaves the input array alone', () => {
    const rules: Rule[] = [{ id: 'r', action: { type: 'modify', ops: [{ op: 'replace', find: 'l', with: 'L' }] } }];
    const { pipeline } = setup(makeConfig({ rules }));
    const input = ctx('hello');
    const original = input.data;
    expect(str(pipeline.run(input).data)).toBe('heLLo');
    expect(new TextDecoder().decode(original)).toBe('hello');
  });
  it('modify applies ops in order', () => {
    const rules: Rule[] = [
      {
        id: 'r',
        action: { type: 'modify', ops: [{ op: 'set', data: 'abc' }, { op: 'replace', find: 'b', with: 'XX' }] },
      },
    ];
    expect(str(setup(makeConfig({ rules })).pipeline.run(ctx()).data)).toBe('aXXc');
  });
  it('skips a modify rule whose ops grow the payload past the limit, and leaves the payload as it was', () => {
    const ops = Array.from({ length: 25 }, () => ({ op: 'replace' as const, find: 'a', with: 'aa' }));
    const { pipeline, stats, log } = setup(makeConfig({ rules: [{ id: 'grow', action: { type: 'modify', ops } }] }));
    const first = pipeline.run(ctx('a'));
    expect(str(first.data)).toBe('a');
    expect(stats.uni.modified).toBe(0);
    pipeline.run(ctx('a'));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('"grow" failed');
  }, SLOW_TEST_MS);

  it('a final rule that fails still stops the rules after it', () => {
    const ops = Array.from({ length: 25 }, () => ({ op: 'replace' as const, find: 'a', with: 'aa' }));
    const rules: Rule[] = [{ id: 'grow', final: true, action: { type: 'modify', ops } }, drop('later')];
    const { pipeline, stats } = setup(makeConfig({ rules }));
    expect(str(pipeline.run(ctx('a')).data)).toBe('a');
    expect(stats.uni.dropped).toBe(0);
  }, SLOW_TEST_MS);

  it('a log that throws does not change the result', () => {
    const stats = createStats();
    const log = (): void => {
      throw new Error('console.log was replaced');
    };
    const rules: Rule[] = [{ id: 'cut', action: { type: 'modify', ops: [{ op: 'replace', find: 'a', with: '' }] } }];
    const config = makeConfig({ rules, log: { session: false, datagram: false, uni: true, bidi: false, previewBytes: 48 } });
    const pipeline = createPipeline({ getConfig: () => config, stats, random: () => 0.5, log });
    expect(pipeline.run(ctx('a')).data).toBeNull();
    expect(stats.uni.dropped).toBe(1);
  });

  it('a set op gives each chunk its own buffer, because enqueue takes it', () => {
    const rules: Rule[] = [{ id: 'r', action: { type: 'modify', ops: [{ op: 'set', data: 'abc' }] } }];
    const { pipeline } = setup(makeConfig({ rules }));
    const first = pipeline.run(ctx('x')).data;
    const second = pipeline.run(ctx('y')).data;
    expect(first?.buffer).not.toBe(second?.buffer);
    if (first) structuredClone(first.buffer, { transfer: [first.buffer] });
    expect(str(pipeline.run(ctx('z')).data)).toBe('abc');
  });

  it('a replace after a transfer of its result still works, with patterns kept between chunks', () => {
    const rules: Rule[] = [{ id: 'r', match: { prefix: 'a' }, action: { type: 'modify', ops: [{ op: 'replace', find: 'a', with: 'b' }] } }];
    const { pipeline } = setup(makeConfig({ rules }));
    const first = pipeline.run(ctx('aa')).data;
    if (first) structuredClone(first.buffer, { transfer: [first.buffer] });
    expect(str(pipeline.run(ctx('aa')).data)).toBe('bb');
  });

  it('patterns of a new config are read again', () => {
    const { pipeline, set } = setup(makeConfig({ rules: [drop('r', { match: { contains: [[1]] } })] }));
    expect(pipeline.run(ctx([1])).data).toBeNull();
    set(makeConfig({ rules: [drop('r', { match: { contains: [[2]] } })] }));
    expect(pipeline.run(ctx([1])).data).not.toBeNull();
    expect(pipeline.run(ctx([2])).data).toBeNull();
  });

  it('a rule with the same id but a new regex runs again', () => {
    let time = 0;
    let rules: Rule[] = [drop('r', { match: { regex: 'old' } })];
    let slow = true;
    const pipeline = createPipeline({
      getConfig: () => makeConfig({ rules }),
      stats: createStats(),
      random: () => 0.5,
      log: () => undefined,
      now: () => {
        if (slow) time += SLOW_REGEX_MS + 1;
        return time;
      },
    });
    pipeline.run(ctx('hello'));
    expect(pipeline.disabledRules()).toEqual(['r']);
    slow = false;
    rules = [drop('r', { match: { regex: 'hello' } })];
    expect(pipeline.disabledRules()).toEqual([]);
    expect(pipeline.run(ctx('hello')).data).toBeNull();
  });

  it('a regex with $ does not match a payload longer than the part it tests', () => {
    const rule = drop('r', { match: { regex: '^a+$' } });
    expect(setup(makeConfig({ rules: [rule] })).pipeline.run(ctx(`${'a'.repeat(REGEX_INPUT_BYTES)}b`)).data).not.toBeNull();
    expect(setup(makeConfig({ rules: [rule] })).pipeline.run(ctx('aaa')).data).toBeNull();
  });

  it('a cut inside a UTF-8 character adds no false U+FFFD', () => {
    const payload = `${'a'.repeat(REGEX_INPUT_BYTES - 1)}é`;
    const { pipeline } = setup(makeConfig({ rules: [drop('r', { match: { regex: '\\uFFFD' } })] }));
    expect(pipeline.run(ctx(payload)).data).not.toBeNull();
  });

  it('a regex tests only the first part of a payload', () => {
    const payload = `${'x'.repeat(REGEX_INPUT_BYTES)}needle`;
    const { pipeline } = setup(makeConfig({ rules: [drop('r', { match: { regex: 'needle' } })] }));
    expect(pipeline.run(ctx(payload)).data).not.toBeNull();
    const early = setup(makeConfig({ rules: [drop('r', { match: { regex: 'needle' } })] }));
    expect(early.pipeline.run(ctx(`needle${'x'.repeat(REGEX_INPUT_BYTES)}`)).data).toBeNull();
  });

  it('turns off a rule whose regex is slow, and keeps the traffic going', () => {
    const stats = createStats();
    const log = vi.fn<(m: string) => void>();
    let time = 0;
    const regexGoesSlow = { times: 1 };
    const config = makeConfig({ rules: [drop('slow', { match: { regex: 'nomatch' } })] });
    const pipeline = createPipeline({
      getConfig: () => config,
      stats,
      random: () => 0.5,
      log,
      now: () => {
        if (regexGoesSlow.times-- > 0) return time;
        time += SLOW_REGEX_MS + 1;
        return time;
      },
    });
    pipeline.run(ctx('hello'));
    expect(pipeline.disabledRules()).toEqual(['slow']);
    expect(log.mock.calls[0]?.[0]).toContain('turned off');
    const hits = log.mock.calls.length;
    expect(pipeline.run(ctx('hello')).data).not.toBeNull();
    expect(log.mock.calls.length).toBe(hits);
  });

  it('counts a modify that leaves an empty payload as a drop', () => {
    const rules: Rule[] = [
      { id: 'cut', action: { type: 'modify', ops: [{ op: 'replace', find: 'a', with: '' }] } },
      drop('later'),
    ];
    const { pipeline, stats } = setup(makeConfig({ rules }));
    expect(pipeline.run(ctx('aa'))).toEqual({ data: null, delayMs: 0 });
    expect(stats.uni.dropped).toBe(1);
    expect(stats.uni.modified).toBe(0);
    expect(pipeline.ruleHits.get('later')).toBeUndefined();
  });

  it('a replace with no match does not count as modified and keeps the same array', () => {
    const rules: Rule[] = [{ id: 'r', action: { type: 'modify', ops: [{ op: 'replace', find: 'zz', with: 'x' }] } }];
    const { pipeline, stats } = setup(makeConfig({ rules }));
    const c = ctx('hello');
    const input = c.data;
    expect(pipeline.run(c).data).toBe(input);
    expect(stats.uni.modified).toBe(0);
  });

  it('modify replace with an empty find changes nothing', () => {
    const rules: Rule[] = [{ id: 'r', action: { type: 'modify', ops: [{ op: 'replace', find: '', with: 'Z' }] } }];
    expect(str(setup(makeConfig({ rules })).pipeline.run(ctx()).data)).toBe('hello');
  });
  it('log action keeps data and counts a hit', () => {
    const rules: Rule[] = [{ id: 'r', action: { type: 'log' } }];
    const { pipeline, log } = setup(makeConfig({ rules }));
    expect(str(pipeline.run(ctx()).data)).toBe('hello');
    expect(pipeline.ruleHits.get('r')).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
  });
  it('log output contains the hex preview limited by previewBytes', () => {
    const { pipeline, log } = setup(makeConfig({ log: { uni: true, previewBytes: 2 } }));
    pipeline.run(ctx('hello'));
    expect(log.mock.calls[0]?.[0]).toContain('68 65 ...(+3B)');
  });
  it('does not log a kind when its log flag is off', () => {
    const { pipeline, log } = setup(makeConfig());
    pipeline.run(ctx());
    expect(log).not.toHaveBeenCalled();
  });
});

describe('pipeline datagram loss', () => {
  it('dropRate drops datagrams when random is below the rate', () => {
    const { pipeline, stats } = setup(makeConfig({ datagram: { dropRate: 0.5 } }), () => 0.2);
    expect(pipeline.run(ctx('x', { kind: 'datagram' }))).toEqual({ data: null, delayMs: 0 });
    expect(stats.datagram.dropped).toBe(1);
  });
  it('dropRate keeps datagrams when random is at or above the rate', () => {
    const { pipeline, stats } = setup(makeConfig({ datagram: { dropRate: 0.5 } }), () => 0.5);
    expect(pipeline.run(ctx('x', { kind: 'datagram' })).data).not.toBeNull();
    expect(stats.datagram.dropped).toBe(0);
  });
  it('dropRate never touches streams', () => {
    const { pipeline, stats } = setup(makeConfig({ datagram: { dropRate: 1 } }), () => 0);
    expect(pipeline.run(ctx('x', { kind: 'uni' })).data).not.toBeNull();
    expect(pipeline.run(ctx('x', { kind: 'bidi' })).data).not.toBeNull();
    expect(stats.uni.dropped + stats.bidi.dropped).toBe(0);
  });
  it('dropRate 0 does not call random', () => {
    const random = vi.fn(() => 0);
    setup(makeConfig(), random).pipeline.run(ctx('x', { kind: 'datagram' }));
    expect(random).not.toHaveBeenCalled();
  });
  it('a lost datagram does not reach the rules', () => {
    const rules: Rule[] = [{ id: 'r', action: { type: 'log' } }];
    const { pipeline } = setup(makeConfig({ datagram: { dropRate: 1 }, rules }), () => 0);
    pipeline.run(ctx('x', { kind: 'datagram' }));
    expect(pipeline.ruleHits.has('r')).toBe(false);
  });
});

describe('pipeline config', () => {
  it('enabled: false passes data through with no delay, loss, rules or stats', () => {
    const config = makeConfig({
      enabled: false,
      datagram: { dropRate: 1, delayMs: 50 },
      stream: { delayMs: 50 },
      rules: [drop('r')],
    });
    const { pipeline, stats } = setup(config, () => 0);
    const input = ctx('hello', { kind: 'datagram' });
    const result = pipeline.run(input);
    expect(result.data).toBe(input.data);
    expect(result.delayMs).toBe(0);
    expect(stats.datagram.dropped).toBe(0);
    expect(pipeline.ruleHits.size).toBe(0);
  });
  it('reads the config again for each chunk', () => {
    const { pipeline, set } = setup(makeConfig());
    expect(pipeline.run(ctx()).data).not.toBeNull();
    set(makeConfig({ rules: [drop('r')] }));
    expect(pipeline.run(ctx()).data).toBeNull();
  });
  it('counts rule hits by id across calls', () => {
    const rules: Rule[] = [{ id: 'a', action: { type: 'log' } }, { id: 'b', match: { prefix: 'x' }, action: { type: 'log' } }];
    const { pipeline } = setup(makeConfig({ rules }));
    pipeline.run(ctx('hello'));
    pipeline.run(ctx('xyz'));
    expect(pipeline.ruleHits.get('a')).toBe(2);
    expect(pipeline.ruleHits.get('b')).toBe(1);
  });
  it('keeps separate stats for each kind', () => {
    const rules: Rule[] = [drop('r', { on: ['bidi'] })];
    const { pipeline, stats } = setup(makeConfig({ rules }));
    pipeline.run(ctx('x', { kind: 'bidi' }));
    pipeline.run(ctx('x', { kind: 'uni' }));
    expect(stats.bidi.dropped).toBe(1);
    expect(stats.uni.dropped).toBe(0);
    expect(stats.datagram.dropped).toBe(0);
  });
});

describe('hold action', () => {
  const run = (canHold: boolean, rules: RuntimeConfig['rules']) => {
    const config: RuntimeConfig = { ...structuredClone(DEFAULT_CONFIG), rules };
    const pipeline = createPipeline({ getConfig: () => config, stats: createStats(), random: () => 0, log: () => undefined, canHold: () => canHold });
    return pipeline.run({ kind: 'datagram', origin: 'remote', sessionId: 1, url: 'https://a.test', streamId: null, seq: 0, data: Uint8Array.of(1) });
  };
  const hold = (id: string, timeoutMs: number): RuntimeConfig['rules'][number] => ({ id, action: { type: 'hold', timeoutMs, onTimeout: 'drop' } });

  it('the first hold rule sets the time, and the rules after it still run', () => {
    const result = run(true, [hold('a', 100), hold('b', 200), { id: 'm', action: { type: 'modify', ops: [{ op: 'set', data: 'x' }] } }]);
    expect(result.hold).toEqual({ ruleId: 'a', timeoutMs: 100, onTimeout: 'drop' });
    expect(result.data).toEqual(new TextEncoder().encode('x'));
  });

  it('does nothing when it cannot hold, and a drop rule still drops', () => {
    expect(run(false, [hold('a', 100)]).hold).toBeUndefined();
    expect(run(true, [hold('a', 100), { id: 'd', action: { type: 'drop' } }])).toEqual({ data: null, delayMs: 0 });
  });
});
