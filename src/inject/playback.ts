// What the player shows, next to what the network gives (ADR-49): frames that WebCodecs decoders give back, their errors, and the
// events and quality of <video> elements. Counts only: no frame data leaves the page. Must not import runtime dependencies.

export interface PlaybackReport {
  /** Frames given back by VideoDecoder and AudioDecoder, and frames that <video> elements showed, in this second. */
  videoFrames: number;
  audioFrames: number;
  /** Frames that <video> elements dropped in this second. */
  droppedFrames: number;
  /** The largest decode queue of a decoder in this second. */
  queue: number;
  decoders: { kind: 'video' | 'audio'; codec: string; width?: number; height?: number }[];
  events: { at: number; kind: 'waiting' | 'stalled' | 'playing' | 'media-error' | 'decoder-error'; text: string }[];
}

interface PlaybackEnv {
  now(): number;
  setInterval(run: () => void, ms: number): unknown;
  /** Called once a second when something happened. A failure in here must not reach the page. */
  report(report: PlaybackReport): void;
}

type Scope = {
  VideoDecoder?: new (init: { output: (frame: unknown) => void; error: (error: unknown) => void }) => object;
  AudioDecoder?: new (init: { output: (frame: unknown) => void; error: (error: unknown) => void }) => object;
  document?: Document;
};

const MAX_EVENTS = 20;
const MAX_DECODERS = 8;
const text = (value: unknown): string => {
  try {
    return String(value).slice(0, 200);
  } catch {
    return '';
  }
};

export function installPlayback(scope: Scope, env: PlaybackEnv): void {
  let videoFrames = 0;
  let audioFrames = 0;
  let droppedFrames = 0;
  let events: PlaybackReport['events'] = [];
  const decoders: { kind: 'video' | 'audio'; codec: string; width?: number; height?: number; ref: WeakRef<object> }[] = [];
  const note = (kind: PlaybackReport['events'][number]['kind'], message: string): void => {
    if (events.length < MAX_EVENTS) events.push({ at: env.now(), kind, text: message });
  };

  for (const kind of ['video', 'audio'] as const) {
    const name = kind === 'video' ? 'VideoDecoder' : 'AudioDecoder';
    const Native = scope[name];
    if (typeof Native !== 'function') continue;
    const NativeDecoder = Native;
    // A subclass, as for WebTransport: the object stays native, so its methods work with no bind.
    class SluiceDecoder extends Native {
      constructor(...args: unknown[]) {
        const init = args[0] as { output?: unknown; error?: unknown } | undefined;
        let output: unknown;
        let error: unknown;
        try {
          output = init?.output;
          error = init?.error;
        } catch {
          // A getter of the page threw. The native constructor meets it too.
        }
        if (typeof output !== 'function' || typeof error !== 'function') {
          super(...(args as [never]));
          return;
        }
        const out = output as (frame: unknown) => void;
        const fail = error as (err: unknown) => void;
        super({
          ...(init as object),
          output: (frame: unknown) => {
            if (kind === 'video') videoFrames++;
            else audioFrames++;
            out(frame);
          },
          error: (err: unknown) => {
            note('decoder-error', `${name}: ${text((err as { message?: unknown } | null)?.message ?? err)}`);
            fail(err);
          },
        } as never);
        if (decoders.length < MAX_DECODERS) decoders.push({ kind, codec: '', ref: new WeakRef(this) });
      }

      configure(config: { codec?: unknown; codedWidth?: unknown; codedHeight?: unknown }): void {
        const entry = decoders.find((item) => item.ref.deref() === this);
        if (entry) {
          try {
            entry.codec = text(config?.codec);
            if (typeof config?.codedWidth === 'number') entry.width = config.codedWidth;
            if (typeof config?.codedHeight === 'number') entry.height = config.codedHeight;
          } catch {
            // A getter of the page threw: the native configure meets it too.
          }
        }
        (NativeDecoder.prototype as { configure: (config: unknown) => void }).configure.call(this, config);
      }
    }
    Object.defineProperty(SluiceDecoder, 'name', { value: name, configurable: true });
    try {
      Object.defineProperty(scope, name, { value: SluiceDecoder, writable: true, configurable: true });
    } catch {
      // The page made it read only. Decoders then stay native.
    }
  }

  // Media events do not bubble, but they reach a listener on the document in the capture phase.
  const doc = scope.document;
  const qualities = new WeakMap<HTMLVideoElement, { total: number; dropped: number }>();
  if (doc) {
    for (const type of ['waiting', 'stalled', 'playing', 'error'] as const) {
      doc.addEventListener(
        type,
        (event) => {
          const target = event.target;
          if (!(target instanceof HTMLMediaElement)) return;
          note(type === 'error' ? 'media-error' : type, type === 'error' ? `media error ${text(target.error?.code ?? '')}` : `<${target.localName}> ${type}`);
        },
        true,
      );
    }
  }

  env.setInterval(() => {
    try {
      if (doc) {
        for (const video of Array.from(doc.querySelectorAll('video')).slice(0, 16)) {
          const quality = video.getVideoPlaybackQuality?.();
          if (!quality) continue;
          const before = qualities.get(video) ?? { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames };
          videoFrames += Math.max(0, quality.totalVideoFrames - before.total);
          droppedFrames += Math.max(0, quality.droppedVideoFrames - before.dropped);
          qualities.set(video, { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames });
        }
      }
      let queue = 0;
      const live = decoders.filter((item) => item.ref.deref() !== undefined);
      decoders.length = 0;
      decoders.push(...live);
      for (const item of live) {
        const size = (item.ref.deref() as { decodeQueueSize?: unknown } | undefined)?.decodeQueueSize;
        if (typeof size === 'number') queue = Math.max(queue, size);
      }
      if (videoFrames === 0 && audioFrames === 0 && droppedFrames === 0 && events.length === 0 && live.length === 0) return;
      env.report({
        videoFrames,
        audioFrames,
        droppedFrames,
        queue,
        decoders: live.map(({ kind, codec, width, height }) => ({ kind, codec, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) })),
        events,
      });
    } catch {
      // The report is lost. The page goes on.
    } finally {
      videoFrames = 0;
      audioFrames = 0;
      droppedFrames = 0;
      events = [];
    }
  }, 1000);
}
