// Recordings that come from the pages in parts, and the rows they make in Record (ADR-19, ADR-33).
import { TRACE_FORMAT, type RuntimeMessage, type TraceEvent, type TraceFile } from '../shared/protocol';

/** A recording of one session. */
export interface RecordingRow {
  key: string;
  trace: TraceFile;
  incomplete: boolean;
}

type Payload<T extends RuntimeMessage['type']> = Extract<RuntimeMessage, { type: T }>['payload'];
type RecordPart = Payload<'record-part'>;
type RecordEnd = Payload<'record-end'>;

/** All recordings in this panel. Past this, a new one is cut and says so. */
const MAX_RECORDED_CHARS = 64 * 1024 * 1024;
/** How long the panel waits for the next part of a recording before it gives up. */
const RECORD_WAIT_MS = 8000;

/** A token is often in the query of a session URL, and a recording is a file that people share. Sluice does not need it (ADR-33). */
export function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export class RecordingCollector {
  readonly rows = new Map<string, RecordingRow>();
  wait: { until: number } | null = null;
  empty = false;
  /** Of the running recording, by frame. */
  private readonly parts = new Map<string, { count: number; over: boolean; events: Map<number, TraceEvent[]> }>();
  private chars = 0;

  part(documentId: string, payload: RecordPart): void {
    const key = `${documentId} ${payload.recordId}`;
    const parts = this.parts.get(key) ?? { count: 0, over: false, events: new Map<number, TraceEvent[]>() };
    this.parts.set(key, parts);
    for (const { sessionId, ...event } of payload.events) {
      parts.count++;
      if (this.wait) this.wait.until = Date.now() + RECORD_WAIT_MS;
      this.chars += event.data?.length ?? 0;
      if (this.chars > MAX_RECORDED_CHARS) {
        parts.over = true;
        continue;
      }
      const list = parts.events.get(sessionId) ?? [];
      parts.events.set(sessionId, list);
      list.push(event);
    }
  }

  /** `startedAt` gives the wall clock time when a session of the page started, when the panel saw it start. */
  end(documentId: string, payload: RecordEnd, startedAt: (sessionId: number) => number | undefined = () => undefined): void {
    const { recordId, count, truncated, sessions } = payload;
    const before = this.rows.size;
    const key = `${documentId} ${recordId}`;
    const parts = this.parts.get(key);
    this.parts.delete(key);
    const incomplete = truncated || parts?.over === true || (parts?.count ?? 0) !== count;
    for (const { sessionId, url, protocol, offered, close, summary } of sessions) {
      const events = parts?.events.get(sessionId) ?? [];
      if (events.length === 0) continue;
      const started = startedAt(sessionId);
      const trace: TraceFile = {
        format: TRACE_FORMAT,
        version: 1,
        url: withoutQuery(url),
        ...(protocol === undefined ? {} : { protocol }),
        ...(offered === undefined ? {} : { offered }),
        ...(started === undefined ? {} : { startedAt: Math.round(started) }),
        close,
        events,
        ...(summary === undefined ? {} : { summary }),
      };
      this.rows.set(`${key} ${sessionId}`, { key: `${key} ${sessionId}`, incomplete, trace });
    }
    if (this.parts.size === 0) {
      this.wait = null;
      if (this.rows.size === before) this.empty = true;
    }
  }

  /** Call when the user stops a recording: the rows come later, after a moment for a long one. */
  waitForRecording(): void {
    this.empty = false;
    this.wait = { until: Date.now() + RECORD_WAIT_MS };
  }

  /** Messages that came so far, or null when nothing is on its way. It gives up if the page stops sending. */
  onItsWay(): number | null {
    if (!this.wait) return null;
    if (Date.now() > this.wait.until) {
      this.wait = null;
      this.empty = this.rows.size === 0;
      return null;
    }
    let count = 0;
    for (const parts of this.parts.values()) count += parts.count;
    return count;
  }
}
