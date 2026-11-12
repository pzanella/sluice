// MAIN side of the bridge: sends runtime events to the ISOLATED script and applies its commands.
// The page can see and forge these events if it finds the nonce. It can then only change its own traffic and send false
// data about itself, so the other side treats all of this as hostile. See the skill `mv3-bridge`.
import { base64ToBytes, bytesToBase64, parseControlMessage, PROTOCOL_LIMITS, TRACE_FORMAT, TRACE_PART_EVENTS, type TraceEvent, type TraceFile, PROTOCOL_VERSION, type ControlMessage, type RuntimeMessage, type TrafficItem } from '../shared/protocol';
import type { PlaybackReport } from './playback';
import type { Runtime, RuntimeEvents, SessionInfo } from './patch';
import type { Recording } from './recorder';

const BATCH_MS = 100;
const MAX_QUEUE_ITEMS = 2000;
const MAX_QUEUE_CHARS = 32 * 1024 * 1024;
const STATS_MS = 1000;
/** How long the first read waits for saved rules. With no answer, traffic passes with no rules. */
const GATE_TIMEOUT_MS = 500;
/** How long held chunks wait for a panel that may come back. */
const HOLD_RELEASE_MS = 1000;
/** Sends a recording below the rate limit of the bridge: 8 events of 64 KiB base64, 5 times per second. */
const RECORD_PART_MS = 200;

/** The page can replace globals later, so these are taken once at install. */
export interface ChannelEnv {
  dispatch(type: string, detail: string): void;
  listen(type: string, handler: (detail: unknown) => void): void;
  setTimeout(run: () => void, ms: number): void;
  setInterval(run: () => void, ms: number): number;
  clearInterval(id: number): void;
  now(): number;
  stringify(value: unknown): string;
  parse(text: string): unknown;
  /** The absolute URL of a session. `new WebTransport` also takes a relative one. */
  absoluteUrl(url: string): string;
}

export function browserEnv(): ChannelEnv {
  const NativeEvent = CustomEvent;
  const dispatchEvent = window.dispatchEvent.bind(window);
  const addEventListener = window.addEventListener.bind(window);
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  const { now } = Date;
  const { stringify, parse } = JSON;
  const NativeURL = URL;
  // Read `detail` through the original getter. A getter that the page puts on CustomEvent.prototype would run here with
  // `this` = our event, and `this.type` holds the nonce.
  const readDetail = Object.getOwnPropertyDescriptor(CustomEvent.prototype, 'detail')?.get;
  const { apply } = Reflect; // Not `.call`: the page can replace Function.prototype.call, and it would get the event.
  return {
    dispatch: (type, detail) => void dispatchEvent(new NativeEvent(type, { detail })),
    listen: (type, handler) => addEventListener(type, (event) => handler(readDetail ? apply(readDetail, event, []) : undefined)),
    setTimeout: (run, ms) => void nativeSetTimeout(run, ms),
    setInterval: (run, ms) => nativeSetInterval(run, ms),
    clearInterval: (id) => nativeClearInterval(id),
    now: () => now(),
    stringify: (value) => stringify(value),
    parse: (text) => parse(text) as unknown,
    absoluteUrl: (url) => new NativeURL(url, document.baseURI).href,
  };
}

type Payload<T extends RuntimeMessage['type']> = Extract<RuntimeMessage, { type: T }>['payload'];

export interface Channel {
  events: RuntimeEvents;
  /** Resolves when the worker has answered, or after a timeout. */
  gate(): Promise<void>;
  attach(runtime: Runtime): void;
  /** Sends a message that is already a JSON string. */
  forward(text: string): void;
  /** Sends one message of this runtime. */
  send<T extends RuntimeMessage['type']>(type: T, payload: Payload<T>): void;
  /** Called with the text of each valid command, after the runtime of this frame applied it. */
  onControl(listener: (text: string, message: ControlMessage) => void): void;
  /** What the player showed in the last second. Sent only while a panel is open (ADR-49). */
  playback(report: PlaybackReport): void;
}

/** `inWorker`: the frame sends a worker only the decisions for its own holds, and a frame has only `workerId` null. */
export function createChannel(nonce: string, env: ChannelEnv, inWorker = false): Channel {
  const toBridge = `sluice:${nonce}:to-bridge`;
  let runtime: Runtime | null = null;
  let capture = false;
  let previewBytes = 0;
  let statsTimer: number | null = null;
  let flushing = false;
  let messageId = 0;
  let captureDropped = 0;
  let queuedChars = 0;
  let holdRelease = 0;
  let replayParts: { id: number; events: TraceEvent[] } | null = null;
  const queue: TrafficItem[] = [];
  const controlListeners: ((text: string, message: ControlMessage) => void)[] = [];
  let openGate: () => void = () => undefined;
  let gateTimerSet = false;
  const gatePromise = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  const send = <T extends RuntimeMessage['type']>(type: T, payload: Payload<T>): void => {
    try {
      env.dispatch(toBridge, env.stringify({ v: PROTOCOL_VERSION, type, id: ++messageId, payload }));
    } catch {
      // The page can break stringify, for example with Object.prototype.toJSON. This must not stop the timers.
    }
  };

  const sendOpen = (session: SessionInfo): void => {
    send('session-open', {
      sessionId: session.id,
      url: env.absoluteUrl(session.url).slice(0, PROTOCOL_LIMITS.url),
      createdAt: session.createdAt,
    });
  };

  const sendMoqt = (session: SessionInfo): void => {
    if (session.moqt) send('moqt-version', { sessionId: session.id, draft: session.moqt.draft, source: session.moqt.source, ...(session.moqt.lite === undefined ? {} : { lite: session.moqt.lite }) });
  };

  const flush = (): void => {
    const items = queue.splice(0, PROTOCOL_LIMITS.batch);
    for (const item of items) queuedChars -= item.preview.length;
    if (items.length > 0) send('traffic', { items });
    if (queue.length > 0) env.setTimeout(flush, BATCH_MS);
    else flushing = false;
  };

  const sendStats = (): void => {
    if (!runtime) return;
    const ruleHits = Array.from(runtime.ruleHits, ([id, count]) => ({ id, count })).slice(0, PROTOCOL_LIMITS.ruleHits);
    const disabledRules = runtime.disabledRules().slice(0, PROTOCOL_LIMITS.ruleHits);
    send('stats', { stats: runtime.stats, ruleHits, captureDropped, disabledRules });
  };

  /** A chunk larger than one message goes in pieces. The app can see any chunk size on a stream. */
  const sendRecording = (recordId: number, recording: Recording): void => {
    const size = PROTOCOL_LIMITS.previewBytes;
    const events: (TraceEvent & { sessionId: number })[] = [];
    for (const { data, sent, ...event } of recording.events) {
      const asked = sent ? { sent: bytesToBase64(sent) } : {};
      if (!data) {
        events.push({ ...event, ...asked, data: null });
        continue;
      }
      for (let at = 0; at < data.byteLength; at += size) {
        events.push({ ...event, ...(at === 0 ? asked : {}), fin: false, data: bytesToBase64(data.subarray(at, at + size)) });
      }
    }
    const count = events.length;
    const next = (): void => {
      const part = events.splice(0, TRACE_PART_EVENTS);
      if (part.length > 0) send('record-part', { recordId, events: part });
      if (events.length > 0) env.setTimeout(next, RECORD_PART_MS);
      else send('record-end', { recordId, count, truncated: recording.truncated, sessions: recording.sessions.slice(0, 256) });
    };
    next();
  };

  const setCapture = (traffic: boolean, bytes: number): void => {
    previewBytes = bytes;
    runtime?.setObjectView?.(traffic);
    // Also when capture is already on: a second panel, or a panel that connects again, must see live sessions too.
    // A panel keeps sessions by id, so a repeat is harmless.
    if (traffic && runtime) {
      for (const session of runtime.sessions.values()) {
        sendOpen(session);
        sendMoqt(session);
        for (const [broadcast, json] of Object.entries(session.catalogs ?? {})) {
          send('moq-catalog', { sessionId: session.id, broadcast: broadcast.slice(0, PROTOCOL_LIMITS.url), json });
        }
      }
    }
    if (traffic) {
      holdRelease++;
      runtime?.setHolding(true);
      runtime?.announceHolds();
    } else if (capture) {
      // After a restart of the service worker, this frame can connect before the panel does, and hear that no panel is open.
      const release = ++holdRelease;
      env.setTimeout(() => {
        if (release === holdRelease) runtime?.setHolding(false);
      }, HOLD_RELEASE_MS);
    }
    if (traffic === capture) return;
    capture = traffic;
    if (traffic) {
      statsTimer = env.setInterval(sendStats, STATS_MS);
    } else {
      queue.length = 0;
      queuedChars = 0;
      if (statsTimer !== null) env.clearInterval(statsTimer);
      statsTimer = null;
    }
  };

  env.listen(`sluice:${nonce}:to-main`, (detail) => {
    try {
      if (typeof detail !== 'string') return;
      const parsed = parseControlMessage(env.parse(detail));
      if (!parsed.ok) return;
      const { value } = parsed;
      if (value.type === 'set-capture') {
        setCapture(value.payload.traffic, value.payload.previewBytes);
        // The worker sends this after any saved rules, so the rules are in place now.
        openGate();
      }
      else if (value.type === 'set-config') runtime?.setConfig(value.payload.config);
      else if (value.type === 'record') {
        if (value.payload.on) runtime?.startRecording();
        else if (runtime) sendRecording(value.payload.recordId, runtime.stopRecording());
      }
      else if (value.type === 'replay-clear') {
        replayParts = null;
        runtime?.armReplay(null);
      }
      else if (value.type === 'replay-arm') {
        const { replayId, url, protocol, offered, end, overlay, close, events, last } = value.payload;
        if (replayParts?.id !== replayId) replayParts = { id: replayId, events: [] };
        replayParts.events.push(...events);
        if (last) {
          const trace: TraceFile = { format: TRACE_FORMAT, version: 1, url, ...(protocol === undefined ? {} : { protocol }), ...(offered === undefined ? {} : { offered }), close, events: replayParts.events };
          replayParts = null;
          runtime?.armReplay(trace, { end: end ?? 'hold', overlay: overlay ?? true });
        }
      }
      else if (value.type === 'connection') {
        // For a worker, the listeners below pass it on.
        if ((value.payload.workerId !== null) === inWorker) runtime?.connection(value.payload.sessionId, value.payload.action);
      }
      else if (value.type === 'inject') {
        // For a worker, the listeners below pass it on.
        if ((value.payload.workerId !== null) === inWorker) {
          const { injectId, sessionId, kind, data } = value.payload;
          const failure = runtime ? runtime.inject(sessionId, kind, base64ToBytes(data)) : 'no-session';
          send('inject-result', { injectId, failure });
        }
      }
      else if ((value.payload.workerId !== null) === inWorker) {
        const { holdId } = value.payload;
        if (value.payload.action === 'edit') runtime?.resolveHold(holdId, { action: 'edit', data: base64ToBytes(value.payload.data) });
        else if (value.payload.action === 'drop') runtime?.resolveHold(holdId, { action: 'drop' });
        else runtime?.resolveHold(holdId, { action: 'forward' });
      }
      for (const listener of controlListeners) listener(detail, value);
    } catch {
      // Not valid JSON. Only a forged event can do this.
    }
  });

  return {
    playback(report) {
      if (capture) send('playback', report);
    },
    attach(next) {
      runtime = next;
    },
    forward(text) {
      env.dispatch(toBridge, text);
    },
    send,
    onControl(listener) {
      controlListeners.push(listener);
    },
    gate() {
      if (!gateTimerSet) {
        gateTimerSet = true;
        // Traffic must never wait for good: with no timer, the gate just stays open.
        try {
          env.setTimeout(openGate, GATE_TIMEOUT_MS);
        } catch {
          openGate();
        }
      }
      return gatePromise;
    },
    events: {
      sessionOpen: sendOpen,
      sessionClosed(session, info) {
        send('session-closed', {
          sessionId: session.id,
          closeCode: info?.closeCode ?? null,
          reason: (info?.reason ?? '').slice(0, PROTOCOL_LIMITS.closeReason),
          at: env.now(),
        });
      },
      streamOpen(session, streamId, kind, origin) {
        if (capture) send('stream-open', { sessionId: session.id, streamId, kind, origin, at: env.now() });
      },
      hold({ holdId, ctx, data, ruleId, timeoutMs, onTimeout }) {
        send('hold', {
          holdId,
          sessionId: ctx.sessionId,
          streamId: ctx.streamId,
          kind: ctx.kind,
          seq: ctx.seq,
          byteLength: data.byteLength,
          data: bytesToBase64(data.subarray(0, PROTOCOL_LIMITS.previewBytes)),
          ruleId: ruleId.slice(0, PROTOCOL_LIMITS.ruleId),
          timeoutMs,
          onTimeout,
        });
      },
      moqtVersion: sendMoqt,
      moqCatalog(session, broadcast, json) {
        if (capture) send('moq-catalog', { sessionId: session.id, broadcast: broadcast.slice(0, PROTOCOL_LIMITS.url), json });
      },
      connectionAction(session, action, streamId) {
        const safe = action.type === 'close-session' ? { ...action, reason: action.reason.slice(0, PROTOCOL_LIMITS.closeReason) } : action;
        send('connection-event', { sessionId: session.id, action: safe, streamId, at: env.now() });
      },
      replayStarted(url) {
        send('replay-started', { url });
      },
      replayEnded(url) {
        send('replay-ended', { url });
      },
      holdEnd(holdId, outcome) {
        send('hold-end', { holdId, outcome });
      },
      chunk(ctx, input, result) {
        if (!capture) return;
        // Video comes in bursts. One batch in the queue lost rows on any burst, so the queue holds many, and the flush sends them in batches.
        if (queue.length >= MAX_QUEUE_ITEMS || queuedChars >= MAX_QUEUE_CHARS) {
          captureDropped++;
          return;
        }
        // What the app gets, or the original if it gets nothing.
        const shown = result.data ?? input;
        const preview = bytesToBase64(shown.subarray(0, previewBytes));
        queuedChars += preview.length;
        queue.push({
          sessionId: ctx.sessionId,
          streamId: ctx.streamId,
          kind: ctx.kind,
          seq: ctx.seq,
          byteLength: input.byteLength,
          outcome: result.data ? 'passed' : 'dropped',
          modified: !ctx.injected && result.data !== null && result.data !== input,
          ...(ctx.injected ? { injected: true as const } : {}),
          ...(ctx.outgoing ? { outgoing: true as const } : {}),
          ...(ctx.moqt ? { moqt: ctx.moqt } : {}),
          delayMs: result.delayMs,
          preview,
          at: env.now(),
        });
        if (!flushing) {
          flushing = true;
          env.setTimeout(flush, BATCH_MS);
        }
      },
    },
  };
}
