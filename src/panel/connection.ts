// Keeps a port to the service worker. The worker stops when idle, which closes the port: connecting again wakes it, and
// it then asks the frames of the tab to connect too (ADR-10).
import { parsePanelMessage, type PanelMessage } from '../shared/protocol';

const FIRST_RETRY_MS = 100;
const MAX_RETRY_MS = 5000;
/** A port that lived this long was fine, so the next retry is fast again. */
const STABLE_MS = 2000;

export interface ConnectionPort {
  postMessage(message: unknown): void;
  onMessage: { addListener(handler: (message: unknown) => void): void };
  onDisconnect: { addListener(handler: () => void): void };
}

interface ConnectionEnv {
  connect(): ConnectionPort;
  setTimeout(run: () => void, ms: number): void;
  now(): number;
}

export interface Connection {
  /** False if nothing was sent. */
  send(message: unknown): boolean;
}

export function connectPanel(
  env: ConnectionEnv,
  onMessage: (message: PanelMessage) => void,
  onStatus: (connected: boolean) => void,
): Connection {
  let port: ConnectionPort | null = null;
  let retryMs = FIRST_RETRY_MS;

  const retry = (): void => {
    env.setTimeout(open, retryMs);
    retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
  };

  function open(): void {
    const openedAt = env.now();
    let next: ConnectionPort;
    try {
      next = env.connect();
    } catch {
      onStatus(false);
      retry();
      return;
    }
    port = next;
    onStatus(true);
    next.onMessage.addListener((raw) => {
      const parsed = parsePanelMessage(raw);
      if (parsed.ok) onMessage(parsed.value);
    });
    next.onDisconnect.addListener(() => {
      if (port === next) port = null;
      onStatus(false);
      if (env.now() - openedAt >= STABLE_MS) retryMs = FIRST_RETRY_MS;
      retry();
    });
  }

  open();
  return {
    send(message) {
      if (!port) return false;
      try {
        port.postMessage(message);
        return true;
      } catch {
        // Closed in the same moment: onDisconnect connects again.
        return false;
      }
    },
  };
}
