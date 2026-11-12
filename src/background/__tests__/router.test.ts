import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type RuntimeConfig } from '../../shared/rules';
import { createRouter, type RouterPort } from '../router';
import { parsePanelMessage } from '../../shared/protocol';

const EXT = 'ext';
const PANEL_URL = 'chrome-extension://ext/panel/panel.html';

type TestPort = RouterPort & { posted: unknown[]; disconnected: boolean; emit(m: unknown): void; drop(): void };

function port(name: string, sender: RouterPort['sender']): TestPort {
  const onMessage: ((m: unknown) => void)[] = [];
  const onDisconnect: (() => void)[] = [];
  return {
    name,
    sender,
    posted: [],
    disconnected: false,
    postMessage(m) {
      this.posted.push(m);
    },
    disconnect() {
      this.disconnected = true;
    },
    onMessage: { addListener: (h) => void onMessage.push(h) },
    onDisconnect: { addListener: (h) => void onDisconnect.push(h) },
    emit: (m) => onMessage.forEach((h) => h(m)),
    drop: () => onDisconnect.forEach((h) => h()),
  };
}

const frame = (over: Partial<NonNullable<RouterPort['sender']>> = {}): TestPort =>
  port('tab', {
    id: EXT,
    url: 'https://a.test/',
    origin: 'https://a.test',
    frameId: 0,
    documentId: 'doc',
    tab: { id: 1, url: 'https://a.test/' },
    ...over,
  });
const panel = (tabId = 1, url = PANEL_URL): TestPort => port(`panel:${tabId}`, { id: EXT, url });
const session = { v: 1, type: 'session-open', id: 1, payload: { sessionId: 1, url: 'https://a.test/', createdAt: 1 } };
const setConfig = { v: 1, type: 'set-config', id: 1, payload: { config: DEFAULT_CONFIG, targetOrigin: 'https://a.test' } };
const captureOf = (p: TestPort): unknown => (p.posted.at(-1) as { payload: { traffic: boolean } }).payload.traffic;

function setup() {
  const wakeTab = vi.fn<(tabId: number) => void>();
  let time = 0;
  const saved = new Map<string, RuntimeConfig>();
  let saveError: string | null = null;
  const router = createRouter({
    extensionId: EXT,
    panelUrl: PANEL_URL,
    wakeTab,
    now: () => time,
    isGranted: (_origin, done) => done(true),
    loadConfig: (origin, done) => done(saved.get(origin) ?? null),
    saveConfig: (origin, config, done) => {
      if (!saveError) saved.set(origin, config);
      done(saveError);
    },
  });
  return { router, wakeTab, saved, failSaves: (error: string) => void (saveError = error), advance: (ms: number) => void (time += ms) };
}

describe('router', () => {
  it('rejects another extension, unknown names and bad panel names', () => {
    const { router } = setup();
    for (const p of [
      port('tab', { id: 'other' }),
      port('other', { id: EXT }),
      port('panel:abc', { id: EXT, url: PANEL_URL }),
      port('panel:1:2', { id: EXT, url: PANEL_URL }),
      port('tab', { id: EXT }),
    ]) {
      router.connect(p);
      expect(p.disconnected).toBe(true);
    }
  });

  it('a page cannot connect as a panel', () => {
    const { router } = setup();
    const fake = panel(1, 'https://a.test/');
    router.connect(fake);
    expect(fake.disconnected).toBe(true);
  });

  it('forwards valid frame messages with the facts of port.sender', () => {
    const { router } = setup();
    const p = panel();
    const f = frame({ frameId: 3, documentId: 'd3', url: 'https://a.test/f' });
    router.connect(p);
    router.connect(f);
    f.emit(session);
    expect(p.posted).toHaveLength(1);
    expect(p.posted[0]).toMatchObject({ type: 'frame-message', payload: { frameId: 3, documentId: 'd3', frameUrl: 'https://a.test/f', message: session } });
  });

  it('drops invalid messages, and shows nothing to the panel of another tab', () => {
    const { router } = setup();
    const p = panel();
    const other = panel(2);
    const f = frame();
    router.connect(p);
    router.connect(other);
    router.connect(f);
    f.emit({ ...session, type: 'set-config' });
    f.emit({ ...session, frameId: 9 });
    f.emit(null);
    expect(p.posted).toEqual([]);
    f.emit(session);
    expect(p.posted).toHaveLength(1);
    expect(other.posted).toEqual([]);
  });

  it('capture follows the open panels, whichever connects first', () => {
    const { router, wakeTab } = setup();
    const before = frame();
    router.connect(before);
    expect(captureOf(before)).toBe(false);
    const p = panel();
    router.connect(p);
    expect(wakeTab).toHaveBeenCalledWith(1);
    expect(captureOf(before)).toBe(true);
    const after = frame({ documentId: 'other' });
    router.connect(after);
    expect(captureOf(after)).toBe(true);
    p.drop();
    expect(captureOf(before)).toBe(false);
    expect(captureOf(after)).toBe(false);
  });

  it('capture stays on while a second panel is open', () => {
    const { router } = setup();
    const f = frame();
    const [a, b] = [panel(), panel()];
    router.connect(f);
    router.connect(a);
    router.connect(b);
    a.drop();
    expect(captureOf(f)).toBe(true);
    b.drop();
    expect(captureOf(f)).toBe(false);
  });

  it('sends a config only to frames of the origin of the tab', () => {
    const { router } = setup();
    const p = panel();
    const top = frame();
    const same = frame({ frameId: 1, documentId: 'b', url: 'about:blank' });
    const cross = frame({ frameId: 2, documentId: 'c', url: 'https://evil.test/', origin: 'https://evil.test' });
    const opaque = frame({ frameId: 3, documentId: 'd', url: 'about:blank', origin: 'null' });
    for (const f of [top, same, cross, opaque]) router.connect(f);
    router.connect(p);
    p.emit(setConfig);
    const got = (f: TestPort): boolean => f.posted.some((m) => (m as { type: string }).type === 'set-config');
    expect([top, same, cross, opaque].map(got)).toEqual([true, true, false, false]);
  });

  it('a config for one site never reaches the next site in the tab', () => {
    const { router } = setup();
    const p = panel();
    const next = frame({ url: 'https://b.test/', origin: 'https://b.test', tab: { id: 1, url: 'https://b.test/' } });
    router.connect(next);
    router.connect(p);
    p.emit(setConfig);
    expect(next.posted.some((m) => (m as { type: string }).type === 'set-config')).toBe(false);
  });

  it('a frame of the target origin in a tab of another site gets no config', () => {
    const { router } = setup();
    const p = panel();
    const f = frame({ frameId: 1, tab: { id: 1, url: 'https://b.test/' } });
    router.connect(f);
    router.connect(p);
    p.emit(setConfig);
    expect(f.posted.some((m) => (m as { type: string }).type === 'set-config')).toBe(false);
  });

  it('does no work for frame messages with no panel', () => {
    const { router } = setup();
    const f = frame();
    router.connect(f);
    const hostile = {
      get v(): number {
        throw new Error('parsed');
      },
    };
    expect(() => f.emit(hostile)).not.toThrow();
    const p = panel();
    router.connect(p);
    f.emit(session);
    expect(p.posted).toHaveLength(1);
  });

  it('limits messages per tab across frames, and recovers', () => {
    const { router, advance } = setup();
    const p = panel();
    const [a, b] = [frame({ documentId: 'a' }), frame({ documentId: 'b', frameId: 1 })];
    router.connect(p);
    router.connect(a);
    router.connect(b);
    for (let i = 0; i < 600; i++) {
      a.emit(session);
      b.emit(session);
    }
    // Two of the 1000 went to loading the saved rules of the two frames.
    expect(p.posted).toHaveLength(998);
    advance(1000);
    a.emit(session);
    expect(p.posted).toHaveLength(999);
  });

  it('the top frame always gets a port, also when frames used all of them', () => {
    const { router } = setup();
    for (let i = 0; i < 64; i++) router.connect(frame({ frameId: i + 1, documentId: `d${i}` }));
    const top = frame({ frameId: 0, documentId: 'top' });
    router.connect(top);
    expect(top.disconnected).toBe(false);
  });

  it('a frame that connects gets the saved config before capture, so MAIN can start to read', () => {
    const { router, saved } = setup();
    saved.set('https://a.test', DEFAULT_CONFIG);
    const f = frame();
    router.connect(f);
    expect(f.posted.map((m) => (m as { type: string }).type)).toEqual(['set-config', 'set-capture']);
    expect(f.posted[0]).toMatchObject({ payload: { targetOrigin: 'https://a.test', config: DEFAULT_CONFIG } });
  });

  it('a frame of another origin gets capture only', () => {
    const { router, saved } = setup();
    saved.set('https://evil.test', DEFAULT_CONFIG);
    const f = frame({ frameId: 1, url: 'https://evil.test/', origin: 'https://evil.test' });
    router.connect(f);
    expect(f.posted.map((m) => (m as { type: string }).type)).toEqual(['set-capture']);
  });

  it('capture waits for a frame that is still loading its rules, also when a panel connects', () => {
    let finish: (config: RuntimeConfig | null) => void = () => undefined;
    const router = createRouter({
      extensionId: EXT,
      panelUrl: PANEL_URL,
      wakeTab: () => undefined,
      now: () => 0,
      loadConfig: (_origin, done) => {
        finish = done;
      },
      saveConfig: (_origin, _config, done) => done(null),
      isGranted: (_origin, done) => done(true),
    });
    const f = frame();
    router.connect(f);
    router.connect(panel());
    expect(f.posted).toEqual([]);
    finish(DEFAULT_CONFIG);
    expect(f.posted.map((m) => (m as { type: string }).type)).toEqual(['set-config', 'set-capture']);
  });

  it('saved rules do not replace newer rules from a panel that came while they loaded', () => {
    let finish: (config: RuntimeConfig | null) => void = () => undefined;
    const router = createRouter({
      extensionId: EXT,
      panelUrl: PANEL_URL,
      wakeTab: () => undefined,
      now: () => 0,
      loadConfig: (_origin, done) => {
        finish = done;
      },
      saveConfig: (_origin, _config, done) => done(null),
      isGranted: (_origin, done) => done(true),
    });
    const f = frame();
    const p = panel();
    router.connect(f);
    const loadFrame = finish;
    router.connect(p);
    p.emit(setConfig);
    loadFrame({ ...DEFAULT_CONFIG, maxDelayedBytes: 1 });
    const configs = f.posted.filter((m) => (m as { type: string }).type === 'set-config');
    expect(configs).toHaveLength(1);
  });

  it('tells the panels of all tabs when a site changes, and says if the site is on', () => {
    const { router } = setup();
    const p = panel();
    router.connect(p);
    router.siteChanged();
    expect(p.posted.at(-1)).toMatchObject({ type: 'site-changed', payload: {} });
    expect(parsePanelMessage(p.posted.at(-1)).ok).toBe(true);
    p.emit({ v: 1, type: 'get-config', id: 2, payload: { targetOrigin: 'https://a.test' } });
    expect(p.posted.at(-1)).toMatchObject({ type: 'config', payload: { granted: true } });
    expect(parsePanelMessage(p.posted.at(-1)).ok).toBe(true);
  });

  it('saves a config and replies, and get-config reads it back', () => {
    const { router, saved } = setup();
    const p = panel();
    router.connect(p);
    p.emit(setConfig);
    expect(saved.get('https://a.test')).toEqual(DEFAULT_CONFIG);
    expect(p.posted.at(-1)).toMatchObject({ type: 'config', payload: { targetOrigin: 'https://a.test', error: null } });
    p.emit({ v: 1, type: 'get-config', id: 2, payload: { targetOrigin: 'https://a.test' } });
    expect(p.posted.at(-1)).toMatchObject({ type: 'config', payload: { config: DEFAULT_CONFIG, error: null } });
    p.emit({ v: 1, type: 'get-config', id: 3, payload: { targetOrigin: 'https://other.test' } });
    expect(p.posted.at(-1)).toMatchObject({ type: 'config', payload: { config: null } });
  });

  it('tells the panel if a save fails, and still applies the rules to the page', () => {
    const { router, failSaves } = setup();
    failSaves('storage full');
    const p = panel();
    const f = frame();
    router.connect(f);
    router.connect(p);
    p.emit(setConfig);
    expect(p.posted.at(-1)).toMatchObject({ type: 'config', payload: { error: 'storage full' } });
    expect(f.posted.some((m) => (m as { type: string }).type === 'set-config')).toBe(true);
  });

  it.each([['http://a.test'], ['chrome://extensions'], ['https://a.test/path'], ['not a url'], ['https://*.a.test']])(
    'never saves under %s',
    (targetOrigin) => {
      const { router, saved } = setup();
      const p = panel();
      router.connect(p);
      p.emit({ ...setConfig, payload: { config: DEFAULT_CONFIG, targetOrigin } });
      expect(saved.size).toBe(0);
      expect(p.posted.at(-1)).toMatchObject({ payload: { error: 'Sluice cannot run on this site.' } });
    },
  );

  it('a panel cannot set capture or send a bad config', () => {
    const { router } = setup();
    const p = panel();
    const f = frame();
    router.connect(f);
    router.connect(p);
    const count = f.posted.length;
    p.emit({ v: 1, type: 'set-capture', id: 1, payload: { traffic: false, previewBytes: 0 } });
    p.emit({ ...setConfig, payload: { config: { ...DEFAULT_CONFIG, maxDelayedBytes: -1 }, targetOrigin: 'https://a.test' } });
    expect(f.posted).toHaveLength(count);
  });

  it('caps frame ports per tab, and frees a place on disconnect', () => {
    const { router } = setup();
    const ports = Array.from({ length: 64 }, (_, i) => frame({ frameId: i + 1, documentId: `d${i}` }));
    ports.forEach((p) => router.connect(p));
    const extra = frame({ frameId: 99, documentId: 'extra' });
    router.connect(extra);
    expect(extra.disconnected).toBe(true);
    ports[0]?.drop();
    const next = frame({ frameId: 100, documentId: 'next' });
    router.connect(next);
    expect(next.disconnected).toBe(false);
    const otherTab = frame({ tab: { id: 2, url: 'https://a.test/' } });
    router.connect(otherTab);
    expect(otherTab.disconnected).toBe(false);
  });

  it('tells the panel when a frame goes, and stops sending to a dead port', () => {
    const { router } = setup();
    const p = panel();
    const f = frame({ frameId: 3, documentId: 'd3' });
    router.connect(p);
    router.connect(f);
    f.drop();
    expect(p.posted.at(-1)).toMatchObject({ type: 'frame-gone', payload: { frameId: 3, documentId: 'd3' } });
    const count = f.posted.length;
    p.emit(setConfig);
    expect(f.posted).toHaveLength(count);
  });

  it('a port that throws on post does not stop the others', () => {
    const { router } = setup();
    const f = frame();
    const broken = panel();
    broken.postMessage = () => {
      throw new Error('closed');
    };
    const good = panel();
    router.connect(f);
    router.connect(broken);
    router.connect(good);
    expect(() => f.emit(session)).not.toThrow();
    expect(good.posted).toHaveLength(1);
  });

  it('sends a decision to the frame it names, with no other data, and only on the site of the tab', () => {
    const { router } = setup();
    const a = frame({ documentId: 'a', frameId: 0 });
    const b = frame({ documentId: 'b', frameId: 1 });
    const other = frame({ documentId: 'c', frameId: 2, origin: 'https://other.test' });
    const p = panel();
    for (const item of [a, b, other, p]) router.connect(item);
    const decide = (documentId: string): void =>
      p.emit({ v: 1, type: 'hold-resolve', id: 9, payload: { documentId, workerId: null, holdId: 4, action: 'forward', data: null } });
    decide('a');
    expect(a.posted.at(-1)).toMatchObject({ type: 'hold-resolve', payload: { holdId: 4, workerId: null, action: 'forward', data: null } });
    expect((a.posted.at(-1) as { payload: object }).payload).not.toHaveProperty('documentId');
    expect(b.posted.some((m) => (m as { type: string }).type === 'hold-resolve')).toBe(false);
    decide('c');
    expect(other.posted.some((m) => (m as { type: string }).type === 'hold-resolve')).toBe(false);
  });

  it('a frame of another origin cannot add held rows', () => {
    const { router } = setup();
    const other = frame({ documentId: 'c', origin: 'https://other.test' });
    const p = panel();
    router.connect(other);
    router.connect(p);
    const count = p.posted.length;
    const held = { holdId: 1, sessionId: 1, streamId: null, kind: 'datagram', seq: 0, byteLength: 0, data: '', ruleId: 'r', timeoutMs: 1000, onTimeout: 'drop' };
    other.emit({ v: 1, type: 'hold', id: 1, payload: held });
    other.emit({ v: 1, type: 'worker-message', id: 2, payload: { workerId: 1, url: 'https://other.test/w.js', message: { v: 1, type: 'hold', id: 1, payload: held } } });
    expect(p.posted).toHaveLength(count);
  });

  it('sends an inject only to the frame it names, on the site of the tab', () => {
    const { router } = setup();
    const a = frame({ documentId: 'a', frameId: 0 });
    const other = frame({ documentId: 'c', frameId: 2, origin: 'https://other.test' });
    const p = panel();
    for (const item of [a, other, p]) router.connect(item);
    const send = (documentId: string): void =>
      p.emit({ v: 1, type: 'inject', id: 9, payload: { documentId, injectId: 1, sessionId: 1, workerId: null, kind: 'datagram', data: btoa('x') } });
    send('a');
    expect(a.posted.at(-1)).toMatchObject({ type: 'inject', payload: { injectId: 1, sessionId: 1 } });
    expect((a.posted.at(-1) as { payload: object }).payload).not.toHaveProperty('documentId');
    send('c');
    expect(other.posted.some((m) => (m as { type: string }).type === 'inject')).toBe(false);
  });

  it('a recording reaches frames that connect later, and ends when the panel goes', () => {
    const { router, wakeTab } = setup();
    const p = panel();
    router.connect(p);
    p.emit({ v: 1, type: 'record', id: 1, payload: { recordId: 1, on: true } });
    expect(wakeTab).toHaveBeenLastCalledWith(1, true);
    const f = frame();
    router.connect(f);
    expect(f.posted.some((m) => (m as { type: string }).type === 'record')).toBe(true);
    p.drop();
    expect(f.posted.at(-2)).toMatchObject({ type: 'record', payload: { on: false } });
  });

  it('a recording to play waits for the top frame of the site', () => {
    const { router } = setup();
    const p = panel();
    router.connect(p);
    const arm = { v: 1, type: 'replay-arm', id: 1, payload: { replayId: 1, url: 'https://a.test/', close: null, events: [], last: true } };
    p.emit(arm);
    const other = frame({ documentId: 'x', frameId: 3, origin: 'https://other.test' });
    router.connect(other);
    expect(other.posted.some((m) => (m as { type: string }).type === 'replay-arm')).toBe(false);
    const top = frame({ documentId: 't', frameId: 0 });
    router.connect(top);
    expect(top.posted.some((m) => (m as { type: string }).type === 'replay-arm')).toBe(true);
  });
});
