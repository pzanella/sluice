import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Rule } from '../rules';
import { LIMITS, validateConfig, validateRule, validateRules } from '../validate';

const drop = { id: 'r1', action: { type: 'drop' } };
const invalid = (value: unknown): string => {
  const result = validateRule(value);
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.errors.join('\n');
};
const withMatch = (match: unknown): unknown => ({ ...drop, match });
const withAction = (action: unknown): unknown => ({ id: 'r1', action });

describe('validateRule', () => {
  it('accepts a full rule and returns an equal copy', () => {
    const rule: Rule = {
      id: 'full',
      enabled: true,
      on: ['datagram', 'uni'],
      match: { contains: ['a', [1, 2]], prefix: [0], regex: 'a+', regexFlags: 'i', minSize: 1, maxSize: 9, sessionUrl: 'x' },
      action: { type: 'modify', ops: [{ op: 'set', data: 'x' }, { op: 'replace', find: 'a', with: '' }] },
      probability: 0.5,
      final: true,
    };
    const result = validateRule(rule);
    expect(result).toEqual({ ok: true, value: rule });
    if (result.ok) expect(result.value).not.toBe(rule);
  });

  it.each([[null], [undefined], [1], ['x'], [[]], [new Date()], [new Map()]])('rejects %s as a rule', (value) => {
    invalid(value);
  });

  it('rejects a bad id', () => {
    expect(invalid({ action: { type: 'drop' } })).toContain('rule.id');
    expect(invalid({ id: '', action: { type: 'drop' } })).toContain('rule.id');
    expect(invalid({ id: 1, action: { type: 'drop' } })).toContain('rule.id');
    expect(invalid({ id: 'x'.repeat(LIMITS.ruleId + 1), action: { type: 'drop' } })).toContain('at most');
  });

  it('rejects unknown fields, so a typo cannot widen a rule', () => {
    expect(invalid(withMatch({ prefx: 'a' }))).toContain('unknown field "prefx"');
    expect(invalid({ ...drop, extra: 1 })).toContain('unknown field "extra"');
  });

  it('rejects __proto__ and leaves Object.prototype alone', () => {
    const value: unknown = JSON.parse('{"id":"r","action":{"type":"drop"},"__proto__":{"polluted":true}}');
    expect(invalid(value)).toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not read inherited values', () => {
    const inherited = Object.create({ polluted: true }) as object;
    Object.assign(inherited, drop);
    invalid(inherited);
  });

  it.each([[-1], [NaN], [Infinity], ['1'], [null], [1.5]])('rejects minSize %s', (minSize) => {
    expect(invalid(withMatch({ minSize }))).toContain('minSize');
  });

  it('rejects minSize above maxSize', () => {
    expect(invalid(withMatch({ minSize: 2, maxSize: 1 }))).toContain('above maxSize');
  });

  it.each([[-1], [NaN], [Infinity], ['1'], [null], [LIMITS.delayMs + 1]])('rejects delayMs %s', (delayMs) => {
    expect(invalid(withAction({ type: 'delay', delayMs }))).toContain('delayMs');
    expect(invalid(withAction({ type: 'delay', delayMs: 1, jitterMs: delayMs }))).toContain('jitterMs');
  });

  it('requires delayMs', () => {
    expect(invalid(withAction({ type: 'delay' }))).toContain('delayMs');
  });

  it.each([[-0.1], [1.1], [NaN], ['0.5']])('rejects probability %s', (probability) => {
    expect(invalid({ ...drop, probability })).toContain('probability');
  });

  it.each([['a'], [{}], [1], [null]])('rejects contains that is not a list: %s', (contains) => {
    expect(invalid(withMatch({ contains }))).toContain('contains');
  });

  it('rejects an empty contains, and empty patterns', () => {
    expect(invalid(withMatch({ contains: [] }))).toContain('at least 1');
    expect(invalid(withMatch({ contains: [''] }))).toContain('contains[0]');
    expect(invalid(withMatch({ prefix: [] }))).toContain('prefix');
  });

  it.each([[256], [-1], [1.5], [NaN], ['1'], [null]])('rejects byte %s in a pattern', (byte) => {
    expect(invalid(withMatch({ prefix: [byte] }))).toContain('prefix[0]');
  });

  it('rejects patterns past the limit', () => {
    expect(invalid(withMatch({ prefix: 'x'.repeat(LIMITS.pattern + 1) }))).toContain('at most');
    expect(invalid(withMatch({ prefix: new Array(LIMITS.pattern + 1).fill(0) }))).toContain('at most');
    expect(invalid(withMatch({ contains: new Array(LIMITS.patternsPerRule + 1).fill('a') }))).toContain('at most');
  });

  it('rejects an invalid regex or flags', () => {
    expect(invalid(withMatch({ regex: '(' }))).toContain('not a valid regular expression');
    expect(invalid(withMatch({ regex: 'a', regexFlags: 'zz' }))).toContain('not a valid regular expression');
    expect(invalid(withMatch({ regex: '' }))).toContain('regex');
    expect(invalid(withMatch({ regex: 1 }))).toContain('regex');
    expect(invalid(withMatch({ regex: 'x'.repeat(LIMITS.regex + 1) }))).toContain('at most');
    expect(invalid(withMatch({ regexFlags: 'i' }))).toContain('needs a regex');
  });

  it.each([['(a+)+$'], ['(a*)*'], ['(ab+)+'], ['(a{1,9})+'], ['x(a+)*y'], ['((a+))+'], ['((a+)b)*'], ['(?:a+)+']])('rejects %s, which can hang the page', (regex) => {
    expect(invalid(withMatch({ regex }))).toContain('repeat inside a repeat');
  });

  it.each([['a+b+'], ['(ab)+'], ['(a+)'], ['\\(a+\\)+'], ['([a+])+'], ['^\\d{2,4}$'], ['(a)(b+)c'], ['((a)b)+'], ['(a+)(b)+']])('accepts %s', (regex) => {
    expect(validateRule(withMatch({ regex })).ok).toBe(true);
  });

  it('rejects bad actions', () => {
    invalid({ id: 'r' });
    expect(invalid(withAction({ type: 'eval' }))).toContain('action.type');
    expect(invalid(withAction({ type: 'drop', delayMs: 1 }))).toContain('does not take');
    expect(invalid(withAction({ type: 'modify', ops: [] }))).toContain('ops');
    expect(invalid(withAction({ type: 'modify', ops: [{ op: 'run' }] }))).toContain('ops[0].op');
    expect(invalid(withAction({ type: 'modify', ops: [{ op: 'set', data: '' }] }))).toContain('data');
    expect(invalid(withAction({ type: 'modify', ops: [{ op: 'replace', find: '', with: 'a' }] }))).toContain('find');
    expect(invalid(withAction({ type: 'modify', ops: [{ op: 'replace', find: 'a' }] }))).toContain('with');
    expect(invalid(withAction({ type: 'modify', ops: [{ op: 'set', data: 'a', find: 'b' }] }))).toContain('"set"');
  });

  it('rejects holes in lists, which structured clone keeps', () => {
    const holes = structuredClone(new Array(3));
    expect(invalid(withMatch({ contains: holes }))).toContain('contains[0]');
    expect(invalid(withMatch({ prefix: holes }))).toContain('prefix[0]');
    expect(invalid({ ...drop, on: holes })).toContain('on[0]');
    expect(invalid(withAction({ type: 'modify', ops: holes }))).toContain('ops[0]');
    expect(validateRules(holes).ok).toBe(false);
  });

  it('rejects patterns past the total budget of the rules', () => {
    const pattern = 'x'.repeat(LIMITS.pattern);
    const count = Math.ceil(LIMITS.totalPatternChars / LIMITS.pattern) + 1;
    const result = validateRules(Array.from({ length: count }, (_, i) => ({ id: `r${i}`, match: { prefix: pattern }, action: { type: 'drop' } })));
    expect(result.ok ? '' : result.errors.join()).toContain('total size');
  });

  it('stops at the first unknown field', () => {
    const many = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, 1]));
    const result = validateRule({ ...drop, ...many });
    expect(result.ok ? [] : result.errors).toHaveLength(1);
  });

  it('reads the length of a list once, so a getter cannot grow it past the limit', () => {
    const list: unknown[] = [];
    Object.defineProperty(list, 0, {
      enumerable: true,
      get() {
        list.length = 1000;
        return 'a';
      },
    });
    const result = validateRule(withMatch({ contains: list }));
    expect(result.ok && result.value.match?.contains).toEqual(['a']);
  });

  it('rejects a function anywhere', () => {
    invalid({ id: 'r', action: () => undefined });
    invalid(withMatch(() => true));
    invalid(withMatch({ regex: () => 'a' }));
  });

  it('rejects bad on and flags', () => {
    expect(invalid({ ...drop, on: [] })).toContain('on');
    expect(invalid({ ...drop, on: ['tcp'] })).toContain('on[0]');
    expect(invalid({ ...drop, enabled: 'yes' })).toContain('enabled');
    expect(invalid({ ...drop, final: 1 })).toContain('final');
  });

  it('turns a throwing getter into an error', () => {
    const hostile = {
      get id(): string {
        throw new Error('boom');
      },
      action: { type: 'drop' },
    };
    expect(validateRule(hostile)).toEqual({ ok: false, errors: ['value cannot be read'] });
  });

  it('reads each value once, so a getter cannot pass the check and then change', () => {
    let reads = 0;
    const flipping = {
      get id(): unknown {
        reads++;
        return reads === 1 ? 'good' : 1;
      },
      action: { type: 'drop' },
    };
    const result = validateRule(flipping);
    expect(reads).toBe(1);
    expect(result.ok && result.value.id).toBe('good');
  });

  it('caps the number of errors', () => {
    const result = validateRules(new Array(LIMITS.rules).fill(null));
    expect(result.ok ? 0 : result.errors.length).toBe(20);
  });
});

describe('validateRules', () => {
  it('rejects null rules and non-lists', () => {
    expect(validateRules([null]).ok).toBe(false);
    expect(validateRules(null).ok).toBe(false);
    expect(validateRules({}).ok).toBe(false);
  });

  it('rejects duplicate ids', () => {
    const result = validateRules([drop, drop]);
    expect(result.ok ? '' : result.errors[0]).toContain('already used');
  });

  it('rejects too many rules before it reads them', () => {
    const list = new Proxy(new Array(LIMITS.rules + 1).fill(drop), {
      get(target, key, receiver): unknown {
        if (key === '0') throw new Error('item was read');
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const result = validateRules(list);
    expect(result.ok ? '' : result.errors[0]).toContain('at most');
  });

  it('accepts an empty list', () => {
    expect(validateRules([])).toEqual({ ok: true, value: [] });
  });
});

describe('validateConfig', () => {
  it('accepts the default config and returns a copy', () => {
    const result = validateConfig(DEFAULT_CONFIG);
    expect(result).toEqual({ ok: true, value: DEFAULT_CONFIG });
    if (result.ok) expect(result.value).not.toBe(DEFAULT_CONFIG);
  });

  const change = (edit: (config: typeof DEFAULT_CONFIG & Record<string, unknown>) => void): boolean => {
    const config = structuredClone(DEFAULT_CONFIG) as typeof DEFAULT_CONFIG & Record<string, unknown>;
    edit(config);
    return validateConfig(config).ok;
  };

  it.each([[-1], [NaN], [Infinity], [1.5], [LIMITS.maxDelayedBytes + 1]])('rejects maxDelayedBytes %s', (value) => {
    expect(change((c) => (c.maxDelayedBytes = value))).toBe(false);
  });

  it('rejects bad nested values', () => {
    expect(change((c) => (c.datagram.dropRate = 1.1))).toBe(false);
    expect(change((c) => (c.datagram.delayMs = -1))).toBe(false);
    expect(change((c) => (c.stream.jitterMs = NaN))).toBe(false);
    expect(change((c) => (c.log.previewBytes = -1))).toBe(false);
    expect(change((c) => ((c as Record<string, unknown>).enabled = 'yes'))).toBe(false);
    expect(change((c) => ((c as Record<string, unknown>).rules = [null]))).toBe(false);
    expect(change((c) => (c.extra = 1))).toBe(false);
  });

  it('rejects missing fields, at each level', () => {
    expect(change((c) => delete (c as Record<string, unknown>).rules)).toBe(false);
    expect(change((c) => delete (c.log as Record<string, unknown>).uni)).toBe(false);
    expect(change((c) => delete (c.datagram as Record<string, unknown>).preserveOrder)).toBe(false);
    expect(change((c) => delete (c.stream as Record<string, unknown>).delayMs)).toBe(false);
  });

  it('delay limits stay below the setTimeout maximum', () => {
    const perSource = LIMITS.delayMs * 2; // Delay plus jitter.
    expect(perSource * (LIMITS.rules + 1)).toBeLessThan(2 ** 31 - 1);
  });
});

describe('connection actions in rules (ADR-41)', () => {
  it.each([
    [{ type: 'stall', durationMs: 3000 }, true],
    [{ type: 'stall', durationMs: 0 }, false],
    [{ type: 'stall', durationMs: 200_000 }, false],
    [{ type: 'close-session', closeCode: 0, reason: 'bye' }, true],
    [{ type: 'close-session', closeCode: -1, reason: '' }, false],
    [{ type: 'close-session', closeCode: 0, reason: 'x'.repeat(1025) }, false],
    [{ type: 'reset-stream', code: 255 }, true],
    [{ type: 'reset-stream', code: 256 }, false],
    [{ type: 'reset-stream', code: 1, reason: 'x' }, false],
  ])('%j is valid: %s', (action, ok) => {
    expect(validateRule({ id: 'a', action }).ok).toBe(ok);
  });
});

describe('timeline in the config (ADR-47)', () => {
  const withTimeline = (timeline: unknown) => validateConfig({ ...DEFAULT_CONFIG, timeline });
  it('takes network, stall and close steps', () => {
    expect(
      withTimeline([
        { atMs: 10_000, action: { type: 'network', dropRate: 0.05, delayMs: 200, jitterMs: 50 } },
        { atMs: 30_000, action: { type: 'stall', durationMs: 5000 } },
        { atMs: 60_000, action: { type: 'close-session', closeCode: 0, reason: 'end' } },
      ]).ok,
    ).toBe(true);
  });
  it.each([
    [[{ atMs: -1, action: { type: 'stall', durationMs: 5 } }]],
    [[{ atMs: 0, action: { type: 'reset-stream', code: 1 } }]],
    [[{ atMs: 0, action: { type: 'network', dropRate: 2, delayMs: 0, jitterMs: 0 } }]],
    [Array.from({ length: 65 }, () => ({ atMs: 0, action: { type: 'stall', durationMs: 5 } }))],
  ])('refuses %j', (timeline) => {
    expect(withTimeline(timeline).ok).toBe(false);
  });
});
