// What the player showed, by page or worker, for the Monitor (ADR-49).
import type { PlaybackReport } from '../inject/playback';

const PLAYBACK_SECONDS = 120;
const MAX_EVENTS = 200;
const MAX_PAGES = 16;

interface PlaybackSecond {
  second: number;
  videoFrames: number;
  audioFrames: number;
  droppedFrames: number;
  queue: number;
}

export interface PlaybackState {
  label: string;
  seconds: PlaybackSecond[];
  decoders: PlaybackReport['decoders'];
  events: PlaybackReport['events'];
  lastAt: number;
  /** When video frames last came. */
  lastVideoAt: number | null;
}

/** `now` is the time the panel got the report, as reports come once a second. */
export function notePlayback(pages: Map<string, PlaybackState>, key: string, label: string, report: PlaybackReport, now: number): void {
  let state = pages.get(key);
  if (!state) {
    if (pages.size >= MAX_PAGES) return;
    state = { label, seconds: [], decoders: [], events: [], lastAt: now, lastVideoAt: null };
    pages.set(key, state);
  }
  const second = Math.floor(now / 1000);
  const last = state.seconds.at(-1);
  const bucket: PlaybackSecond =
    last?.second === second ? last : { second, videoFrames: 0, audioFrames: 0, droppedFrames: 0, queue: 0 };
  if (bucket !== last) state.seconds.push(bucket);
  while (state.seconds.length > 0 && (state.seconds[0]?.second ?? second) <= second - PLAYBACK_SECONDS) state.seconds.shift();
  bucket.videoFrames += report.videoFrames;
  bucket.audioFrames += report.audioFrames;
  bucket.droppedFrames += report.droppedFrames;
  bucket.queue = Math.max(bucket.queue, report.queue);
  state.decoders = report.decoders;
  state.events.push(...report.events);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  state.lastAt = now;
  if (report.videoFrames > 0) state.lastVideoAt = now;
}

export type PlaybackHealth = 'playing' | 'frozen' | 'idle';

/** Frozen: video frames came before, and none in the last 2 s while the page still reports. */
export function playbackHealth(state: PlaybackState, now: number): PlaybackHealth {
  if (state.lastVideoAt === null) return 'idle';
  if (now - state.lastVideoAt > 2000 && now - state.lastAt < 3000) return 'frozen';
  return now - state.lastVideoAt <= 2000 ? 'playing' : 'idle';
}

export function playbackSeries(state: PlaybackState, now: number, count: number, pick: (bucket: PlaybackSecond) => number): number[] {
  const last = Math.floor(now / 1000);
  const bySecond = new Map(state.seconds.map((bucket) => [bucket.second, bucket]));
  const out: number[] = [];
  for (let second = last - count + 1; second <= last; second++) {
    const bucket = bySecond.get(second);
    out.push(bucket ? pick(bucket) : 0);
  }
  return out;
}

/** For tests in CI: the same numbers as the view, with no frame data. */
export function playbackReport(state: PlaybackState, now: number) {
  const recent = state.seconds.filter((bucket) => bucket.second < Math.floor(now / 1000) && bucket.second >= Math.floor(now / 1000) - 10);
  const sum = (pick: (bucket: PlaybackSecond) => number): number => recent.reduce((total, bucket) => total + pick(bucket), 0) / 10;
  return {
    label: state.label,
    health: playbackHealth(state, now),
    videoFramesPerSecond: sum((bucket) => bucket.videoFrames),
    audioFramesPerSecond: sum((bucket) => bucket.audioFrames),
    droppedFramesPerSecond: sum((bucket) => bucket.droppedFrames),
    decoders: state.decoders,
    events: state.events,
  };
}
