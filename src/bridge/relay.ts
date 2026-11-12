// ISOLATED side of the bridge. This is the first check of what the page sends: MAIN cannot check anything, because the
// page can replace its globals. It connects only when a frame has something to report (a session, or a worker that Sluice
// could not instrument), so most pages use no port.
import { parseRuntimeMessage, PROTOCOL_LIMITS, PROTOCOL_VERSION } from '../shared/protocol';

/** Enough for a full batch of 4 KiB previews every 100 ms, about 3 MB/s. A frame past it loses messages. */
const MAX_CHARS_PER_SECOND = 8 * 1024 * 1024;
/** Each event also costs a listener call, however short it is. */
const EVENT_COST = 1024;
/** Session events reach the worker with no panel open, so they cost more: about 120 for each second per frame. */
const SESSION_EVENT_COST = 64 * 1024;
const MAX_OPEN_SESSIONS = 1024;
/** A port that dies this soon was refused, for example at the cap of ports per tab. */
const SHORT_LIFE_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export interface RelayPort {
  postMessage(message: unknown): void;
  onMessage: { addListener(handler: (message: unknown) => void): void };
  onDisconnect: { addListener(handler: () => void): void };
}

interface RelayEnv {
  /** Throws if the extension was reloaded. */
  connect(): RelayPort;
  /** Sends a JSON string to MAIN. */
  toMain(text: string): void;
  now(): number;
  /** False after an update or reload of the extension: this script can then never reach the worker again. */
  alive(): boolean;
}

interface Relay {
  /** A CustomEvent detail from MAIN. Hostile: it can be any value. */
  fromMain(detail: unknown): void;
  /** The service worker asks for ports after it restarts. Only frames with a live session answer. */
  wake(force?: boolean): void;
}

export function createRelay(env: RelayEnv): Relay {
  let port: RelayPort | null = null;
  let tokens = MAX_CHARS_PER_SECOND;
  let refilledAt = env.now();
  /** False after the worker says that no panel is open. Null until it says anything. */
  let capture: boolean | null = null;
  let backoffMs = 0;
  let connectAfter = 0;
  const openSessions = new Set<string>();
  /** The panel that opens later must hear about these, and a frame can have no session of its own. */
  let hasSkippedWorkers = false;

  /** Nobody can answer now, and MAIN would hear nothing more. With no panel, a hold must not wait. */
  const endCapture = (): void => {
    if (capture === false || env.alive()) return;
    capture = false;
    env.toMain(JSON.stringify({ v: PROTOCOL_VERSION, type: 'set-capture', id: 0, payload: { traffic: false, previewBytes: 0 } }));
  };

  const ensurePort = (): RelayPort | null => {
    if (port) return port;
    if (env.now() < connectAfter) return null;
    try {
      const next = env.connect();
      const connectedAt = env.now();
      next.onMessage.addListener((message) => {
        const command = message as { type?: unknown; payload?: { traffic?: unknown } } | null;
        if (command?.type === 'set-capture') capture = command.payload?.traffic === true;
        env.toMain(JSON.stringify(message));
      });
      next.onDisconnect.addListener(() => {
        if (port === next) port = null;
        // A long-lived port dying is normal: the worker stops when idle.
        backoffMs = env.now() - connectedAt < SHORT_LIFE_MS ? Math.min(MAX_BACKOFF_MS, Math.max(1000, backoffMs * 2)) : 0;
        connectAfter = env.now() + backoffMs;
        endCapture();
      });
      port = next;
      return next;
    } catch {
      endCapture();
      return null;
    }
  };

  const allowed = (cost: number): boolean => {
    const now = env.now();
    tokens = Math.min(MAX_CHARS_PER_SECOND, tokens + ((now - refilledAt) / 1000) * MAX_CHARS_PER_SECOND);
    refilledAt = now;
    if (tokens < cost) return false;
    tokens -= cost;
    return true;
  };

  return {
    fromMain(detail) {
      // Length first: JSON.parse of a huge string is the slow part.
      if (typeof detail !== 'string' || detail.length > PROTOCOL_LIMITS.messageChars) return;
      if (!allowed(detail.length + EVENT_COST)) return;
      let value: unknown;
      try {
        value = JSON.parse(detail);
      } catch {
        return;
      }
      const parsed = parseRuntimeMessage(value);
      if (!parsed.ok) return;
      const message = parsed.value;
      // A worker counts ids of its own, so the same id can be in the frame and in a worker.
      const fromWorker = message.type === 'worker-message' ? message.payload : null;
      const report = fromWorker ? fromWorker.message : message;
      const sessionKey = (id: number): string => `${fromWorker?.workerId ?? 'frame'}:${id}`;
      if (report.type === 'session-open' && openSessions.size < MAX_OPEN_SESSIONS) openSessions.add(sessionKey(report.payload.sessionId));
      if (report.type === 'session-closed') openSessions.delete(sessionKey(report.payload.sessionId));
      if (message.type === 'worker-gone') {
        for (const key of openSessions) if (key.startsWith(`${message.payload.workerId}:`)) openSessions.delete(key);
      }
      if (message.type === 'worker-skipped') hasSkippedWorkers = true;
      // These go on with no panel too, so they cost the same.
      const isSessionEvent = report.type === 'session-open' || report.type === 'session-closed' || message.type === 'worker-skipped';
      // MAIN sends the rest only while a panel is open, so with no panel only a forged event gets here.
      if (!isSessionEvent && capture === false) return;
      if (isSessionEvent && !allowed(SESSION_EVENT_COST)) return;
      try {
        ensurePort()?.postMessage(message);
      } catch {
        // The port closed in the same moment. The next message opens a new one.
        port = null;
      }
    },
    wake(force = false) {
      // `force`: the user asked for something in the panel that this page must hear before its first session.
      if (force || openSessions.size > 0 || hasSkippedWorkers) ensurePort();
    },
  };
}
