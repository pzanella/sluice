// Rule engine: decides for each incoming chunk or datagram if it is dropped, delayed or changed.
import type { BytePattern, ConnectionAction, MoqtMatch, NetworkStep, Rule, RuleMatch, RuntimeConfig, TrafficKind } from '../shared/rules';
import type { HoldOffer } from './hold';
import type { MoqtObjectInfo } from './moqt/objects';
import { createRandom } from './prng';
import { decodeText, hex, indexOfBytes, patternToBytes, replaceBytes, startsWith } from './bytes';

export interface ChunkContext {
  kind: TrafficKind;
  /** 'remote' = opened by the server, 'local' = createBidirectionalStream(). */
  origin: 'remote' | 'local';
  sessionId: number;
  url: string;
  /** Local counter: the WebTransport API does not expose the QUIC stream ID. */
  streamId: number | null;
  /** Index of the chunk in its stream or session. */
  seq: number;
  data: Uint8Array<ArrayBuffer>;
  /** Sent from the panel. It skips the rules. */
  injected?: true;
  /** What the app writes, not what it receives. */
  outgoing?: true;
  /** Set when `data` is the payload of one MoQT object. */
  moqt?: MoqtObjectInfo;
}

export interface PipelineResult {
  /** Null = dropped. */
  data: Uint8Array<ArrayBuffer> | null;
  delayMs: number;
  /** Set by the first hold rule that matched. The stream asks the user before it delivers the chunk. */
  hold?: HoldOffer;
  /** Set by the first rule that acts on the connection: stall, close or reset (ADR-41). */
  connection?: ConnectionAction;
}

interface KindStats {
  streams: number;
  chunks: number;
  bytes: number;
  dropped: number;
  modified: number;
  delayed: number;
}

export type Stats = Record<TrafficKind, KindStats>;

export const createStats = (): Stats => {
  const empty = (): KindStats => ({ streams: 0, chunks: 0, bytes: 0, dropped: 0, modified: 0, delayed: 0 });
  return { datagram: empty(), uni: empty(), bidi: empty() };
};

interface PipelineDeps {
  getConfig: () => RuntimeConfig;
  stats: Stats;
  /** Injected so tests (and seeded runs in Phase 5) are deterministic. */
  random: () => number;
  log: (message: string) => void;
  /** Injected so tests can make a regex seem slow. */
  now?: () => number;
  /** The network of a session set by its timeline, or undefined for the network of the config (ADR-47). */
  networkFor?: (sessionId: number) => NetworkStep | undefined;
  /** False with no panel to answer, or too many chunks held. A hold rule then does nothing. */
  canHold?: () => boolean;
}

/** A regex tests only this part of a payload: the time of a slow regex grows with its input. */
export const REGEX_INPUT_BYTES = 4096;
/** One slow test turns the rule off for this page. JavaScript cannot stop a test while it runs (ADR-11). */
export const SLOW_REGEX_MS = 50;

export interface Pipeline {
  run(ctx: ChunkContext): PipelineResult;
  /** How many times each rule matched, by rule id. */
  ruleHits: Map<string, number>;
  /** Ids of the current rules that are off because their regex was too slow. */
  disabledRules(): string[];
}

/** Compiled once per pattern: building a RegExp for each chunk is slow on the hot path. */
function compileRegex(source: string, flags: string | undefined, cache: Map<string, RegExp | null>): RegExp | null {
  const key = `${flags ?? ''}/${source}`;
  let regex = cache.get(key);
  if (regex === undefined) {
    try {
      regex = new RegExp(source, flags);
    } catch {
      regex = null;
    }
    cache.set(key, regex);
  }
  // The 'g' and 'y' flags keep state between test() calls.
  if (regex) regex.lastIndex = 0;
  return regex;
}

/** Moves a cut back to the start of a UTF-8 character, so the text does not end in a false U+FFFD. */
function characterEnd(data: Uint8Array, end: number): number {
  let at = end;
  while (at > 0 && end - at < 3 && ((data[at] as number) & 0xc0) === 0x80) at--;
  return at;
}

const regexKey = (match: RuleMatch): string => `${match.regexFlags ?? ''}/${match.regex ?? ''}`;

function matchesObject(match: MoqtMatch, info: MoqtObjectInfo | undefined): boolean {
  // A rule about objects never matches a plain chunk: a session with another draft, a fetch stream, a padding stream.
  if (!info) return false;
  if (match.trackAlias !== undefined && info.trackAlias !== match.trackAlias) return false;
  if (match.track !== undefined && info.track !== match.track) return false;
  if (match.keyframe !== undefined && info.key !== match.keyframe) return false;
  if (match.groupMin !== undefined && info.group < match.groupMin) return false;
  if (match.groupMax !== undefined && info.group > match.groupMax) return false;
  if (match.subgroup !== undefined && info.subgroup !== match.subgroup) return false;
  if (match.objectMin !== undefined && info.object < match.objectMin) return false;
  if (match.objectMax !== undefined && info.object > match.objectMax) return false;
  return true;
}

type ToBytes = (pattern: BytePattern) => Uint8Array;

function matchesPayload(
  match: RuleMatch,
  ctx: ChunkContext,
  regexCache: Map<string, RegExp | null>,
  toBytes: ToBytes,
  timeRegex: (run: () => boolean) => boolean,
): boolean {
  const { data } = ctx;
  if (match.moqt !== undefined && !matchesObject(match.moqt, ctx.moqt)) return false;
  if (match.minSize !== undefined && data.length < match.minSize) return false;
  if (match.maxSize !== undefined && data.length > match.maxSize) return false;
  if (match.sessionUrl !== undefined && !ctx.url.includes(match.sessionUrl)) return false;
  if (match.prefix !== undefined && !startsWith(data, toBytes(match.prefix))) return false;
  if (match.contains !== undefined) {
    const found = match.contains.some((pattern) => indexOfBytes(data, toBytes(pattern)) !== -1);
    if (!found) return false;
  }
  if (match.regex !== undefined) {
    // An invalid regex never matches. Validation (Phase 2) rejects it before it gets here.
    const regex = compileRegex(match.regex, match.regexFlags, regexCache);
    const cut = data.length > REGEX_INPUT_BYTES;
    // `$` would match at the cut, not at the real end, and a wrong match can drop a chunk. So it does not match at all.
    if (cut && match.regex.includes('$')) return false;
    const text = decodeText(data.subarray(0, cut ? characterEnd(data, REGEX_INPUT_BYTES) : data.length));
    if (!regex || !timeRegex(() => regex.test(text))) return false;
  }
  return true;
}

/** The same for the same message in each run. A MoQT object has real IDs. The rest has the order of its stream or session. */
function messageKey(ctx: ChunkContext): string {
  const { moqt } = ctx;
  if (moqt) return `moqt ${moqt.trackAlias} ${moqt.group} ${moqt.subgroup} ${moqt.object}`;
  return `${ctx.outgoing ? 'out ' : ''}${ctx.sessionId} ${ctx.kind} ${ctx.streamId} ${ctx.seq}`;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  const { getConfig, stats, random, log: rawLog } = deps;
  // The page can replace console.log. A log that throws must not change what happens to the traffic.
  const log = (message: string): void => {
    try {
      rawLog(message);
    } catch {
      // Nothing to do: the log is lost.
    }
  };
  const ruleHits = new Map<string, number>();
  const regexCache = new Map<string, RegExp | null>();
  const reportedRules = new Set<string | undefined>();
  // By the regex, not by the rule id: a rule that the user fixes keeps its id, and must run again.
  const slowRegexes = new Set<string>();

  // Encoded once for each config, not for each chunk. These are only read: a `set` op makes its own copy, because
  // `enqueue` takes the buffer of what it gets.
  let compiledFor: RuntimeConfig | null = null;
  let compiled = new Map<BytePattern, Uint8Array>();
  const toBytes: ToBytes = (pattern) => {
    const config = getConfig();
    if (config !== compiledFor) {
      compiledFor = config;
      compiled = new Map();
    }
    let bytes = compiled.get(pattern);
    if (!bytes) {
      bytes = patternToBytes(pattern);
      compiled.set(pattern, bytes);
    }
    return bytes;
  };
  const now = deps.now ?? performance.now.bind(performance);

  const jitter = (base: number, spread: number | undefined, rnd: () => number): number =>
    Math.max(0, base + (spread ? (rnd() * 2 - 1) * spread : 0));

  const logChunk = (tag: string, ctx: ChunkContext): void => {
    const stream = ctx.streamId !== null ? `#${ctx.streamId}` : '';
    const dump = hex(ctx.data, getConfig().log.previewBytes);
    log(`${ctx.kind}${stream} ${tag} sess=${ctx.sessionId} seq=${ctx.seq} len=${ctx.data.length}\n${dump}`);
  };

  const ruleApplies = (rule: Rule, ctx: ChunkContext, rnd: () => number): boolean => {
    if (rule.enabled === false) return false;
    if (rule.match?.regex !== undefined && slowRegexes.has(regexKey(rule.match))) return false;
    const direction = rule.direction ?? 'in';
    if (direction !== 'both' && direction !== (ctx.outgoing ? 'out' : 'in')) return false;
    if (rule.on && !rule.on.includes(ctx.kind)) return false;
    const timeRegex = (run: () => boolean): boolean => {
      const start = now();
      const result = run();
      if (now() - start > SLOW_REGEX_MS) {
        if (rule.match) slowRegexes.add(regexKey(rule.match));
        log(`rule "${rule.id}" was turned off on this page: its regex took more than ${SLOW_REGEX_MS} ms`);
      }
      return result;
    };
    if (rule.match && !matchesPayload(rule.match, ctx, regexCache, toBytes, timeRegex)) return false;
    // Last, so random() is used only for chunks the rule is about.
    return rule.probability === undefined || rnd() < rule.probability;
  };

  function run(ctx: ChunkContext): PipelineResult {
    const config = getConfig();
    if (!config.enabled) return { data: ctx.data, delayMs: 0 };

    const kindStats = stats[ctx.kind];
    const isDatagram = ctx.kind === 'datagram';
    const network = deps.networkFor?.(ctx.sessionId);
    const base = network ?? (isDatagram ? config.datagram : config.stream);
    const dropRate = network ? network.dropRate : config.datagram.dropRate;
    // One generator for each message, not one for all: other streams must not change the decisions of this message (ADR-25).
    const rnd = config.seed === undefined ? random : createRandom(config.seed, messageKey(ctx));
    // The simulated network acts on what the app receives. What it sends has only the rules.
    let delayMs = ctx.outgoing ? 0 : jitter(base.delayMs, base.jitterMs, rnd);
    let hold: HoldOffer | undefined;
    let connection: ConnectionAction | undefined;

    // Simulated loss only on datagrams: on a reliable stream it would break the app framing.
    if (isDatagram && !ctx.outgoing && dropRate > 0 && rnd() < dropRate) {
      kindStats.dropped++;
      if (config.log.datagram) logChunk('DROP (loss)', ctx);
      return { data: null, delayMs: 0 };
    }

    if (config.log[ctx.kind]) logChunk('IN', ctx);

    for (const rule of config.rules) {
      let matched = false;
      // A bad rule must not break the traffic of the app: skip it and leave the payload as it is.
      try {
        if (!ruleApplies(rule, ctx, rnd)) continue;
        matched = true;
        ruleHits.set(rule.id, (ruleHits.get(rule.id) ?? 0) + 1);

        const { action } = rule;
        switch (action.type) {
          case 'log':
            logChunk(`RULE ${rule.id}`, ctx);
            break;
          case 'drop':
            kindStats.dropped++;
            if (config.log[ctx.kind]) logChunk(`DROP ${rule.id}`, ctx);
            return { data: null, delayMs: 0 };
          case 'delay':
            delayMs += jitter(action.delayMs, action.jitterMs, rnd);
            break;
          case 'hold':
            if (!hold && deps.canHold?.()) hold = { ruleId: rule.id, timeoutMs: action.timeoutMs, onTimeout: action.onTimeout };
            break;
          case 'stall':
            connection ??= action;
            break;
          case 'close-session':
            // The session goes: this chunk must not reach the app after the close.
            kindStats.dropped++;
            return { data: null, delayMs: 0, connection: action };
          case 'reset-stream':
            if (ctx.streamId === null) break;
            kindStats.dropped++;
            return { data: null, delayMs: 0, connection: action };
          case 'modify': {
            let edited = ctx.data;
            for (const op of action.ops) {
              edited =
                op.op === 'set'
                  ? patternToBytes(op.data)
                  : replaceBytes(edited, toBytes(op.find), toBytes(op.with));
            }
            // An empty chunk cannot be delivered: it is a drop, and the counters must say so.
            if (edited.byteLength === 0) {
              kindStats.dropped++;
              if (config.log[ctx.kind]) logChunk(`DROP ${rule.id}`, ctx);
              return { data: null, delayMs: 0 };
            }
            // A `replace` with no match changes nothing, so it must not count or show as modified.
            if (edited !== ctx.data) kindStats.modified++;
            ctx.data = edited;
            break;
          }
        }
        if (rule.final) break;
      } catch (err) {
        // Once for each rule: this runs at traffic rate.
        const id = (rule as Rule | null)?.id;
        if (!reportedRules.has(id)) {
          reportedRules.add(id);
          log(`rule "${String(id)}" failed and was skipped: ${String(err)}`);
        }
        // `final` means that the rules after it do not see this chunk, also if its action failed.
        if (matched && rule.final) break;
      }
    }

    if (delayMs > 0) kindStats.delayed++;
    return { data: ctx.data, delayMs, ...(hold ? { hold } : {}), ...(connection ? { connection } : {}) };
  }

  return {
    run,
    ruleHits,
    disabledRules: () =>
      getConfig()
        .rules.filter((rule) => rule.match?.regex !== undefined && slowRegexes.has(regexKey(rule.match)))
        .map((rule) => rule.id),
  };
}
