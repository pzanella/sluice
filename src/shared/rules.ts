// Rule DSL and runtime config. Every value is plain JSON, so rules can cross the message
// channel and be validated. Rules never hold functions: nothing here is run as code.

/** The MoQT drafts whose objects Sluice can read (ADR-23, ADR-27). Others stay in chunk mode. */
export const OBJECT_DRAFTS: ReadonlySet<number> = new Set(Array.from({ length: 17 }, (_, i) => i + 7)); // 7 to 23.

/** The moq-lite versions whose frames Sluice can read (ADR-30). */
export const LITE_VERSIONS: ReadonlySet<number> = new Set([3, 4, 5, 6]);

export type RuleDirection = 'in' | 'out' | 'both';

export type TrafficKind = 'datagram' | 'uni' | 'bidi';

/** A byte pattern: a string (encoded as UTF-8) or a list of byte values. */
export type BytePattern = string | number[];

/**
 * Fields of a MoQT object. All set here must be true (AND). A rule with this works on whole objects: while such a rule is on,
 * new streams of a session with a known draft are cut into objects, and all rules see each object's payload as the chunk (ADR-23).
 */
export interface MoqtMatch {
  trackAlias?: number;
  /** The name of the track. moq-lite only, for now. */
  track?: string;
  /** True: only keyframes. False: only frames that are not. A frame that does not say never matches. */
  keyframe?: boolean;
  groupMin?: number;
  groupMax?: number;
  subgroup?: number;
  objectMin?: number;
  objectMax?: number;
}

/** All the conditions set here must be true (AND). An empty match is true for every chunk. */
export interface RuleMatch {
  /** The payload contains at least one of these patterns (OR). */
  contains?: BytePattern[];
  prefix?: BytePattern;
  /** Regular expression source, tested on the payload decoded as UTF-8. */
  regex?: string;
  regexFlags?: string;
  minSize?: number;
  maxSize?: number;
  /** The session URL contains this text. */
  sessionUrl?: string;
  moqt?: MoqtMatch;
}

/** Declarative payload edits. For edits by hand, see the action `hold`. */
export type ModifyOp =
  /** Replace the whole payload. */
  | { op: 'set'; data: BytePattern }
  /** Replace every match of a byte pattern. An empty `find` does nothing. */
  | { op: 'replace'; find: BytePattern; with: BytePattern };

/** What happens to a held chunk if nobody decides in time. */
export type HoldTimeoutAction = 'forward' | 'drop';

export type RuleAction =
  | { type: 'log' }
  | { type: 'drop' }
  | { type: 'delay'; delayMs: number; jitterMs?: number }
  | { type: 'modify'; ops: ModifyOp[] }
  /** Wait for the user in the panel, for at most `timeoutMs`. With no panel open, the chunk passes with no wait. */
  | { type: 'hold'; timeoutMs: number; onTimeout: HoldTimeoutAction }
  /** The app gets nothing more of this session for `durationMs`, this chunk too. Then all of it comes, in order (ADR-41). */
  | { type: 'stall'; durationMs: number }
  /** Close the whole session, as `WebTransport.close()` does. The server sees it. The chunk is dropped. */
  | { type: 'close-session'; closeCode: number; reason: string }
  /** End the stream of this chunk with an error for the app, and stop the server stream. Streams only. */
  | { type: 'reset-stream'; code: number };

/** The simulated network of one session from a step of the timeline on: loss on datagrams, delay and jitter on all it receives. */
export interface NetworkStep {
  dropRate: number;
  delayMs: number;
  jitterMs: number;
  /** A cap on what the session receives, in kbit/s. None = no cap (ADR-48). */
  kbps?: number;
}

/** A cap on what each session receives, with a queue: datagrams that would wait longer than `queueMs` are lost (ADR-48). */
export interface Bandwidth {
  kbps: number;
  queueMs: number;
}

/** What a rule, the panel or the timeline asks of the connection, past the chunk itself. */
export type ConnectionAction =
  | { type: 'stall'; durationMs: number }
  | { type: 'close-session'; closeCode: number; reason: string }
  | { type: 'reset-stream'; code: number }
  | ({ type: 'network' } & NetworkStep);

type TimelineAction = { type: 'stall'; durationMs: number } | { type: 'close-session'; closeCode: number; reason: string } | ({ type: 'network' } & NetworkStep);

/** At `atMs` after a session opens, do this. Each new session starts the timeline again (ADR-47). */
export interface TimelineStep {
  atMs: number;
  action: TimelineAction;
}

export interface Rule {
  id: string;
  /** Default: true. */
  enabled?: boolean;
  /** Default: every kind. */
  on?: TrafficKind[];
  /** What the app receives, what it sends, or both. Default: `in`. */
  direction?: RuleDirection;
  match?: RuleMatch;
  action: RuleAction;
  /** Apply the rule only with this probability (0..1). */
  probability?: number;
  /** If the rule matches, do not check the rules after it. */
  final?: boolean;
}

export interface RuntimeConfig {
  /** Master switch. Off = pass through, and streams not yet accessed are not wrapped. */
  enabled: boolean;
  log: {
    session: boolean;
    datagram: boolean;
    uni: boolean;
    bidi: boolean;
    previewBytes: number;
  };
  datagram: {
    /** 0..1: simulated packet loss, seen only by the app. */
    dropRate: number;
    delayMs: number;
    jitterMs: number;
    /** False allows reordering, only when the delay is above zero. */
    preserveOrder: boolean;
  };
  /** Streams always keep their order. */
  stream: { delayMs: number; jitterMs: number };
  /** Also wrap the readable side of createBidirectionalStream(). */
  wrapLocalBidi: boolean;
  /** Stop reading the native stream when delays hold this many bytes. */
  maxDelayedBytes: number;
  /** With this, random decisions repeat in each run (ADR-25). With none, they differ. */
  seed?: number;
  rules: Rule[];
  /** A cap on what each session receives (ADR-48). */
  bandwidth?: Bandwidth;
  /** Steps in time for each session (ADR-47). */
  timeline?: TimelineStep[];
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  enabled: true,
  log: { session: false, datagram: false, uni: false, bidi: false, previewBytes: 48 },
  datagram: { dropRate: 0, delayMs: 0, jitterMs: 0, preserveOrder: true },
  stream: { delayMs: 0, jitterMs: 0 },
  wrapLocalBidi: true,
  maxDelayedBytes: 8 * 1024 * 1024,
  rules: [],
};
