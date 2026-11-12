// The rule form works on text fields. This turns them into DSL rules and back. The validator decides what is valid, so
// the form cannot save a rule that a page would reject.
import type { HoldTimeoutAction, MoqtMatch, Rule, RuleDirection, RuleAction, RuleMatch, TrafficKind } from '../shared/rules';

export type DraftAction = 'drop' | 'delay' | 'modify-replace' | 'modify-set' | 'log' | 'hold' | 'stall' | 'close-session' | 'reset-stream';

export interface RuleDraft {
  id: string;
  enabled: boolean;
  action: DraftAction;
  kinds: Record<TrafficKind, boolean>;
  direction: RuleDirection;
  contains: string;
  prefix: string;
  regex: string;
  ignoreCase: boolean;
  minSize: string;
  maxSize: string;
  sessionUrl: string;
  track: string;
  keyframe: '' | 'key' | 'delta';
  trackAlias: string;
  groupMin: string;
  groupMax: string;
  subgroup: string;
  objectMin: string;
  objectMax: string;
  /** 0 to 100, as the user thinks of it. */
  percent: string;
  final: boolean;
  delayMs: string;
  jitterMs: string;
  find: string;
  replaceWith: string;
  setData: string;
  /** In seconds, as the user thinks of it. */
  holdSeconds: string;
  onTimeout: HoldTimeoutAction;
  /** In seconds, as the user thinks of it. */
  stallSeconds: string;
  closeCode: string;
  closeReason: string;
  resetCode: string;
}

const MOQT_FIELDS = ['trackAlias', 'groupMin', 'groupMax', 'subgroup', 'objectMin', 'objectMax'] as const;

export function newDraft(id: string): RuleDraft {
  return {
    id,
    enabled: true,
    action: 'drop',
    kinds: { datagram: true, uni: true, bidi: true },
    direction: 'in',
    contains: '',
    prefix: '',
    regex: '',
    ignoreCase: false,
    minSize: '',
    maxSize: '',
    sessionUrl: '',
    track: '',
    keyframe: '',
    trackAlias: '',
    groupMin: '',
    groupMax: '',
    subgroup: '',
    objectMin: '',
    objectMax: '',
    percent: '',
    final: false,
    delayMs: '100',
    jitterMs: '',
    find: '',
    replaceWith: '',
    setData: '',
    holdSeconds: '30',
    onTimeout: 'forward',
    stallSeconds: '3',
    closeCode: '0',
    closeReason: 'Closed by Sluice',
    resetCode: '0',
  };
}

/** Empty stays out of the rule. Text that is not a number becomes NaN, and the validator names the field. */
const toNumber = (text: string): number | undefined => (text.trim() === '' ? undefined : Number(text));

function actionOf(draft: RuleDraft): RuleAction {
  switch (draft.action) {
    case 'drop':
      return { type: 'drop' };
    case 'log':
      return { type: 'log' };
    case 'hold':
      return { type: 'hold', timeoutMs: (toNumber(draft.holdSeconds) ?? NaN) * 1000, onTimeout: draft.onTimeout };
    case 'delay': {
      const jitterMs = toNumber(draft.jitterMs);
      return { type: 'delay', delayMs: toNumber(draft.delayMs) ?? NaN, ...(jitterMs === undefined ? {} : { jitterMs }) };
    }
    case 'modify-replace':
      return { type: 'modify', ops: [{ op: 'replace', find: draft.find, with: draft.replaceWith }] };
    case 'modify-set':
      return { type: 'modify', ops: [{ op: 'set', data: draft.setData }] };
    case 'stall':
      return { type: 'stall', durationMs: Math.round((toNumber(draft.stallSeconds) ?? NaN) * 1000) };
    case 'close-session':
      return { type: 'close-session', closeCode: toNumber(draft.closeCode) ?? NaN, reason: draft.closeReason };
    case 'reset-stream':
      return { type: 'reset-stream', code: toNumber(draft.resetCode) ?? NaN };
  }
}

export function draftToRule(draft: RuleDraft): Rule {
  const match: RuleMatch = {};
  if (draft.contains) match.contains = [draft.contains];
  if (draft.prefix) match.prefix = draft.prefix;
  if (draft.regex) {
    match.regex = draft.regex;
    if (draft.ignoreCase) match.regexFlags = 'i';
  }
  const minSize = toNumber(draft.minSize);
  const maxSize = toNumber(draft.maxSize);
  if (minSize !== undefined) match.minSize = minSize;
  if (maxSize !== undefined) match.maxSize = maxSize;
  if (draft.sessionUrl) match.sessionUrl = draft.sessionUrl;
  const moqt: MoqtMatch = {};
  for (const key of MOQT_FIELDS) {
    const value = toNumber(draft[key]);
    if (value !== undefined) moqt[key] = value;
  }
  if (draft.track) moqt.track = draft.track;
  if (draft.keyframe) moqt.keyframe = draft.keyframe === 'key';
  if (Object.keys(moqt).length > 0) match.moqt = moqt;

  const rule: Rule = { id: draft.id, action: actionOf(draft) };
  if (!draft.enabled) rule.enabled = false;
  const kinds = (Object.keys(draft.kinds) as TrafficKind[]).filter((kind) => draft.kinds[kind]);
  // All kinds is the default. None stays in, and the validator says that it is wrong.
  if (kinds.length < 3) rule.on = kinds;
  if (draft.direction !== 'in') rule.direction = draft.direction;
  if (Object.keys(match).length > 0) rule.match = match;
  const percent = toNumber(draft.percent);
  if (percent !== undefined) rule.probability = percent / 100;
  if (draft.final) rule.final = true;
  return rule;
}

/** The form shows one text pattern and one edit. Null for a rule with more, which stays as it is, and read only. */
export function ruleToDraft(rule: Rule): RuleDraft | null {
  const draft = newDraft(rule.id);
  draft.enabled = rule.enabled !== false;
  draft.final = rule.final === true;
  draft.direction = rule.direction ?? 'in';
  if (rule.on) draft.kinds = { datagram: rule.on.includes('datagram'), uni: rule.on.includes('uni'), bidi: rule.on.includes('bidi') };
  if (rule.probability !== undefined) draft.percent = String(rule.probability * 100);

  const { match, action } = rule;
  if (match) {
    const [first, ...others] = match.contains ?? [];
    if (others.length > 0 || (first !== undefined && typeof first !== 'string')) return null;
    if (match.prefix !== undefined && typeof match.prefix !== 'string') return null;
    if (match.regexFlags !== undefined && match.regexFlags !== 'i') return null;
    draft.contains = first ?? '';
    draft.prefix = match.prefix ?? '';
    draft.regex = match.regex ?? '';
    draft.ignoreCase = match.regexFlags === 'i';
    draft.minSize = match.minSize === undefined ? '' : String(match.minSize);
    draft.maxSize = match.maxSize === undefined ? '' : String(match.maxSize);
    draft.sessionUrl = match.sessionUrl ?? '';
    draft.track = match.moqt?.track ?? '';
    draft.keyframe = match.moqt?.keyframe === undefined ? '' : match.moqt.keyframe ? 'key' : 'delta';
    for (const key of MOQT_FIELDS) {
      const value = match.moqt?.[key];
      draft[key] = value === undefined ? '' : String(value);
    }
  }

  switch (action.type) {
    case 'drop':
    case 'log':
      draft.action = action.type;
      return draft;
    case 'hold':
      draft.action = 'hold';
      draft.holdSeconds = String(action.timeoutMs / 1000);
      draft.onTimeout = action.onTimeout;
      return draft;
    case 'delay':
      draft.action = 'delay';
      draft.delayMs = String(action.delayMs);
      draft.jitterMs = action.jitterMs === undefined ? '' : String(action.jitterMs);
      return draft;
    case 'modify': {
      const [op, ...more] = action.ops;
      if (!op || more.length > 0) return null;
      if (op.op === 'set') {
        if (typeof op.data !== 'string') return null;
        draft.action = 'modify-set';
        draft.setData = op.data;
        return draft;
      }
      if (typeof op.find !== 'string' || typeof op.with !== 'string') return null;
      draft.action = 'modify-replace';
      draft.find = op.find;
      draft.replaceWith = op.with;
      return draft;
    }
    case 'stall':
      draft.action = 'stall';
      draft.stallSeconds = String(action.durationMs / 1000);
      return draft;
    case 'close-session':
      draft.action = 'close-session';
      draft.closeCode = String(action.closeCode);
      draft.closeReason = action.reason;
      return draft;
    case 'reset-stream':
      draft.action = 'reset-stream';
      draft.resetCode = String(action.code);
      return draft;
  }
}

/** Longest value in the closed row. Edit shows all of it. */
const SUMMARY_VALUE_CHARS = 60;
const short = (value: string): string => (value.length > SUMMARY_VALUE_CHARS ? `${value.slice(0, SUMMARY_VALUE_CHARS)}…` : value);

const KIND_NAMES: Record<TrafficKind, string> = { datagram: 'datagrams', uni: 'uni streams', bidi: 'bidi streams' };

function describeAction(draft: RuleDraft): string {
  switch (draft.action) {
    case 'drop':
      return 'Drop';
    case 'log':
      return 'Log';
    case 'hold':
      return `Hold up to ${short(draft.holdSeconds)} s, then ${draft.onTimeout}`;
    case 'delay':
      return `Delay ${short(draft.delayMs)} ms${draft.jitterMs ? ` ± ${short(draft.jitterMs)} ms` : ''}`;
    case 'modify-replace':
      return `Replace "${short(draft.find)}" with "${short(draft.replaceWith)}"`;
    case 'modify-set':
      return `Set payload to "${short(draft.setData)}"`;
    case 'stall':
      return `Stall the session for ${short(draft.stallSeconds)} s`;
    case 'close-session':
      return `Close the session (code ${short(draft.closeCode)})`;
    case 'reset-stream':
      return `Reset the stream (code ${short(draft.resetCode)})`;
  }
}

/** The closed row of a rule. It must say all that the rule does, as a rule for one kind must not read like a rule for all. */
export function describeDraft(draft: RuleDraft): string {
  const kinds = (Object.keys(draft.kinds) as TrafficKind[]).filter((kind) => draft.kinds[kind]).map((kind) => KIND_NAMES[kind]);
  const conditions = [
    draft.contains && `contains "${short(draft.contains)}"`,
    draft.prefix && `starts with "${short(draft.prefix)}"`,
    draft.regex && `matches /${short(draft.regex)}/${draft.ignoreCase ? 'i' : ''}`,
    draft.minSize && `at least ${short(draft.minSize)} bytes`,
    draft.maxSize && `at most ${short(draft.maxSize)} bytes`,
    draft.sessionUrl && `session URL contains "${short(draft.sessionUrl)}"`,
    draft.track && `track "${short(draft.track)}"`,
    draft.keyframe && (draft.keyframe === 'key' ? 'key frames only' : 'not key frames'),
    draft.trackAlias && `track alias ${short(draft.trackAlias)}`,
    (draft.groupMin || draft.groupMax) && `group ${short(draft.groupMin) || '0'} to ${short(draft.groupMax) || 'any'}`,
    draft.subgroup && `subgroup ${short(draft.subgroup)}`,
    (draft.objectMin || draft.objectMax) && `object ${short(draft.objectMin) || '0'} to ${short(draft.objectMax) || 'any'}`,
    draft.percent && `${short(draft.percent)}% of the time`,
  ].filter(Boolean);
  const onlySome = kinds.length < 3;
  return [
    describeAction(draft),
    draft.direction === 'out' ? 'on what the app sends' : draft.direction === 'both' && 'on what the app receives and sends',
    onlySome && (kinds.length > 0 ? `only ${kinds.join(' and ')}` : 'no traffic kind chosen'),
    conditions.length > 0 ? `if ${conditions.join(' and ')}` : !onlySome && 'for every message',
    draft.final && 'then skip the rules after it',
    !draft.enabled && 'turned off',
  ]
    .filter(Boolean)
    .join(', ');
}
