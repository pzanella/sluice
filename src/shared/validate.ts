// Validators for the rule DSL and the runtime config. Input is untrusted, so:
// - unknown fields are errors: a typo such as `prefx` would otherwise give a rule that matches everything;
// - each value is read once and copied, and callers use only the copy. It has no extra fields;
// - nothing here runs input as code. `new RegExp` only compiles a pattern.
import type { Bandwidth, BytePattern, ModifyOp, MoqtMatch, Rule, RuleAction, RuleMatch, RuntimeConfig, TimelineStep, TrafficKind } from './rules';

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * Size limits. Delays are capped so that the sum of every delay of a chunk stays below the setTimeout maximum
 * (2^31 - 1 ms): past that, a timer fires at once. See the test "delay limits stay below the setTimeout maximum".
 */
export const LIMITS = {
  /** A hold always ends, and soon: while it waits, the stream behind it waits too. */
  holdMinMs: 100,
  holdMaxMs: 5 * 60 * 1000,
  rules: 256,
  ruleId: 128,
  patternsPerRule: 256,
  /** Characters in a string pattern, or bytes in a list pattern. */
  pattern: 64 * 1024,
  /** All the patterns of one validation. Rules must fit in a port message and in chrome.storage.session. */
  totalPatternChars: 1024 * 1024,
  regex: 1024,
  sessionUrl: 8192,
  opsPerRule: 64,
  delayMs: 3_600_000,
  /** A stall ends: while it lasts, delayed bytes grow, and the stream stops reading at maxDelayedBytes. */
  stallMaxMs: 120_000,
  timelineSteps: 64,
  /** 10 Gbit/s. */
  kbps: 10_000_000,
  queueMs: 60_000,
  /** A step at most 24 hours after the session opens. */
  timelineMs: 86_400_000,
  /** WebTransport close info: a 32-bit code and a reason of at most 1024 bytes. */
  closeCode: 0xffffffff,
  closeReason: 1024,
  /** WebTransport stream error codes are 0 to 255 in Chromium. */
  streamErrorCode: 255,
  previewBytes: 64 * 1024,
  /** Per stream, and the server chooses how many streams there are. */
  maxDelayedBytes: 64 * 1024 * 1024,
} as const;

const MAX_ERRORS = 20;
export const TRAFFIC_KINDS: readonly TrafficKind[] = ['datagram', 'uni', 'bidi'];

/** Collects errors, each with the path of the value. */
export class Check {
  readonly errors: string[] = [];
  patternChars = 0;

  fail(path: string, message: string): undefined {
    if (this.errors.length < MAX_ERRORS) this.errors.push(`${path}: ${message}`);
    return undefined;
  }

  /** A plain object with only the allowed keys. The result has no prototype, so inherited values are never read. */
  object(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return this.fail(path, 'must be an object');
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return this.fail(path, 'must be a plain object');
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        // Return at once: an object with many unknown keys must not cost one error text for each.
        return this.fail(path, `unknown field "${key.slice(0, 64)}"`);
      }
      copy[key] = (value as Record<string, unknown>)[key];
    }
    return copy;
  }

  /** The length is checked before the first item is read, so a huge list costs nothing. */
  list(value: unknown, path: string, max: number, min = 0): unknown[] | undefined {
    if (!Array.isArray(value)) return this.fail(path, 'must be a list');
    // Read once: a getter on an item could change the length while the loop below runs.
    const { length } = value;
    if (length < min) return this.fail(path, `must have at least ${min} item(s)`);
    if (length > max) return this.fail(path, `must have at most ${max} items`);
    // A copy with no holes. Structured clone keeps holes, and map() and every() skip them, so a hole would pass.
    const copy: unknown[] = [];
    for (let i = 0; i < length; i++) copy.push((value as unknown[])[i]);
    return copy;
  }

  number(value: unknown, path: string, max: number, options: { integer?: boolean; min?: number } = {}): number | undefined {
    const min = options.min ?? 0;
    if (typeof value !== 'number' || !Number.isFinite(value)) return this.fail(path, 'must be a finite number');
    if (value < min || value > max) return this.fail(path, `must be between ${min} and ${max}`);
    if (options.integer && !Number.isInteger(value)) return this.fail(path, 'must be a whole number');
    return value;
  }

  integer(value: unknown, path: string, max: number = Number.MAX_SAFE_INTEGER): number | undefined {
    return this.number(value, path, max, { integer: true });
  }

  boolean(value: unknown, path: string): boolean | undefined {
    if (typeof value !== 'boolean') return this.fail(path, 'must be true or false');
    return value;
  }

  string(value: unknown, path: string, max: number, min = 0): string | undefined {
    if (typeof value !== 'string') return this.fail(path, 'must be text');
    if (value.length < min) return this.fail(path, min === 1 ? 'must not be empty' : `must have at least ${min} characters`);
    if (value.length > max) return this.fail(path, `must have at most ${max} characters`);
    return value;
  }

  oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T | undefined {
    if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T;
    return this.fail(path, `must be one of: ${options.join(', ')}`);
  }

  result<T>(value: T | undefined): Result<T> {
    if (this.errors.length > 0 || value === undefined) {
      return { ok: false, errors: this.errors.length > 0 ? this.errors : ['invalid value'] };
    }
    return { ok: true, value };
  }
}

/** Runs a validator. Reading a hostile object can throw, and that is one more invalid input. */
export function guarded<T>(run: (check: Check) => T | undefined): Result<T> {
  const check = new Check();
  try {
    return check.result(run(check));
  } catch {
    return { ok: false, errors: ['value cannot be read'] };
  }
}

function bytePattern(check: Check, value: unknown, path: string, allowEmpty = false): BytePattern | undefined {
  const min = allowEmpty ? 0 : 1;
  if (typeof value === 'string' || Array.isArray(value)) {
    check.patternChars += value.length;
    if (check.patternChars > LIMITS.totalPatternChars) {
      return check.fail(path, `the total size of all patterns must be at most ${LIMITS.totalPatternChars}`);
    }
  }
  if (typeof value === 'string') return check.string(value, path, LIMITS.pattern, min);
  // Uint8Array.from would turn a bad value into a wrong byte with no error: 256 becomes 0, and so does NaN.
  const list = check.list(value, path, LIMITS.pattern, min);
  if (!list) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const byte = check.integer(list[i], `${path}[${i}]`, 255);
    if (byte === undefined) return undefined;
    bytes.push(byte);
  }
  return bytes;
}

/**
 * Finds the common shape of a regex that can run for a very long time, such as `(a+)+`. This is best effort: other
 * shapes exist, such as `(a|aa)+`, and JavaScript cannot stop a regex that is running. See ADR-11.
 */
function hasNestedQuantifier(source: string): boolean {
  const plain = source.replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'x');
  const repeat = /^(?:[+*]|\{\d+,\d*\})/;
  // For each open group: does it have a repeat inside, at any depth?
  const groups: boolean[] = [false];
  for (let i = 0; i < plain.length; i++) {
    const char = plain.charAt(i);
    if (char === '(') {
      groups.push(false);
    } else if (char === ')') {
      const inner = groups.pop() ?? false;
      if (inner && repeat.test(plain.slice(i + 1))) return true;
      if (inner) groups[groups.length - 1] = true;
    } else if (repeat.test(plain.slice(i))) {
      groups[groups.length - 1] = true;
    }
  }
  return false;
}

function regexSource(check: Check, source: unknown, flags: unknown, path: string): void {
  const text = check.string(source, `${path}.regex`, LIMITS.regex, 1);
  const flagText = flags === undefined ? undefined : check.string(flags, `${path}.regexFlags`, 16);
  if (text === undefined || (flags !== undefined && flagText === undefined)) return;
  try {
    new RegExp(text, flagText);
  } catch (err) {
    check.fail(`${path}.regex`, `is not a valid regular expression: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}`);
    return;
  }
  if (hasNestedQuantifier(text)) check.fail(`${path}.regex`, 'has a repeat inside a repeat, which can hang the page');
}

const MATCH_KEYS = ['contains', 'prefix', 'regex', 'regexFlags', 'minSize', 'maxSize', 'sessionUrl', 'moqt'] as const;
const MOQT_KEYS = ['trackAlias', 'groupMin', 'groupMax', 'subgroup', 'objectMin', 'objectMax'] as const;

function moqtMatch(check: Check, value: unknown, path: string): MoqtMatch | undefined {
  const raw = check.object(value, path, [...MOQT_KEYS, 'track', 'keyframe']);
  if (!raw) return undefined;
  const out: MoqtMatch = {};
  if (raw.keyframe !== undefined) {
    const keyframe = check.boolean(raw.keyframe, `${path}.keyframe`);
    if (keyframe !== undefined) out.keyframe = keyframe;
  }
  if (raw.track !== undefined) {
    const track = check.string(raw.track, `${path}.track`, LIMITS.sessionUrl, 1);
    if (track !== undefined) out.track = track;
  }
  for (const key of MOQT_KEYS) {
    if (raw[key] === undefined) continue;
    const number = check.integer(raw[key], `${path}.${key}`);
    if (number !== undefined) out[key] = number;
  }
  if (Object.keys(raw).length === 0) check.fail(path, 'needs at least one field');
  if (out.groupMin !== undefined && out.groupMax !== undefined && out.groupMin > out.groupMax) check.fail(`${path}.groupMin`, 'must not be above groupMax');
  if (out.objectMin !== undefined && out.objectMax !== undefined && out.objectMin > out.objectMax) check.fail(`${path}.objectMin`, 'must not be above objectMax');
  return out;
}

function ruleMatch(check: Check, value: unknown, path: string): RuleMatch | undefined {
  const raw = check.object(value, path, MATCH_KEYS);
  if (!raw) return undefined;
  const out: RuleMatch = {};
  if (raw.contains !== undefined) {
    // An empty list never matches, so the rule would be dead with no sign of why.
    const list = check.list(raw.contains, `${path}.contains`, LIMITS.patternsPerRule, 1);
    if (list) {
      const patterns = list.map((item, i) => bytePattern(check, item, `${path}.contains[${i}]`));
      if (patterns.every((p) => p !== undefined)) out.contains = patterns;
    }
  }
  if (raw.prefix !== undefined) {
    const prefix = bytePattern(check, raw.prefix, `${path}.prefix`);
    if (prefix !== undefined) out.prefix = prefix;
  }
  if (raw.regexFlags !== undefined && raw.regex === undefined) check.fail(`${path}.regexFlags`, 'needs a regex');
  if (raw.regex !== undefined) {
    regexSource(check, raw.regex, raw.regexFlags, path);
    out.regex = raw.regex as string;
    if (raw.regexFlags !== undefined) out.regexFlags = raw.regexFlags as string;
  }
  if (raw.minSize !== undefined) {
    const minSize = check.integer(raw.minSize, `${path}.minSize`);
    if (minSize !== undefined) out.minSize = minSize;
  }
  if (raw.maxSize !== undefined) {
    const maxSize = check.integer(raw.maxSize, `${path}.maxSize`);
    if (maxSize !== undefined) out.maxSize = maxSize;
  }
  if (out.minSize !== undefined && out.maxSize !== undefined && out.minSize > out.maxSize) {
    check.fail(`${path}.minSize`, 'must not be above maxSize');
  }
  if (raw.sessionUrl !== undefined) {
    const sessionUrl = check.string(raw.sessionUrl, `${path}.sessionUrl`, LIMITS.sessionUrl, 1);
    if (sessionUrl !== undefined) out.sessionUrl = sessionUrl;
  }
  if (raw.moqt !== undefined) {
    const moqt = moqtMatch(check, raw.moqt, `${path}.moqt`);
    if (moqt) out.moqt = moqt;
  }
  return out;
}

function modifyOp(check: Check, value: unknown, path: string): ModifyOp | undefined {
  const type = check.object(value, path, ['op', 'data', 'find', 'with']);
  if (!type) return undefined;
  if (type.op === 'set') {
    if (type.find !== undefined || type.with !== undefined) return check.fail(path, '"set" takes only "data"');
    // An empty payload is not delivered, so this would be a drop that the drop counter does not see.
    const data = bytePattern(check, type.data, `${path}.data`);
    return data === undefined ? undefined : { op: 'set', data };
  }
  if (type.op === 'replace') {
    if (type.data !== undefined) return check.fail(path, '"replace" takes only "find" and "with"');
    const find = bytePattern(check, type.find, `${path}.find`);
    // Empty `with` is valid: it deletes the match.
    const replacement = bytePattern(check, type.with, `${path}.with`, true);
    return find === undefined || replacement === undefined ? undefined : { op: 'replace', find, with: replacement };
  }
  return check.fail(`${path}.op`, 'must be one of: set, replace');
}

function ruleAction(check: Check, value: unknown, path: string): RuleAction | undefined {
  const keys = ['delayMs', 'jitterMs', 'ops', 'timeoutMs', 'onTimeout', 'durationMs', 'closeCode', 'reason', 'code'];
  const raw = check.object(value, path, ['type', ...keys]);
  if (!raw) return undefined;
  const extra = (allowed: readonly string[]): void => {
    for (const key of keys) {
      if (!allowed.includes(key) && raw[key] !== undefined) check.fail(path, `"${String(raw.type)}" does not take "${key}"`);
    }
  };
  switch (raw.type) {
    case 'log':
    case 'drop':
      extra([]);
      return { type: raw.type };
    case 'delay': {
      extra(['delayMs', 'jitterMs']);
      const delayMs = check.number(raw.delayMs, `${path}.delayMs`, LIMITS.delayMs);
      if (delayMs === undefined) return undefined;
      if (raw.jitterMs === undefined) return { type: 'delay', delayMs };
      const jitterMs = check.number(raw.jitterMs, `${path}.jitterMs`, LIMITS.delayMs);
      return jitterMs === undefined ? undefined : { type: 'delay', delayMs, jitterMs };
    }
    case 'modify': {
      extra(['ops']);
      const list = check.list(raw.ops, `${path}.ops`, LIMITS.opsPerRule, 1);
      if (!list) return undefined;
      const ops = list.map((op, i) => modifyOp(check, op, `${path}.ops[${i}]`));
      return ops.every((op) => op !== undefined) ? { type: 'modify', ops } : undefined;
    }
    case 'hold': {
      extra(['timeoutMs', 'onTimeout']);
      const timeoutMs = check.integer(raw.timeoutMs, `${path}.timeoutMs`, LIMITS.holdMaxMs);
      const onTimeout = check.oneOf(raw.onTimeout, `${path}.onTimeout`, ['forward', 'drop'] as const);
      if (timeoutMs === undefined || onTimeout === undefined) return undefined;
      if (timeoutMs < LIMITS.holdMinMs) return check.fail(`${path}.timeoutMs`, `must be between ${LIMITS.holdMinMs} and ${LIMITS.holdMaxMs}`);
      return { type: 'hold', timeoutMs, onTimeout };
    }
    case 'stall': {
      extra(['durationMs']);
      const durationMs = check.integer(raw.durationMs, `${path}.durationMs`, LIMITS.stallMaxMs);
      if (durationMs === undefined) return undefined;
      if (durationMs < 1) return check.fail(`${path}.durationMs`, `must be between 1 and ${LIMITS.stallMaxMs}`);
      return { type: 'stall', durationMs };
    }
    case 'close-session': {
      extra(['closeCode', 'reason']);
      const closeCode = check.integer(raw.closeCode, `${path}.closeCode`, LIMITS.closeCode);
      const reason = check.string(raw.reason, `${path}.reason`, LIMITS.closeReason);
      if (closeCode === undefined || reason === undefined) return undefined;
      if (new TextEncoder().encode(reason).length > LIMITS.closeReason) return check.fail(`${path}.reason`, `must be at most ${LIMITS.closeReason} bytes`);
      return { type: 'close-session', closeCode, reason };
    }
    case 'reset-stream': {
      extra(['code']);
      const code = check.integer(raw.code, `${path}.code`, LIMITS.streamErrorCode);
      return code === undefined ? undefined : { type: 'reset-stream', code };
    }
    default:
      return check.fail(`${path}.type`, 'must be one of: log, drop, delay, modify, hold, stall, close-session, reset-stream');
  }
}

const RULE_KEYS = ['id', 'enabled', 'on', 'direction', 'match', 'action', 'probability', 'final'] as const;

function rule(check: Check, value: unknown, path: string): Rule | undefined {
  const raw = check.object(value, path, RULE_KEYS);
  if (!raw) return undefined;
  const id = check.string(raw.id, `${path}.id`, LIMITS.ruleId, 1);
  const action = ruleAction(check, raw.action, `${path}.action`);
  if (id === undefined || action === undefined) return undefined;

  const out: Rule = { id, action };
  if (raw.enabled !== undefined) {
    const enabled = check.boolean(raw.enabled, `${path}.enabled`);
    if (enabled !== undefined) out.enabled = enabled;
  }
  if (raw.direction !== undefined) {
    const direction = check.oneOf(raw.direction, `${path}.direction`, ['in', 'out', 'both'] as const);
    if (direction) out.direction = direction;
  }
  if (raw.on !== undefined) {
    // An empty list means the rule never applies.
    const list = check.list(raw.on, `${path}.on`, TRAFFIC_KINDS.length, 1);
    if (list) {
      const kinds = list.map((kind, i) => check.oneOf(kind, `${path}.on[${i}]`, TRAFFIC_KINDS));
      if (kinds.every((kind) => kind !== undefined)) out.on = kinds;
    }
  }
  if (raw.match !== undefined) {
    const match = ruleMatch(check, raw.match, `${path}.match`);
    if (match) out.match = match;
  }
  if (raw.probability !== undefined) {
    const probability = check.number(raw.probability, `${path}.probability`, 1);
    if (probability !== undefined) out.probability = probability;
  }
  if (raw.final !== undefined) {
    const final = check.boolean(raw.final, `${path}.final`);
    if (final !== undefined) out.final = final;
  }
  return out;
}

function rules(check: Check, value: unknown, path: string): Rule[] | undefined {
  const list = check.list(value, path, LIMITS.rules);
  if (!list) return undefined;
  const out: Rule[] = [];
  const ids = new Set<string>();
  list.forEach((item, i) => {
    const parsed = rule(check, item, `${path}[${i}]`);
    if (!parsed) return;
    // Hit counters are kept by id, so two rules with one id would share a counter.
    if (ids.has(parsed.id)) check.fail(`${path}[${i}].id`, `"${parsed.id}" is already used`);
    ids.add(parsed.id);
    out.push(parsed);
  });
  return out;
}

function bandwidth(check: Check, value: unknown, path: string): Bandwidth | undefined {
  const raw = check.object(value, path, ['kbps', 'queueMs']);
  if (!raw) return undefined;
  const kbps = check.integer(raw.kbps, `${path}.kbps`, LIMITS.kbps);
  const queueMs = check.integer(raw.queueMs, `${path}.queueMs`, LIMITS.queueMs);
  if (kbps === undefined || queueMs === undefined) return undefined;
  return kbps < 1 ? check.fail(`${path}.kbps`, `must be between 1 and ${LIMITS.kbps}`) : { kbps, queueMs };
}

function timeline(check: Check, value: unknown, path: string): TimelineStep[] | undefined {
  const list = check.list(value, path, LIMITS.timelineSteps);
  if (!list) return undefined;
  const steps = list.map((item, i): TimelineStep | undefined => {
    const at = `${path}[${i}]`;
    const raw = check.object(item, at, ['atMs', 'action']);
    if (!raw) return undefined;
    const atMs = check.integer(raw.atMs, `${at}.atMs`, LIMITS.timelineMs);
    const action = check.object(raw.action, `${at}.action`, ['type', 'durationMs', 'closeCode', 'reason', 'dropRate', 'delayMs', 'jitterMs', 'kbps']);
    if (atMs === undefined || !action) return undefined;
    if (action.type === 'network') {
      const dropRate = check.number(action.dropRate, `${at}.action.dropRate`, 1);
      const delayMs = check.number(action.delayMs, `${at}.action.delayMs`, LIMITS.delayMs);
      const jitterMs = check.number(action.jitterMs, `${at}.action.jitterMs`, LIMITS.delayMs);
      const kbps = action.kbps === undefined ? undefined : check.integer(action.kbps, `${at}.action.kbps`, LIMITS.kbps);
      if (action.kbps !== undefined && (kbps === undefined || kbps < 1)) return check.fail(`${at}.action.kbps`, `must be between 1 and ${LIMITS.kbps}`);
      return dropRate === undefined || delayMs === undefined || jitterMs === undefined
        ? undefined
        : { atMs, action: { type: 'network', dropRate, delayMs, jitterMs, ...(kbps === undefined ? {} : { kbps }) } };
    }
    if (action.type !== 'stall' && action.type !== 'close-session') return check.fail(`${at}.action.type`, 'must be one of: network, stall, close-session');
    const parsed = ruleAction(check, action, `${at}.action`);
    return parsed && (parsed.type === 'stall' || parsed.type === 'close-session') ? { atMs, action: parsed } : undefined;
  });
  return steps.every((step) => step !== undefined) ? steps : undefined;
}

function config(check: Check, value: unknown, path: string): RuntimeConfig | undefined {
  const raw = check.object(value, path, ['enabled', 'log', 'datagram', 'stream', 'wrapLocalBidi', 'maxDelayedBytes', 'seed', 'rules', 'timeline', 'bandwidth']);
  if (!raw) return undefined;
  const required = (obj: Record<string, unknown>, objPath: string, keys: readonly string[]): void => {
    for (const key of keys) if (obj[key] === undefined) check.fail(`${objPath}.${key}`, 'is required');
  };
  required(raw, path, ['enabled', 'log', 'datagram', 'stream', 'wrapLocalBidi', 'maxDelayedBytes', 'rules']);
  if (check.errors.length > 0) return undefined;

  const logKeys = ['session', 'datagram', 'uni', 'bidi', 'previewBytes'] as const;
  const log = check.object(raw.log, `${path}.log`, logKeys);
  const datagramKeys = ['dropRate', 'delayMs', 'jitterMs', 'preserveOrder'] as const;
  const datagram = check.object(raw.datagram, `${path}.datagram`, datagramKeys);
  const streamKeys = ['delayMs', 'jitterMs'] as const;
  const stream = check.object(raw.stream, `${path}.stream`, streamKeys);
  if (!log || !datagram || !stream) return undefined;
  required(log, `${path}.log`, logKeys);
  required(datagram, `${path}.datagram`, datagramKeys);
  required(stream, `${path}.stream`, streamKeys);

  const out = {
    enabled: check.boolean(raw.enabled, `${path}.enabled`),
    log: {
      session: check.boolean(log.session, `${path}.log.session`),
      datagram: check.boolean(log.datagram, `${path}.log.datagram`),
      uni: check.boolean(log.uni, `${path}.log.uni`),
      bidi: check.boolean(log.bidi, `${path}.log.bidi`),
      previewBytes: check.integer(log.previewBytes, `${path}.log.previewBytes`, LIMITS.previewBytes),
    },
    datagram: {
      dropRate: check.number(datagram.dropRate, `${path}.datagram.dropRate`, 1),
      delayMs: check.number(datagram.delayMs, `${path}.datagram.delayMs`, LIMITS.delayMs),
      jitterMs: check.number(datagram.jitterMs, `${path}.datagram.jitterMs`, LIMITS.delayMs),
      preserveOrder: check.boolean(datagram.preserveOrder, `${path}.datagram.preserveOrder`),
    },
    stream: {
      delayMs: check.number(stream.delayMs, `${path}.stream.delayMs`, LIMITS.delayMs),
      jitterMs: check.number(stream.jitterMs, `${path}.stream.jitterMs`, LIMITS.delayMs),
    },
    wrapLocalBidi: check.boolean(raw.wrapLocalBidi, `${path}.wrapLocalBidi`),
    maxDelayedBytes: check.integer(raw.maxDelayedBytes, `${path}.maxDelayedBytes`, LIMITS.maxDelayedBytes),
    ...(raw.seed === undefined ? {} : { seed: check.integer(raw.seed, `${path}.seed`, 0xffffffff) }),
    rules: rules(check, raw.rules, `${path}.rules`),
    ...(raw.timeline === undefined ? {} : { timeline: timeline(check, raw.timeline, `${path}.timeline`) }),
    ...(raw.bandwidth === undefined ? {} : { bandwidth: bandwidth(check, raw.bandwidth, `${path}.bandwidth`) }),
  };
  // Every field above failed with an error if it is undefined, so the caller never sees this cast.
  return check.errors.length > 0 ? undefined : (out as RuntimeConfig);
}

export const validateRule = (value: unknown): Result<Rule> => guarded((check) => rule(check, value, 'rule'));
export const validateRules = (value: unknown): Result<Rule[]> => guarded((check) => rules(check, value, 'rules'));
export const validateConfig = (value: unknown): Result<RuntimeConfig> => guarded((check) => config(check, value, 'config'));
export const readConfig = config;
