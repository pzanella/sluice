// Routes messages between frames and panels. It keeps no state that must survive: all of it comes from live ports, so a
// restart of the worker loses nothing. Frame facts come only from `port.sender`, never from a message.
import { originPattern } from '../shared/origins';
import {
  parsePanelRequest,
  parseRuntimeMessage,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  type ControlMessage,
  type PanelMessage,
} from '../shared/protocol';
import type { RuntimeConfig } from '../shared/rules';

const MAX_FRAME_PORTS_PER_TAB = 64;
const CAPTURE_PREVIEW_BYTES = 4096;
/** Messages to the panels of one tab. 64 frames at 10 batches/s is 640, far above any real page. */
const MAX_MESSAGES_PER_SECOND = 1000;

export interface RouterPort {
  name: string;
  sender?:
    | {
        id?: string | undefined;
        url?: string | undefined;
        origin?: string | undefined;
        frameId?: number | undefined;
        documentId?: string | undefined;
        tab?: { id?: number | undefined; url?: string | undefined } | undefined;
      }
    | undefined;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(handler: (message: unknown) => void): void };
  onDisconnect: { addListener(handler: () => void): void };
}

interface RouterEnv {
  extensionId: string;
  panelUrl: string;
  /** Asks the frames of a tab to connect, for example after a restart of the worker. */
  wakeTab(tabId: number, force?: boolean): void;
  now(): number;
  /** Saved config of a site. Callbacks, so a test can answer in the same turn. */
  loadConfig(origin: string, done: (config: RuntimeConfig | null) => void): void;
  saveConfig(origin: string, config: RuntimeConfig, done: (error: string | null) => void): void;
  /** Is Sluice on for this origin? */
  isGranted(origin: string, done: (granted: boolean) => void): void;
}

interface FramePort {
  port: RouterPort;
  frameId: number;
  documentId: string;
  frameUrl: string;
  /** Null for an opaque origin. */
  origin: string | null;
  topOrigin: string | null;
  /** False while its saved rules load: capture also opens the gate in MAIN, so it must come after them. */
  ready: boolean;
  /** A panel sent newer rules while the saved ones were loading. */
  hasNewerConfig: boolean;
}

const originOf = (url: string | undefined): string | null => {
  try {
    const { origin } = new URL(url ?? '');
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
};

export function createRouter(env: RouterEnv): { connect(port: RouterPort): void; siteChanged(): void } {
  const frames = new Map<number, Set<FramePort>>();
  const panels = new Map<number, Set<RouterPort>>();
  let messageId = 0;
  const budgets = new Map<number, { second: number; count: number }>();
  /** The running recording of a tab. A frame that connects later records too. */
  const recordings = new Map<number, ControlMessage>();
  /** A recording to play, for a top frame that has no port yet: a frame connects only at its first session. */
  const waitingArm = new Map<number, unknown[]>();

  /** Per tab, not per frame: a page can make many frames. Checked before parsing, because parsing is the cost. */
  const withinBudget = (tabId: number): boolean => {
    const second = Math.floor(env.now() / 1000);
    const budget = budgets.get(tabId);
    if (budget?.second !== second) {
      budgets.set(tabId, { second, count: 1 });
      return true;
    }
    return ++budget.count <= MAX_MESSAGES_PER_SECOND;
  };

  const safePost = (port: RouterPort, message: unknown): void => {
    try {
      port.postMessage(message);
    } catch {
      // Closed in the same moment: onDisconnect does the cleanup.
    }
  };

  const toPanels = (tabId: number, message: PanelMessage): void => {
    for (const panel of panels.get(tabId) ?? []) safePost(panel, message);
  };

  const capture = (tabId: number): ControlMessage => ({
    v: PROTOCOL_VERSION,
    type: 'set-capture',
    id: ++messageId,
    payload: { traffic: (panels.get(tabId)?.size ?? 0) > 0, previewBytes: CAPTURE_PREVIEW_BYTES },
  });

  const connectFrame = (port: RouterPort): void => {
    const { sender } = port;
    const tabId = sender?.tab?.id;
    const frameId = sender?.frameId;
    const documentId = sender?.documentId;
    if (tabId === undefined || frameId === undefined || !documentId) return port.disconnect();
    const tabFrames = frames.get(tabId) ?? new Set<FramePort>();
    // A page can make many frames, and each one would hold a port. The top frame always gets in: frames of an iframe
    // must not be able to hide the page from the panel.
    if (frameId !== 0 && tabFrames.size >= MAX_FRAME_PORTS_PER_TAB) return port.disconnect();

    const frame: FramePort = {
      port,
      frameId,
      documentId,
      frameUrl: (sender?.url ?? '').slice(0, PROTOCOL_LIMITS.url),
      origin: sender?.origin && sender.origin !== 'null' ? sender.origin : null,
      topOrigin: originOf(sender?.tab?.url),
      ready: false,
      hasNewerConfig: false,
    };
    tabFrames.add(frame);
    frames.set(tabId, tabFrames);

    port.onMessage.addListener((raw) => {
      // With no panel there is nobody to tell, so a page cannot make the worker do any work.
      if (!panels.get(tabId)?.size || !withinBudget(tabId)) return;
      // Second check, because this is the last stop before the panel. Nothing here trusts a renderer.
      const parsed = parseRuntimeMessage(raw);
      if (!parsed.ok) return;
      // Such a frame gets no rules, so it holds nothing. Its rows could only fill the list and hide those of the page.
      const report = parsed.value.type === 'worker-message' ? parsed.value.payload.message : parsed.value;
      const onlyForSite =
        report.type === 'hold' ||
        report.type === 'hold-end' ||
        report.type === 'inject-result' ||
        report.type === 'record-part' ||
        report.type === 'record-end' ||
        report.type === 'replay-started';
      if (onlyForSite && (frame.origin === null || frame.origin !== frame.topOrigin)) return;
      toPanels(tabId, {
        v: PROTOCOL_VERSION,
        type: 'frame-message',
        id: ++messageId,
        payload: { frameId, documentId, frameUrl: frame.frameUrl, message: parsed.value },
      });
    });
    port.onDisconnect.addListener(() => {
      tabFrames.delete(frame);
      if (tabFrames.size === 0 && frames.get(tabId) === tabFrames) frames.delete(tabId);
      // With no budget check: the panel needs this to free its rows, and the number of ports limits it.
      toPanels(tabId, { v: PROTOCOL_VERSION, type: 'frame-gone', id: ++messageId, payload: { frameId, documentId } });
    });
    // Rules first: set-capture also tells MAIN that it can start to read (ADR-11).
    const sendCapture = (): void => {
      frame.ready = true;
      if (frame.origin !== null && frame.origin === frame.topOrigin) {
        const recording = recordings.get(tabId);
        if (recording) safePost(port, recording);
        if (frameId === 0) {
          for (const message of waitingArm.get(tabId) ?? []) safePost(port, message);
          waitingArm.delete(tabId);
        }
      }
      safePost(port, capture(tabId));
    };
    // Past the budget the frame gets no rules, but a page cannot use new frames to make the worker read storage.
    if (frame.origin && frame.origin === frame.topOrigin && withinBudget(tabId)) {
      env.loadConfig(frame.origin, (config) => {
        if (config && !frame.hasNewerConfig) {
          const targetOrigin = frame.origin as string;
          safePost(port, { v: PROTOCOL_VERSION, type: 'set-config', id: ++messageId, payload: { config, targetOrigin } });
        }
        sendCapture();
      });
    } else {
      sendCapture();
    }
  };

  const sendCaptureToFrames = (tabId: number): void => {
    for (const frame of frames.get(tabId) ?? []) if (frame.ready) safePost(frame.port, capture(tabId));
  };

  const connectPanel = (port: RouterPort, tabId: number): void => {
    // Only our own panel page. A content script reports the URL of its page, so it cannot pass this.
    if (port.sender?.url !== env.panelUrl) return port.disconnect();
    const tabPanels = panels.get(tabId) ?? new Set<RouterPort>();
    tabPanels.add(port);
    panels.set(tabId, tabPanels);

    const reply = (targetOrigin: string, config: RuntimeConfig | null, error: string | null): void => {
      env.isGranted(targetOrigin, (granted) => {
        safePost(port, { v: PROTOCOL_VERSION, type: 'config', id: ++messageId, payload: { targetOrigin, config, error, granted } });
      });
    };
    port.onMessage.addListener((raw) => {
      const parsed = parsePanelRequest(raw);
      if (!parsed.ok) return;
      const request = parsed.value;
      if (request.type === 'hold-resolve' || request.type === 'inject' || request.type === 'connection') {
        const { documentId, ...payload } = request.payload;
        for (const frame of frames.get(tabId) ?? []) {
          // Same check as for rules: this payload is written for the site of the tab.
          if (frame.documentId === documentId && frame.origin !== null && frame.origin === frame.topOrigin) {
            safePost(frame.port, { v: PROTOCOL_VERSION, type: request.type, id: ++messageId, payload });
          }
        }
        return;
      }
      if (request.type === 'record' || request.type === 'replay-arm' || request.type === 'replay-clear') {
        if (request.type === 'record') {
          if (request.payload.on) recordings.set(tabId, request);
          else recordings.delete(tabId);
        }
        if (request.type === 'replay-clear') waitingArm.delete(tabId);
        let hasTop = false;
        for (const frame of frames.get(tabId) ?? []) {
          // A recording is of the site of the tab, and a session plays only in its top frame.
          if (frame.origin === null || frame.origin !== frame.topOrigin) continue;
          if (frame.frameId === 0) hasTop = true;
          if (request.type === 'record' || frame.frameId === 0) safePost(frame.port, request);
        }
        if (request.type === 'replay-arm' && !hasTop) {
          const list = waitingArm.get(tabId) ?? [];
          waitingArm.set(tabId, list);
          list.push(request);
        }
        // These must reach a page that has no session yet.
        if (request.type !== 'replay-clear' && !hasTop) env.wakeTab(tabId, true);
        return;
      }
      const { targetOrigin } = request.payload;
      // Only a real origin of a page that Sluice can run on, as written by the URL parser.
      if (originPattern(targetOrigin) === null || originOf(targetOrigin) !== targetOrigin) {
        reply(targetOrigin, null, 'Sluice cannot run on this site.');
        return;
      }
      if (request.type === 'get-config') {
        env.loadConfig(targetOrigin, (config) => reply(targetOrigin, config, null));
        return;
      }
      env.saveConfig(targetOrigin, request.payload.config, (error) => {
        reply(targetOrigin, request.payload.config, error);
      });
      for (const frame of frames.get(tabId) ?? []) {
        // Rules are written for one site, and a page can read what it gets. So a frame of another origin gets none, an
        // opaque origin matches nothing, and neither does the next site if the tab navigated (see `targetOrigin`).
        if (frame.origin === targetOrigin && frame.topOrigin === targetOrigin) {
          frame.hasNewerConfig = true;
          safePost(frame.port, request);
        }
      }
    });
    port.onDisconnect.addListener(() => {
      tabPanels.delete(port);
      if (tabPanels.size === 0 && panels.get(tabId) === tabPanels) {
        panels.delete(tabId);
        waitingArm.delete(tabId);
        // Nobody can get the result, and the page must not keep filling its memory.
        const recording = recordings.get(tabId);
        recordings.delete(tabId);
        if (recording?.type === 'record') {
          const stop = { ...recording, payload: { ...recording.payload, on: false } };
          for (const frame of frames.get(tabId) ?? []) safePost(frame.port, stop);
        }
      }
      sendCaptureToFrames(tabId);
    });
    sendCaptureToFrames(tabId);
    env.wakeTab(tabId);
  };

  return {
    siteChanged() {
      for (const tabId of panels.keys()) toPanels(tabId, { v: PROTOCOL_VERSION, type: 'site-changed', id: ++messageId, payload: {} });
    },
    connect(port) {
      if (port.sender?.id !== env.extensionId) return port.disconnect();
      if (port.name === 'tab') return connectFrame(port);
      const match = /^panel:(\d+)$/.exec(port.name);
      if (match) return connectPanel(port, Number(match[1]));
      port.disconnect();
    },
  };
}
