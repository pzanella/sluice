// A session that plays a recording, with no server. It has the shape of the native objects, and the normal wrappers go on top,
// so rules and the panel work as in a live session. Writes of the app go nowhere (ADR-19).
import { base64ToBytes, type TraceFile } from '../shared/protocol';
import { join, writeQuicVarint } from './moqt/objects';
import { readRequest, type Request } from './moqt/request';
import { readVarint } from './moqt/version';

/** How well a recorded request answers the request of the app now. 0 = not at all. */
function matchScore(recorded: Request, now: Request): number {
  if (recorded.type !== now.type) return 0;
  if (recorded.names !== null || now.names !== null) return recorded.names === now.names ? 3 : 0;
  if (recorded.text !== '' || now.text !== '') return recorded.text === now.text ? 2 : 0;
  return 1;
}

/** A moq-lite group stream starts with type 0, a size, then the subscribe ID. Null if the chunk does not start with a whole header. */
function readGroupHeader(chunk: Uint8Array): { typeEnd: number; id: number; idEnd: number; end: number } | null {
  const type = readVarint(chunk, 0);
  if (!type || type.value !== 0) return null;
  const size = readVarint(chunk, type.next);
  if (!size || size.next + size.value > chunk.length) return null;
  const id = readVarint(chunk, size.next);
  if (!id || id.next > size.next + size.value) return null;
  return { typeEnd: type.next, id: id.value, idEnd: id.next, end: size.next + size.value };
}

/** Puts the subscribe ID of the app in place of the recorded one, in the header of a moq-lite group stream. */
function rewriteGroupHeader(chunk: Uint8Array<ArrayBuffer>, ids: Map<number, number>): Uint8Array<ArrayBuffer> {
  const header = readGroupHeader(chunk);
  const mapped = header ? ids.get(header.id) : undefined;
  if (!header || mapped === undefined || mapped === header.id) return chunk;
  const body = join([writeQuicVarint(mapped), chunk.subarray(header.idEnd, header.end)]);
  return join([chunk.subarray(0, header.typeEnd), writeQuicVarint(body.length), body, chunk.subarray(header.end)]);
}

/** Of the answer on a request stream, kept for an app that asks again. A control answer is small. */
const MAX_GIVEN_BYTES = 64 * 1024;

/** The track in the names of a moq-lite request: broadcast, then a zero byte, then the track. */
const trackOf = (names: string): string => names.slice(names.indexOf('\u0000') + 1);
/** The end of a track name, after its last dot: `avc3` in `1.avc3`. Null with no such end. */
const extOf = (track: string): string | null => {
  const dot = track.lastIndexOf('.');
  return dot > 0 && dot < track.length - 1 ? track.slice(dot + 1) : null;
};

/** The kind of a moq-lite track, from the end of its name: `avc3` in `2.avc3`. Null with no such end. */
function kindOf(names: string): string | null {
  const track = names.slice(names.indexOf('\u0000') + 1);
  const dot = track.lastIndexOf('.');
  return dot > 0 && dot < track.length - 1 ? `${names.slice(0, names.indexOf('\u0000'))}\u0000${track.slice(dot + 1)}` : null;
}

/** How long a recorded group waits for the app to ask for its track, and how many bytes of such groups can wait (ADR-59). */
const HOLD_FOR_REQUEST_MS = 5000;
const MAX_HELD_BYTES = 16 * 1024 * 1024;

/** With no write, a stream of the app gets a recorded stream in the order of opening after this. */
const BIND_WAIT_MS = 300;
/** A request that is not whole yet is taken as it is after this much time with no more writes. */
const SETTLE_MS = 30;

interface ReplayEnv {
  setTimeout(run: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
  now(): number;
  /** Called once, when the last event has played and no close was recorded. The session stays open, so the app holds its last frame. */
  onEnd?: () => void;
}

export interface ReplaySession {
  ready: Promise<void>;
  closed: Promise<WebTransportCloseInfo>;
  draining: Promise<void>;
  datagrams: WebTransportDatagramDuplexStream;
  incomingUnidirectionalStreams: ReadableStream;
  incomingBidirectionalStreams: ReadableStream;
  createBidirectionalStream(): WebTransportBidirectionalStream;
  createUnidirectionalStream(): WritableStream;
  close(info?: WebTransportCloseInfo): void;
  progress(): { elapsedMs: number; totalMs: number; ended: boolean };
}

const makeBytes = (): { stream: ReadableStream<Uint8Array>; controller: ReadableByteStreamController } => {
  let controller!: ReadableByteStreamController;
  const stream = new ReadableStream<Uint8Array>({
    type: 'bytes',
    start(c) {
      controller = c as unknown as ReadableByteStreamController;
    },
  });
  return { stream, controller };
};

export function createReplaySession(trace: TraceFile, env: ReplayEnv): ReplaySession {
  const closeBytes = (controller: ReadableByteStreamController): void => {
    try {
      controller.close();
      controller.byobRequest?.respond(0);
    } catch {
      // The app cancelled it.
    }
  };
  const makeOuter = (): { stream: ReadableStream; controller: ReadableStreamDefaultController } => {
    let controller!: ReadableStreamDefaultController;
    const stream = new ReadableStream({
      start(c) {
        controller = c;
      },
    });
    return { stream, controller };
  };

  const datagram = makeBytes();
  const uni = makeOuter();
  const bidi = makeOuter();
  const open = new Map<number, ReadableByteStreamController>();
  // Streams that the app opened in the recording. It gets them in the same order when it opens streams now. By ID, which is the order
  // of opening: the first answers can come in another order.
  const localIds = new Set<number>();
  for (const event of trace.events) {
    if (event.origin === 'local' && event.streamId !== null) localIds.add(event.streamId);
  }
  // The protocol that the server chose, or the one that the page offered when the server chose none.
  const lite = (trace.protocol || trace.offered || '').startsWith('moq-lite');
  const asked = new Map<number, Uint8Array>();
  for (const event of trace.events) {
    if (event.origin === 'local' && event.streamId !== null && event.sent && !asked.has(event.streamId)) asked.set(event.streamId, base64ToBytes(event.sent));
  }
  interface Slot {
    id: number;
    request: Request | null;
    stream: ReadableStream<Uint8Array>;
    used: boolean;
    /** What the slot has given so far, so an app that asks again for the same thing gets the same answer. */
    given: Uint8Array<ArrayBuffer>[];
    givenBytes: number;
    /** Streams of the app that asked again: they get each new byte too. */
    copies: ReadableByteStreamController[];
    /** The recorded answer is complete: a copy made now ends after what was given. */
    ended: boolean;
  }
  const slots: Slot[] = [];
  for (const id of [...localIds].sort((a, b) => a - b)) {
    const made = makeBytes();
    open.set(id, made.controller);
    const sent = asked.get(id);
    slots.push({ id, request: sent ? readRequest(sent, lite) : null, stream: made.stream, used: false, given: [], givenBytes: 0, copies: [], ended: false });
  }
  const slotById = new Map(slots.map((slot) => [slot.id, slot]));
  /** Recorded subscribe ID to the ID the app uses now, for moq-lite group headers. */
  const ids = new Map<number, number>();
  /**
   * moq-lite: the recorded subscribe IDs that have groups in the recording, with their track when known (ADR-59). A player that
   * starts again often asks first for a quality that the recording has no groups of (it played another one then).
   */
  const media = new Map<number, string | null>();
  if (lite) {
    const seen = new Set<number>();
    for (const event of trace.events) {
      if (event.kind !== 'uni' || event.streamId === null || !event.data || seen.has(event.streamId)) continue;
      seen.add(event.streamId);
      const header = readGroupHeader(base64ToBytes(event.data));
      if (header && !media.has(header.id)) media.set(header.id, null);
    }
    for (const slot of slots) {
      const id = slot.request?.subscribeId;
      const names = slot.request?.names;
      if (id != null && names && media.has(id)) media.set(id, trackOf(names));
    }
    for (const track of trace.summary?.tracks ?? []) if (track.alias !== undefined && media.get(track.alias) === null) media.set(track.alias, track.name);
  }
  /** A recorded subscription with groups, of a track of the same kind (`1.avc3` for `0.avc3`). One that no request has yet comes first. */
  const mediaLike = (names: string): number | null => {
    const kind = extOf(trackOf(names));
    if (kind === null) return null;
    const same = [...media].filter(([, track]) => track !== null && extOf(track) === kind).map(([id]) => id);
    return same.find((id) => !ids.has(id)) ?? same[0] ?? null;
  };
  /** The kind of each subscription of the app now (`avc3`), the newest last. */
  const appKinds = new Map<number, string>();
  /**
   * The newest subscription of the app of the same kind as a recorded track. A recording follows the quality that the player
   * picked then (2.avc3, then 1.avc3): the player now gets all of it on the subscription it has, as it would get from a server
   * that changes quality.
   */
  const sameKind = (recorded: number): number | null => {
    const track = media.get(recorded);
    const kind = track ? extOf(track) : null;
    if (kind === null) return null;
    let found: number | null = null;
    for (const [id, appKind] of appKinds) if (appKind === kind) found = id;
    return found;
  };
  /** Set below: gives the app the groups that waited for its request. */
  let releaseHeld: (recorded: number) => void = () => undefined;
  const pair = (readable: ReadableStream<Uint8Array>, writable: WritableStream = new WritableStream()): WebTransportBidirectionalStream =>
    ({ readable, writable }) as unknown as WebTransportBidirectionalStream;
  /** Streams of the app that wait for a recorded stream, or got none: they close at the end. */
  const waiting = new Set<ReadableByteStreamController>();

  /**
   * The recorded stream for a request of the app (ADR-43, ADR-56). First a free one that answers the same request. If none: the
   * same request again (a player that subscribes again after a recovery), or a track of the same kind (`2.avc3` for `1.avc3`:
   * a player that picks another quality). Both get a copy of the recorded answer, and the groups of the recorded track go to the
   * new subscription.
   */
  const pick = (bytes: Uint8Array | null): { slot: Slot; again: boolean } | null => {
    const free = slots.filter((slot) => !slot.used);
    if (!bytes) {
      const slot = free[0];
      return slot ? { slot, again: false } : null;
    }
    const now = readRequest(bytes, lite);
    let best: Slot | null = null;
    let bestScore = 0;
    for (const slot of free) {
      const score = slot.request ? matchScore(slot.request, now) : 0;
      if (score > bestScore) {
        best = slot;
        bestScore = score;
      }
    }
    let again = false;
    if (!best && now.names !== null) {
      best = slots.find((slot) => slot.used && slot.request?.names === now.names) ?? null;
      again = best !== null;
    }
    if (!best && now.names !== null) {
      const kind = kindOf(now.names);
      const same = slots.filter((slot) => slot.request?.names != null && kind !== null && kindOf(slot.request.names) === kind);
      best = same.find((slot) => !slot.used) ?? same.find((slot) => slot.used) ?? null;
      again = best?.used === true;
    }
    // The recording has no groups for this request: the recorded track of the same kind plays in its place (another quality).
    let instead: number | null = null;
    if (lite && now.names !== null && now.subscribeId !== null) {
      const recorded = best?.request?.subscribeId;
      if (recorded == null || !media.has(recorded)) instead = mediaLike(now.names);
      if (!best && instead !== null) {
        best = slots.find((slot) => slot.request?.subscribeId === instead) ?? null;
        again = best?.used === true;
      }
    }
    const map = (recorded: number): void => {
      if (now.subscribeId === null) return;
      ids.set(recorded, now.subscribeId);
      const kind = now.names === null ? null : extOf(trackOf(now.names));
      if (kind !== null) {
        appKinds.delete(now.subscribeId);
        appKinds.set(now.subscribeId, kind);
      }
      // After the answer on the request stream, as from a server.
      env.setTimeout(() => releaseHeld(recorded), 0);
    };
    if (instead !== null) map(instead);
    if (!best) return null;
    if (best.request?.subscribeId != null && best.request.subscribeId !== instead) map(best.request.subscribeId);
    return { slot: best, again };
  };

  /** A stream of the app: it gets the recorded stream that answers what it writes first (ADR-43). */
  const lazyPair = (): WebTransportBidirectionalStream => {
    let bind!: (source: ReadableStream<Uint8Array> | null) => void;
    const bound = new Promise<ReadableStream<Uint8Array> | null>((resolve) => {
      bind = resolve;
    });
    let chosen = false;
    const choose = (bytes: Uint8Array | null): void => {
      if (chosen) return;
      chosen = true;
      env.clearTimeout(timer);
      const found = pick(bytes);
      if (!found) return bind(null);
      if (!found.again) {
        found.slot.used = true;
        return bind(found.slot.stream);
      }
      // A copy of what the recorded stream gave so far, then each new byte of it.
      const copy = makeBytes();
      for (const chunk of found.slot.given) copy.controller.enqueue(chunk.slice());
      if (found.slot.ended) closeBytes(copy.controller);
      else {
        found.slot.copies.push(copy.controller);
        waiting.add(copy.controller);
      }
      bind(copy.stream);
    };
    const timer = env.setTimeout(() => choose(null), BIND_WAIT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let own: ReadableByteStreamController | null = null;
    const readable = new ReadableStream<Uint8Array>({
      type: 'bytes',
      start(c) {
        own = c as unknown as ReadableByteStreamController;
        waiting.add(own);
      },
      async pull(c) {
        const source = await bound;
        if (!source) return new Promise<void>(() => undefined);
        reader ??= source.getReader();
        const { value, done } = await reader.read();
        if (done) {
          if (own) waiting.delete(own);
          closeBytes(c as unknown as ReadableByteStreamController);
        } else c.enqueue(value as Uint8Array<ArrayBuffer>);
      },
      cancel(reason) {
        if (own) waiting.delete(own);
        return reader?.cancel(reason);
      },
    });
    // An app can write one request in several writes (moq-lite writes the type, then the message). Wait until it is whole.
    let written = new Uint8Array(0);
    let settle: ReturnType<typeof setTimeout> | null = null;
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        if (chosen) return;
        written = join([written, chunk]).slice(0, 4096);
        if (settle !== null) env.clearTimeout(settle);
        const request = readRequest(written, lite);
        if (request.names !== null || written.length >= 4096) choose(written);
        else settle = env.setTimeout(() => choose(written), SETTLE_MS);
      },
    });
    return pair(readable, writable);
  };
  const byRequest = asked.size > 0;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let ended = false;
  let finishClosed!: (info: WebTransportCloseInfo) => void;
  const closed = new Promise<WebTransportCloseInfo>((resolve) => {
    finishClosed = resolve;
  });
  const end = (info: WebTransportCloseInfo): void => {
    if (ended) return;
    ended = true;
    if (timer !== null) env.clearTimeout(timer);
    for (const entry of held.values()) env.clearTimeout(entry.timer);
    held.clear();
    closeBytes(datagram.controller);
    for (const controller of open.values()) closeBytes(controller);
    for (const controller of waiting) closeBytes(controller);
    for (const { controller } of [uni, bidi]) {
      try {
        controller.close();
      } catch {
        // The app cancelled it.
      }
    }
    finishClosed(info);
  };

  /** Streams that got their first bytes: only those carry a group header. */
  const started = new Set<number>();
  /**
   * moq-lite group streams of a recorded subscription that the app has not made now (ADR-59). They wait for it: the start of a
   * recording plays in a few ms, so the first groups can come before the player asked for the track, and a video group lost at
   * the start is a key frame lost. If the app does not ask in time, they never go to it: their subscribe ID can be the ID of
   * another track now (a player that starts on another quality), and the decoder would get two tracks.
   */
  const held = new Map<number, { recorded: number; events: TraceFile['events']; timer: ReturnType<typeof setTimeout> }>();
  let heldBytes = 0;
  /** Group streams that waited too long: the rest of them is dropped too. */
  const unasked = new Set<number>();
  const hold = (id: number, recorded: number, event: TraceFile['events'][number]): void => {
    const size = event.data?.length ?? 0;
    if (heldBytes + size > MAX_HELD_BYTES) {
      if (!event.fin) unasked.add(id);
      return;
    }
    heldBytes += size;
    const timer = env.setTimeout(() => {
      const entry = held.get(id);
      if (!entry) return;
      held.delete(id);
      for (const e of entry.events) heldBytes -= e.data?.length ?? 0;
      if (!entry.events.some((e) => e.fin)) unasked.add(id);
    }, HOLD_FOR_REQUEST_MS);
    held.set(id, { recorded, events: [event], timer });
  };
  /** The app asked for a recorded subscription: its groups that waited go to the app now, in order. */
  const release = (recorded: number): void => {
    if (ended) return;
    for (const [id, entry] of [...held]) {
      if (entry.recorded !== recorded) {
        // A track of the same kind that the app did not ask for goes to its subscription of that kind.
        const target = ids.has(entry.recorded) ? null : sameKind(entry.recorded);
        if (target === null) continue;
        ids.set(entry.recorded, target);
      }
      held.delete(id);
      env.clearTimeout(entry.timer);
      for (const e of entry.events) heldBytes -= e.data?.length ?? 0;
      for (const e of entry.events) play(e);
    }
  };
  releaseHeld = release;
  const play = (event: TraceFile['events'][number]): void => {
    if (event.kind === 'datagram') {
      if (event.data) {
        try {
          datagram.controller.enqueue(base64ToBytes(event.data));
        } catch {
          // The app cancelled it.
        }
      }
      return;
    }
    const id = event.streamId as number;
    if (unasked.has(id)) {
      if (event.fin) unasked.delete(id);
      return;
    }
    const waits = held.get(id);
    if (waits) {
      heldBytes += event.data?.length ?? 0;
      waits.events.push(event);
      return;
    }
    let controller = open.get(id);
    if (!controller && lite && byRequest && event.kind === 'uni') {
      const header = event.data ? readGroupHeader(base64ToBytes(event.data)) : null;
      if (header && !ids.has(header.id)) {
        const target = sameKind(header.id);
        if (target === null) return hold(id, header.id, event);
        ids.set(header.id, target);
      }
    }
    if (!controller) {
      const made = makeBytes();
      controller = made.controller;
      open.set(id, controller);
      try {
        if (event.kind === 'uni') uni.controller.enqueue(made.stream);
        else bidi.controller.enqueue(pair(made.stream));
      } catch {
        // The app cancelled it.
      }
    }
    try {
      if (event.data) {
        let bytes = base64ToBytes(event.data);
        if (lite && ids.size > 0 && event.kind === 'uni' && !started.has(id)) bytes = rewriteGroupHeader(bytes, ids);
        started.add(id);
        const slot = slotById.get(id);
        if (slot) {
          if (slot.givenBytes < MAX_GIVEN_BYTES) {
            slot.given.push(bytes.slice());
            slot.givenBytes += bytes.byteLength;
          }
          for (const copy of slot.copies) {
            try {
              copy.enqueue(bytes.slice());
            } catch {
              // That stream of the app is gone.
            }
          }
        }
        controller.enqueue(bytes);
      }
      if (event.fin) {
        closeBytes(controller);
        // The copies of a request asked again end with the recorded answer.
        const slot = slotById.get(id);
        if (slot) slot.ended = true;
        for (const copy of slot?.copies.splice(0) ?? []) {
          waiting.delete(copy);
          closeBytes(copy);
        }
      }
    } catch {
      // The app cancelled it.
    }
  };

  const start = env.now();
  let next = 0;
  let done = false;
  const totalMs = trace.events.at(-1)?.t ?? 0;
  const step = (): void => {
    timer = null;
    if (ended) return;
    const elapsed = env.now() - start;
    while (next < trace.events.length && (trace.events[next]?.t ?? 0) <= elapsed) {
      play(trace.events[next] as TraceFile['events'][number]);
      next++;
    }
    const upcoming = trace.events[next];
    if (upcoming) {
      timer = env.setTimeout(step, upcoming.t - elapsed);
    } else if (trace.close) {
      const { closeCode, reason, t } = trace.close;
      if (t <= elapsed) end({ closeCode, reason });
      else timer = env.setTimeout(step, t - elapsed);
    } else if (!done) {
      done = true;
      env.onEnd?.();
    }
  };
  // Not now: the app must first get the object.
  timer = env.setTimeout(step, 0);

  return {
    ready: Promise.resolve(),
    closed,
    draining: new Promise<void>(() => undefined),
    datagrams: {
      readable: datagram.stream,
      writable: new WritableStream(),
      maxDatagramSize: 1200,
      incomingMaxAge: null,
      outgoingMaxAge: null,
      incomingHighWaterMark: 1,
      outgoingHighWaterMark: 1,
    } as unknown as WebTransportDatagramDuplexStream,
    incomingUnidirectionalStreams: uni.stream,
    incomingBidirectionalStreams: bidi.stream,
    createBidirectionalStream: () => {
      if (byRequest) return lazyPair();
      // An old recording, with no requests in it: in the order of opening (ADR-33).
      const found = pick(null);
      if (found) found.slot.used = true;
      return pair(found?.slot.stream ?? makeBytes().stream);
    },
    createUnidirectionalStream: () => new WritableStream(),
    close(info) {
      end({ closeCode: info?.closeCode ?? 0, reason: info?.reason ?? '' });
    },
    progress: () => ({ elapsedMs: Math.min(env.now() - start, totalMs), totalMs, ended: done || ended }),
  };
}
