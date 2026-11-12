// Replaces WebTransport with a subclass. The instance stays native (created by super), so close(),
// getStats(), ready, closed and the other members work with no change.
// Nothing is exposed on the page global: the channel with the panel is in channel.ts.
import type { PanelConnectionAction } from '../shared/protocol';
import type { HoldOutcome, InjectFailure, InjectKind, ReplayEnd, TraceFile } from '../shared/protocol';
import { DEFAULT_CONFIG, type ConnectionAction, type NetworkStep, type RuntimeConfig } from '../shared/rules';
import { DEFAULT_QUEUE_MS } from '../shared/profiles';
import { DelayBudget, syntheticReceiveStream, wrapByteStream, wrapStreamOfStreams, type StreamMeta } from './byte-stream';
import { createHoldQueue, type HeldChunk } from './hold';
import { OBJECT_DRAFTS } from '../shared/rules';
import { wrapWritable } from './outgoing';
import { createOverlay, type Overlay } from './overlay';
import { createLiteTracker, LITE_VERSIONS, type LiteTracker } from './moqt/lite';
import { createDatagramFramer, createSubgroupFramer, type ObjectFramer, type ObjectUnit } from './moqt/objects';
import { createIetfTracker, type IetfTracker } from './moqt/control';
import { createSetupReader, versionFromOffer, versionFromProtocol, type MoqtVersion } from './moqt/version';
import { createRecorder, type Recording } from './recorder';
import { createReplaySession, type ReplaySession } from './replay';
import { createPipeline, createStats, type ChunkContext, type Pipeline, type PipelineResult, type Stats } from './pipeline';
import { proxyPlatform } from './proxy';

const TAG = '[Sluice]';

export interface SessionInfo {
  id: number;
  url: string;
  createdAt: number;
  /** The protocol that the server chose. */
  protocol?: string;
  /** The MoQ protocol that the page offered, when the server chose none and the version came from the offer. */
  offered?: string;
  /** Absent until it is known. Most sessions are not MoQT. */
  moqt?: MoqtVersion;
  /** What the control messages of moq-lite said so far. */
  lite?: LiteTracker;
  /** The last catalog of each broadcast, as JSON text. */
  catalogs?: Record<string, string>;
}

export interface Runtime {
  /** While a panel looks, new streams of a MoQ session are cut into objects, so it can show them. */
  setObjectView?(on: boolean): void;
  readonly sessions: ReadonlyMap<number, SessionInfo>;
  readonly stats: Stats;
  readonly ruleHits: Pipeline['ruleHits'];
  readonly disabledRules: Pipeline['disabledRules'];
  getConfig(): RuntimeConfig;
  /** Read for each chunk, so changes apply with no reload. */
  setConfig(config: RuntimeConfig): void;
  /** Holds only with a panel open. Turning this off applies the timeout action of each held chunk. */
  setHolding(active: boolean): void;
  announceHolds(): void;
  startRecording(): void;
  stopRecording(): Recording;
  /** The next session to this URL plays the file, with no server. Null clears it. */
  /** Null stops: it also ends the sessions that play now, so the app can go live. */
  armReplay(trace: TraceFile | null, options?: { end: ReplayEnd; overlay: boolean }): void;
  /** Null if the app got it. */
  inject(sessionId: number, kind: InjectKind, data: Uint8Array<ArrayBuffer>): InjectFailure | null;
  /** False if there is no such session or stream. */
  connection(sessionId: number, action: PanelConnectionAction): boolean;
  resolveHold(holdId: number, decision: { action: 'forward' } | { action: 'drop' } | { action: 'edit'; data: Uint8Array<ArrayBuffer> }): void;
  /** Restores the native constructor. Sessions that already exist stay wrapped. */
  uninstall(): void;
}

/** What the channel needs to know. A failure in here must not reach the app or its traffic. */
export interface RuntimeEvents {
  sessionOpen(session: SessionInfo): void;
  sessionClosed(session: SessionInfo, info: WebTransportCloseInfo | null): void;
  streamOpen(session: SessionInfo, streamId: number, kind: 'uni' | 'bidi', origin: 'remote' | 'local'): void;
  chunk(ctx: ChunkContext, input: Uint8Array<ArrayBuffer>, result: PipelineResult): void;
  hold(chunk: HeldChunk): void;
  holdEnd(holdId: number, outcome: HoldOutcome): void;
  replayStarted(url: string): void;
  replayEnded(url: string): void;
  moqtVersion(session: SessionInfo): void;
  moqCatalog(session: SessionInfo, broadcast: string, json: string): void;
  /** A rule or the panel stalled, closed or reset something. `streamId` for a reset. */
  connectionAction(session: SessionInfo, action: ConnectionAction, streamId: number | null): void;
}

interface InstallOptions {
  config?: RuntimeConfig;
  events?: Partial<RuntimeEvents>;
  gate?: () => Promise<void>;
  random?: () => number;
  log?: (message: string) => void;
  /** In a worker with a blob: base URL, a relative session URL must use the URL of the real script. */
  resolveUrl?: (url: string) => string;
}

interface Session extends SessionInfo {
  /** A session that plays a recording: a new recording must not hold it. */
  replaying?: boolean;
  budget: DelayBudget;
  startedAt: number;
  /** The first bidi stream of the client, where a draft before 15 gets its SERVER_SETUP. Set once. */
  firstLocalStream?: number;
  readSetup?: ReturnType<typeof createSetupReader> | null;
  /** Uni streams of a moq-lite session: true for media. */
  mediaStreams?: Map<number, boolean>;
  /** Set when the app first reads this kind of message: before that, there is nothing to add to. */
  injectDatagram?: (data: Uint8Array<ArrayBuffer>) => InjectFailure | null;
  injectUni?: (stream: ReadableStream) => InjectFailure | null;
  /** Track names of an IETF MoQT session, from SUBSCRIBE and SUBSCRIBE_OK (ADR-45). */
  ietf?: IetfTracker;
  /** Until this time (performance.now), the app gets nothing of this session (ADR-41). */
  stallUntil?: number;
  /** Closes the session as the app would. */
  closeNow?: (info: WebTransportCloseInfo) => void;
  /** The network that the timeline set for this session (ADR-47). */
  network?: NetworkStep;
  /** When the link of a bandwidth cap is free again, in performance.now (ADR-48). */
  linkFreeAt?: number;
  /** Timers of the timeline, cleared when the session closes. */
  timeline?: ReturnType<typeof setTimeout>[];
}

type Scope = { WebTransport?: typeof WebTransport };

export function install(scope: Scope = globalThis as Scope, options: InstallOptions = {}): Runtime | null {
  const Native = scope.WebTransport;
  if (typeof Native !== 'function') return null;

  const nativeDescriptor = Object.getOwnPropertyDescriptor(scope, 'WebTransport');
  // Taken now, so a page that replaces it later cannot change what the panel does.
  const nativeClose = Native.prototype.close as (info?: WebTransportCloseInfo) => void;
  let config = options.config ?? structuredClone(DEFAULT_CONFIG);
  const getConfig = (): RuntimeConfig => config;
  const rawLog = options.log ?? ((message: string) => console.log(TAG, message));
  // The page can replace console.log. A log that throws must not reach the app.
  const log = (message: string): void => {
    try {
      rawLog(message);
    } catch {
      // Nothing to do: the log is lost.
    }
  };
  const stats = createStats();
  const receivePrototype = (scope as { WebTransportReceiveStream?: { prototype: object } }).WebTransportReceiveStream?.prototype;
  // Taken now: the page can replace these later. A page that breaks its own timers before this only harms itself.
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const emitHold = (send: (events: Partial<RuntimeEvents>) => void): void => {
    try {
      if (options.events) send(options.events);
    } catch (err) {
      log(`event failed: ${String(err)}`);
    }
  };
  const nowMs = performance.now.bind(performance);
  const recorder = createRecorder(nowMs);
  let armed: { trace: TraceFile; end: ReplayEnd; overlay: boolean; played: boolean } | null = null;
  const playingNow = new Set<ReplaySession>();
  /** One box on the page for all replays, so a new session of the app does not add a second box. */
  let pageOverlay: Overlay | null = null;
  /** The newest replay session: only it writes to the box. */
  let latest: ReplaySession | null = null;
  const holds = createHoldQueue({
    announce: (chunk) => emitHold((events) => events.hold?.(chunk)),
    ended: (holdId, outcome) => emitHold((events) => events.holdEnd?.(holdId, outcome)),
    setTimeout: nativeSetTimeout,
    clearTimeout: nativeClearTimeout,
    now: performance.now.bind(performance),
  });
  const pipeline = createPipeline({
    getConfig,
    stats,
    random: options.random ?? Math.random,
    log,
    canHold: holds.accepting,
    networkFor: (sessionId) => sessions.get(sessionId)?.network,
  });
  const sessions = new Map<number, Session>();
  let sessionSeq = 0;
  let objectView = false;
  /** Sessions that play a recording with a box on the page, by session ID. */
  const overlays = new Map<number, Overlay>();
  let streamSeq = 0;

  const emit = (send: (events: Partial<RuntimeEvents>) => void): void => {
    if (!options.events) return;
    try {
      send(options.events);
    } catch (err) {
      log(`event failed: ${String(err)}`);
    }
  };

  /** Puts the track name on each object, so rules and the panel can use it (ADR-45). */
  const withNames = (framer: ObjectFramer, tracker: IetfTracker): ObjectFramer => {
    const name = (units: ObjectUnit[]): ObjectUnit[] => {
      for (const unit of units) {
        if (unit.moqt && unit.moqt.track === undefined) {
          const track = tracker.nameOf(unit.moqt.trackAlias);
          if (track !== undefined) unit.moqt.track = track;
        }
      }
      return units;
    };
    return { push: (chunk) => name(framer.push(chunk)), end: () => name(framer.end()) };
  };

  const foundMoqt = (session: Session, version: MoqtVersion): void => {
    session.moqt = version;
    if (version.lite !== undefined && LITE_VERSIONS.has(version.lite)) {
      session.lite = createLiteTracker(version.lite, (broadcast, json) => {
        session.catalogs = { ...session.catalogs, [broadcast]: json };
        emit((events) => events.moqCatalog?.(session, broadcast, json));
      });
    }
    else if (version.draft !== null && OBJECT_DRAFTS.has(version.draft)) session.ietf = createIetfTracker(version.draft);
    session.readSetup = null;
    if (config.log.session) log(`session #${session.id} is MoQT ${version.draft === null ? 'final' : `draft ${version.draft}`}`);
    emit((events) => events.moqtVersion?.(session));
  };

  const wrapBytes = (
    native: ReadableStream,
    meta: StreamMeta,
    budget: DelayBudget,
    exposeInject?: (inject: (data: Uint8Array<ArrayBuffer>) => InjectFailure | null) => void,
  ): ReadableStream<Uint8Array> =>
    wrapByteStream(native, meta, {
      ...(exposeInject ? { exposeInject } : {}),
      onConnection: (ctx, action) => {
        const session = sessions.get(ctx.sessionId);
        if (!session) return;
        if (action.type === 'close-session') closeSession(session, action.closeCode, action.reason);
        else if (action.type === 'reset-stream' && ctx.streamId !== null) emit((events) => events.connectionAction?.(session, action, ctx.streamId));
      },
      onRaw: (data, fin) => {
        const session = sessions.get(meta.sessionId);
        if (session?.lite && data && meta.kind === 'bidi' && meta.streamId !== null) session.lite.received(meta.streamId, data);
        if (session && data && session.readSetup && meta.streamId === session.firstLocalStream) {
          const parsed = session.readSetup(data);
          if (parsed !== 'more') session.readSetup = null;
          if (typeof parsed === 'object') foundMoqt(session, parsed);
        }
        if (session?.ietf && data && meta.kind === 'bidi' && meta.origin === 'local' && meta.streamId !== null) session.ietf.received(meta.streamId, data);
        if (session) {
          // On its first bytes, a uni stream of a MoQ session says if it is media (ADR-35).
          let media = false;
          if (meta.kind === 'uni' && meta.streamId !== null && session.lite) {
            const seen = session.mediaStreams?.get(meta.streamId);
            if (seen === undefined && data) {
              media = session.lite.isMedia(data) ?? false;
              (session.mediaStreams ??= new Map()).set(meta.streamId, media);
            } else media = seen ?? false;
            if (fin) session.mediaStreams?.delete(meta.streamId);
          }
          if (!session.replaying) recorder.add(session, { kind: meta.kind, streamId: meta.streamId, origin: meta.origin, data, fin }, media);
        }
      },
      run: runWithStall,
      framer: () => {
        const session = sessions.get(meta.sessionId);
        const draft = session?.moqt?.draft;
        if (meta.kind === 'bidi') return null;
        // Only when something needs it: cutting into objects holds bytes back until each object is complete.
        // A recording counts groups and frames for its summary (ADR-37).
        if (!objectView && !recorder.on && !overlays.has(meta.sessionId) && !config.rules.some((rule) => rule.enabled !== false && rule.match?.moqt)) return null;
        if (session?.lite) return meta.kind === 'uni' ? session.lite.groupFramer() : null;
        if (draft === null || draft === undefined || !OBJECT_DRAFTS.has(draft)) return null;
        const framer = meta.kind === 'datagram' ? createDatagramFramer(draft) : createSubgroupFramer(draft);
        return session?.ietf ? withNames(framer, session.ietf) : framer;
      },
      onChunk: (byteLength) => {
        stats[meta.kind].chunks++;
        stats[meta.kind].bytes += byteLength;
      },
      onResult: (ctx, input, result) => {
        if (ctx.moqt && overlays.has(ctx.sessionId)) overlays.get(ctx.sessionId)?.note(ctx.moqt);
        if (ctx.moqt && recorder.on && !ctx.injected) recorder.note(ctx.sessionId, ctx, ctx.moqt, input.byteLength);
        emit((events) => events.chunk?.(ctx, input, result));
      },
      maxDelayedBytes: () => queueLimit(meta.sessionId),
      budget,
      hold: (ctx, data, offer) => {
        const { decision, cancel } = holds.hold(ctx, data, offer);
        return {
          cancel,
          decision: decision.then((result) => {
            if (result.action === 'edit') stats[ctx.kind].modified++;
            if (result.action === 'drop') stats[ctx.kind].dropped++;
            return result;
          }),
        };
      },
      ...(options.gate ? { gate: options.gate } : {}),
      preserveOrder: () => config.datagram.preserveOrder,
    });

  const wrapSend = (native: WritableStream, meta: { kind: ChunkContext['kind']; sessionId: number; url: string; streamId: number | null; origin: 'remote' | 'local' }): WritableStream =>
    wrapWritable(native, meta, {
      run: pipeline.run,
      onChunk: (byteLength) => {
        stats[meta.kind].chunks++;
        stats[meta.kind].bytes += byteLength;
      },
      onResult: (ctx, input, result) => {
        emit((events) => events.chunk?.(ctx, input, result));
        const session = sessions.get(ctx.sessionId);
        if (session && result.connection?.type === 'close-session') closeSession(session, result.connection.closeCode, result.connection.reason);
      },
      onSent: (data) => {
        if (meta.kind !== 'bidi' || meta.streamId === null) return;
        sessions.get(meta.sessionId)?.lite?.sent(meta.streamId, data);
        sessions.get(meta.sessionId)?.ietf?.sent(meta.streamId, data);
        if (meta.origin === 'local') recorder.sent(meta.sessionId, meta.streamId, data);
      },
      hold: (ctx, data, offer) => {
        const { decision, cancel } = holds.hold(ctx, data, offer);
        return {
          cancel,
          decision: decision.then((result) => {
            if (result.action === 'edit') stats[ctx.kind].modified++;
            if (result.action === 'drop') stats[ctx.kind].dropped++;
            return result;
          }),
        };
      },
    });

  const newStreamId = (kind: 'uni' | 'bidi', origin: string, session: Session): number => {
    const id = ++streamSeq;
    stats[kind].streams++;
    if (config.log.session) log(`sess=${session.id} new ${kind} stream #${id} (${origin})`);
    emit((events) => events.streamOpen?.(session, id, kind, origin === 'local' ? 'local' : 'remote'));
    return id;
  };

  const wrapReceive = (stream: ReadableStream, session: Session): ReadableStream => {
    if (!config.enabled) return stream;
    const streamId = newStreamId('uni', 'remote', session);
    return wrapBytes(stream, { kind: 'uni', origin: 'remote', sessionId: session.id, url: session.url, streamId }, session.budget);
  };

  const wrapBidi = (
    stream: WebTransportBidirectionalStream,
    session: Session,
    origin: 'remote' | 'local',
  ): WebTransportBidirectionalStream => {
    if (!config.enabled) return stream;
    const streamId = newStreamId('bidi', origin, session);
    // So a replay gives the app its streams in the same order, also those with no answer.
    if (origin === 'local' && !session.replaying) recorder.add(session, { kind: 'bidi', streamId, origin, data: null, fin: false });
    if (origin === 'local' && session.firstLocalStream === undefined && !session.moqt) {
      session.firstLocalStream = streamId;
      session.readSetup = createSetupReader();
    }
    let readable: ReadableStream | undefined;
    let writable: WritableStream | undefined;
    return proxyPlatform(stream, {
      // On first access, so the native side stays unlocked until the app uses it.
      writable: () =>
        (writable ??= config.enabled
          ? wrapSend(stream.writable, { kind: 'bidi', origin, sessionId: session.id, url: session.url, streamId })
          : stream.writable),
      readable: () =>
        (readable ??= config.enabled
          ? wrapBytes(stream.readable, { kind: 'bidi', origin, sessionId: session.id, url: session.url, streamId }, session.budget)
          : stream.readable),
    });
  };

  // With no query: a token there can change on each start of the app, and it is not the place that the app goes to.
  const sameUrl = (a: string, b: string): boolean => {
    try {
      const one = new URL(a, globalThis.location?.href);
      const two = new URL(b);
      return one.origin === two.origin && one.pathname === two.pathname;
    } catch {
      return false;
    }
  };

  const stall = (session: Session, durationMs: number): void => {
    const now = nowMs();
    // A match during a stall does not make it longer: a rule that matches each chunk would stall for ever.
    if ((session.stallUntil ?? 0) > now) return;
    session.stallUntil = now + durationMs;
    emit((events) => events.connectionAction?.(session, { type: 'stall', durationMs }, null));
  };
  const closeSession = (session: Session, closeCode: number, reason: string): void => {
    emit((events) => events.connectionAction?.(session, { type: 'close-session', closeCode, reason }, null));
    try {
      session.closeNow?.({ closeCode, reason });
    } catch (err) {
      log(`close failed: ${String(err)}`);
    }
  };
  /** The steps of the timeline of the config, from the open of this session (ADR-47). */
  const startTimeline = (session: Session): void => {
    const begin = (): void => {
      const steps = config.enabled ? config.timeline : undefined;
      if (!steps || steps.length === 0 || !sessions.has(session.id)) return;
      // Times count from the open of the session, also when the saved rules came a little later.
      const elapsed = nowMs() - session.startedAt;
      session.timeline = steps.map((step) =>
        nativeSetTimeout(() => {
          if (!sessions.has(session.id)) return;
          const { action } = step;
          if (action.type === 'stall') {
            session.stallUntil = 0;
            stall(session, action.durationMs);
          } else if (action.type === 'close-session') closeSession(session, action.closeCode, action.reason);
          else {
            session.network = { dropRate: action.dropRate, delayMs: action.delayMs, jitterMs: action.jitterMs, ...(action.kbps === undefined ? {} : { kbps: action.kbps }) };
            emit((events) => events.connectionAction?.(session, action, null));
          }
        }, Math.max(0, step.atMs - elapsed)),
      );
    };
    // At page load the saved rules can come after the first session opens. The gate waits for them, with a timeout.
    if (options.gate) options.gate().then(begin, begin);
    else begin();
  };

  /**
   * Bytes a session holds before it stops reading the network. With a cap, about 2 s of the link, so the flow control of the
   * browser slows the server as a real slow link would, and the delay does not grow for minutes (ADR-48).
   */
  const queueLimit = (sessionId: number): number => {
    const session = sessions.get(sessionId);
    const kbps = session?.network ? session.network.kbps : config.bandwidth?.kbps;
    if (kbps === undefined) return config.maxDelayedBytes;
    return Math.min(config.maxDelayedBytes, Math.max(64 * 1024, kbps * 125 * 2));
  };

  /** The pipeline, then a stall: chunks that come during a stall wait for its end, in order. Not what the app sends. */
  const runWithStall = (ctx: ChunkContext): PipelineResult => {
    const result = pipeline.run(ctx);
    const session = sessions.get(ctx.sessionId);
    if (!session || ctx.outgoing) return result;
    if (result.connection?.type === 'stall') stall(session, result.connection.durationMs);
    let out = result;
    // A cap: each chunk takes its time on the link, after the chunks before it. A datagram that would wait too long is lost.
    const kbps = session.network ? session.network.kbps : config.bandwidth?.kbps;
    if (kbps !== undefined && kbps > 0 && out.data) {
      const now = nowMs();
      const start = Math.max(now, session.linkFreeAt ?? 0);
      const queued = start - now;
      const queueMs = config.bandwidth?.queueMs ?? DEFAULT_QUEUE_MS;
      if (ctx.kind === 'datagram' && queued > queueMs) {
        stats.datagram.dropped++;
        return { data: null, delayMs: 0 };
      }
      session.linkFreeAt = start + (out.data.byteLength * 8) / kbps;
      out = { ...out, delayMs: out.delayMs + (session.linkFreeAt - now) };
    }
    const left = (session.stallUntil ?? 0) - nowMs();
    return left > 0 && out.data ? { ...out, delayMs: Math.max(out.delayMs, left) } : out;
  };

  class SluiceWebTransport extends Native {
    #session: Session;
    #datagrams?: WebTransportDatagramDuplexStream;
    #uni?: ReadableStream;
    #bidi?: ReadableStream;
    #replay?: ReplaySession;
    #overlay?: Overlay | null;

    // Rest arguments: with no arguments the native constructor throws its own TypeError.
    constructor(...args: [url: string | URL, options?: WebTransportOptions]) {
      // Convert once: a page object with a stateful toString() must not give a second, different URL.
      // A template literal throws TypeError on a Symbol, as native does. String() does not.
      if (args.length > 0) {
        const text = `${args[0] as string}`;
        args[0] = options.resolveUrl ? options.resolveUrl(text) : text;
      }
      const url = String(args[0]);
      // Read once: this is a page object.
      let offered: unknown;
      try {
        offered = (args[1] as { protocols?: unknown } | undefined)?.protocols;
      } catch {
        // A getter of the page threw. The native constructor will meet it too.
      }
      // A port with no server: this class needs a native object, and a replay must not reach the real server.
      const plan = armed && sameUrl(url, armed.trace.url) ? armed : null;
      // With `hold`, a new session (the user starts the player again) plays the recording from the start, and holds at the end again.
      const playing = plan ? plan.trace : null;
      super(...(playing ? (['https://127.0.0.1:9/'] as [string]) : args));
      // Another tool can patch WebTransport before Sluice, with a function that returns a native object. This object then has
      // the native prototype, so the getters and methods of this class never run: a session with no streams.
      const prototype = new.target.prototype as object;
      if (Object.getPrototypeOf(this) !== prototype) Object.setPrototypeOf(this, prototype);
      if (playing && plan) {
        const first = !plan.played;
        plan.played = true;
        if (plan.end === 'live') armed = null;
        super.ready.catch(() => undefined);
        super.closed.catch(() => undefined);
        if (plan.overlay && !pageOverlay && typeof document !== 'undefined') pageOverlay = createOverlay(document, nativeSetTimeout);
        const overlay = plan.overlay ? pageOverlay : null;
        overlay?.reset();
        let progressTimer: ReturnType<typeof setTimeout> | null = null;
        const replay = createReplaySession(playing, {
          setTimeout: nativeSetTimeout,
          clearTimeout: nativeClearTimeout,
          now: nowMs,
          onEnd: () => {
            emit((events) => events.replayEnded?.(playing.url));
            const { totalMs } = replay.progress();
            if (latest === replay) overlay?.progress(totalMs, totalMs, true);
          },
        });
        playingNow.add(replay);
        latest = replay;
        this.#replay = replay;
        this.#overlay = overlay;
        if (overlay) {
          const tick = (): void => {
            // A newer session of the app has the box now.
            if (latest !== replay) return;
            const { elapsedMs, totalMs, ended } = replay.progress();
            overlay.progress(elapsedMs, totalMs, ended);
            if (!ended) progressTimer = nativeSetTimeout(tick, 500);
          };
          tick();
        }
        replay.closed.then(() => {
          playingNow.delete(replay);
          if (progressTimer !== null) nativeClearTimeout(progressTimer);
          if (playingNow.size === 0 && pageOverlay) {
            pageOverlay.remove();
            pageOverlay = null;
          }
        }, () => undefined);
        // On this instance only, so a live session has no more members than before (invariant 1).
        const own = (name: string, value: unknown): void => void Object.defineProperty(this, name, { value, configurable: true });
        own('ready', replay.ready);
        own('closed', replay.closed);
        own('draining', replay.draining);
        own('close', (info?: WebTransportCloseInfo) => replay.close(info));
        own('createUnidirectionalStream', () => Promise.resolve(replay.createUnidirectionalStream()));
        own('protocol', playing.protocol ?? '');
        // A player asks for numbers about the connection. The native object has failed, so it would throw.
        own('getStats', () => Promise.resolve({ timestamp: nowMs(), bytesSent: 0, packetsSent: 0, packetsLost: 0, smoothedRtt: 0, rttVariation: 0, minRtt: 0, numOutgoingStreamsCreated: 0, numIncomingStreamsCreated: 0, estimatedSendRate: null }));
        // Another tool that patched WebTransport first can leave its own method here. It calls the native object, which goes nowhere in a replay.
        Reflect.deleteProperty(this, 'createBidirectionalStream');
        if (first) emit((events) => events.replayStarted?.(playing.url));
      }
      const session: Session = { id: ++sessionSeq, url, createdAt: Date.now(), budget: new DelayBudget(), startedAt: nowMs() };
      this.#session = session;
      if (this.#replay) session.replaying = true;
      sessions.set(session.id, session);
      // The close of this class: a replay has its own, and a page that replaces close() later does not change this one.
      const replayNow = this.#replay;
      session.closeNow = replayNow ? (info) => replayNow.close(info) : (info) => Reflect.apply(nativeClose, this, [info]);
      const box = this.#overlay;
      if (box) {
        overlays.set(session.id, box);
        this.#replay?.closed.then(() => overlays.delete(session.id), () => undefined);
      }
      // That tool can also put its own method on the object, which hides the method of this class. Keep it in the path of the data.
      const foreignUni = playing ? undefined : (Object.getOwnPropertyDescriptor(this, 'createUnidirectionalStream')?.value as unknown);
      if (typeof foreignUni === 'function') {
        const value = async (...rest: unknown[]): Promise<WritableStream> => {
          const stream = (await Reflect.apply(foreignUni, this, rest)) as WritableStream;
          if (!config.enabled) return stream;
          const streamId = newStreamId('uni', 'local', session);
          return wrapSend(stream, { kind: 'uni', origin: 'local', sessionId: session.id, url: session.url, streamId });
        };
        Object.defineProperty(this, 'createUnidirectionalStream', { value, writable: true, configurable: true });
      }
      const foreign = playing ? undefined : (Object.getOwnPropertyDescriptor(this, 'createBidirectionalStream')?.value as unknown);
      if (typeof foreign === 'function') {
        const value = async (...rest: unknown[]): Promise<WebTransportBidirectionalStream> => {
          const stream = (await Reflect.apply(foreign, this, rest)) as WebTransportBidirectionalStream;
          return config.enabled && config.wrapLocalBidi ? wrapBidi(stream, session, 'local') : stream;
        };
        Object.defineProperty(this, 'createBidirectionalStream', { value, writable: true, configurable: true });
      }

      const logSession = (message: string): void => {
        if (config.log.session) log(`session #${session.id} ${message}`);
      };
      logSession(`-> ${session.url}`);
      emit((events) => events.sessionOpen?.(session));
      // Our own handlers: they do not touch the handlers of the app and never cause unhandledrejection.
      this.ready.then(
        () => {
          logSession('ready');
          // Read only now: the server chooses it.
          const protocol = (this as unknown as { protocol?: unknown }).protocol;
          if (typeof protocol === 'string' && protocol !== '') session.protocol = protocol;
          const chosen = versionFromProtocol(protocol);
          const version = chosen ?? versionFromOffer(offered);
          if (!chosen && version && Array.isArray(offered)) {
            const named = offered.find((item): item is string => typeof item === 'string' && versionFromProtocol(item) !== null);
            if (named) session.offered = named;
          }
          if (version) foundMoqt(session, version);
        },
        () => undefined,
      );
      this.closed
        .then(
          (info) => {
            logSession('closed');
            recorder.sessionClosed(session, info);
            emit((events) => events.sessionClosed?.(session, info));
          },
          () => {
            logSession('closed with error');
            recorder.sessionClosed(session, { closeCode: 0, reason: '' });
            emit((events) => events.sessionClosed?.(session, null));
          },
        )
        .finally(() => {
          for (const timer of session.timeline ?? []) nativeClearTimeout(timer);
          sessions.delete(session.id);
        });
      startTimeline(session);
    }

    override get datagrams(): WebTransportDatagramDuplexStream {
      if (!this.#datagrams) {
        const native = this.#replay ? this.#replay.datagrams : super.datagrams;
        if (!config.enabled) return (this.#datagrams = native);
        const session = this.#session;
        let readable: ReadableStream | undefined;
        let writable: WritableStream | undefined;
        const datagramMeta = { kind: 'datagram' as const, origin: 'local' as const, sessionId: session.id, url: session.url, streamId: null };
        this.#datagrams = proxyPlatform(native, {
          writable: () => (writable ??= config.enabled ? wrapSend(native.writable, datagramMeta) : native.writable),
          // The newer API: each call gives a stream of its own.
          ...(typeof (native as unknown as { createWritable?: unknown }).createWritable === 'function'
            ? {
                createWritable: () => (...args: unknown[]) => {
                  const made = (native as unknown as { createWritable(...a: unknown[]): WritableStream }).createWritable(...args);
                  return config.enabled ? wrapSend(made, datagramMeta) : made;
                },
              }
            : {}),
          readable: () =>
            (readable ??= config.enabled
              ? wrapBytes(
                  native.readable,
                  { kind: 'datagram', origin: 'remote', sessionId: session.id, url: session.url, streamId: null },
                  session.budget,
                  (inject) => {
                    session.injectDatagram = inject;
                  },
                )
              : native.readable),
        });
      }
      return this.#datagrams;
    }

    override get incomingUnidirectionalStreams(): ReadableStream {
      if (!this.#uni) {
        const native = this.#replay ? this.#replay.incomingUnidirectionalStreams : super.incomingUnidirectionalStreams;
        const session = this.#session;
        this.#uni = config.enabled
          ? wrapStreamOfStreams(native, (stream) => wrapReceive(stream, session), (inject) => {
              session.injectUni = inject;
            })
          : native;
      }
      return this.#uni;
    }

    override get incomingBidirectionalStreams(): ReadableStream {
      if (!this.#bidi) {
        const native = this.#replay ? this.#replay.incomingBidirectionalStreams : super.incomingBidirectionalStreams;
        const session = this.#session;
        this.#bidi = config.enabled
          ? wrapStreamOfStreams(native, (stream: WebTransportBidirectionalStream) => wrapBidi(stream, session, 'remote'))
          : native;
      }
      return this.#bidi;
    }

    override async createUnidirectionalStream(streamOptions?: WebTransportSendStreamOptions): Promise<WritableStream> {
      const stream = (await super.createUnidirectionalStream(streamOptions)) as WritableStream;
      if (!config.enabled || this.#replay) return stream;
      const streamId = newStreamId('uni', 'local', this.#session);
      return wrapSend(stream, { kind: 'uni', origin: 'local', sessionId: this.#session.id, url: this.#session.url, streamId });
    }

    override async createBidirectionalStream(
      streamOptions?: WebTransportSendStreamOptions,
    ): Promise<WebTransportBidirectionalStream> {
      const stream = this.#replay ? this.#replay.createBidirectionalStream() : await super.createBidirectionalStream(streamOptions);
      return config.enabled && config.wrapLocalBidi ? wrapBidi(stream, this.#session, 'local') : stream;
    }
  }

  // Keep the public name and the argument count. WebTransport.toString() looks native, but
  // Function.prototype.toString.call(WebTransport) still shows this class.
  Object.defineProperty(SluiceWebTransport, 'name', { value: Native.name, configurable: true });
  Object.defineProperty(SluiceWebTransport, 'length', { value: Native.length, configurable: true });
  Object.defineProperty(SluiceWebTransport, 'toString', {
    value: () => Function.prototype.toString.call(Native),
    configurable: true,
  });

  const define = (descriptor: PropertyDescriptor | undefined, value: unknown): void => {
    Object.defineProperty(scope, 'WebTransport', descriptor ? { ...descriptor, value } : { value, writable: true, configurable: true });
  };
  define(nativeDescriptor, SluiceWebTransport);

  return {
    setObjectView: (on: boolean) => {
      objectView = on;
    },
    sessions,
    stats,
    ruleHits: pipeline.ruleHits,
    disabledRules: pipeline.disabledRules,
    getConfig,
    setConfig(next) {
      config = next;
    },
    setHolding: holds.setActive,
    announceHolds: holds.announceAll,
    startRecording: () => recorder.start(),
    stopRecording: () => recorder.stop(),
    armReplay(trace, options = { end: 'hold', overlay: true }) {
      armed = trace ? { trace, ...options, played: false } : null;
      if (!trace) for (const replay of [...playingNow]) replay.close({ closeCode: 0, reason: 'Sluice stopped the replay' });
    },
    inject(sessionId, kind, data) {
      const session = sessions.get(sessionId);
      if (!session) return 'no-session';
      if (kind === 'datagram') {
        if (!session.injectDatagram) return 'not-read';
        return session.injectDatagram(data);
      }
      if (!session.injectUni) return 'not-read';
      // A copy: the stream takes the buffer, and the list must show it only if the app can get it.
      const failure = session.injectUni(syntheticReceiveStream(data.slice(), receivePrototype));
      if (failure) return failure;
      // Not in the stats: the counters are about the network (ADR-17).
      const streamId = ++streamSeq;
      emit((events) => events.streamOpen?.(session, streamId, 'uni', 'remote'));
      const ctx: ChunkContext = { kind: 'uni', origin: 'remote', sessionId, url: session.url, streamId, seq: 0, data, injected: true };
      emit((events) => events.chunk?.(ctx, data, { data, delayMs: 0 }));
      return null;
    },
    connection(sessionId, action) {
      const session = sessions.get(sessionId);
      if (!session) return false;
      if (action.type === 'stall') {
        session.stallUntil = 0;
        stall(session, action.durationMs);
        return true;
      }
      closeSession(session, action.closeCode, action.reason);
      return true;
    },
    resolveHold: holds.resolve,
    uninstall() {
      define(nativeDescriptor, Native);
    },
  };
}
