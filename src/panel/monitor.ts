// The Monitor view: what each MoQ track did over the last minutes, and the problems that the app saw (ADR-42).
// It works on what reaches the panel, which is a sample under heavy load. All names come from the page: show them as text only.
import type { ConnectionAction } from '../shared/rules';

export const MONITOR_SECONDS = 120;
const MAX_EVENTS = 300;
/** Intervals between frames kept for the pause threshold. */
const INTERVALS = 50;
const LAG_WINDOW_MS = 30_000;
const MAX_LAGS = 2000;

/**
 * Video ahead of audio in the stream, in ms (negative: behind): the media time of the last video frame minus the one of the last
 * audio frame. A player has to buffer the one ahead, so a large value is drift that the player sees (ADR-50).
 */
export const avOffsetMs = (video: MonitorTrack | undefined, audio: MonitorTrack | undefined): number | null =>
  video?.lastMediaUs != null && audio?.lastMediaUs != null ? Math.round((video.lastMediaUs - audio.lastMediaUs) / 1000) : null;

export interface MonitorThresholds {
  /** A track with no frame for this long has a pause. At least 4 times its usual interval between frames. */
  pauseMs: number;
  /** Key frames further apart than this are late. 0 = no check. */
  keyIntervalMs: number;
}

export const DEFAULT_THRESHOLDS: MonitorThresholds = { pauseMs: 1000, keyIntervalMs: 5000 };

interface TrackSecond {
  second: number;
  bytes: number;
  frames: number;
  groups: number;
  keyframes: number;
  dropped: number;
}

type MonitorEventKind = 'gap' | 'pause' | 'late-key' | 'key-dropped' | 'network' | 'stall' | 'close-session' | 'reset-stream' | 'session-closed';

export interface MonitorEvent {
  at: number;
  kind: MonitorEventKind;
  /** Null for an event of the whole session. */
  track: string | null;
  text: string;
}

export interface MonitorTrack {
  name: string;
  seconds: TrackSecond[];
  frames: number;
  lastAt: number | null;
  lastGroup: number | null;
  lastKeyAt: number | null;
  keyIntervals: number[];
  intervals: number[];
  gaps: number;
  pauses: number;
  lateKeys: number;
  /** Key frames that a rule dropped: the app never got them. */
  keysDropped: number;
  /** The timestamp of the last frame, from the frame itself, in microseconds. */
  lastMediaUs: number | null;
  /** Arrival time minus media time, for the last 30 s: the lowest is when the track was most on time (ADR-50). */
  lags: { at: number; lag: number }[];
  /** How much later than its best of the last 30 s the last frame came, in ms. Null with no timestamps. */
  lagMs: number | null;
}

export interface SessionMonitor {
  tracks: Map<string, MonitorTrack>;
  events: MonitorEvent[];
}

export const newSessionMonitor = (): SessionMonitor => ({ tracks: new Map(), events: [] });

/** Past this many tracks in a session, new ones are not followed. */
const MAX_TRACKS = 64;

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** The pause threshold of a track: the setting, or 4 times its usual interval when that is longer. A catalog track sends rarely. */
const pauseThreshold = (track: MonitorTrack, thresholds: MonitorThresholds): number =>
  Math.max(thresholds.pauseMs, 4 * median(track.intervals));

function addEvent(monitor: SessionMonitor, event: MonitorEvent): void {
  monitor.events.push(event);
  if (monitor.events.length > MAX_EVENTS) monitor.events.shift();
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

interface FrameInfo {
  at: number;
  bytes: number;
  group: number;
  key: boolean;
  /** A rule dropped it: the app did not get it. */
  dropped: boolean;
  /** The timestamp of the frame, from the frame itself. */
  mediaUs?: number;
}

/** One frame (or object) of a track, as the app got it. */
export function noteFrame(monitor: SessionMonitor, name: string, frame: FrameInfo, thresholds: MonitorThresholds): void {
  let track = monitor.tracks.get(name);
  if (!track) {
    if (monitor.tracks.size >= MAX_TRACKS) return;
    track = { name, seconds: [], frames: 0, lastAt: null, lastGroup: null, lastKeyAt: null, keyIntervals: [], intervals: [], gaps: 0, pauses: 0, lateKeys: 0, keysDropped: 0, lastMediaUs: null, lags: [], lagMs: null };
    monitor.tracks.set(name, track);
  }
  const second = Math.floor(frame.at / 1000);
  let bucket = track.seconds.at(-1);
  if (bucket?.second !== second) {
    bucket = { second, bytes: 0, frames: 0, groups: 0, keyframes: 0, dropped: 0 };
    track.seconds.push(bucket);
    while (track.seconds.length > 0 && (track.seconds[0]?.second ?? second) <= second - MONITOR_SECONDS) track.seconds.shift();
  }
  bucket.bytes += frame.bytes;
  if (frame.dropped) {
    bucket.dropped++;
    if (frame.key) {
      track.keysDropped++;
      addEvent(monitor, { at: frame.at, kind: 'key-dropped', track: name, text: `a rule dropped the key frame of group ${frame.group}` });
    }
    return;
  }
  bucket.frames++;
  track.frames++;
  if (track.lastAt !== null) {
    const interval = frame.at - track.lastAt;
    const limit = pauseThreshold(track, thresholds);
    if (track.intervals.length >= 5 && interval > limit) {
      track.pauses++;
      addEvent(monitor, { at: frame.at, kind: 'pause', track: name, text: `no frame for ${seconds(interval)}` });
    }
    track.intervals.push(interval);
    if (track.intervals.length > INTERVALS) track.intervals.shift();
  }
  track.lastAt = frame.at;
  if (frame.mediaUs !== undefined) {
    track.lastMediaUs = frame.mediaUs;
    const lag = frame.at - frame.mediaUs / 1000;
    track.lags.push({ at: frame.at, lag });
    while (track.lags.length > 0 && (track.lags[0]?.at ?? frame.at) < frame.at - LAG_WINDOW_MS) track.lags.shift();
    if (track.lags.length > MAX_LAGS) track.lags.splice(0, track.lags.length - MAX_LAGS);
    track.lagMs = Math.max(0, lag - Math.min(...track.lags.map((item) => item.lag)));
  }
  // Groups come on streams in parallel: only a newer group counts, and a jump of more than one is a gap.
  if (track.lastGroup === null || frame.group > track.lastGroup) {
    if (track.lastGroup !== null && frame.group > track.lastGroup + 1) {
      track.gaps++;
      const from = track.lastGroup + 1;
      const to = frame.group - 1;
      addEvent(monitor, { at: frame.at, kind: 'gap', track: name, text: from === to ? `group ${from} missing` : `groups ${from} to ${to} missing` });
    }
    bucket.groups++;
    track.lastGroup = frame.group;
  }
  if (frame.key) {
    bucket.keyframes++;
    if (track.lastKeyAt !== null) {
      const interval = frame.at - track.lastKeyAt;
      track.keyIntervals.push(interval);
      if (track.keyIntervals.length > 20) track.keyIntervals.shift();
      if (thresholds.keyIntervalMs > 0 && interval > thresholds.keyIntervalMs) {
        track.lateKeys++;
        addEvent(monitor, { at: frame.at, kind: 'late-key', track: name, text: `key frame after ${seconds(interval)}` });
      }
    }
    track.lastKeyAt = frame.at;
  }
}

export function noteConnection(monitor: SessionMonitor, action: ConnectionAction, streamId: number | null, at: number): void {
  const text =
    action.type === 'stall'
      ? `Sluice stalled the session for ${seconds(action.durationMs)}`
      : action.type === 'close-session'
        ? `Sluice closed the session (code ${action.closeCode})`
        : action.type === 'network'
          ? `the timeline set the network: ${Math.round(action.dropRate * 1000) / 10}% loss, ${action.delayMs} ms ± ${action.jitterMs} ms${action.kbps === undefined ? '' : `, cap ${action.kbps >= 1000 ? `${action.kbps / 1000} Mbit/s` : `${action.kbps} kbit/s`}`}`
          : `Sluice reset stream #${String(streamId)} (code ${action.code})`;
  addEvent(monitor, { at, kind: action.type, track: null, text });
}

export function noteClosed(monitor: SessionMonitor, closeCode: number | null, reason: string, at: number): void {
  addEvent(monitor, { at, kind: 'session-closed', track: null, text: closeCode === null ? 'the session closed with an error' : `the session closed (code ${closeCode}${reason ? `, ${reason}` : ''})` });
}

export type TrackHealth = 'ok' | 'warn' | 'stalled' | 'idle' | 'left';

/** A track left by the player: quiet for 10 s while another track of the session still comes. A player that takes another
 * quality leaves the old one, and that is not a problem. */
/** A catalog comes once, and again only when it changes: silence is normal for it. */
const isCatalogTrack = (track: MonitorTrack): boolean => track.name.includes('catalog');

function trackLeft(monitor: SessionMonitor, track: MonitorTrack, now: number): boolean {
  if (isCatalogTrack(track) || track.lastAt === null || now - track.lastAt < 10_000) return false;
  for (const other of monitor.tracks.values()) if (other !== track && other.lastAt !== null && now - other.lastAt < 2000) return true;
  return false;
}

/** `now` is in the clock of the page. A track with no frame for long is stalled, and one with a recent problem warns. */
export function trackHealth(monitor: SessionMonitor, track: MonitorTrack, now: number, thresholds: MonitorThresholds, open: boolean): TrackHealth {
  if (track.lastAt === null) return 'idle';
  if (trackLeft(monitor, track, now)) return 'left';
  if (isCatalogTrack(track)) return monitor.events.some((event) => event.track === track.name && now - event.at < 10_000) ? 'warn' : 'ok';
  if (open && track.intervals.length >= 5 && now - track.lastAt > pauseThreshold(track, thresholds)) return 'stalled';
  const recent = monitor.events.some((event) => event.track === track.name && now - event.at < 10_000);
  return recent ? 'warn' : 'ok';
}

/** Bits per second for each of the last `count` seconds up to `now`, 0 for a second with nothing. */
export function series(track: MonitorTrack, now: number, count: number, pick: (bucket: TrackSecond) => number): number[] {
  const last = Math.floor(now / 1000);
  const bySecond = new Map(track.seconds.map((bucket) => [bucket.second, bucket]));
  const out: number[] = [];
  for (let second = last - count + 1; second <= last; second++) {
    const bucket = bySecond.get(second);
    out.push(bucket ? pick(bucket) : 0);
  }
  return out;
}

export const average = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

type CheckId = 'gaps' | 'pauses' | 'key-frames' | 'receiving';

interface CheckResult {
  id: CheckId;
  pass: boolean;
  /** What was seen, in a few words. */
  detail: string;
}

/**
 * Pass or fail for one track (ADR-44). `key-frames` applies only to a track that had key frames. `receiving` applies only to an open
 * session: a track that stopped fails it.
 */
export function trackChecks(track: MonitorTrack, now: number, thresholds: MonitorThresholds, open: boolean, left = false): CheckResult[] {
  const out: CheckResult[] = [
    { id: 'gaps', pass: track.gaps === 0, detail: track.gaps === 0 ? 'no group skipped' : count(track.gaps, 'gap in the groups', 'gaps in the groups') },
    { id: 'pauses', pass: track.pauses === 0, detail: track.pauses === 0 ? 'no pause' : count(track.pauses, 'pause', 'pauses') },
  ];
  if (track.lastKeyAt !== null || track.keysDropped > 0) {
    const late = thresholds.keyIntervalMs > 0 && track.lastKeyAt !== null && now - track.lastKeyAt > thresholds.keyIntervalMs;
    const pass = track.lateKeys === 0 && track.keysDropped === 0 && track.lastKeyAt !== null && !late;
    const detail =
      track.keysDropped > 0
        ? `${count(track.keysDropped, 'key frame', 'key frames')} dropped`
        : track.lateKeys > 0
          ? count(track.lateKeys, 'late key frame', 'late key frames')
          : late
            ? `no key frame for ${seconds(now - (track.lastKeyAt ?? now))}`
            : 'key frames on time';
    out.push({ id: 'key-frames', pass, detail });
  }
  if (open && track.lastAt !== null && !left && !isCatalogTrack(track)) {
    const quiet = now - track.lastAt;
    const pass = track.intervals.length < 5 || quiet <= pauseThreshold(track, thresholds);
    out.push({ id: 'receiving', pass, detail: pass ? 'frames arrive' : `no frame for ${seconds(quiet)}` });
  }
  return out;
}

/** A report to attach to a bug or to read in CI: settings, tracks with checks and their seconds, and events. No payloads. */
export function monitorReport(url: string | null, monitor: SessionMonitor, thresholds: MonitorThresholds, now = Date.now(), open = true) {
  const tracks = Array.from(monitor.tracks.values(), (track) => {
    const recent = track.seconds.filter((bucket) => bucket.second < Math.floor(now / 1000) && bucket.second >= Math.floor(now / 1000) - 10);
    return {
      name: track.name,
      frames: track.frames,
      gaps: track.gaps,
      pauses: track.pauses,
      lateKeys: track.lateKeys,
      keysDropped: track.keysDropped,
      keyIntervalMs: average(track.keyIntervals),
      lagMs: track.lagMs,
      /** Over the last 10 full seconds. */
      bitsPerSecond: recent.length === 0 ? 0 : (recent.reduce((sum, bucket) => sum + bucket.bytes, 0) * 8) / 10,
      framesPerSecond: recent.length === 0 ? 0 : recent.reduce((sum, bucket) => sum + bucket.frames, 0) / 10,
      checks: trackChecks(track, now, thresholds, open, trackLeft(monitor, track, now)),
      seconds: track.seconds,
    };
  });
  return {
    format: 'sluice-monitor' as const,
    version: 1 as const,
    url,
    open,
    thresholds,
    pass: tracks.every((track) => track.checks.every((check) => check.pass)),
    tracks,
    events: monitor.events,
  };
}
