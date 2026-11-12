// What the panel knows. All of it comes from the page, so it is capped, and Maps keep page values from acting as object
// keys. Rendering reads `version`, so a burst of messages costs one render.
import type { HeldMessage, InjectFailure, KindCounters, PanelMessage, RuntimeReport, TrafficItem, WorkerSkipReason } from '../shared/protocol';
import { LITE_VERSIONS, OBJECT_DRAFTS, type TrafficKind } from '../shared/rules';
import { parseCatalog, type Rendition } from '../shared/catalog';
import { decodePreview, toText } from './format';
import { notePlayback, type PlaybackState } from './playback';
import { RecordingCollector, withoutQuery, type RecordingRow } from './recordings';
export type { RecordingRow } from './recordings';
import { DEFAULT_THRESHOLDS, newSessionMonitor, noteClosed, noteConnection, noteFrame, type MonitorThresholds, type SessionMonitor } from './monitor';

export const STORE_LIMITS = { tracks: 256, catalogs: 16, injectResults: 64, holds: 256, rows: 5000, sessions: 1024, sessionsPerFrame: 256, streamsPerSession: 1024, frames: 256, workersPerFrame: 64 } as const;

export interface TrackRow {
  name: string;
  frames: number;
  bytes: number;
  groups: number;
  lastGroup: number | null;
  keyframes: number;
  lastKeyGroup: number | null;
  dropped: number;
  recent: { second: number; bytes: number }[];
  /** When the last frame came, in the clock of the page. */
  lastAt: number;
}

const TRACK_SECONDS = 6;

/** Bits per second over the last full seconds. Null with too little to say. */
export function trackBitrate(track: TrackRow): number | null {
  const full = track.recent.slice(0, -1);
  if (full.length === 0) return null;
  const first = full[0]?.second as number;
  const last = full.at(-1)?.second as number;
  return (full.reduce((sum, { bytes }) => sum + bytes, 0) * 8) / (last - first + 1);
}

interface StreamRow {
  streamId: number;
  kind: 'uni' | 'bidi';
  origin: 'remote' | 'local' | null;
}

export interface SessionRow {
  key: string;
  documentId: string;
  frameId: number;
  sessionId: number;
  /** Null when traffic came first, for example after the panel connected again. */
  url: string | null;
  closed: { closeCode: number | null; reason: string } | null;
  streams: Map<number, StreamRow>;
  hasDatagrams: boolean;
  /** The URL of the worker that opened it. Null for a session of a frame. */
  workerUrl: string | null;
  /** Tells workers with the same URL apart. Null for a session of a frame. */
  workerId: number | null;
  /** Empty if it is not known to be MoQT. Page data, so only shown as text. */
  moqt: string;
  /** When the session started, in ms since 1970. Undefined when the panel did not see it start. */
  createdAt?: number;
  /** Last catalog of each broadcast. Page data, so only shown as text. */
  catalogs: Map<string, { json: string; renditions: Rendition[] }>;
  tracks: Map<string, TrackRow>;
  /** History and problems for the Monitor view (ADR-42). */
  monitor: SessionMonitor;
  /** When a stall that the panel or a rule started ends, in the clock of the page. */
  stalledUntil: number | null;
}

export interface MessageRow {
  /** Stays the same while the list scrolls or loses its oldest rows. */
  n: number;
  sessionKey: string;
  item: TrafficItem;
  /** Filled by the first filter that needs it: decoding all rows at each render is slow. */
  searchText?: string;
}

interface FrameRow {
  documentId: string;
  frameId: number;
  url: string;
  gone: boolean;
  counters: Record<TrafficKind, KindCounters> | null;
  captureDropped: number;
  disabledRules: string[];
  ruleHits: { id: string; count: number }[];
  /** What the page had reported at the last Clear. */
  droppedBase: number;
  sessions: number;
  /** A worker has a row of its own, because it has counters of its own. Null for a frame. */
  worker: { parent: string; url: string; id: number } | null;
  /** What the page had counted at the last Clear. Its counters only grow. */
  countedBase: KindCounters | null;
}

const addCounters = (total: KindCounters, part: KindCounters): void => {
  total.streams += part.streams;
  total.chunks += part.chunks;
  total.bytes += part.bytes;
  total.dropped += part.dropped;
  total.modified += part.modified;
  total.delayed += part.delayed;
};

const noCounters = (): KindCounters => ({ streams: 0, chunks: 0, bytes: 0, dropped: 0, modified: 0, delayed: 0 });

function frameTotal(frame: FrameRow): KindCounters {
  const total = noCounters();
  for (const kind of Object.values(frame.counters ?? {})) addCounters(total, kind);
  return total;
}

/** Keeps a worker apart from its frame and from other workers: each one counts session ids from 1. */
const workerKey = (documentId: string, workerId: number): string => `${documentId}#worker-${workerId}`;

export interface HoldRow extends HeldMessage {
  key: string;
  /** Where to send the decision. */
  documentId: string;
  workerId: number | null;
  /** Grows each time the page announces it, as a panel that connected again hears of it again. */
  announced: number;
  /** The row of its frame or worker in the store. */
  frameKey: string;
  /** On the clock of the panel. Only for the display: the page has the real timer. */
  deadline: number;
}

/** A row stays this long after its time, so a late `hold-end` is not needed to clear it. */
const HOLD_GRACE_MS = 5000;

/** An open session, for the Inject view. */
export interface InjectTarget {
  key: string;
  label: string;
  documentId: string;
  workerId: number | null;
  sessionId: number;
  /** Who must answer. */
  frameKey: string;
}

export interface InjectResult {
  failure: InjectFailure | null;
}

export type Scope = { sessionKey: string; stream: number | 'datagram' | null } | null;

export const sessionKey = (documentId: string, sessionId: number): string => `${documentId}:${sessionId}`;

export class PanelStore {
  version = 0;
  /** Workers that run with no instrumentation, by document and URL. Capped like the rest. */
  readonly skippedWorkers = new Map<string, { documentId: string; url: string; reason: WorkerSkipReason }>();
  rows: MessageRow[] = [];
  /** Oldest rows removed to stay under the limit. */
  evicted = 0;
  /** Messages over the limits of frames, sessions or streams. */
  ignored = 0;
  readonly sessions = new Map<string, SessionRow>();
  readonly frames = new Map<string, FrameRow>();
  /** Stay after Clear: they are still waiting for a decision. */
  readonly holds = new Map<string, HoldRow>();
  /** By frame and id of the request, so only the frame that was asked can answer. A page can lie only about what it did itself. */
  readonly injectResults = new Map<string, InjectResult>();
  /** Recordings that come from the pages (ADR-19). */
  readonly recorder = new RecordingCollector();
  get recordings(): Map<string, RecordingRow> {
    return this.recorder.rows;
  }
  get recordWait(): { until: number } | null {
    return this.recorder.wait;
  }
  get recordEmpty(): boolean {
    return this.recorder.empty;
  }
  set recordEmpty(value: boolean) {
    this.recorder.empty = value;
  }
  /** What the player of each frame or worker showed, by document (ADR-49). */
  readonly playback = new Map<string, PlaybackState>();
  replayStartedUrl: string | null = null;
  replayEndedUrl: string | null = null;
  private nextRow = 0;
  /** Thresholds of the Monitor view. */
  thresholds: MonitorThresholds = { ...DEFAULT_THRESHOLDS };
  /** A clock for the display of a hold. */
  now: () => number = () => performance.now();

  /** Open sessions stay: they are still live, and the page would not announce them again. */
  clear(): void {
    this.rows = [];
    this.playback.clear();
    this.evicted = 0;
    this.ignored = 0;
    // These stay: the workers still run with no instrumentation, and the page would not say so again.
    for (const frame of this.frames.values()) {
      frame.droppedBase += frame.captureDropped;
      frame.captureDropped = 0;
      frame.sessions = 0;
      frame.countedBase = frameTotal(frame);
    }
    for (const [key, session] of this.sessions) {
      if (session.closed) {
        this.sessions.delete(key);
        continue;
      }
      session.hasDatagrams = false;
      session.streams.clear();
      session.tracks.clear();
      session.monitor = newSessionMonitor();
      const frame = this.frames.get(session.documentId);
      if (frame) frame.sessions++;
    }
    // A live frame stays with no session, or its next report would bring back all that it counted before this Clear.
    for (const [documentId, frame] of this.frames) if (frame.sessions === 0 && frame.gone) this.frames.delete(documentId);
    this.version++;
  }

  /** Makes room with rows of documents that are gone, so old pages cannot use up the list for the page in the tab. */
  private evictGone(): boolean {
    for (const [key, frame] of this.frames) {
      if (!frame.gone) continue;
      this.frames.delete(key);
      for (const [sessionId, session] of this.sessions) if (session.documentId === key) this.sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  /** Last choice for a new frame: a live row with no session. If it reports again, its old counts come back. */
  private evictIdle(): boolean {
    for (const [key, frame] of this.frames) {
      if (frame.sessions > 0) continue;
      this.frames.delete(key);
      return true;
    }
    return false;
  }

  private frame(documentId: string, frameId: number, url: string): FrameRow | null {
    let frame = this.frames.get(documentId);
    if (!frame) {
      if (this.frames.size >= STORE_LIMITS.frames && !this.evictGone() && !this.evictIdle()) return null;
      frame = { documentId, frameId, url, gone: false, counters: null, captureDropped: 0, disabledRules: [], ruleHits: [], droppedBase: 0, sessions: 0, worker: null, countedBase: null };
      this.frames.set(documentId, frame);
    }
    frame.gone = false;
    frame.url = url;
    return frame;
  }

  private session(frame: FrameRow, sessionId: number): SessionRow | null {
    const key = sessionKey(frame.documentId, sessionId);
    let session = this.sessions.get(key);
    if (!session) {
      if (frame.sessions >= STORE_LIMITS.sessionsPerFrame) return null;
      while (this.sessions.size >= STORE_LIMITS.sessions) if (!this.evictGone()) return null;
      session = {
        key,
        documentId: frame.documentId,
        frameId: frame.frameId,
        sessionId,
        url: null,
        closed: null,
        streams: new Map(),
        hasDatagrams: false,
        workerUrl: frame.worker?.url ?? null,
        workerId: frame.worker?.id ?? null,
        moqt: '',
        catalogs: new Map(),
        tracks: new Map(),
        monitor: newSessionMonitor(),
        stalledUntil: null,
      };
      this.sessions.set(key, session);
      frame.sessions++;
    }
    return session;
  }

  private addStream(session: SessionRow, row: StreamRow): void {
    const known = session.streams.get(row.streamId);
    if (known) {
      if (row.origin) known.origin = row.origin;
      return;
    }
    if (session.streams.size >= STORE_LIMITS.streamsPerSession) {
      this.ignored++;
      return;
    }
    session.streams.set(row.streamId, row);
  }

  handle(message: PanelMessage): void {
    this.version++;
    // The panel handles this one itself, because it is not page data.
    if (message.type === 'config' || message.type === 'site-changed') return;
    if (message.type === 'frame-gone') {
      const { documentId } = message.payload;
      this.documentGone(documentId, 'The page is gone.');
      for (const [key, row] of this.frames) if (row.worker?.parent === documentId) this.workerGone(key);
      for (const [key, entry] of this.skippedWorkers) if (entry.documentId === documentId) this.skippedWorkers.delete(key);
      return;
    }
    const { documentId, frameId, frameUrl, message: inner } = message.payload;
    if (inner.type === 'worker-skipped') {
      const key = `${documentId} ${inner.payload.url}`;
      if (this.skippedWorkers.size >= STORE_LIMITS.frames && !this.skippedWorkers.has(key)) this.ignored++;
      else this.skippedWorkers.set(key, { documentId, url: inner.payload.url, reason: inner.payload.reason });
      return;
    }
    if (inner.type === 'worker-gone') {
      this.workerGone(workerKey(documentId, inner.payload.workerId));
      return;
    }
    if (inner.type === 'worker-message' && !this.frames.has(workerKey(documentId, inner.payload.workerId))) {
      let workers = 0;
      for (const row of this.frames.values()) if (row.worker?.parent === documentId) workers++;
      if (workers >= STORE_LIMITS.workersPerFrame) {
        this.ignored++;
        return;
      }
    }
    const frame = this.frame(
      inner.type === 'worker-message' ? workerKey(documentId, inner.payload.workerId) : documentId,
      frameId,
      inner.type === 'worker-message' ? inner.payload.url : frameUrl,
    );
    if (!frame) {
      this.ignored++;
      return;
    }
    if (inner.type === 'worker-message') {
      frame.worker = { parent: documentId, url: inner.payload.url, id: inner.payload.workerId };
      this.report(frame, inner.payload.message);
    } else {
      this.report(frame, inner);
    }
  }

  /** A worker that ended sends no close for its sessions. */
  private workerGone(key: string): void {
    this.documentGone(key, 'The worker ended.');
  }

  /** A page or worker that ended sends no close for its sessions, and an open one could never leave the list. */
  private documentGone(key: string, reason: string): void {
    const frame = this.frames.get(key);
    if (frame) frame.gone = true;
    for (const session of this.sessions.values()) {
      if (session.documentId === key && !session.closed) session.closed = { closeCode: null, reason };
    }
    for (const [holdKey, row] of this.holds) if (row.frameKey === key) this.holds.delete(holdKey);
  }

  private report(frame: FrameRow, inner: RuntimeReport): void {
    switch (inner.type) {
      case 'connection-event': {
        const session = this.session(frame, inner.payload.sessionId);
        if (!session) return;
        const { action, streamId, at } = inner.payload;
        noteConnection(session.monitor, action, streamId, at);
        if (action.type === 'stall') session.stalledUntil = at + action.durationMs;
        this.version++;
        return;
      }
      case 'moq-catalog': {
        const session = this.session(frame, inner.payload.sessionId);
        const renditions = parseCatalog(inner.payload.json);
        if (session && renditions && (session.catalogs.has(inner.payload.broadcast) || session.catalogs.size < STORE_LIMITS.catalogs)) {
          session.catalogs.set(inner.payload.broadcast, { json: inner.payload.json, renditions });
        }
        this.version++;
        return;
      }
      case 'moqt-version': {
        const session = this.session(frame, inner.payload.sessionId);
        if (session) {
          const { draft } = inner.payload;
          const { lite } = inner.payload;
          if (lite !== undefined) {
            session.moqt = LITE_VERSIONS.has(lite) ? `moq-lite ${lite}` : lite === 0 ? 'moq-lite (version in its setup), chunks only' : `moq-lite ${lite}, chunks only`;
            break;
          }
          // The UI must say when rules on objects cannot work here (skill `moqt-framing`).
          session.moqt = draft === null ? 'MoQT, chunks only' : OBJECT_DRAFTS.has(draft) ? `MoQT draft ${draft}` : `MoQT draft ${draft}, chunks only`;
        }
        return;
      }
      case 'session-open':
      case 'session-closed':
      case 'stream-open': {
        const session = this.session(frame, inner.payload.sessionId);
        if (!session) {
          this.ignored++;
          return;
        }
        if (inner.type === 'session-open') {
          session.url = inner.payload.url;
          session.createdAt = inner.payload.createdAt;
          // A slow worker can come back after it was taken for gone (ADR-14).
          session.closed = null;
        }
        else if (inner.type === 'session-closed') {
          session.closed = { closeCode: inner.payload.closeCode, reason: inner.payload.reason };
          noteClosed(session.monitor, inner.payload.closeCode, inner.payload.reason, inner.payload.at);
          this.version++;
        } else {
          this.addStream(session, { streamId: inner.payload.streamId, kind: inner.payload.kind, origin: inner.payload.origin });
        }
        return;
      }
      case 'stats':
        frame.counters = inner.payload.stats;
        frame.disabledRules = inner.payload.disabledRules;
        frame.ruleHits = inner.payload.ruleHits;
        frame.captureDropped = Math.max(0, inner.payload.captureDropped - frame.droppedBase);
        return;
      case 'hold': {
        const key = `${frame.documentId} ${inner.payload.holdId}`;
        if (this.holds.size >= STORE_LIMITS.holds && !this.holds.has(key)) {
          this.ignored++;
          return;
        }
        this.holds.set(key, {
          ...inner.payload,
          key,
          announced: (this.holds.get(key)?.announced ?? 0) + 1,
          frameKey: frame.documentId,
          documentId: frame.worker?.parent ?? frame.documentId,
          workerId: frame.worker?.id ?? null,
          deadline: this.now() + inner.payload.timeoutMs,
        });
        return;
      }
      case 'record-part':
        this.recorder.part(frame.documentId, inner.payload);
        return;
      case 'record-end':
        this.recorder.end(frame.documentId, inner.payload, (sessionId) => this.sessions.get(sessionKey(frame.documentId, sessionId))?.createdAt);
        return;
      case 'replay-ended':
        this.replayEndedUrl = inner.payload.url;
        this.version++;
        return;
      case 'playback': {
        // No query: a token can be in it.
        notePlayback(this.playback, frame.documentId, frame.worker ? `worker ${withoutQuery(frame.worker.url)}` : withoutQuery(frame.url), inner.payload, Date.now());
        this.version++;
        return;
      }
      case 'replay-started':
        this.replayStartedUrl = inner.payload.url;
        return;
      case 'inject-result':
      {
        const key = `${frame.documentId} ${inner.payload.injectId}`;
        // The first answer counts, and a full list loses its oldest one, not all.
        if (this.injectResults.has(key)) return;
        if (this.injectResults.size >= STORE_LIMITS.injectResults) {
          for (const oldest of this.injectResults.keys()) {
            this.injectResults.delete(oldest);
            break;
          }
        }
        this.injectResults.set(key, { failure: inner.payload.failure });
        return;
      }
      case 'hold-end':
        this.holds.delete(`${frame.documentId} ${inner.payload.holdId}`);
        return;
      case 'traffic':
        for (const item of inner.payload.items) this.addItem(frame, item);
        return;
    }
  }

  private addToTrack(session: SessionRow, name: string, item: TrafficItem): void {
    const { moqt, byteLength, at } = item;
    if (!moqt) return;
    let track = session.tracks.get(name);
    if (!track) {
      if (session.tracks.size >= STORE_LIMITS.tracks) return;
      track = { name, frames: 0, bytes: 0, groups: 0, lastGroup: null, keyframes: 0, lastKeyGroup: null, dropped: 0, recent: [], lastAt: at };
      session.tracks.set(name, track);
    }
    noteFrame(
      session.monitor,
      name,
      { at, bytes: byteLength, group: moqt.group, key: moqt.key === true, dropped: item.outcome === 'dropped', ...(moqt.mediaUs === undefined ? {} : { mediaUs: moqt.mediaUs }) },
      this.thresholds,
    );
    track.frames++;
    track.bytes += byteLength;
    if (item.outcome === 'dropped') track.dropped++;
    // Groups come on streams in parallel, so a late frame of an older group must not count again.
    if (track.lastGroup === null || moqt.group > track.lastGroup) {
      track.groups++;
      track.lastGroup = moqt.group;
    }
    if (moqt.key) {
      track.keyframes++;
      track.lastKeyGroup = moqt.group;
    }
    // By second, for a bitrate that follows the stream.
    track.lastAt = Math.max(track.lastAt, at);
    const second = Math.floor(at / 1000);
    const last = track.recent.at(-1);
    if (last?.second === second) last.bytes += byteLength;
    else {
      track.recent.push({ second, bytes: byteLength });
      if (track.recent.length > TRACK_SECONDS) track.recent.shift();
    }
  }

  private addItem(frame: FrameRow, item: TrafficItem): void {
    const session = this.session(frame, item.sessionId);
    if (!session) {
      this.ignored++;
      return;
    }
    if (item.kind === 'datagram') session.hasDatagrams = true;
    else if (item.streamId !== null) this.addStream(session, { streamId: item.streamId, kind: item.kind, origin: null });
    // IETF objects have a name once SUBSCRIBE went by (ADR-45). Before that, the alias stands in.
    if (item.moqt && !item.outgoing) this.addToTrack(session, item.moqt.track ?? `alias ${item.moqt.trackAlias}`, item);
    this.rows.push({ n: this.nextRow++, sessionKey: session.key, item });
    // Remove in steps: removing one row for each new row would move the whole array each time.
    if (this.rows.length > STORE_LIMITS.rows + 500) {
      const extra = this.rows.length - STORE_LIMITS.rows;
      this.rows.splice(0, extra);
      this.evicted += extra;
    }
  }

  /** Rows in the scope that match the filter. The filter looks at the kind, the outcome and the payload text. */
  /** Starts the Monitor again for every session: counts, checks and events. */
  resetMonitor(): void {
    for (const session of this.sessions.values()) session.monitor = newSessionMonitor();
    this.playback.clear();
    this.version++;
  }

  /** Forgets closed sessions and their rows. Open sessions and the counters stay. */
  removeClosed(): void {
    const gone = new Set<string>();
    for (const [key, session] of this.sessions) {
      if (!session.closed) continue;
      gone.add(key);
      this.sessions.delete(key);
      const frame = this.frames.get(session.documentId);
      if (frame) frame.sessions = Math.max(0, frame.sessions - 1);
    }
    if (gone.size === 0) return;
    this.rows = this.rows.filter((row) => !gone.has(row.sessionKey));
    this.version++;
  }

  /** `sessions`: only rows of these sessions. Null = all. */
  visibleRows(scope: Scope, filter: string, sessions: Set<string> | null = null): MessageRow[] {
    const needle = filter.trim().toLowerCase();
    return this.rows.filter((row) => {
      const { sessionKey: key, item } = row;
      if (sessions && !sessions.has(key)) return false;
      if (scope) {
        if (key !== scope.sessionKey) return false;
        if (scope.stream === 'datagram' && item.kind !== 'datagram') return false;
        if (typeof scope.stream === 'number' && item.streamId !== scope.stream) return false;
      }
      if (!needle) return true;
      const label = `${item.kind} ${item.outcome}${item.modified ? ' modified' : ''}${item.injected ? ' injected' : ''}`;
      if (label.includes(needle)) return true;
      row.searchText ??= toText(decodePreview(item.preview)).toLowerCase();
      return row.searchText.includes(needle);
    });
  }

  totals(): KindCounters {
    const total = noCounters();
    for (const frame of this.frames.values()) {
      const counted = frameTotal(frame);
      const base = frame.countedBase ?? noCounters();
      addCounters(total, {
        streams: counted.streams - base.streams,
        chunks: counted.chunks - base.chunks,
        bytes: counted.bytes - base.bytes,
        dropped: counted.dropped - base.dropped,
        modified: counted.modified - base.modified,
        delayed: counted.delayed - base.delayed,
      });
    }
    return total;
  }

  /** Hits of all frames, by rule id. A Map, because a rule id can be any text. */
  ruleHits(): Map<string, number> {
    const hits = new Map<string, number>();
    for (const frame of this.frames.values()) {
      for (const { id, count } of frame.ruleHits) hits.set(id, (hits.get(id) ?? 0) + count);
    }
    return hits;
  }

  disabledRules(): string[] {
    return Array.from(new Set(Array.from(this.frames.values()).flatMap((frame) => frame.disabledRules)));
  }

  /** Open sessions that a request can reach: the service worker sends one only to frames of the site of the tab. */
  injectTargets(site: string | null | undefined): InjectTarget[] {
    const targets: InjectTarget[] = [];
    const otherSite = (url: string | undefined): boolean => {
      try {
        const { origin } = new URL(url ?? '');
        // about:blank and srcdoc have no origin in their URL, and they can have the one of the site.
        return origin !== 'null' && origin !== site;
      } catch {
        return false;
      }
    };
    for (const session of this.sessions.values()) {
      if (session.closed) continue;
      const row = this.frames.get(session.documentId);
      const worker = row?.worker ?? null;
      if (otherSite(worker ? this.frames.get(worker.parent)?.url : row?.url)) continue;
      const name = session.url ?? 'Unknown session';
      targets.push({
        key: session.key,
        // The part that tells sessions apart goes first: a select cuts the end of a long URL.
        label: `${worker ? `Worker ${worker.id}` : `Frame ${session.frameId}`}, session ${session.sessionId}: ${name}`,
        documentId: worker?.parent ?? session.documentId,
        workerId: worker?.id ?? null,
        sessionId: session.sessionId,
        frameKey: session.documentId,
      });
    }
    return targets;
  }

  /** Oldest first. Also removes rows far past their time: a page can skip its `hold-end`. */
  holdRows(): HoldRow[] {
    const now = this.now();
    for (const [key, row] of this.holds) if (now > row.deadline + HOLD_GRACE_MS) this.holds.delete(key);
    return Array.from(this.holds.values());
  }

  /** Forgets one recording of this panel. */
  deleteRecording(key: string): void {
    if (this.recorder.rows.delete(key)) this.version++;
  }

  /** Call when the user stops a recording: the rows come later, after a moment for a long one. */
  waitForRecording(): void {
    this.recorder.waitForRecording();
  }

  /** Messages that came so far, or null when nothing is on its way. It gives up if the page stops sending. */
  recordingOnItsWay(): number | null {
    return this.recorder.onItsWay();
  }

  lostItems(): number {
    let lost = this.ignored;
    for (const frame of this.frames.values()) lost += frame.captureDropped;
    return lost;
  }
}
