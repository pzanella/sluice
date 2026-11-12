import { describe, expect, it } from 'vitest';
import type { Rule } from '../../shared/rules';
import { validateRule, validateRules } from '../../shared/validate';
import { RULE_TEMPLATES } from '../rule-templates';
import { describeDraft, draftToRule, newDraft, ruleToDraft } from '../rule-draft';

describe('rule drafts', () => {
  it('keeps the MoQT fields, and leaves out empty ones', () => {
    const draft = { ...newDraft('r'), groupMin: '10', groupMax: '20', trackAlias: '0' };
    const rule = draftToRule(draft);
    expect(rule.match).toEqual({ moqt: { trackAlias: 0, groupMin: 10, groupMax: 20 } });
    expect(validateRule(rule).ok).toBe(true);
    const back = ruleToDraft(rule);
    expect([back?.groupMin, back?.groupMax, back?.trackAlias, back?.objectMin]).toEqual(['10', '20', '0', '']);
    expect(describeDraft(draft)).toContain('group 10 to 20');
    expect(draftToRule(newDraft('r')).match).toBeUndefined();
  });

  it('a new draft is a valid drop rule for every message, with no extra fields', () => {
    const rule = draftToRule(newDraft('r1'));
    expect(rule).toEqual({ id: 'r1', action: { type: 'drop' } });
    expect(validateRule(rule).ok).toBe(true);
  });

  it('turns every field into a valid rule, and back', () => {
    const draft = {
      ...newDraft('r'),
      enabled: false,
      action: 'delay' as const,
      kinds: { datagram: true, uni: false, bidi: false },
      contains: 'a',
      prefix: 'b',
      regex: 'c+',
      ignoreCase: true,
      minSize: '1',
      maxSize: '9',
      sessionUrl: 'x',
      percent: '50',
      final: true,
      delayMs: '10',
      jitterMs: '5',
    };
    const rule = draftToRule(draft);
    expect(validateRule(rule)).toEqual({ ok: true, value: rule });
    expect(ruleToDraft(rule)).toEqual(draft);
  });

  it.each([
    [{ action: 'modify-replace', find: 'a', replaceWith: '' }, { type: 'modify', ops: [{ op: 'replace', find: 'a', with: '' }] }],
    [{ action: 'modify-set', setData: 'z' }, { type: 'modify', ops: [{ op: 'set', data: 'z' }] }],
    [{ action: 'log' }, { type: 'log' }],
  ])('action %j', (fields, action) => {
    const draft = { ...newDraft('r'), ...fields } as ReturnType<typeof newDraft>;
    const rule = draftToRule(draft);
    expect(rule.action).toEqual(action);
    expect(ruleToDraft(rule)).toEqual(draft);
  });

  it.each([
    ['text in a number field', { minSize: 'abc' }, 'minSize'],
    ['a negative delay', { action: 'delay', delayMs: '-1' }, 'delayMs'],
    ['an empty delay', { action: 'delay', delayMs: '' }, 'delayMs'],
    ['over 100 percent', { percent: '150' }, 'probability'],
    ['no kinds', { kinds: { datagram: false, uni: false, bidi: false } }, 'on'],
    ['a bad regex', { regex: '(' }, 'regex'],
    ['a slow regex', { regex: '(a+)+' }, 'repeat inside a repeat'],
    ['an empty find', { action: 'modify-replace', find: '' }, 'find'],
    ['an empty set', { action: 'modify-set', setData: '' }, 'data'],
  ])('the validator rejects %s', (_name, fields, expected) => {
    const result = validateRule(draftToRule({ ...newDraft('r'), ...fields } as ReturnType<typeof newDraft>));
    expect(result.ok ? '' : result.errors.join()).toContain(expected);
  });

  it.each<[string, Rule]>([
    ['two patterns', { id: 'r', match: { contains: ['a', 'b'] }, action: { type: 'drop' } }],
    ['byte patterns', { id: 'r', match: { contains: [[1]] }, action: { type: 'drop' } }],
    ['a byte prefix', { id: 'r', match: { prefix: [1] }, action: { type: 'drop' } }],
    ['other flags', { id: 'r', match: { regex: 'a', regexFlags: 'm' }, action: { type: 'drop' } }],
    ['two edits', { id: 'r', action: { type: 'modify', ops: [{ op: 'set', data: 'a' }, { op: 'set', data: 'b' }] } }],
    ['byte edits', { id: 'r', action: { type: 'modify', ops: [{ op: 'set', data: [1] }] } }],
  ])('a rule with %s is not editable in the form', (_name, rule) => {
    expect(ruleToDraft(rule)).toBeNull();
  });

  it('describes a rule in words', () => {
    expect(describeDraft(newDraft('r'))).toBe('Drop, for every message');
    expect(describeDraft({ ...newDraft('r'), action: 'delay', delayMs: '50', contains: 'x', percent: '10' })).toBe(
      'Delay 50 ms, if contains "x" and 10% of the time',
    );
  });

  it('says all that a rule does, as a rule for one kind must not read like a rule for all', () => {
    const draft = { ...newDraft('r'), kinds: { datagram: true, uni: false, bidi: false } };
    expect(describeDraft(draft)).toBe('Drop, only datagrams');
    expect(describeDraft({ ...draft, sessionUrl: 'a', minSize: '100', maxSize: '200' })).toBe(
      'Drop, only datagrams, if at least 100 bytes and at most 200 bytes and session URL contains "a"',
    );
    expect(describeDraft({ ...newDraft('r'), action: 'delay', delayMs: '100', jitterMs: '50' })).toBe('Delay 100 ms ± 50 ms, for every message');
    expect(describeDraft({ ...newDraft('r'), action: 'modify-replace', find: 'a', replaceWith: 'b' })).toBe('Replace "a" with "b", for every message');
    expect(describeDraft({ ...newDraft('r'), action: 'modify-set', setData: 'z', regex: 'x', ignoreCase: true })).toBe('Set payload to "z", if matches /x/i');
    expect(describeDraft({ ...newDraft('r'), final: true, enabled: false })).toBe('Drop, for every message, then skip the rules after it, turned off');
  });

  it('a hold rule goes to the DSL in ms and back in seconds, and a bad time is refused', () => {
    const draft = { ...newDraft('r'), action: 'hold' as const, holdSeconds: '2.5', onTimeout: 'drop' as const };
    const rule = draftToRule(draft);
    expect(rule.action).toEqual({ type: 'hold', timeoutMs: 2500, onTimeout: 'drop' });
    expect(validateRule(rule).ok).toBe(true);
    expect(ruleToDraft(rule)).toEqual(draft);
    expect(describeDraft(draft)).toBe('Hold up to 2.5 s, then drop, for every message');
    for (const holdSeconds of ['', '0', '301', 'x']) expect(validateRule(draftToRule({ ...draft, holdSeconds })).ok).toBe(false);
  });

  it('cuts a long value in the summary', () => {
    expect(describeDraft({ ...newDraft('r'), regex: 'a'.repeat(5000) })).toBe(`Drop, if matches /${'a'.repeat(60)}…/`);
  });
});

describe('rule templates', () => {
  it.each(RULE_TEMPLATES.map((template) => [template.label, template] as const))('%s gives a valid rule', (_label, template) => {
    const rule = draftToRule({ ...newDraft('t1'), ...template.draft });
    expect(validateRules([rule]).ok).toBe(true);
  });
});

describe('connection actions in the form', () => {
  it.each([
    { type: 'stall', durationMs: 2500 },
    { type: 'close-session', closeCode: 4, reason: 'bye' },
    { type: 'reset-stream', code: 7 },
  ] as const)('%j goes to the form and back', (action) => {
    const rule: Rule = { id: 'r', action };
    const draft = ruleToDraft(rule);
    if (!draft) throw new Error('no draft');
    expect(draftToRule(draft)).toEqual(rule);
    expect(validateRule(draftToRule(draft)).ok).toBe(true);
  });
});
