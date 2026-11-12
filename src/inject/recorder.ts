// Keeps what the network delivered, before any rule, in the page. Nothing leaves the page until the user stops the recording.
import type { TrafficKind } from '../shared/rules';
import { TRACE_MAX_TRACKS, TRACE_SENT_BYTES, type TraceSummary } from '../shared/protocol';

/** A long recording must not fill the memory of the page. Past this, it stops and says so. */
export const MAX_RECORD_BYTES = 32 * 1024 * 1024;

interface RecordedEvent {
  sessionId: number;
  t: number;
  kind: TrafficKind;
  streamId: number | null;
  origin: 'remote' | 'local';
  data: Uint8Array<ArrayBuffer> | null;
  fin: boolean;
  /** First bytes that the app wrote on a stream it opened, on the first event of that stream (ADR-43). */
  sent?: Uint8Array<ArrayBuffer>;
}

interface RecordedSession {
  sessionId: number;
  url: string;
  /** What the server chose. An app such as a MoQ player reads it, so a replay must give it too. */
  protocol?: string;
  /** The MoQ protocol that the page offered, when the server chose none. A replay never gives it as chosen. */
  offered?: string;
  close: { t: number; closeCode: number; reason: string } | null;
  /** Set when the session had MoQ objects that the recording kept. */
  summary?: TraceSummary;
}

/** One MoQ object that the app got, as the parser saw it. */
interface NotedObject {
  track?: string;
  trackAlias: number;
  group: number;
  key?: boolean;
  mediaUs?: number;
}

export interface Recording {
  events: RecordedEvent[];
  sessions: RecordedSession[];
  truncated: boolean;
}

interface Recorder {
  readonly on: boolean;
  start(): void;
  /** `media`: a stream of a media track. It is not kept in the start of the session, as old media then new media plays badly (ADR-35). */
  add(session: { id: number; url: string; startedAt: number; protocol?: string }, event: Omit<RecordedEvent, 'sessionId' | 't'>, media?: boolean): void;
  sessionClosed(session: { id: number; url: string; startedAt: number }, info: { closeCode?: number; reason?: string } | null): void;
  /** What the app wrote on a stream it opened. Only the first bytes are kept. */
  sent(sessionId: number, streamId: number, data: Uint8Array): void;
  /** Counts one object for the summary of the recording, if its stream is in the recording. */
  note(sessionId: number, stream: { kind: string; streamId: number | null; origin: string }, object: NotedObject, bytes: number): void;
  stop(): Recording;
}

/** The start of each open session is always kept, as an app cannot play from the middle: it needs the setup and the answers to its first requests (ADR-34). */
export const MAX_HEAD_BYTES = 2 * 1024 * 1024;
const MAX_HEADS_BYTES = 8 * 1024 * 1024;
/** Longest wait between two events of the start of a session, in a recording. */
export const MAX_HEAD_GAP_MS = 20;

interface Head {
  session: { id: number; url: string; startedAt: number; protocol?: string };
  events: RecordedEvent[];
  bytes: number;
  full: boolean;
}

export function createRecorder(now: () => number): Recorder {
  let on = false;
  const heads = new Map<number, Head>();
  let headBytes = 0;
  /** How much of a session the recording skipped, by session: it plays with no long wait in the middle. */
  const skipped = new Map<number, number>();
  /** Streams of open sessions, so a recording skips those that it would get in part. */
  const streams = new Map<string, { lost: boolean; media: boolean; skip: boolean }>();
  const streamKey = (sessionId: number, event: { kind: string; streamId: number | null; origin: string }): string | null =>
    event.streamId === null ? null : `${sessionId} ${event.kind} ${event.origin} ${event.streamId}`;
  let bytes = 0;
  let truncated = false;
  let events: RecordedEvent[] = [];
  const sessions = new Map<number, RecordedSession>();
  let startedAt = 0;
  interface Counted {
    groups: Set<number>;
    firstGroup: number;
    lastGroup: number;
    frames: number;
    keyframes: number;
    bytes: number;
    minUs: number;
    maxUs: number;
    alias: number;
  }
  /** The first bytes that the app wrote on each stream it opened, by session and stream. Kept while the session lives. */
  const sentBytes = new Map<string, Uint8Array<ArrayBuffer>>();
  /** By session, then by track name. */
  const counted = new Map<number, Map<string, Counted>>();
  const MAX_GROUPS = 100_000;
  const known = (session: { id: number; url: string; protocol?: string; offered?: string }): RecordedSession => {
    let row = sessions.get(session.id);
    if (!row) {
      row = { sessionId: session.id, url: session.url, close: null };
      sessions.set(session.id, row);
    }
    if (session.protocol) row.protocol = session.protocol;
    if (session.offered) row.offered = session.offered;
    return row;
  };
  return {
    get on() {
      return on;
    },
    start() {
      on = true;
      bytes = 0;
      truncated = false;
      events = [];
      sessions.clear();
      skipped.clear();
      counted.clear();
      startedAt = now();
      for (const state of streams.values()) state.skip = state.lost || state.media;
      for (const { session, events: head } of heads.values()) {
        known(session);
        // Only whole streams: a part of a stream is bytes that the app cannot read.
        const whole = head.filter((e) => {
          const key = streamKey(session.id, e);
          return key === null || !streams.get(key)?.skip;
        });
        // The start plays fast: a long open session has answers spread over minutes (a probe stream of moq-lite answers every few
        // seconds), and the media of the recording must not wait for them (ADR-39).
        let before = 0;
        let at = 0;
        const quick = whole.map((e) => {
          at += Math.min(Math.max(0, e.t - before), MAX_HEAD_GAP_MS);
          before = e.t;
          return { ...e, t: at };
        });
        events.push(...quick);
        for (const e of quick) bytes += e.data?.byteLength ?? 0;
        skipped.set(session.id, Math.max(0, now() - session.startedAt - at));
      }
    },
    add(session, event, media = false) {
      const size = event.data?.byteLength ?? 0;
      const key = streamKey(session.id, event);
      let state = key === null ? undefined : streams.get(key);
      if (key !== null && !state) {
        state = { lost: false, media, skip: false };
        streams.set(key, state);
      }
      // A copy: the original goes to the app, which takes the buffer.
      let copy: Uint8Array<ArrayBuffer> | null | undefined;
      const data = (): Uint8Array<ArrayBuffer> | null => (copy === undefined ? (copy = event.data?.slice() ?? null) : copy);
      let head = heads.get(session.id);
      if (!head) {
        head = { session, events: [], bytes: 0, full: false };
        heads.set(session.id, head);
      }
      if (state?.media) {
        // Not in the start. Skipped by a recording that comes later.
      } else if (head.full || head.bytes + size > MAX_HEAD_BYTES || headBytes + size > MAX_HEADS_BYTES) {
        head.full = true;
        if (state && !on) state.lost = true;
      } else {
        {
          head.events.push({ ...event, sessionId: session.id, t: now() - session.startedAt, data: data() });
          head.bytes += size;
          headBytes += size;
        }
      }
      if (key !== null && event.fin && !on) streams.delete(key);
      if (!on || truncated || state?.skip) return;
      if (bytes + size > MAX_RECORD_BYTES) {
        truncated = true;
        return;
      }
      bytes += size;
      known(session);
      // A copy: the original goes to the app, which takes the buffer.
      events.push({ ...event, sessionId: session.id, t: now() - session.startedAt - (skipped.get(session.id) ?? 0), data: data() ?? null });
    },
    sessionClosed(session, info) {
      const head = heads.get(session.id);
      if (head) headBytes -= head.bytes;
      heads.delete(session.id);
      for (const key of [...streams.keys()]) if (key.startsWith(`${session.id} `)) streams.delete(key);
      for (const key of [...sentBytes.keys()]) if (key.startsWith(`${session.id} `)) sentBytes.delete(key);
      if (on && info) known(session).close = { t: now() - session.startedAt - (skipped.get(session.id) ?? 0), closeCode: info.closeCode ?? 0, reason: info.reason ?? '' };
    },
    sent(sessionId, streamId, data) {
      const key = `${sessionId} ${streamId}`;
      const before = sentBytes.get(key) ?? new Uint8Array(0);
      if (before.length >= TRACE_SENT_BYTES) return;
      const next = new Uint8Array(Math.min(TRACE_SENT_BYTES, before.length + data.length));
      next.set(before);
      next.set(data.subarray(0, next.length - before.length), before.length);
      sentBytes.set(key, next);
    },
    note(sessionId, stream, object, size) {
      if (!on || truncated) return;
      const key = streamKey(sessionId, stream);
      if (key !== null && streams.get(key)?.skip) return;
      let tracks = counted.get(sessionId);
      if (!tracks) counted.set(sessionId, (tracks = new Map()));
      const name = object.track ?? `alias ${object.trackAlias}`;
      let row = tracks.get(name);
      if (!row) {
        if (tracks.size >= TRACE_MAX_TRACKS) return;
        row = { groups: new Set(), firstGroup: object.group, lastGroup: object.group, frames: 0, keyframes: 0, bytes: 0, minUs: Infinity, maxUs: -Infinity, alias: object.trackAlias };
        tracks.set(name, row);
      }
      if (row.groups.size < MAX_GROUPS) row.groups.add(object.group);
      row.firstGroup = Math.min(row.firstGroup, object.group);
      row.lastGroup = Math.max(row.lastGroup, object.group);
      row.frames++;
      row.alias = object.trackAlias;
      if (object.key) row.keyframes++;
      row.bytes += size;
      if (object.mediaUs !== undefined) {
        row.minUs = Math.min(row.minUs, object.mediaUs);
        row.maxUs = Math.max(row.maxUs, object.mediaUs);
      }
    },
    stop() {
      on = false;
      const recordedMs = Math.max(0, now() - startedAt);
      for (const row of sessions.values()) {
        const tracks = counted.get(row.sessionId);
        row.summary = {
          recordedMs,
          tracks: Array.from(tracks ?? [], ([name, c]) => ({
            name,
            groups: c.groups.size,
            firstGroup: c.firstGroup,
            lastGroup: c.lastGroup,
            frames: c.frames,
            keyframes: c.keyframes,
            bytes: c.bytes,
            ...(c.maxUs >= c.minUs ? { mediaMs: (c.maxUs - c.minUs) / 1000 } : {}),
            alias: c.alias,
          })),
        };
      }
      // On the first event of each stream that the app opened: what it asked for.
      const marked = new Set<string>();
      events = events.map((event) => {
        if (event.origin !== 'local' || event.streamId === null) return event;
        const key = `${event.sessionId} ${event.streamId}`;
        if (marked.has(key)) return event;
        marked.add(key);
        const sent = sentBytes.get(key);
        return sent ? { ...event, sent } : event;
      });
      const out: Recording = { events, sessions: Array.from(sessions.values()), truncated };
      events = [];
      sessions.clear();
      counted.clear();
      return out;
    },
  };
}
