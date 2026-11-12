// One-click tests of the simple Rules view (ADR-55). Each one is a normal rule with a fixed id, so the advanced view shows it too.
import type { PanelConnectionAction } from '../shared/protocol';
import type { Rule } from '../shared/rules';

type TrackKind = 'video' | 'audio' | 'catalog' | 'any';

export interface QuickParams {
  track: string;
  value: number;
}

export type QuickGroup = 'Video' | 'Audio and sync' | 'Connection' | 'Content';

export interface QuickTest {
  id: string;
  group: QuickGroup;
  title: string;
  /** What the player should do, in a few words. */
  expect: string;
  /** The track it needs. `any`: no track. */
  track: TrackKind;
  /** A slider, when the test has a value. */
  slider?: { label: string; min: number; max: number; step: number; initial: number; unit: string };
  build(params: QuickParams): Rule;
  /** The same once, by hand, on the newest open session (ADR-41): the action, and what the app sees then. */
  now?(params: QuickParams): { action: PanelConnectionAction; done: string };
}

const moqt = (track: string): Rule['match'] => (track ? { moqt: { track } } : undefined);
const withMatch = (rule: Rule, match: Rule['match']): Rule => (match ? { ...rule, match } : rule);

export const QUICK_PREFIX = 'quick-';

export const QUICK_TESTS: readonly QuickTest[] = [
  {
    id: 'lose-frames',
    group: 'Video',
    title: 'Lose frames',
    expect: 'Video stutters or skips. A good player recovers at the next group.',
    track: 'video',
    slider: { label: 'Frames lost', min: 1, max: 100, step: 1, initial: 10, unit: '%' },
    build: ({ track, value }) => withMatch({ id: `${QUICK_PREFIX}lose-frames`, action: { type: 'drop' }, on: ['uni'], probability: value / 100 }, moqt(track)),
  },
  {
    id: 'drop-key',
    group: 'Video',
    title: 'No key frames',
    expect: 'Video freezes until a key frame comes again. Audio goes on.',
    track: 'video',
    build: ({ track }) => ({ id: `${QUICK_PREFIX}drop-key`, action: { type: 'drop' }, on: ['uni'], match: { moqt: { ...(track ? { track } : {}), keyframe: true } } }),
  },
  {
    id: 'delay-track',
    group: 'Audio and sync',
    title: 'Late track',
    expect: 'Audio and video drift apart. The player should resync or report it.',
    track: 'audio',
    slider: { label: 'Delay', min: 50, max: 3000, step: 50, initial: 500, unit: 'ms' },
    build: ({ track, value }) => withMatch({ id: `${QUICK_PREFIX}delay-track`, action: { type: 'delay', delayMs: value }, on: ['uni'] }, moqt(track)),
  },
  {
    id: 'mute-track',
    group: 'Audio and sync',
    title: 'Missing track',
    expect: 'One track never arrives. The player should go on with the others.',
    track: 'audio',
    build: ({ track }) => withMatch({ id: `${QUICK_PREFIX}mute-track`, action: { type: 'drop' }, on: ['uni'] }, moqt(track)),
  },
  {
    id: 'rebuffer',
    group: 'Video',
    title: 'Rebuffer',
    expect: 'At each key frame, nothing comes for a while. The player buffers, then catches up.',
    track: 'video',
    slider: { label: 'Stall', min: 1, max: 20, step: 1, initial: 3, unit: 's' },
    now: ({ value }) => ({ action: { type: 'stall', durationMs: value * 1000 }, done: `The app gets nothing of this session for ${value} s. Then all of it comes, in order.` }),
    build: ({ track, value }) => ({
      id: `${QUICK_PREFIX}rebuffer`,
      action: { type: 'stall', durationMs: value * 1000 },
      on: ['uni'],
      match: { moqt: { ...(track ? { track } : {}), keyframe: true } },
    }),
  },
  {
    id: 'reconnect',
    group: 'Connection',
    title: 'Reconnect',
    expect: 'The session closes now and then. The player should reconnect by itself.',
    track: 'video',
    slider: { label: 'Close after about', min: 2, max: 60, step: 1, initial: 10, unit: 's' },
    now: () => ({ action: { type: 'close-session', closeCode: 0, reason: 'Closed by Sluice' }, done: 'Close sent: the session closed. The player should reconnect by itself.' }),
    // At about 25 frames per second, a chance of 1 in (25 × seconds) for each frame.
    build: ({ track, value }) =>
      withMatch(
        { id: `${QUICK_PREFIX}reconnect`, action: { type: 'close-session', closeCode: 0, reason: 'Closed by Sluice' }, on: ['uni'], probability: Math.min(1, 1 / (25 * value)) },
        moqt(track),
      ),
  },
  {
    id: 'hold-catalog',
    group: 'Content',
    title: 'Edit the catalog',
    expect: 'The catalog waits at the top of this view for 30 s, so you can change it by hand.',
    track: 'catalog',
    build: ({ track }) => withMatch({ id: `${QUICK_PREFIX}hold-catalog`, action: { type: 'hold', timeoutMs: 30_000, onTimeout: 'forward' }, on: ['uni'] }, moqt(track)),
  },
  {
    id: 'lose-datagrams',
    group: 'Connection',
    title: 'Lose datagrams',
    expect: 'Only for apps that use datagrams: some never arrive.',
    track: 'any',
    slider: { label: 'Datagrams lost', min: 1, max: 100, step: 1, initial: 5, unit: '%' },
    build: ({ value }) => ({ id: `${QUICK_PREFIX}lose-datagrams`, action: { type: 'drop' }, on: ['datagram'], probability: value / 100 }),
  },
];

/** The params of a quick test from its saved rule, so the card shows what runs. */
export function paramsOf(test: QuickTest, rule: Rule): QuickParams {
  const track = rule.match?.moqt?.track ?? '';
  const { action } = rule;
  let value = test.slider?.initial ?? 0;
  if (test.id === 'reconnect' && rule.probability) value = Math.round(1 / (25 * rule.probability));
  else if (action.type === 'delay') value = action.delayMs;
  else if (action.type === 'stall') value = Math.round(action.durationMs / 1000);
  else if (rule.probability !== undefined) value = Math.round(rule.probability * 100);
  return { track, value };
}
