import { describe, expect, it } from 'vitest';
import { avOffsetMs, DEFAULT_THRESHOLDS, monitorReport, newSessionMonitor, noteClosed, noteConnection, noteFrame, series, trackChecks, trackHealth } from '../monitor';

const track = (m: ReturnType<typeof newSessionMonitor>, name: string) => {
  const found = m.tracks.get(name);
  if (!found) throw new Error(`no track ${name}`);
  return found;
};
const frame = (at: number, group: number, key = false, dropped = false) => ({ at, bytes: 100, group, key, dropped });

describe('monitor', () => {
  it('counts frames, groups and key frames by second', () => {
    const m = newSessionMonitor();
    noteFrame(m, 'video', frame(1000, 1, true), DEFAULT_THRESHOLDS);
    noteFrame(m, 'video', frame(1040, 1), DEFAULT_THRESHOLDS);
    noteFrame(m, 'video', frame(2000, 2, true), DEFAULT_THRESHOLDS);
    const video = track(m, 'video');
    expect(video.seconds).toEqual([
      { second: 1, bytes: 200, frames: 2, groups: 1, keyframes: 1, dropped: 0 },
      { second: 2, bytes: 100, frames: 1, groups: 1, keyframes: 1, dropped: 0 },
    ]);
    expect(series(video, 3000, 3, (b) => b.frames)).toEqual([2, 1, 0]);
    expect(video.keyIntervals).toEqual([1000]);
  });

  it('sees a gap in groups, and not a late frame of an older group', () => {
    const m = newSessionMonitor();
    for (const [at, group] of [[0, 5], [10, 6], [20, 5], [30, 9]] as const) noteFrame(m, 'v', frame(at, group), DEFAULT_THRESHOLDS);
    expect(track(m, 'v').gaps).toBe(1);
    expect(m.events.map((e) => e.text)).toEqual(['groups 7 to 8 missing']);
  });

  it('sees a pause, after the track has a usual interval', () => {
    const m = newSessionMonitor();
    for (let i = 0; i < 6; i++) noteFrame(m, 'v', frame(i * 40, 1), DEFAULT_THRESHOLDS);
    noteFrame(m, 'v', frame(200 + 1500, 1), DEFAULT_THRESHOLDS);
    expect(m.events.at(-1)).toMatchObject({ kind: 'pause', track: 'v', text: 'no frame for 1.5 s' });
  });

  it('does not take a rare track, such as a catalog, for a pause', () => {
    const m = newSessionMonitor();
    for (let i = 0; i < 8; i++) noteFrame(m, 'catalog.json', frame(i * 5000, i), DEFAULT_THRESHOLDS);
    expect(m.events.filter((e) => e.kind === 'pause')).toEqual([]);
  });

  it('sees late key frames, and can turn that check off', () => {
    const m = newSessionMonitor();
    noteFrame(m, 'v', frame(0, 1, true), DEFAULT_THRESHOLDS);
    noteFrame(m, 'v', frame(6000, 2, true), DEFAULT_THRESHOLDS);
    expect(track(m, 'v').lateKeys).toBe(1);
    const off = newSessionMonitor();
    noteFrame(off, 'v', frame(0, 1, true), { ...DEFAULT_THRESHOLDS, keyIntervalMs: 0 });
    noteFrame(off, 'v', frame(6000, 2, true), { ...DEFAULT_THRESHOLDS, keyIntervalMs: 0 });
    expect(off.events).toEqual([]);
  });

  it('counts a dropped frame as dropped, not as a frame the app got', () => {
    const m = newSessionMonitor();
    noteFrame(m, 'v', frame(0, 1, true, true), DEFAULT_THRESHOLDS);
    expect(track(m, 'v').frames).toBe(0);
    expect(track(m, 'v').seconds[0]?.dropped).toBe(1);
    expect(m.events.at(-1)).toMatchObject({ kind: 'key-dropped', track: 'v', text: 'a rule dropped the key frame of group 1' });
  });

  it('says a track is stalled, has a problem, or is OK', () => {
    const m = newSessionMonitor();
    for (let i = 0; i < 6; i++) noteFrame(m, 'v', frame(i * 40, i), DEFAULT_THRESHOLDS);
    const v = track(m, 'v');
    expect(trackHealth(m, v, 300, DEFAULT_THRESHOLDS, true)).toBe('ok');
    expect(trackHealth(m, v, 5000, DEFAULT_THRESHOLDS, true)).toBe('stalled');
    expect(trackHealth(m, v, 5000, DEFAULT_THRESHOLDS, false)).toBe('ok');
    noteFrame(m, 'v', frame(300, 9), DEFAULT_THRESHOLDS);
    expect(trackHealth(m, v, 400, DEFAULT_THRESHOLDS, true)).toBe('warn');
  });

  it('lists actions of Sluice and the close, and makes a report with no payloads', () => {
    const m = newSessionMonitor();
    noteConnection(m, { type: 'stall', durationMs: 3000 }, null, 1);
    noteConnection(m, { type: 'reset-stream', code: 2 }, 12, 2);
    noteClosed(m, 0, 'bye', 3);
    expect(m.events.map((e) => e.text)).toEqual(['Sluice stalled the session for 3.0 s', 'Sluice reset stream #12 (code 2)', 'the session closed (code 0, bye)']);
    expect(monitorReport('relay/moq', m, DEFAULT_THRESHOLDS)).toMatchObject({ format: 'sluice-monitor', version: 1, url: 'relay/moq', events: m.events });
  });
});

describe('checks (ADR-44)', () => {
  it('pass for a steady track, and fail for gaps, dropped key frames and a track that stopped', () => {
    const m = newSessionMonitor();
    for (let i = 0; i < 10; i++) noteFrame(m, 'v', frame(i * 40, Math.floor(i / 5), i % 5 === 0), DEFAULT_THRESHOLDS);
    const v = track(m, 'v');
    expect(trackChecks(v, 400, DEFAULT_THRESHOLDS, true).every((check) => check.pass)).toBe(true);
    expect(trackChecks(v, 5000, DEFAULT_THRESHOLDS, true).find((check) => check.id === 'receiving')).toMatchObject({ pass: false });
    noteFrame(m, 'v', frame(420, 5, true, true), DEFAULT_THRESHOLDS);
    noteFrame(m, 'v', frame(440, 5), DEFAULT_THRESHOLDS);
    const checks = trackChecks(v, 460, DEFAULT_THRESHOLDS, true);
    expect(checks.find((check) => check.id === 'gaps')).toMatchObject({ pass: false, detail: '1 gap in the groups' });
    expect(checks.find((check) => check.id === 'key-frames')).toMatchObject({ pass: false, detail: '1 key frame dropped' });
  });

  it('has no key frame check for a track with no key frames, such as audio', () => {
    const m = newSessionMonitor();
    noteFrame(m, 'a', frame(0, 1), DEFAULT_THRESHOLDS);
    expect(trackChecks(track(m, 'a'), 10, DEFAULT_THRESHOLDS, true).map((check) => check.id)).toEqual(['gaps', 'pauses', 'receiving']);
  });

  it('the report says pass only when every check passes', () => {
    const m = newSessionMonitor();
    noteFrame(m, 'a', frame(0, 1), DEFAULT_THRESHOLDS);
    expect(monitorReport(null, m, DEFAULT_THRESHOLDS, 10, true).pass).toBe(true);
    noteFrame(m, 'a', frame(20, 3), DEFAULT_THRESHOLDS);
    expect(monitorReport(null, m, DEFAULT_THRESHOLDS, 30, true).pass).toBe(false);
  });
});

describe('lag and A/V offset (ADR-50)', () => {
  it('says how much later than its best a track is, from the frame timestamps', () => {
    const m = newSessionMonitor();
    noteFrame(m, 'v', { ...frame(1000, 1), mediaUs: 0 }, DEFAULT_THRESHOLDS);
    noteFrame(m, 'v', { ...frame(1040, 1), mediaUs: 40_000 }, DEFAULT_THRESHOLDS);
    expect(track(m, 'v').lagMs).toBe(0);
    noteFrame(m, 'v', { ...frame(1580, 1), mediaUs: 80_000 }, DEFAULT_THRESHOLDS);
    expect(track(m, 'v').lagMs).toBe(500);
  });

  it('gives video ahead of audio in ms', () => {
    const m = newSessionMonitor();
    noteFrame(m, 'v', { ...frame(0, 1), mediaUs: 2_000_000 }, DEFAULT_THRESHOLDS);
    noteFrame(m, 'a', { ...frame(0, 1), mediaUs: 1_750_000 }, DEFAULT_THRESHOLDS);
    expect(avOffsetMs(track(m, 'v'), track(m, 'a'))).toBe(250);
    expect(avOffsetMs(track(m, 'v'), undefined)).toBeNull();
  });
});

describe('a track the player left', () => {
  it('is Not received, with no receiving check, when another track still comes', () => {
    const m = newSessionMonitor();
    for (let i = 0; i < 6; i++) noteFrame(m, 'v1', frame(i * 40, 1), DEFAULT_THRESHOLDS);
    for (let i = 0; i < 6; i++) noteFrame(m, 'v2', frame(20_000 + i * 40, 1), DEFAULT_THRESHOLDS);
    const old = track(m, 'v1');
    expect(trackHealth(m, old, 20_300, DEFAULT_THRESHOLDS, true)).toBe('left');
    expect(monitorReport(null, m, DEFAULT_THRESHOLDS, 20_300, true).tracks.find((t) => t.name === 'v1')?.checks.map((c) => c.id)).not.toContain('receiving');
  });
});
