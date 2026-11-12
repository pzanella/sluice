import { describe, expect, it } from 'vitest';
import { notePlayback, playbackHealth, playbackReport, type PlaybackState } from '../playback';

const report = (videoFrames: number) => ({ videoFrames, audioFrames: 50, droppedFrames: 0, queue: 1, decoders: [], events: [] });

describe('playback state', () => {
  it('says playing, then frozen when video frames stop while the page still reports', () => {
    const pages = new Map<string, PlaybackState>();
    notePlayback(pages, 'd', 'page', report(25), 1000);
    const state = pages.get('d');
    if (!state) throw new Error('no state');
    expect(playbackHealth(state, 1500)).toBe('playing');
    notePlayback(pages, 'd', 'page', report(0), 4000);
    expect(playbackHealth(state, 4100)).toBe('frozen');
    expect(playbackReport(state, 5000)).toMatchObject({ health: 'frozen', videoFramesPerSecond: 2.5 });
  });
});
