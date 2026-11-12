import { describe, expect, it } from 'vitest';
import type { PanelMessage, RuntimeMessage, RuntimeReport, TrafficItem } from '../../shared/protocol';
import { createStatsForTest } from './stats';
import { PanelStore, sessionKey, STORE_LIMITS, trackBitrate, type TrackRow } from '../store';

const frameMessage = (message: RuntimeMessage, documentId = 'd', frameId = 0): PanelMessage => ({
  v: 1,
  type: 'frame-message',
  id: 1,
  payload: { frameId, documentId, frameUrl: 'https://a.test/', message },
});
const open = (sessionId = 1, documentId = 'd'): PanelMessage =>
  frameMessage({ v: 1, type: 'session-open', id: 1, payload: { sessionId, url: 'https://a.test/wt', createdAt: 1 } }, documentId);
const item = (over: Partial<TrafficItem> = {}): TrafficItem => ({
  sessionId: 1,
  streamId: null,
  kind: 'datagram',
  seq: 0,
  byteLength: 5,
  outcome: 'passed',
  modified: false,
  delayMs: 0,
  preview: btoa('hello'),
  at: 1,
  ...over,
});
const traffic = (items: TrafficItem[], documentId = 'd'): PanelMessage =>
  frameMessage({ v: 1, type: 'traffic', id: 1, payload: { items } }, documentId);

describe('PanelStore', () => {
  it('keeps one session when MAIN announces it again', () => {
    const store = new PanelStore();
    store.handle(open());
    store.handle(open());
    expect(store.sessions.size).toBe(1);
  });

  it('keeps sessions of two documents apart, also with the same session id', () => {
    const store = new PanelStore();
    store.handle(open(1, 'a'));
    store.handle(open(1, 'b'));
    expect(store.sessions.size).toBe(2);
  });

  it('a page value used as a key stays plain data', () => {
    const store = new PanelStore();
    store.handle(open(1, '__proto__'));
    expect(store.sessions.has(sessionKey('__proto__', 1))).toBe(true);
    expect(({} as Record<string, unknown>).sessions).toBeUndefined();
  });

  it('marks a session closed', () => {
    const store = new PanelStore();
    store.handle(open());
    store.handle(frameMessage({ v: 1, type: 'session-closed', id: 1, payload: { sessionId: 1, closeCode: 7, reason: 'x', at: 1 } }));
    expect(store.sessions.get(sessionKey('d', 1))?.closed).toEqual({ closeCode: 7, reason: 'x' });
  });

  it('adds a session and streams from traffic, when it comes first', () => {
    const store = new PanelStore();
    store.handle(traffic([item(), item({ kind: 'uni', streamId: 4 })]));
    const session = store.sessions.get(sessionKey('d', 1));
    expect(session?.url).toBeNull();
    expect(session?.hasDatagrams).toBe(true);
    expect(session?.streams.get(4)).toEqual({ streamId: 4, kind: 'uni', origin: null });
  });

  it('a later stream-open fills in the origin', () => {
    const store = new PanelStore();
    store.handle(traffic([item({ kind: 'bidi', streamId: 4 })]));
    store.handle(frameMessage({ v: 1, type: 'stream-open', id: 1, payload: { sessionId: 1, streamId: 4, kind: 'bidi', origin: 'local', at: 1 } }));
    expect(store.sessions.get(sessionKey('d', 1))?.streams.get(4)?.origin).toBe('local');
  });

  it('keeps the newest rows and counts the others', () => {
    const store = new PanelStore();
    const batch = Array.from({ length: 50 }, (_, seq) => item({ seq }));
    for (let i = 0; i < (STORE_LIMITS.rows + 600) / 50; i++) store.handle(traffic(batch));
    expect(store.rows.length).toBeLessThanOrEqual(STORE_LIMITS.rows + 500);
    expect(store.evicted).toBeGreaterThan(0);
    expect(store.rows.length + store.evicted).toBe(STORE_LIMITS.rows + 600);
    // Rows that the list let go are not lost messages.
    expect(store.lostItems()).toBe(0);
  });

  it('caps sessions per frame, and in total', () => {
    const store = new PanelStore();
    for (let i = 0; i < STORE_LIMITS.sessionsPerFrame + 5; i++) store.handle(open(i));
    expect(store.sessions.size).toBe(STORE_LIMITS.sessionsPerFrame);
    expect(store.ignored).toBe(5);
    for (let doc = 0; doc < 10; doc++) for (let i = 0; i < STORE_LIMITS.sessionsPerFrame; i++) store.handle(open(i, `d${doc}`));
    expect(store.sessions.size).toBe(STORE_LIMITS.sessions);
  });

  it('caps streams and frames', () => {
    const store = new PanelStore();
    for (let i = 0; i < STORE_LIMITS.streamsPerSession + 3; i++) store.handle(traffic([item({ kind: 'uni', streamId: i })]));
    expect(store.sessions.get(sessionKey('d', 1))?.streams.size).toBe(STORE_LIMITS.streamsPerSession);
    const frames = new PanelStore();
    for (let i = 0; i < STORE_LIMITS.frames + 2; i++) frames.handle(open(1, `d${i}`));
    expect(frames.frames.size).toBe(STORE_LIMITS.frames);
    expect(frames.ignored).toBe(2);
  });

  it('a clear keeps open sessions and removes closed ones', () => {
    const store = new PanelStore();
    store.handle(open(1));
    store.handle(open(2));
    store.handle(traffic([item({ kind: 'uni', streamId: 9 })]));
    store.handle(frameMessage({ v: 1, type: 'session-closed', id: 1, payload: { sessionId: 2, closeCode: 0, reason: '', at: 1 } }));
    store.clear();
    const live = store.sessions.get(sessionKey('d', 1));
    expect(live?.url).toBe('https://a.test/wt');
    expect(live?.streams.size).toBe(0);
    expect(store.sessions.has(sessionKey('d', 2))).toBe(false);
    expect(store.frames.get('d')?.sessions).toBe(1);
  });

  it('Reset checks starts the Monitor of each session again', () => {
    const store = new PanelStore();
    store.handle(open(1));
    store.handle(traffic([item({ kind: 'uni', streamId: 3, moqt: { trackAlias: 0, group: 1, subgroup: null, object: 0, track: 'v' } })]));
    expect(store.sessions.get(sessionKey('d', 1))?.monitor.tracks.size).toBe(1);
    store.resetMonitor();
    expect(store.sessions.get(sessionKey('d', 1))?.monitor.tracks.size).toBe(0);
  });

  it('removes closed sessions and their rows, and keeps the rest', () => {
    const store = new PanelStore();
    store.handle(open(1));
    store.handle(open(2));
    store.handle(traffic([item({ sessionId: 1 }), item({ sessionId: 2 })]));
    store.handle(frameMessage({ v: 1, type: 'session-closed', id: 1, payload: { sessionId: 2, closeCode: 0, reason: '', at: 1 } }));
    store.removeClosed();
    expect([...store.sessions.keys()]).toEqual([sessionKey('d', 1)]);
    expect(store.rows.map((row) => row.sessionKey)).toEqual([sessionKey('d', 1)]);
    expect(store.frames.get('d')?.sessions).toBe(1);
  });

  it('removes a gone frame with no session on clear, so a long life does not fill the cap', () => {
    const store = new PanelStore();
    store.handle(open(1, 'old'));
    store.handle(frameMessage({ v: 1, type: 'session-closed', id: 1, payload: { sessionId: 1, closeCode: 0, reason: '', at: 1 } }, 'old'));
    store.handle({ v: 1, type: 'frame-gone', id: 1, payload: { frameId: 0, documentId: 'old' } });
    store.clear();
    expect(store.frames.size).toBe(0);
  });

  it('a page that left frees its sessions, so the next page in the tab is not hidden', () => {
    const store = new PanelStore();
    for (let i = 0; i < STORE_LIMITS.sessions; i++) {
      store.handle(open(i, `old-${Math.floor(i / 16)}`));
    }
    expect(store.sessions.size).toBe(STORE_LIMITS.sessions);
    for (let i = 0; i < STORE_LIMITS.sessions / 16; i++) store.handle({ v: 1, type: 'frame-gone', id: 1, payload: { frameId: 0, documentId: `old-${i}` } });
    expect([...store.sessions.values()].every((session) => session.closed)).toBe(true);
    store.clear();
    expect(store.sessions.size).toBe(0);
    store.handle(open(1, 'new'));
    expect(store.sessions.has('new:1')).toBe(true);
  });

  it('with no Clear, a new page takes the place of a page that left', () => {
    const store = new PanelStore();
    for (let i = 0; i < STORE_LIMITS.sessions; i++) store.handle(open(i, `old-${Math.floor(i / 16)}`));
    store.handle({ v: 1, type: 'frame-gone', id: 1, payload: { frameId: 0, documentId: 'old-0' } });
    store.handle(open(1, 'new'));
    expect(store.sessions.has('new:1')).toBe(true);
  });

  it('a live frame with no session makes room at the cap of frames', () => {
    const store = new PanelStore();
    for (let i = 0; i < STORE_LIMITS.frames; i++) {
      store.handle(open(1, `f-${i}`));
      store.handle(frameMessage({ v: 1, type: 'session-closed', id: 1, payload: { sessionId: 1, closeCode: 0, reason: '', at: 1 } }, `f-${i}`));
    }
    store.clear();
    expect(store.frames.size).toBe(STORE_LIMITS.frames);
    store.handle(open(1, 'new'));
    expect(store.sessions.has('new:1')).toBe(true);
  });

  it('Clear starts the counters from zero, and a page that reports again does not bring back the old counts', () => {
    const store = new PanelStore();
    const stats = (chunks: number) =>
      frameMessage({
        v: 1,
        type: 'stats',
        id: 1,
        payload: {
          stats: {
            datagram: { streams: 0, chunks, bytes: chunks * 10, dropped: 1, modified: 0, delayed: 0 },
            uni: { streams: 0, chunks: 0, bytes: 0, dropped: 0, modified: 0, delayed: 0 },
            bidi: { streams: 0, chunks: 0, bytes: 0, dropped: 0, modified: 0, delayed: 0 },
          },
          disabledRules: [],
          ruleHits: [],
          captureDropped: 0,
        },
      });
    store.handle(stats(85));
    expect(store.totals().chunks).toBe(85);
    store.clear();
    expect(store.totals()).toMatchObject({ chunks: 0, bytes: 0, dropped: 0 });
    store.handle(stats(90));
    expect(store.totals()).toMatchObject({ chunks: 5, bytes: 50, dropped: 0 });
  });

  it('after a clear, lost items count only new losses', () => {
    const store = new PanelStore();
    const stats = (captureDropped: number): PanelMessage =>
      frameMessage({ v: 1, type: 'stats', id: 1, payload: { stats: createStatsForTest(), ruleHits: [], captureDropped, disabledRules: [] } });
    store.handle(open());
    store.handle(stats(10));
    expect(store.lostItems()).toBe(10);
    store.clear();
    store.handle(stats(10));
    expect(store.lostItems()).toBe(0);
    store.handle(stats(12));
    expect(store.lostItems()).toBe(2);
  });

  it('caches payload text, so a filter does not decode a row twice', () => {
    const store = new PanelStore();
    store.handle(traffic([item()]));
    store.visibleRows(null, 'zz');
    expect(store.rows[0]?.searchText).toBe('hello');
  });

  it('filters by scope and by text', () => {
    const store = new PanelStore();
    store.handle(traffic([item(), item({ kind: 'uni', streamId: 2, preview: btoa('World'), outcome: 'dropped' })]));
    store.handle(traffic([item({ preview: btoa('other') })], 'e'));
    const key = sessionKey('d', 1);
    expect(store.visibleRows(null, '')).toHaveLength(3);
    expect(store.visibleRows({ sessionKey: key, stream: null }, '')).toHaveLength(2);
    expect(store.visibleRows({ sessionKey: key, stream: 'datagram' }, '')).toHaveLength(1);
    expect(store.visibleRows({ sessionKey: key, stream: 2 }, '')).toHaveLength(1);
    expect(store.visibleRows(null, ' world ')).toHaveLength(1);
    expect(store.visibleRows(null, 'dropped')).toHaveLength(1);
    expect(store.visibleRows(null, 'absent')).toHaveLength(0);
  });

  it('adds up the counters of all frames, and what they could not send', () => {
    const store = new PanelStore();
    const stats = createStatsForTest();
    stats.uni.chunks = 2;
    stats.datagram.bytes = 9;
    const message = (documentId: string): PanelMessage =>
      frameMessage({ v: 1, type: 'stats', id: 1, payload: { stats, ruleHits: [], captureDropped: 3, disabledRules: [] } }, documentId);
    store.handle(message('a'));
    store.handle(message('b'));
    expect(store.totals()).toMatchObject({ chunks: 4, bytes: 18 });
    expect(store.lostItems()).toBe(6);
  });

  it('frame-gone keeps the history, and a clear removes it', () => {
    const store = new PanelStore();
    store.handle(traffic([item()]));
    store.handle({ v: 1, type: 'frame-gone', id: 1, payload: { frameId: 0, documentId: 'd' } });
    expect(store.frames.get('d')?.gone).toBe(true);
    expect(store.rows).toHaveLength(1);
    store.handle(frameMessage({ v: 1, type: 'session-open', id: 1, payload: { sessionId: 2, url: 'https://a.test/', createdAt: 1 } }));
    expect(store.frames.get('d')?.gone).toBe(false);
    const before = store.version;
    store.clear();
    expect(store.rows).toHaveLength(0);
    expect(store.lostItems()).toBe(0);
    expect(store.version).toBeGreaterThan(before);
  });
});

describe('workers', () => {
  const inWorker = (message: RuntimeReport, workerId = 1, documentId = 'd'): PanelMessage =>
    frameMessage({ v: 1, type: 'worker-message', id: 1, payload: { workerId, url: 'https://a.test/w.js', message } }, documentId);
  const report: RuntimeReport = { v: 1, type: 'session-open', id: 1, payload: { sessionId: 1, url: 'https://a.test/wt', createdAt: 1 } };

  it('keeps the same session id of a frame and of two workers apart', () => {
    const store = new PanelStore();
    store.handle(open());
    store.handle(inWorker(report, 1));
    store.handle(inWorker(report, 2));
    expect(store.sessions.size).toBe(3);
    expect([...store.sessions.values()].map((s) => s.workerUrl)).toEqual([null, 'https://a.test/w.js', 'https://a.test/w.js']);
  });

  it('keeps the counters of a worker apart from its frame', () => {
    const store = new PanelStore();
    store.handle(open());
    store.handle(inWorker(report));
    expect(store.frames.size).toBe(2);
    expect(store.frames.get('d')?.worker).toBeNull();
    expect(store.frames.get('d#worker-1')?.worker).toEqual({ id: 1, parent: 'd', url: 'https://a.test/w.js' });
  });

  it('closes the open sessions of a worker that ended, and no others', () => {
    const store = new PanelStore();
    store.handle(open());
    store.handle(inWorker(report, 1));
    store.handle(inWorker(report, 2));
    store.handle(frameMessage({ v: 1, type: 'worker-gone', id: 1, payload: { workerId: 1 } }));
    expect(store.sessions.get(sessionKey('d#worker-1', 1))?.closed?.reason).toBe('The worker ended.');
    expect(store.sessions.get(sessionKey('d#worker-2', 1))?.closed).toBeNull();
    expect(store.sessions.get(sessionKey('d', 1))?.closed).toBeNull();
  });

  it('a gone frame takes its workers with it', () => {
    const store = new PanelStore();
    store.handle(inWorker(report, 1));
    store.handle({ v: 1, type: 'frame-gone', id: 1, payload: { frameId: 0, documentId: 'd' } });
    expect(store.frames.get('d#worker-1')?.gone).toBe(true);
  });

  it('lists skipped workers, with a cap, and Clear keeps the list', () => {
    const store = new PanelStore();
    for (let i = 0; i < STORE_LIMITS.frames + 5; i++) {
      store.handle(frameMessage({ v: 1, type: 'worker-skipped', id: 1, payload: { url: `https://a.test/${i}`, reason: 'csp' } }));
    }
    expect(store.skippedWorkers.size).toBe(STORE_LIMITS.frames);
    expect(store.ignored).toBe(5);
    store.clear();
    expect(store.skippedWorkers.size).toBe(STORE_LIMITS.frames);
  });

  it('skipped workers of a page go with the page', () => {
    const store = new PanelStore();
    store.handle(frameMessage({ v: 1, type: 'worker-skipped', id: 1, payload: { url: 'https://a.test/w.js', reason: 'csp' } }, 'a'));
    store.handle(frameMessage({ v: 1, type: 'worker-skipped', id: 1, payload: { url: 'https://b.test/w.js', reason: 'csp' } }, 'b'));
    store.handle({ v: 1, type: 'frame-gone', id: 1, payload: { frameId: 0, documentId: 'a' } });
    expect([...store.skippedWorkers.values()].map((e) => e.documentId)).toEqual(['b']);
  });

  it('one document cannot use up the list with worker rows', () => {
    const store = new PanelStore();
    for (let i = 0; i < 300; i++) store.handle(inWorker(report, i));
    store.handle(open(1, 'next'));
    expect(store.frames.has('next')).toBe(true);
    expect(store.ignored).toBe(300 - STORE_LIMITS.workersPerFrame);
  });

  it('a gone page closes the sessions of its workers, and its rows make room for the next page', () => {
    const store = new PanelStore();
    for (let d = 0; d < STORE_LIMITS.frames; d++) store.handle(open(1, `d${d}`));
    store.handle(open(1, 'late'));
    expect(store.frames.has('late')).toBe(false);
    store.handle({ v: 1, type: 'frame-gone', id: 1, payload: { frameId: 0, documentId: 'd0' } });
    store.handle(open(1, 'late'));
    expect(store.frames.has('late')).toBe(true);
    expect(store.frames.has('d0')).toBe(false);

    const other = new PanelStore();
    other.handle(inWorker(report, 1));
    other.handle({ v: 1, type: 'frame-gone', id: 1, payload: { frameId: 0, documentId: 'd' } });
    expect(other.sessions.get(sessionKey('d#worker-1', 1))?.closed?.reason).toBe('The worker ended.');
  });
});

describe('holds', () => {
  const held = (holdId = 1) =>
    ({ v: 1, type: 'hold', id: 1, payload: { holdId, sessionId: 1, streamId: null, kind: 'datagram', seq: 0, byteLength: 2, data: 'aGk=', ruleId: 'r', timeoutMs: 1000, onTimeout: 'forward' } }) as const;
  it('lists a hold until it ends, and Clear keeps it', () => {
    const store = new PanelStore();
    store.handle(frameMessage(held()));
    expect(store.holdRows()).toHaveLength(1);
    expect(store.holdRows()[0]).toMatchObject({ documentId: 'd', workerId: null });
    store.clear();
    expect(store.holdRows()).toHaveLength(1);
    store.handle(frameMessage({ v: 1, type: 'hold-end', id: 1, payload: { holdId: 1, outcome: 'forwarded' } }));
    expect(store.holdRows()).toHaveLength(0);
  });
  it('routes the hold of a worker through its frame', () => {
    const store = new PanelStore();
    store.handle(frameMessage({ v: 1, type: 'worker-message', id: 1, payload: { workerId: 7, url: 'https://a.test/w.js', message: held() } }));
    expect(store.holdRows()[0]).toMatchObject({ documentId: 'd', workerId: 7 });
    store.handle(frameMessage({ v: 1, type: 'worker-gone', id: 1, payload: { workerId: 7 } }));
    expect(store.holdRows()).toHaveLength(0);
  });
  it('a hold goes with its page, and a page that sends no end cannot keep a row, or pass the cap', () => {
    const store = new PanelStore();
    let time = 0;
    store.now = () => time;
    store.handle(frameMessage(held()));
    store.handle({ v: 1, type: 'frame-gone', id: 1, payload: { frameId: 0, documentId: 'd' } });
    expect(store.holdRows()).toHaveLength(0);
    for (let i = 0; i < STORE_LIMITS.holds + 5; i++) store.handle(frameMessage(held(i)));
    expect(store.holdRows()).toHaveLength(STORE_LIMITS.holds);
    time = 10_000;
    expect(store.holdRows()).toHaveLength(0);
  });
});

describe('inject', () => {
  const result = (injectId: number, failure: 'closed' | null, documentId = 'd') =>
    frameMessage({ v: 1, type: 'inject-result', id: 1, payload: { injectId, failure } }, documentId);

  it('lists open sessions a request can reach, not those of another site', () => {
    const store = new PanelStore();
    store.handle(open(1, 'd'));
    store.handle({ v: 1, type: 'frame-message', id: 1, payload: { frameId: 1, documentId: 'x', frameUrl: 'https://other.test/', message: { v: 1, type: 'session-open', id: 1, payload: { sessionId: 1, url: 'https://a.test/wt', createdAt: 1 } } } });
    store.handle({ v: 1, type: 'frame-message', id: 1, payload: { frameId: 2, documentId: 'blank', frameUrl: 'about:blank', message: { v: 1, type: 'session-open', id: 1, payload: { sessionId: 1, url: 'https://a.test/wt', createdAt: 1 } } } });
    expect(store.injectTargets('https://a.test').map((t) => t.documentId)).toEqual(['d', 'blank']);
    store.handle(frameMessage({ v: 1, type: 'session-closed', id: 1, payload: { sessionId: 1, closeCode: 0, reason: '', at: 1 } }));
    expect(store.injectTargets('https://a.test').map((t) => t.documentId)).toEqual(['blank']);
  });

  it('the first answer of the frame counts, and another frame cannot answer for it', () => {
    const store = new PanelStore();
    store.handle(result(1, 'closed', 'other'));
    expect(store.injectResults.get('d 1')).toBeUndefined();
    store.handle(result(1, null));
    store.handle(result(1, 'closed'));
    expect(store.injectResults.get('d 1')).toEqual({ failure: null });
  });

  it('a full list loses only its oldest answer', () => {
    const store = new PanelStore();
    for (let i = 0; i < STORE_LIMITS.injectResults + 1; i++) store.handle(result(i, null));
    expect(store.injectResults.has('d 0')).toBe(false);
    expect(store.injectResults.has('d 1')).toBe(true);
  });
});

describe('MoQT version', () => {
  it('is shown on its session', () => {
    const store = new PanelStore();
    store.handle(open(1));
    expect(store.sessions.get('d:1')?.moqt).toBe('');
    store.handle(frameMessage({ v: 1, type: 'moqt-version', id: 1, payload: { sessionId: 1, draft: 6, source: 'setup' } }));
    expect(store.sessions.get('d:1')?.moqt).toBe('MoQT draft 6, chunks only');
    store.handle(frameMessage({ v: 1, type: 'moqt-version', id: 1, payload: { sessionId: 1, draft: null, source: 'protocol' } }));
    expect(store.sessions.get('d:1')?.moqt).toBe('MoQT, chunks only');
    store.handle(frameMessage({ v: 1, type: 'moqt-version', id: 1, payload: { sessionId: 1, draft: null, source: 'protocol', lite: 6 } }));
    expect(store.sessions.get('d:1')?.moqt).toBe('moq-lite 6');
    store.handle(frameMessage({ v: 1, type: 'moqt-version', id: 1, payload: { sessionId: 1, draft: null, source: 'protocol', lite: 7 } }));
    expect(store.sessions.get('d:1')?.moqt).toBe('moq-lite 7, chunks only');
  });
});

describe('MoQ tracks', () => {
  const frame = (group: number, object: number, over: Partial<NonNullable<TrafficItem['moqt']>> = {}, at = 1000): TrafficItem =>
    item({ kind: 'uni', streamId: 1, byteLength: 100, at, moqt: { trackAlias: 0, group, subgroup: null, object, track: 'v', ...over } });

  it('counts groups once, when streams come in parallel, and keyframes', () => {
    const store = new PanelStore();
    store.handle(open(1));
    store.handle(traffic([frame(5, 0, { key: true }), frame(6, 0, { key: true }), frame(5, 1), frame(6, 1, { key: false })]));
    const track = store.sessions.get('d:1')?.tracks.get('v');
    expect(track).toMatchObject({ frames: 4, bytes: 400, groups: 2, lastGroup: 6, keyframes: 2, lastKeyGroup: 6 });
  });

  it('gives a bitrate from the full seconds, and none too early', () => {
    const store = new PanelStore();
    store.handle(open(1));
    store.handle(traffic([frame(1, 0, {}, 1000)]));
    const track = store.sessions.get('d:1')?.tracks.get('v') as TrackRow;
    expect(trackBitrate(track)).toBeNull();
    store.handle(traffic([frame(1, 1, {}, 2000), frame(1, 2, {}, 3000)]));
    expect(trackBitrate(track)).toBe(800);
  });

  it('keeps the catalog of a broadcast, ignores what is not a catalog, and Clear keeps the catalog', () => {
    const store = new PanelStore();
    store.handle(open(1));
    const catalog = (json: string): PanelMessage => frameMessage({ v: 1, type: 'moq-catalog', id: 1, payload: { sessionId: 1, broadcast: 'b', json } });
    store.handle(catalog('not json'));
    expect(store.sessions.get('d:1')?.catalogs.size).toBe(0);
    store.handle(catalog('{"video":{"renditions":{"v":{"codec":"avc1"}}}}'));
    expect(store.sessions.get('d:1')?.catalogs.get('b')?.renditions[0]?.name).toBe('v');
    store.handle(traffic([frame(1, 0)]));
    store.clear();
    expect(store.sessions.get('d:1')?.tracks.size).toBe(0);
    expect(store.sessions.get('d:1')?.catalogs.size).toBe(1);
  });
});

describe('a recording on its way', () => {
  const end = (sessions: { sessionId: number; url: string; protocol?: string; close: null }[]): PanelMessage =>
    frameMessage({ v: 1, type: 'record-end', id: 1, payload: { recordId: 1, count: sessions.length, truncated: false, sessions } });
  const part = (): PanelMessage =>
    frameMessage({ v: 1, type: 'record-part', id: 1, payload: { recordId: 1, events: [{ sessionId: 1, t: 0, kind: 'uni', streamId: 1, origin: 'remote', data: 'AQ==', fin: false }] } });

  it('says so from the stop until the end, and keeps no query', () => {
    const store = new PanelStore();
    store.handle(open(1));
    expect(store.recordingOnItsWay()).toBeNull();
    store.waitForRecording();
    expect(store.recordingOnItsWay()).toBe(0);
    store.handle(part());
    expect(store.recordingOnItsWay()).toBe(1);
    store.handle(end([{ sessionId: 1, url: 'https://relay.test/moq?jwt=secret', protocol: 'moq-lite-06', close: null }]));
    expect(store.recordingOnItsWay()).toBeNull();
    expect(store.recordEmpty).toBe(false);
    const row = [...store.recordings.values()][0];
    expect(row?.trace.url).toBe('https://relay.test/moq');
    expect(row?.trace.protocol).toBe('moq-lite-06');
    // The wall clock time when the session started, for a .moqtrace export (ADR-57).
    expect(row?.trace.startedAt).toBe(1);
    expect(JSON.stringify(row)).not.toContain('secret');
  });

  it('says when nothing was recorded', () => {
    const store = new PanelStore();
    store.handle(open(1));
    store.waitForRecording();
    store.handle(end([]));
    expect(store.recordingOnItsWay()).toBeNull();
    expect(store.recordEmpty).toBe(true);
  });
});


describe('track rows', () => {
  it('keep when their last frame came, so a track the player left can show as not received', () => {
    const store = new PanelStore();
    store.handle(open(1));
    const frame = (at: number) => item({ kind: 'uni', streamId: 3, at, moqt: { trackAlias: 0, group: 1, subgroup: null, object: 0, track: '1.avc3' } });
    store.handle(traffic([frame(1000), frame(3000)]));
    expect(store.sessions.get(sessionKey('d', 1))?.tracks.get('1.avc3')?.lastAt).toBe(3000);
  });
});
