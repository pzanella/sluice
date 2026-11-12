// Messages between MAIN, ISOLATED, the service worker and the panel. See the skill `mv3-bridge`.
// Each direction has its own parser: a message that a page sends can never parse as a command.
// Chrome ports use JSON, so messages hold no binary values: payload bytes travel as base64.
import type { ConnectionAction, HoldTimeoutAction, RuntimeConfig, TrafficKind } from './rules';
import type { PlaybackReport } from '../inject/playback';
import { Check, guarded, LIMITS, readConfig, TRAFFIC_KINDS, type Result } from './validate';

export const PROTOCOL_VERSION = 1;

export const PROTOCOL_LIMITS = {
  /** Log batch size. See the skill `mv3-bridge`. */
  batch: 50,
  /** Bytes of payload in one traffic item. */
  previewBytes: 64 * 1024,
  url: 8192,
  /** WebTransport limits the close reason to 1024 bytes. */
  closeReason: 1024,
  /** Same as the limit of rules. */
  ruleHits: 256,
  ruleId: 128,
  /** Length of one message as a JSON string: a full batch of the largest previews, plus its fields. */
  messageChars: 5 * 1024 * 1024,
} as const;

interface Envelope<T extends string, P> {
  v: typeof PROTOCOL_VERSION;
  type: T;
  /** Counter of the sender. */
  id: number;
  payload: P;
}

interface SessionOpen {
  sessionId: number;
  url: string;
  createdAt: number;
}

interface SessionClosed {
  sessionId: number;
  /** Null when the session ended with an error. */
  closeCode: number | null;
  reason: string;
  at: number;
}

interface StreamOpen {
  sessionId: number;
  streamId: number;
  kind: 'uni' | 'bidi';
  origin: 'remote' | 'local';
  at: number;
}

export interface TrafficItem {
  sessionId: number;
  /** Null for datagrams. */
  streamId: number | null;
  kind: TrafficKind;
  seq: number;
  /** Size of the whole chunk. The preview can be shorter. */
  byteLength: number;
  outcome: 'passed' | 'dropped';
  modified: boolean;
  /** Sent from the panel, not by the server. */
  injected?: true;
  /** What the app wrote, not what it received. */
  outgoing?: true;
  /** Set when this is one MoQT object, and the size and preview are of its payload. */
  moqt?: { trackAlias: number; group: number; subgroup: number | null; object: number; track?: string; key?: boolean; mediaUs?: number };
  delayMs: number;
  /** Base64 of the first bytes of the chunk. */
  preview: string;
  at: number;
}

/** A chunk that waits for the user. `data` holds at most `previewBytes` of it, so a larger one cannot be edited. */
export interface HeldMessage {
  holdId: number;
  sessionId: number;
  streamId: number | null;
  kind: TrafficKind;
  seq: number;
  byteLength: number;
  data: string;
  ruleId: string;
  /** Time left, in ms. */
  timeoutMs: number;
  onTimeout: HoldTimeoutAction;
}

const HOLD_OUTCOMES = ['forwarded', 'dropped', 'edited', 'timeout-forwarded', 'timeout-dropped', 'gone'] as const;
export type HoldOutcome = (typeof HOLD_OUTCOMES)[number];

const HOLD_ACTIONS = ['forward', 'drop', 'edit'] as const;
type HoldResolve = { holdId: number; workerId: number | null; action: 'forward' | 'drop'; data: null } | { holdId: number; workerId: number | null; action: 'edit'; data: string };

const INJECT_KINDS = ['datagram', 'uni'] as const;
export type InjectKind = (typeof INJECT_KINDS)[number];
interface InjectRequest {
  injectId: number;
  sessionId: number;
  workerId: number | null;
  kind: InjectKind;
  data: string;
}
/** What the panel can do to a session: stall it or close it (ADR-41). Rules reset streams. */
export type PanelConnectionAction = { type: 'stall'; durationMs: number } | { type: 'close-session'; closeCode: number; reason: string };
interface ConnectionRequest {
  sessionId: number;
  workerId: number | null;
  action: PanelConnectionAction;
}
const INJECT_FAILURES = ['no-session', 'not-read', 'closed', 'full'] as const;
export type InjectFailure = (typeof INJECT_FAILURES)[number];

/** One message of a recording. `data` is base64. Null with `fin`: only the end of a stream. */
export interface TraceEvent {
  t: number;
  kind: TrafficKind;
  streamId: number | null;
  origin: 'remote' | 'local';
  data: string | null;
  fin: boolean;
  /** On the first event of a stream that the app opened: the first bytes the app wrote on it, base64. A replay uses them to give
   * the app the stream that answers the same request (ADR-43). */
  sent?: string;
}
type TraceClose = { t: number; closeCode: number; reason: string } | null;
export const TRACE_FORMAT = 'sluice-trace';
/** Bytes that a recording keeps of what the app wrote on each stream it opened. */
export const TRACE_SENT_BYTES = 512;
const TRACE_SENT_CHARS = Math.ceil(TRACE_SENT_BYTES / 3) * 4;

/** What a replay does when its recording ends: hold the last frame, play again, or let the next session go live. */
export type ReplayEnd = 'hold' | 'loop' | 'live';
const REPLAY_ENDS: readonly ReplayEnd[] = ['hold', 'loop', 'live'];
/** What a recording holds for one MoQ track. Counted in the page while it records. */
interface TraceTrack {
  name: string;
  groups: number;
  firstGroup: number;
  lastGroup: number;
  frames: number;
  keyframes: number;
  bytes: number;
  /** From the timestamps in the frames. Not set when the frames have none. */
  mediaMs?: number;
  /** The track alias (the subscribe ID in moq-lite) of its last objects, so a replay knows the track of a group (ADR-59). */
  alias?: number;
}
/** What a recording holds, for the panel. Old files and files of other apps have none. */
export interface TraceSummary {
  /** From Start recording to Stop recording. */
  recordedMs: number;
  tracks: TraceTrack[];
}
export const TRACE_MAX_TRACKS = 64;
/** A file of one session. It can come from anywhere, so it passes `parseTrace`. */
export interface TraceFile {
  format: typeof TRACE_FORMAT;
  version: 1;
  url: string;
  /** The protocol that the server chose. Old files have none. */
  protocol?: string;
  /** The MoQ protocol that the page offered, when the server chose none: the version of the session. A replay does not give it
   * to the app as chosen. */
  offered?: string;
  /** When the session started, in ms since 1970 (time 0 of the events). Old files have none. */
  startedAt?: number;
  close: TraceClose;
  events: TraceEvent[];
  summary?: TraceSummary;
}
/** Events in one message, each with at most `previewBytes`. */
export const TRACE_PART_EVENTS = 8;
const TRACE_MAX_EVENTS = 200_000;

export interface KindCounters {
  streams: number;
  chunks: number;
  bytes: number;
  dropped: number;
  modified: number;
  delayed: number;
}

interface StatsPayload {
  stats: Record<TrafficKind, KindCounters>;
  /** A list, not an object: a rule id such as `__proto__` must stay plain data. */
  ruleHits: { id: string; count: number }[];
  /** Traffic items not sent because the channel was full. The counters above still include those chunks. */
  captureDropped: number;
  /** Rules that the page turned off because they were too slow. */
  disabledRules: string[];
}

/** What one runtime reports: the runtime of a frame, or of a worker in it. */
export type RuntimeReport =
  | Envelope<'session-open', SessionOpen>
  | Envelope<'session-closed', SessionClosed>
  | Envelope<'stream-open', StreamOpen>
  | Envelope<'traffic', { items: TrafficItem[] }>
  | Envelope<'stats', StatsPayload>
  | Envelope<'hold', HeldMessage>
  | Envelope<'hold-end', { holdId: number; outcome: HoldOutcome }>
  | Envelope<'inject-result', { injectId: number; failure: InjectFailure | null }>
  | Envelope<'record-part', { recordId: number; events: (TraceEvent & { sessionId: number })[] }>
  | Envelope<'record-end', { recordId: number; count: number; truncated: boolean; sessions: { sessionId: number; url: string; protocol?: string; offered?: string; close: TraceClose; summary?: TraceSummary }[] }>
  | Envelope<'replay-started', { url: string }>
  | Envelope<'replay-ended', { url: string }>
  /** Once a second: what the player showed (ADR-49). */
  | Envelope<'playback', PlaybackReport>
  /** `draft` null: the final version. */
  | Envelope<'moq-catalog', { sessionId: number; broadcast: string; json: string }>
  /** A rule or the panel stalled, closed or reset something (ADR-41). */
  | Envelope<'connection-event', { sessionId: number; action: ConnectionAction; streamId: number | null; at: number }>
  | Envelope<'moqt-version', { sessionId: number; draft: number | null; source: 'protocol' | 'setup'; lite?: number }>;

/** Why a worker runs with no instrumentation, so its traffic is not in the panel (ADR-14). */
const WORKER_SKIP_REASONS = ['csp', 'starting', 'blob-url', 'data-url', 'limit', 'refused'] as const;
export type WorkerSkipReason = (typeof WORKER_SKIP_REASONS)[number];

/** MAIN to panel. Hostile: the page can send any of these, with any values. */
export type RuntimeMessage =
  | RuntimeReport
  | Envelope<'worker-message', { workerId: number; url: string; message: RuntimeReport }>
  | Envelope<'worker-gone', { workerId: number }>
  | Envelope<'worker-skipped', { url: string; reason: WorkerSkipReason }>;

/** What MAIN sends. With no panel open, no payload bytes leave the page. */
interface CaptureSettings {
  traffic: boolean;
  previewBytes: number;
}

/**
 * To MAIN. `targetOrigin` is the site the rules were written for: a tab can navigate while a message is on its way, and
 * the new site must not read the rules of the old one. The service worker sends `set-capture` itself: it accepts only
 * `set-config` from the panel.
 */
export type ControlMessage =
  | Envelope<'set-config', { config: RuntimeConfig; targetOrigin: string }>
  | Envelope<'set-capture', CaptureSettings>
  /** `workerId`: null for the runtime of the frame. */
  | Envelope<'hold-resolve', HoldResolve>
  | Envelope<'inject', InjectRequest>
  | Envelope<'connection', ConnectionRequest>
  | Envelope<'record', { recordId: number; on: boolean }>
  /** A recording in parts. It waits for a session to `url`. With `last`, it is complete. */
  | Envelope<'replay-arm', { replayId: number; url: string; protocol?: string; offered?: string; end?: ReplayEnd; overlay?: boolean; close: TraceClose; events: TraceEvent[]; last: boolean }>
  | Envelope<'replay-clear', Record<string, never>>;

/** Service worker to panel. The frame fields come from `port.sender`, so a page cannot set them. */
export type PanelMessage =
  | Envelope<'frame-message', { frameId: number; documentId: string; frameUrl: string; message: RuntimeMessage }>
  | Envelope<'frame-gone', { frameId: number; documentId: string }>
  /** The saved config of a site. Null = nothing saved. `error` says that the last save failed. `granted`: Sluice is on for it. */
  | Envelope<'config', { targetOrigin: string; config: RuntimeConfig | null; error: string | null; granted: boolean }>
  /** A grant or saved rules changed, maybe from the popup. The panel asks again. */
  | Envelope<'site-changed', Record<string, never>>;

/** Panel to service worker. */
type PanelRequest =
  | Envelope<'get-config', { targetOrigin: string }>
  | Extract<ControlMessage, { type: 'set-config' }>
  /** `documentId` comes from the store of the panel. The worker finds the frame with it among the live ports of the tab. */
  | Envelope<'hold-resolve', HoldResolve & { documentId: string }>
  | Envelope<'inject', InjectRequest & { documentId: string }>
  | Envelope<'connection', ConnectionRequest & { documentId: string }>
  /** To all frames of the site of the tab. */
  | Extract<ControlMessage, { type: 'record' }>
  /** To the top frame only. */
  | Extract<ControlMessage, { type: 'replay-arm' | 'replay-clear' }>;

const envelope = (check: Check, value: unknown, path: string): { type: unknown; id: number; payload: unknown } | undefined => {
  const raw = check.object(value, path, ['v', 'type', 'id', 'payload']);
  if (!raw) return undefined;
  if (raw.v !== PROTOCOL_VERSION) return check.fail(`${path}.v`, `must be ${PROTOCOL_VERSION}`);
  const id = check.integer(raw.id, `${path}.id`);
  return id === undefined ? undefined : { type: raw.type, id, payload: raw.payload };
};

/** The largest time a Date can hold. Past this, `new Date(at).toISOString()` throws in the panel. */
const MAX_TIME = 8.64e15;

const base64Chars = /^[A-Za-z0-9+/]*={0,2}$/;

function preview(check: Check, value: unknown, path: string): string | undefined {
  // Base64 is 4 characters for each 3 bytes.
  const maxChars = Math.ceil(PROTOCOL_LIMITS.previewBytes / 3) * 4;
  const text = check.string(value, path, maxChars);
  if (text === undefined) return undefined;
  if (text.length % 4 !== 0 || !base64Chars.test(text)) return check.fail(path, 'must be base64');
  return text;
}

/** WebTransport URLs are always https. This also stops a `javascript:` URL from reaching the panel. */
function httpsUrl(check: Check, value: unknown, path: string): string | undefined {
  const text = check.string(value, path, PROTOCOL_LIMITS.url);
  if (text === undefined) return undefined;
  return text.startsWith('https://') ? text : check.fail(path, 'must start with https://');
}

function sessionOpen(check: Check, value: unknown, path: string): SessionOpen | undefined {
  const raw = check.object(value, path, ['sessionId', 'url', 'createdAt']);
  if (!raw) return undefined;
  const out = {
    sessionId: check.integer(raw.sessionId, `${path}.sessionId`),
    url: httpsUrl(check, raw.url, `${path}.url`),
    createdAt: check.number(raw.createdAt, `${path}.createdAt`, MAX_TIME),
  };
  return check.errors.length > 0 ? undefined : (out as SessionOpen);
}

function sessionClosed(check: Check, value: unknown, path: string): SessionClosed | undefined {
  const raw = check.object(value, path, ['sessionId', 'closeCode', 'reason', 'at']);
  if (!raw) return undefined;
  const out = {
    sessionId: check.integer(raw.sessionId, `${path}.sessionId`),
    closeCode: raw.closeCode === null ? null : check.integer(raw.closeCode, `${path}.closeCode`, 0xffffffff),
    reason: check.string(raw.reason, `${path}.reason`, PROTOCOL_LIMITS.closeReason),
    at: check.number(raw.at, `${path}.at`, MAX_TIME),
  };
  return check.errors.length > 0 ? undefined : (out as SessionClosed);
}

function streamOpen(check: Check, value: unknown, path: string): StreamOpen | undefined {
  const raw = check.object(value, path, ['sessionId', 'streamId', 'kind', 'origin', 'at']);
  if (!raw) return undefined;
  const out = {
    sessionId: check.integer(raw.sessionId, `${path}.sessionId`),
    streamId: check.integer(raw.streamId, `${path}.streamId`),
    kind: check.oneOf(raw.kind, `${path}.kind`, ['uni', 'bidi'] as const),
    origin: check.oneOf(raw.origin, `${path}.origin`, ['remote', 'local'] as const),
    at: check.number(raw.at, `${path}.at`, MAX_TIME),
  };
  return check.errors.length > 0 ? undefined : (out as StreamOpen);
}

function trafficItem(check: Check, value: unknown, path: string): TrafficItem | undefined {
  const raw = check.object(value, path, [
    'sessionId', 'streamId', 'kind', 'seq', 'byteLength', 'outcome', 'modified', 'injected', 'outgoing', 'moqt', 'delayMs', 'preview', 'at',
  ]);
  if (!raw) return undefined;
  const kind = check.oneOf(raw.kind, `${path}.kind`, TRAFFIC_KINDS);
  // Datagrams have no stream, and a stream chunk always has one.
  if (kind === 'datagram' && raw.streamId !== null) check.fail(`${path}.streamId`, 'must be null for a datagram');
  if ((kind === 'uni' || kind === 'bidi') && raw.streamId === null) check.fail(`${path}.streamId`, 'is required for a stream');
  const out = {
    sessionId: check.integer(raw.sessionId, `${path}.sessionId`),
    streamId: raw.streamId === null ? null : check.integer(raw.streamId, `${path}.streamId`),
    kind,
    seq: check.integer(raw.seq, `${path}.seq`),
    byteLength: check.integer(raw.byteLength, `${path}.byteLength`),
    outcome: check.oneOf(raw.outcome, `${path}.outcome`, ['passed', 'dropped'] as const),
    modified: check.boolean(raw.modified, `${path}.modified`),
    delayMs: check.number(raw.delayMs, `${path}.delayMs`, Number.MAX_SAFE_INTEGER),
    preview: preview(check, raw.preview, `${path}.preview`),
    at: check.number(raw.at, `${path}.at`, MAX_TIME),
  };
  if (raw.injected !== undefined && raw.injected !== true) check.fail(`${path}.injected`, 'must be true');
  if (raw.outgoing !== undefined && raw.outgoing !== true) check.fail(`${path}.outgoing`, 'must be true');
  let moqt: TrafficItem['moqt'];
  if (raw.moqt !== undefined) {
    const fields = check.object(raw.moqt, `${path}.moqt`, ['trackAlias', 'group', 'subgroup', 'object', 'track', 'key', 'mediaUs']);
    if (fields) {
      moqt = {
        trackAlias: check.integer(fields.trackAlias, `${path}.moqt.trackAlias`) as number,
        group: check.integer(fields.group, `${path}.moqt.group`) as number,
        subgroup: fields.subgroup === null ? null : (check.integer(fields.subgroup, `${path}.moqt.subgroup`) as number),
        object: check.integer(fields.object, `${path}.moqt.object`) as number,
        ...(fields.key === undefined ? {} : { key: check.boolean(fields.key, `${path}.moqt.key`) as boolean }),
        ...(fields.mediaUs === undefined ? {} : { mediaUs: check.integer(fields.mediaUs, `${path}.moqt.mediaUs`) as number }),
        ...(fields.track === undefined ? {} : { track: check.string(fields.track, `${path}.moqt.track`, PROTOCOL_LIMITS.url) as string }),
      };
    }
  }
  if (check.errors.length > 0) return undefined;
  return { ...out, ...(raw.injected === true ? { injected: true } : {}), ...(raw.outgoing === true ? { outgoing: true } : {}), ...(moqt ? { moqt } : {}) } as TrafficItem;
}

function traffic(check: Check, value: unknown, path: string): { items: TrafficItem[] } | undefined {
  const raw = check.object(value, path, ['items']);
  if (!raw) return undefined;
  const list = check.list(raw.items, `${path}.items`, PROTOCOL_LIMITS.batch, 1);
  if (!list) return undefined;
  const items = list.map((item, i) => trafficItem(check, item, `${path}.items[${i}]`));
  return items.every((item) => item !== undefined) ? { items } : undefined;
}

function counters(check: Check, value: unknown, path: string): KindCounters | undefined {
  const keys = ['streams', 'chunks', 'bytes', 'dropped', 'modified', 'delayed'] as const;
  const raw = check.object(value, path, keys);
  if (!raw) return undefined;
  const out = Object.fromEntries(keys.map((key) => [key, check.integer(raw[key], `${path}.${key}`)]));
  return check.errors.length > 0 ? undefined : (out as unknown as KindCounters);
}

function statsPayload(check: Check, value: unknown, path: string): StatsPayload | undefined {
  const raw = check.object(value, path, ['stats', 'ruleHits', 'captureDropped', 'disabledRules']);
  if (!raw) return undefined;
  const stats = check.object(raw.stats, `${path}.stats`, TRAFFIC_KINDS);
  const list = check.list(raw.ruleHits, `${path}.ruleHits`, PROTOCOL_LIMITS.ruleHits);
  if (!stats || !list) return undefined;
  const datagram = counters(check, stats.datagram, `${path}.stats.datagram`);
  const uni = counters(check, stats.uni, `${path}.stats.uni`);
  const bidi = counters(check, stats.bidi, `${path}.stats.bidi`);
  const ruleHits = list.map((item, i) => {
    const hit = check.object(item, `${path}.ruleHits[${i}]`, ['id', 'count']);
    if (!hit) return undefined;
    const id = check.string(hit.id, `${path}.ruleHits[${i}].id`, PROTOCOL_LIMITS.ruleId, 1);
    const count = check.integer(hit.count, `${path}.ruleHits[${i}].count`);
    return id === undefined || count === undefined ? undefined : { id, count };
  });
  const captureDropped = check.integer(raw.captureDropped, `${path}.captureDropped`);
  const disabledList = check.list(raw.disabledRules, `${path}.disabledRules`, PROTOCOL_LIMITS.ruleHits);
  if (!disabledList) return undefined;
  const disabledRules = disabledList.map((id, i) => check.string(id, `${path}.disabledRules[${i}]`, PROTOCOL_LIMITS.ruleId, 1));
  if (!datagram || !uni || !bidi || captureDropped === undefined || !ruleHits.every((hit) => hit !== undefined)) return undefined;
  if (!disabledRules.every((id) => id !== undefined)) return undefined;
  return { stats: { datagram, uni, bidi }, ruleHits, captureDropped, disabledRules };
}

function heldMessage(check: Check, value: unknown, path: string): HeldMessage | undefined {
  const raw = check.object(value, path, ['holdId', 'sessionId', 'streamId', 'kind', 'seq', 'byteLength', 'data', 'ruleId', 'timeoutMs', 'onTimeout']);
  if (!raw) return undefined;
  const kind = check.oneOf(raw.kind, `${path}.kind`, TRAFFIC_KINDS);
  if (kind === 'datagram' && raw.streamId !== null) check.fail(`${path}.streamId`, 'must be null for a datagram');
  if ((kind === 'uni' || kind === 'bidi') && raw.streamId === null) check.fail(`${path}.streamId`, 'is required for a stream');
  const out = {
    holdId: check.integer(raw.holdId, `${path}.holdId`),
    sessionId: check.integer(raw.sessionId, `${path}.sessionId`),
    streamId: raw.streamId === null ? null : check.integer(raw.streamId, `${path}.streamId`),
    kind,
    seq: check.integer(raw.seq, `${path}.seq`),
    byteLength: check.integer(raw.byteLength, `${path}.byteLength`),
    data: preview(check, raw.data, `${path}.data`),
    ruleId: check.string(raw.ruleId, `${path}.ruleId`, PROTOCOL_LIMITS.ruleId, 1),
    timeoutMs: check.number(raw.timeoutMs, `${path}.timeoutMs`, LIMITS.holdMaxMs),
    onTimeout: check.oneOf(raw.onTimeout, `${path}.onTimeout`, ['forward', 'drop'] as const),
  };
  return check.errors.length > 0 ? undefined : (out as HeldMessage);
}

function holdResolve(check: Check, raw: Record<string, unknown>, path: string): HoldResolve | undefined {
  const holdId = check.integer(raw.holdId, `${path}.holdId`);
  const workerId = raw.workerId === null ? null : check.integer(raw.workerId, `${path}.workerId`);
  const action = check.oneOf(raw.action, `${path}.action`, HOLD_ACTIONS);
  if (holdId === undefined || workerId === undefined || action === undefined) return undefined;
  if (action !== 'edit') return raw.data === null ? { holdId, workerId, action, data: null } : check.fail(`${path}.data`, 'must be null');
  const data = preview(check, raw.data, `${path}.data`);
  return data === undefined ? undefined : { holdId, workerId, action, data };
}

function traceEvent(check: Check, value: unknown, path: string): TraceEvent | undefined {
  const raw = check.object(value, path, ['t', 'kind', 'streamId', 'origin', 'data', 'fin', 'sessionId', 'sent']);
  if (!raw) return undefined;
  const kind = check.oneOf(raw.kind, `${path}.kind`, TRAFFIC_KINDS);
  if (kind === 'datagram' && raw.streamId !== null) check.fail(`${path}.streamId`, 'must be null for a datagram');
  if ((kind === 'uni' || kind === 'bidi') && raw.streamId === null) check.fail(`${path}.streamId`, 'is required for a stream');
  const out = {
    t: check.number(raw.t, `${path}.t`, MAX_TIME),
    kind,
    streamId: raw.streamId === null ? null : check.integer(raw.streamId, `${path}.streamId`),
    origin: check.oneOf(raw.origin, `${path}.origin`, ['remote', 'local'] as const),
    data: raw.data === null ? null : preview(check, raw.data, `${path}.data`),
    fin: check.boolean(raw.fin, `${path}.fin`),
    ...(raw.sent === undefined ? {} : { sent: preview(check, raw.sent, `${path}.sent`) }),
  };
  if (out.sent !== undefined && (typeof out.sent !== 'string' || out.sent.length > TRACE_SENT_CHARS)) check.fail(`${path}.sent`, 'is too long');
  return check.errors.length > 0 ? undefined : (out as TraceEvent);
}

function traceClose(check: Check, value: unknown, path: string): TraceClose | undefined {
  if (value === null) return null;
  const raw = check.object(value, path, ['t', 'closeCode', 'reason']);
  if (!raw) return undefined;
  const t = check.number(raw.t, `${path}.t`, MAX_TIME);
  const closeCode = check.integer(raw.closeCode, `${path}.closeCode`);
  const reason = check.string(raw.reason, `${path}.reason`, PROTOCOL_LIMITS.closeReason);
  return t === undefined || closeCode === undefined || reason === undefined ? undefined : { t, closeCode, reason };
}

function traceSummary(check: Check, value: unknown, path: string): TraceSummary | undefined {
  const raw = check.object(value, path, ['recordedMs', 'tracks']);
  if (!raw) return undefined;
  const recordedMs = check.number(raw.recordedMs, `${path}.recordedMs`, MAX_TIME);
  const list = check.list(raw.tracks, `${path}.tracks`, TRACE_MAX_TRACKS);
  if (recordedMs === undefined || !list) return undefined;
  const tracks = list.map((item, i): TraceTrack | undefined => {
    const at = `${path}.tracks[${i}]`;
    const row = check.object(item, at, ['name', 'groups', 'firstGroup', 'lastGroup', 'frames', 'keyframes', 'bytes', 'mediaMs', 'alias']);
    if (!row) return undefined;
    const name = check.string(row.name, `${at}.name`, 256);
    const [groups, firstGroup, lastGroup, frames, keyframes, bytes] = (['groups', 'firstGroup', 'lastGroup', 'frames', 'keyframes', 'bytes'] as const).map((key) =>
      check.integer(row[key], `${at}.${key}`),
    );
    const mediaMs = row.mediaMs === undefined ? undefined : check.number(row.mediaMs, `${at}.mediaMs`, MAX_TIME);
    if (name === undefined || groups === undefined || firstGroup === undefined || lastGroup === undefined || frames === undefined || keyframes === undefined || bytes === undefined) return undefined;
    const alias = row.alias === undefined ? undefined : check.integer(row.alias, `${at}.alias`);
    if ((row.mediaMs !== undefined && mediaMs === undefined) || (row.alias !== undefined && alias === undefined)) return undefined;
    return { name, groups, firstGroup, lastGroup, frames, keyframes, bytes, ...(mediaMs === undefined ? {} : { mediaMs }), ...(alias === undefined ? {} : { alias }) };
  });
  return tracks.every((item) => item !== undefined) ? { recordedMs, tracks } : undefined;
}

function traceFile(check: Check, value: unknown, path: string): TraceFile | undefined {
  const raw = check.object(value, path, ['format', 'version', 'url', 'protocol', 'offered', 'startedAt', 'close', 'events', 'summary']);
  if (!raw) return undefined;
  if (raw.format !== TRACE_FORMAT || raw.version !== 1) return check.fail(path, 'is not a recording of this version');
  const url = httpsUrl(check, raw.url, `${path}.url`);
  const protocol = raw.protocol === undefined ? undefined : check.string(raw.protocol, `${path}.protocol`, 64);
  const offered = raw.offered === undefined ? undefined : check.string(raw.offered, `${path}.offered`, 64);
  const startedAt = raw.startedAt === undefined ? undefined : check.integer(raw.startedAt, `${path}.startedAt`);
  const close = traceClose(check, raw.close, `${path}.close`);
  const list = check.list(raw.events, `${path}.events`, TRACE_MAX_EVENTS);
  const summary = raw.summary === undefined ? undefined : traceSummary(check, raw.summary, `${path}.summary`);
  if (url === undefined || close === undefined || !list || (raw.summary !== undefined && summary === undefined) || (raw.startedAt !== undefined && startedAt === undefined) || (raw.offered !== undefined && offered === undefined)) return undefined;
  const events = list.map((item, i) => traceEvent(check, item, `${path}.events[${i}]`));
  return events.every((item) => item !== undefined)
    ? { format: TRACE_FORMAT, version: 1, url, ...(protocol === undefined ? {} : { protocol }), ...(offered === undefined ? {} : { offered }), ...(startedAt === undefined ? {} : { startedAt }), close, events, ...(summary === undefined ? {} : { summary }) }
    : undefined;
}

function connectionRequest(check: Check, raw: Record<string, unknown>, path: string): ConnectionRequest | undefined {
  const sessionId = check.integer(raw.sessionId, `${path}.sessionId`);
  const workerId = raw.workerId === null ? null : check.integer(raw.workerId, `${path}.workerId`);
  const action = panelConnectionAction(check, raw.action, `${path}.action`);
  return sessionId === undefined || workerId === undefined || action === undefined ? undefined : { sessionId, workerId, action };
}

function panelConnectionAction(check: Check, value: unknown, path: string): PanelConnectionAction | undefined {
  const action = connectionAction(check, value, path);
  return action?.type === 'stall' || action?.type === 'close-session' ? action : undefined;
}

function connectionAction(check: Check, value: unknown, path: string): ConnectionAction | undefined {
  const raw = check.object(value, path, ['type', 'durationMs', 'closeCode', 'reason', 'streamId', 'code', 'dropRate', 'delayMs', 'jitterMs', 'kbps']);
  if (!raw) return undefined;
  if (raw.type === 'network') {
    const dropRate = check.number(raw.dropRate, `${path}.dropRate`, 1);
    const delayMs = check.number(raw.delayMs, `${path}.delayMs`, LIMITS.delayMs);
    const jitterMs = check.number(raw.jitterMs, `${path}.jitterMs`, LIMITS.delayMs);
    const kbps = raw.kbps === undefined ? undefined : check.integer(raw.kbps, `${path}.kbps`, LIMITS.kbps);
    if (raw.kbps !== undefined && kbps === undefined) return undefined;
    return dropRate === undefined || delayMs === undefined || jitterMs === undefined ? undefined : { type: 'network', dropRate, delayMs, jitterMs, ...(kbps === undefined ? {} : { kbps }) };
  }
  if (raw.type === 'stall') {
    const durationMs = check.integer(raw.durationMs, `${path}.durationMs`, LIMITS.stallMaxMs);
    return durationMs === undefined || durationMs < 1 ? check.fail(`${path}.durationMs`, 'is not valid') : { type: 'stall', durationMs };
  }
  if (raw.type === 'close-session') {
    const closeCode = check.integer(raw.closeCode, `${path}.closeCode`, LIMITS.closeCode);
    const reason = check.string(raw.reason, `${path}.reason`, LIMITS.closeReason);
    return closeCode === undefined || reason === undefined ? undefined : { type: 'close-session', closeCode, reason };
  }
  if (raw.type === 'reset-stream') {
    const code = check.integer(raw.code, `${path}.code`, LIMITS.streamErrorCode);
    return code === undefined ? undefined : { type: 'reset-stream', code };
  }
  return check.fail(`${path}.type`, 'must be one of: stall, close-session, reset-stream, network');
}

function injectRequest(check: Check, raw: Record<string, unknown>, path: string): InjectRequest | undefined {
  const injectId = check.integer(raw.injectId, `${path}.injectId`);
  const sessionId = check.integer(raw.sessionId, `${path}.sessionId`);
  const workerId = raw.workerId === null ? null : check.integer(raw.workerId, `${path}.workerId`);
  const kind = check.oneOf(raw.kind, `${path}.kind`, INJECT_KINDS);
  const data = preview(check, raw.data, `${path}.data`);
  if (injectId === undefined || sessionId === undefined || workerId === undefined || kind === undefined || data === undefined) return undefined;
  // A byte stream cannot deliver an empty chunk.
  if (data === '') return check.fail(`${path}.data`, 'must not be empty');
  return { injectId, sessionId, workerId, kind, data };
}

function runtimeMessage(check: Check, value: unknown, path: string): RuntimeMessage | undefined {
  const head = envelope(check, value, path);
  if (!head) return undefined;
  const { id } = head;
  const v = PROTOCOL_VERSION;
  const at = `${path}.payload`;
  if (head.type === 'worker-message') {
    const raw = check.object(head.payload, at, ['workerId', 'url', 'message']);
    if (!raw) return undefined;
    const workerId = check.integer(raw.workerId, `${at}.workerId`);
    const url = check.string(raw.url, `${at}.url`, PROTOCOL_LIMITS.url);
    // Reports only: a message in a message in a message would let a page make the parser recurse.
    const message = runtimeReport(check, raw.message, `${at}.message`);
    if (workerId === undefined || url === undefined || !message) return undefined;
    return { v, type: head.type, id, payload: { workerId, url, message } };
  }
  if (head.type === 'worker-gone') {
    const raw = check.object(head.payload, at, ['workerId']);
    const workerId = raw && check.integer(raw.workerId, `${at}.workerId`);
    return workerId === undefined || !raw ? undefined : { v, type: head.type, id, payload: { workerId } };
  }
  if (head.type === 'worker-skipped') {
    const raw = check.object(head.payload, at, ['url', 'reason']);
    if (!raw) return undefined;
    const url = check.string(raw.url, `${at}.url`, PROTOCOL_LIMITS.url);
    const reason = check.oneOf(raw.reason, `${at}.reason`, WORKER_SKIP_REASONS);
    return url === undefined || reason === undefined ? undefined : { v, type: head.type, id, payload: { url, reason } };
  }
  return runtimeReport(check, value, path);
}

function runtimeReport(check: Check, value: unknown, path: string): RuntimeReport | undefined {
  const head = envelope(check, value, path);
  if (!head) return undefined;
  const { id } = head;
  const v = PROTOCOL_VERSION;
  const at = `${path}.payload`;
  switch (head.type) {
    case 'session-open': {
      const payload = sessionOpen(check, head.payload, at);
      return payload && { v, type: head.type, id, payload };
    }
    case 'session-closed': {
      const payload = sessionClosed(check, head.payload, at);
      return payload && { v, type: head.type, id, payload };
    }
    case 'stream-open': {
      const payload = streamOpen(check, head.payload, at);
      return payload && { v, type: head.type, id, payload };
    }
    case 'traffic': {
      const payload = traffic(check, head.payload, at);
      return payload && { v, type: head.type, id, payload };
    }
    case 'stats': {
      const payload = statsPayload(check, head.payload, at);
      return payload && { v, type: head.type, id, payload };
    }
    case 'hold': {
      const payload = heldMessage(check, head.payload, at);
      return payload && { v, type: head.type, id, payload };
    }
    case 'record-part': {
      const raw = check.object(head.payload, at, ['recordId', 'events']);
      if (!raw) return undefined;
      const recordId = check.integer(raw.recordId, `${at}.recordId`);
      const list = check.list(raw.events, `${at}.events`, TRACE_PART_EVENTS, 1);
      if (recordId === undefined || !list) return undefined;
      const events = list.map((item, i) => {
        const sessionId = check.integer((item as { sessionId?: unknown } | null)?.sessionId, `${at}.events[${i}].sessionId`);
        const event = traceEvent(check, item, `${at}.events[${i}]`);
        return sessionId === undefined || !event ? undefined : { ...event, sessionId };
      });
      return events.every((item) => item !== undefined) ? { v, type: head.type, id, payload: { recordId, events } } : undefined;
    }
    case 'record-end': {
      const raw = check.object(head.payload, at, ['recordId', 'count', 'truncated', 'sessions']);
      if (!raw) return undefined;
      const recordId = check.integer(raw.recordId, `${at}.recordId`);
      const count = check.integer(raw.count, `${at}.count`);
      const truncated = check.boolean(raw.truncated, `${at}.truncated`);
      const list = check.list(raw.sessions, `${at}.sessions`, 256);
      if (recordId === undefined || count === undefined || truncated === undefined || !list) return undefined;
      const sessions = list.map((item, i) => {
        const row = check.object(item, `${at}.sessions[${i}]`, ['sessionId', 'url', 'protocol', 'offered', 'close', 'summary']);
        if (!row) return undefined;
        const sessionId = check.integer(row.sessionId, `${at}.sessions[${i}].sessionId`);
        const url = httpsUrl(check, row.url, `${at}.sessions[${i}].url`);
        const close = traceClose(check, row.close, `${at}.sessions[${i}].close`);
        const protocol = row.protocol === undefined ? undefined : check.string(row.protocol, `${at}.sessions[${i}].protocol`, 64);
        const offered = row.offered === undefined ? undefined : check.string(row.offered, `${at}.sessions[${i}].offered`, 64);
        if (row.offered !== undefined && offered === undefined) return undefined;
        const summary = row.summary === undefined ? undefined : traceSummary(check, row.summary, `${at}.sessions[${i}].summary`);
        if (row.summary !== undefined && summary === undefined) return undefined;
        return sessionId === undefined || url === undefined || close === undefined
          ? undefined
          : { sessionId, url, ...(protocol === undefined ? {} : { protocol }), ...(offered === undefined ? {} : { offered }), close, ...(summary === undefined ? {} : { summary }) };
      });
      return sessions.every((item) => item !== undefined) ? { v, type: head.type, id, payload: { recordId, count, truncated, sessions } } : undefined;
    }
    case 'connection-event': {
      const raw = check.object(head.payload, at, ['sessionId', 'action', 'streamId', 'at']);
      if (!raw) return undefined;
      const sessionId = check.integer(raw.sessionId, `${at}.sessionId`);
      const action = connectionAction(check, raw.action, `${at}.action`);
      const streamId = raw.streamId === null ? null : check.integer(raw.streamId, `${at}.streamId`);
      const time = check.number(raw.at, `${at}.at`, MAX_TIME);
      return sessionId === undefined || action === undefined || streamId === undefined || time === undefined
        ? undefined
        : { v, type: head.type, id, payload: { sessionId, action, streamId, at: time } };
    }
    case 'moq-catalog': {
      const raw = check.object(head.payload, at, ['sessionId', 'broadcast', 'json']);
      if (!raw) return undefined;
      const sessionId = check.integer(raw.sessionId, `${at}.sessionId`);
      const broadcast = check.string(raw.broadcast, `${at}.broadcast`, PROTOCOL_LIMITS.url);
      const json = check.string(raw.json, `${at}.json`, 256 * 1024);
      return sessionId === undefined || broadcast === undefined || json === undefined ? undefined : { v, type: head.type, id, payload: { sessionId, broadcast, json } };
    }
    case 'moqt-version': {
      const raw = check.object(head.payload, at, ['sessionId', 'draft', 'source', 'lite']);
      if (!raw) return undefined;
      const sessionId = check.integer(raw.sessionId, `${at}.sessionId`);
      const draft = raw.draft === null ? null : check.integer(raw.draft, `${at}.draft`, 9999);
      const lite = raw.lite === undefined ? undefined : check.integer(raw.lite, `${at}.lite`, 9999);
      if (raw.lite !== undefined && lite === undefined) return undefined;
      const source = check.oneOf(raw.source, `${at}.source`, ['protocol', 'setup'] as const);
      return sessionId === undefined || draft === undefined || source === undefined ? undefined : { v, type: head.type, id, payload: { sessionId, draft, source, ...(lite === undefined ? {} : { lite }) } };
    }
    case 'playback': {
      const raw = check.object(head.payload, at, ['videoFrames', 'audioFrames', 'droppedFrames', 'queue', 'decoders', 'events']);
      if (!raw) return undefined;
      const counts = (['videoFrames', 'audioFrames', 'droppedFrames', 'queue'] as const).map((key) => check.integer(raw[key], `${at}.${key}`, 1_000_000));
      const decoderList = check.list(raw.decoders, `${at}.decoders`, 8);
      const eventList = check.list(raw.events, `${at}.events`, 20);
      if (counts.some((value) => value === undefined) || !decoderList || !eventList) return undefined;
      const decoders = decoderList.map((item, i) => {
        const row = check.object(item, `${at}.decoders[${i}]`, ['kind', 'codec', 'width', 'height']);
        if (!row) return undefined;
        const kind = check.oneOf(row.kind, `${at}.decoders[${i}].kind`, ['video', 'audio'] as const);
        const codec = check.string(row.codec, `${at}.decoders[${i}].codec`, 200);
        const width = row.width === undefined ? undefined : check.integer(row.width, `${at}.decoders[${i}].width`, 100_000);
        const height = row.height === undefined ? undefined : check.integer(row.height, `${at}.decoders[${i}].height`, 100_000);
        if (kind === undefined || codec === undefined) return undefined;
        return { kind, codec, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) };
      });
      const events = eventList.map((item, i) => {
        const row = check.object(item, `${at}.events[${i}]`, ['at', 'kind', 'text']);
        if (!row) return undefined;
        const time = check.number(row.at, `${at}.events[${i}].at`, MAX_TIME);
        const kind = check.oneOf(row.kind, `${at}.events[${i}].kind`, ['waiting', 'stalled', 'playing', 'media-error', 'decoder-error'] as const);
        const message = check.string(row.text, `${at}.events[${i}].text`, 300);
        return time === undefined || kind === undefined || message === undefined ? undefined : { at: time, kind, text: message };
      });
      if (!decoders.every((item) => item !== undefined) || !events.every((item) => item !== undefined) || check.errors.length > 0) return undefined;
      const [videoFrames, audioFrames, droppedFrames, queue] = counts as number[];
      return { v, type: head.type, id, payload: { videoFrames: videoFrames as number, audioFrames: audioFrames as number, droppedFrames: droppedFrames as number, queue: queue as number, decoders, events } };
    }
    case 'replay-ended': {
      const raw = check.object(head.payload, at, ['url']);
      const url = raw && httpsUrl(check, raw.url, `${at}.url`);
      return url === undefined ? undefined : { v, type: head.type, id, payload: { url } };
    }
    case 'replay-started': {
      const raw = check.object(head.payload, at, ['url']);
      const url = raw && httpsUrl(check, raw.url, `${at}.url`);
      return url === undefined || !raw ? undefined : { v, type: head.type, id, payload: { url } };
    }
    case 'inject-result': {
      const raw = check.object(head.payload, at, ['injectId', 'failure']);
      if (!raw) return undefined;
      const injectId = check.integer(raw.injectId, `${at}.injectId`);
      const failure = raw.failure === null ? null : check.oneOf(raw.failure, `${at}.failure`, INJECT_FAILURES);
      return injectId === undefined || failure === undefined ? undefined : { v, type: head.type, id, payload: { injectId, failure } };
    }
    case 'hold-end': {
      const raw = check.object(head.payload, at, ['holdId', 'outcome']);
      if (!raw) return undefined;
      const holdId = check.integer(raw.holdId, `${at}.holdId`);
      const outcome = check.oneOf(raw.outcome, `${at}.outcome`, HOLD_OUTCOMES);
      return holdId === undefined || outcome === undefined ? undefined : { v, type: head.type, id, payload: { holdId, outcome } };
    }
    default:
      return check.fail(`${path}.type`, 'is not a message of this direction');
  }
}

function controlMessage(check: Check, value: unknown, path: string): ControlMessage | undefined {
  const head = envelope(check, value, path);
  if (!head) return undefined;
  if (head.type === 'set-capture') {
    const raw = check.object(head.payload, `${path}.payload`, ['traffic', 'previewBytes']);
    if (!raw) return undefined;
    const traffic = check.boolean(raw.traffic, `${path}.payload.traffic`);
    const previewBytes = check.integer(raw.previewBytes, `${path}.payload.previewBytes`, PROTOCOL_LIMITS.previewBytes);
    if (traffic === undefined || previewBytes === undefined) return undefined;
    return { v: PROTOCOL_VERSION, type: 'set-capture', id: head.id, payload: { traffic, previewBytes } };
  }
  if (head.type === 'hold-resolve') {
    const raw = check.object(head.payload, `${path}.payload`, ['holdId', 'workerId', 'action', 'data']);
    const payload = raw && holdResolve(check, raw, `${path}.payload`);
    return payload ? { v: PROTOCOL_VERSION, type: 'hold-resolve', id: head.id, payload } : undefined;
  }
  if (head.type === 'record') {
    const raw = check.object(head.payload, `${path}.payload`, ['recordId', 'on']);
    const recordId = raw ? check.integer(raw.recordId, `${path}.payload.recordId`) : undefined;
    const on = raw ? check.boolean(raw.on, `${path}.payload.on`) : undefined;
    return recordId === undefined || on === undefined ? undefined : { v: PROTOCOL_VERSION, type: 'record', id: head.id, payload: { recordId, on } };
  }
  if (head.type === 'replay-clear') {
    return check.object(head.payload, `${path}.payload`, []) ? { v: PROTOCOL_VERSION, type: 'replay-clear', id: head.id, payload: {} } : undefined;
  }
  if (head.type === 'replay-arm') {
    const at = `${path}.payload`;
    const raw = check.object(head.payload, at, ['replayId', 'url', 'protocol', 'offered', 'end', 'overlay', 'close', 'events', 'last']);
    if (!raw) return undefined;
    const replayId = check.integer(raw.replayId, `${at}.replayId`);
    const url = httpsUrl(check, raw.url, `${at}.url`);
    const close = traceClose(check, raw.close, `${at}.close`);
    const last = check.boolean(raw.last, `${at}.last`);
    const protocol = raw.protocol === undefined ? undefined : check.string(raw.protocol, `${at}.protocol`, 64);
    const offered = raw.offered === undefined ? undefined : check.string(raw.offered, `${at}.offered`, 64);
    if (raw.offered !== undefined && offered === undefined) return undefined;
    const end = raw.end === undefined ? undefined : check.oneOf(raw.end, `${at}.end`, REPLAY_ENDS);
    const overlay = raw.overlay === undefined ? undefined : check.boolean(raw.overlay, `${at}.overlay`);
    const list = check.list(raw.events, `${at}.events`, TRACE_PART_EVENTS);
    if (replayId === undefined || url === undefined || close === undefined || last === undefined || !list) return undefined;
    const events = list.map((item, i) => traceEvent(check, item, `${at}.events[${i}]`));
    return events.every((item) => item !== undefined) ? { v: PROTOCOL_VERSION, type: 'replay-arm', id: head.id, payload: { replayId, url, ...(protocol === undefined ? {} : { protocol }), ...(offered === undefined ? {} : { offered }), ...(end === undefined ? {} : { end }), ...(overlay === undefined ? {} : { overlay }), close, events, last } } : undefined;
  }
  if (head.type === 'inject') {
    const raw = check.object(head.payload, `${path}.payload`, ['injectId', 'sessionId', 'workerId', 'kind', 'data']);
    const payload = raw && injectRequest(check, raw, `${path}.payload`);
    return payload ? { v: PROTOCOL_VERSION, type: 'inject', id: head.id, payload } : undefined;
  }
  if (head.type === 'connection') {
    const raw = check.object(head.payload, `${path}.payload`, ['sessionId', 'workerId', 'action']);
    const payload = raw && connectionRequest(check, raw, `${path}.payload`);
    return payload ? { v: PROTOCOL_VERSION, type: 'connection', id: head.id, payload } : undefined;
  }
  if (head.type !== 'set-config') return check.fail(`${path}.type`, 'is not a message of this direction');
  const raw = check.object(head.payload, `${path}.payload`, ['config', 'targetOrigin']);
  if (!raw) return undefined;
  const targetOrigin = check.string(raw.targetOrigin, `${path}.payload.targetOrigin`, PROTOCOL_LIMITS.url, 1);
  const config = readConfig(check, raw.config, `${path}.payload.config`);
  if (!config || targetOrigin === undefined) return undefined;
  return { v: PROTOCOL_VERSION, type: 'set-config', id: head.id, payload: { config, targetOrigin } };
}

function panelMessage(check: Check, value: unknown, path: string): PanelMessage | undefined {
  const head = envelope(check, value, path);
  if (!head) return undefined;
  const { id } = head;
  const v = PROTOCOL_VERSION;
  const at = `${path}.payload`;
  if (head.type === 'frame-message') {
    const raw = check.object(head.payload, at, ['frameId', 'documentId', 'frameUrl', 'message']);
    if (!raw) return undefined;
    const frameId = check.integer(raw.frameId, `${at}.frameId`);
    const documentId = check.string(raw.documentId, `${at}.documentId`, 128, 1);
    const frameUrl = check.string(raw.frameUrl, `${at}.frameUrl`, PROTOCOL_LIMITS.url);
    const message = runtimeMessage(check, raw.message, `${at}.message`);
    if (frameId === undefined || documentId === undefined || frameUrl === undefined || !message) return undefined;
    return { v, type: 'frame-message', id, payload: { frameId, documentId, frameUrl, message } };
  }
  if (head.type === 'frame-gone') {
    const raw = check.object(head.payload, at, ['frameId', 'documentId']);
    if (!raw) return undefined;
    const frameId = check.integer(raw.frameId, `${at}.frameId`);
    const documentId = check.string(raw.documentId, `${at}.documentId`, 128, 1);
    if (frameId === undefined || documentId === undefined) return undefined;
    return { v, type: 'frame-gone', id, payload: { frameId, documentId } };
  }
  if (head.type === 'config') {
    const raw = check.object(head.payload, at, ['targetOrigin', 'config', 'error', 'granted']);
    if (!raw) return undefined;
    const targetOrigin = check.string(raw.targetOrigin, `${at}.targetOrigin`, PROTOCOL_LIMITS.url, 1);
    const config = raw.config === null ? null : readConfig(check, raw.config, `${at}.config`);
    const error = raw.error === null ? null : check.string(raw.error, `${at}.error`, 1024);
    const granted = check.boolean(raw.granted, `${at}.granted`);
    if (targetOrigin === undefined || config === undefined || error === undefined || granted === undefined) return undefined;
    return { v, type: 'config', id, payload: { targetOrigin, config, error, granted } };
  }
  if (head.type === 'site-changed') {
    return check.object(head.payload, at, []) ? { v, type: 'site-changed', id, payload: {} } : undefined;
  }
  return check.fail(`${path}.type`, 'is not a message of this direction');
}

function panelRequest(check: Check, value: unknown, path: string): PanelRequest | undefined {
  const head = envelope(check, value, path);
  if (!head) return undefined;
  if (head.type === 'get-config') {
    const raw = check.object(head.payload, `${path}.payload`, ['targetOrigin']);
    if (!raw) return undefined;
    const targetOrigin = check.string(raw.targetOrigin, `${path}.payload.targetOrigin`, PROTOCOL_LIMITS.url, 1);
    return targetOrigin === undefined ? undefined : { v: PROTOCOL_VERSION, type: 'get-config', id: head.id, payload: { targetOrigin } };
  }
  if (head.type === 'hold-resolve') {
    const raw = check.object(head.payload, `${path}.payload`, ['documentId', 'holdId', 'workerId', 'action', 'data']);
    if (!raw) return undefined;
    const documentId = check.string(raw.documentId, `${path}.payload.documentId`, 128, 1);
    const payload = holdResolve(check, raw, `${path}.payload`);
    return documentId === undefined || !payload ? undefined : { v: PROTOCOL_VERSION, type: 'hold-resolve', id: head.id, payload: { ...payload, documentId } };
  }
  if (head.type === 'connection') {
    const raw = check.object(head.payload, `${path}.payload`, ['documentId', 'sessionId', 'workerId', 'action']);
    if (!raw) return undefined;
    const documentId = check.string(raw.documentId, `${path}.payload.documentId`, 128, 1);
    const payload = connectionRequest(check, raw, `${path}.payload`);
    return documentId === undefined || !payload ? undefined : { v: PROTOCOL_VERSION, type: 'connection', id: head.id, payload: { ...payload, documentId } };
  }
  if (head.type === 'inject') {
    const raw = check.object(head.payload, `${path}.payload`, ['documentId', 'injectId', 'sessionId', 'workerId', 'kind', 'data']);
    if (!raw) return undefined;
    const documentId = check.string(raw.documentId, `${path}.payload.documentId`, 128, 1);
    const payload = injectRequest(check, raw, `${path}.payload`);
    return documentId === undefined || !payload ? undefined : { v: PROTOCOL_VERSION, type: 'inject', id: head.id, payload: { ...payload, documentId } };
  }
  if (head.type !== 'set-config' && head.type !== 'record' && head.type !== 'replay-arm' && head.type !== 'replay-clear') {
    return check.fail(`${path}.type`, 'is not a message of this direction');
  }
  const control = controlMessage(check, value, path);
  return control?.type === 'set-config' || control?.type === 'record' || control?.type === 'replay-arm' || control?.type === 'replay-clear' ? control : undefined;
}

 /** For a file from anywhere. */
export const parseTrace = (value: unknown): Result<TraceFile> => guarded((check) => traceFile(check, value, 'file'));
export const parseRuntimeMessage = (value: unknown): Result<RuntimeMessage> =>
  guarded((check) => runtimeMessage(check, value, 'message'));
export const parseControlMessage = (value: unknown): Result<ControlMessage> =>
  guarded((check) => controlMessage(check, value, 'message'));
export const parsePanelRequest = (value: unknown): Result<PanelRequest> =>
  guarded((check) => panelRequest(check, value, 'message'));
export const parsePanelMessage = (value: unknown): Result<PanelMessage> =>
  guarded((check) => panelMessage(check, value, 'message'));

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Written by hand so it uses no page global: the page can replace `btoa` in the MAIN world. */
export function bytesToBase64(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const a = data[i] as number;
    const b = data[i + 1];
    const c = data[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    // Index, not charAt(): the page can replace String.prototype methods too.
    out += (BASE64[(n >> 18) & 63] as string) + (BASE64[(n >> 12) & 63] as string);
    out += b === undefined ? '=' : (BASE64[(n >> 6) & 63] as string);
    out += c === undefined ? '=' : (BASE64[n & 63] as string);
  }
  return out;
}

const BASE64_VALUES = new Map(Array.from(BASE64, (char, value) => [char, value]));
const readBase64 = BASE64_VALUES.get.bind(BASE64_VALUES);

/** Also runs in MAIN, so it uses no page global, as `bytesToBase64` does. Throws if the text is not base64. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (text.length % 4 !== 0) throw new Error('not base64');
  const padding = text[text.length - 2] === '=' ? 2 : text[text.length - 1] === '=' ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const char = text[i + j] as string;
      const pad = char === '=' && i + j >= text.length - padding;
      const value = pad ? 0 : readBase64(char);
      if (value === undefined) throw new Error('not base64');
      n = (n << 6) | value;
    }
    out[at++] = n >> 16;
    if (at < out.length) out[at++] = (n >> 8) & 255;
    if (at < out.length) out[at++] = n & 255;
  }
  return out;
}
