import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_LIMITS } from '../../shared/protocol';
import { createRelay, type RelayPort } from '../relay';

function setup(connectError = false, isAlive: () => boolean = () => true) {
  const ports: (RelayPort & { posted: unknown[]; emit(m: unknown): void; drop(): void })[] = [];
  const toMain = vi.fn<(text: string) => void>();
  let time = 0;
  const relay = createRelay({
    alive: isAlive,
    connect: () => {
      if (connectError) throw new Error('Extension context invalidated');
      const onMessage: ((m: unknown) => void)[] = [];
      const onDisconnect: (() => void)[] = [];
      const port = {
        posted: [] as unknown[],
        postMessage(m: unknown) {
          this.posted.push(m);
        },
        onMessage: { addListener: (h: (m: unknown) => void) => void onMessage.push(h) },
        onDisconnect: { addListener: (h: () => void) => void onDisconnect.push(h) },
        emit: (m: unknown) => onMessage.forEach((h) => h(m)),
        drop: () => onDisconnect.forEach((h) => h()),
      };
      ports.push(port);
      return port;
    },
    toMain,
    now: () => time,
  });
  return { relay, ports, toMain, advance: (ms: number) => void (time += ms) };
}

const open = (sessionId = 1): string =>
  JSON.stringify({ v: 1, type: 'session-open', id: 1, payload: { sessionId, url: 'https://a.test/', createdAt: 1 } });
const closed = (sessionId = 1): string =>
  JSON.stringify({ v: 1, type: 'session-closed', id: 2, payload: { sessionId, closeCode: 0, reason: '', at: 1 } });

describe('relay', () => {
  it('opens no port until the first valid message', () => {
    const { relay, ports } = setup();
    relay.wake();
    expect(ports).toHaveLength(0);
    relay.fromMain(open());
    expect(ports).toHaveLength(1);
    expect(ports[0]?.posted).toHaveLength(1);
    relay.fromMain(closed());
    expect(ports).toHaveLength(1);
  });

  it.each([
    ['a number', 1],
    ['an object', { v: 1 }],
    ['null', null],
    ['bad JSON', '{'],
    ['the wrong direction', JSON.stringify({ v: 1, type: 'set-capture', id: 1, payload: { traffic: true, previewBytes: 1 } })],
    ['extra fields', JSON.stringify({ v: 1, type: 'session-open', id: 1, frameId: 0, payload: {} })],
    ['too long', ' '.repeat(PROTOCOL_LIMITS.messageChars + 1)],
  ])('drops %s and opens no port', (_name, detail) => {
    const { relay, ports } = setup();
    relay.fromMain(detail);
    expect(ports).toHaveLength(0);
  });

  it('forwards the clean copy, not the raw text', () => {
    const { relay, ports } = setup();
    relay.fromMain(open());
    expect(ports[0]?.posted[0]).toEqual(JSON.parse(open()));
    expect(typeof ports[0]?.posted[0]).toBe('object');
  });

  it('sends commands to MAIN as a string', () => {
    const { relay, ports, toMain } = setup();
    relay.fromMain(open());
    ports[0]?.emit({ type: 'x' });
    expect(toMain).toHaveBeenCalledWith('{"type":"x"}');
  });

  it('after a disconnect, wake opens a port only with a live session', () => {
    const { relay, ports, advance } = setup();
    relay.fromMain(open());
    advance(2000);
    ports[0]?.drop();
    relay.wake();
    expect(ports).toHaveLength(2);
    relay.fromMain(closed());
    advance(2000);
    ports[1]?.drop();
    relay.wake();
    expect(ports).toHaveLength(2);
    relay.fromMain(open(2));
    expect(ports).toHaveLength(3);
  });

  it('limits the rate per frame and recovers', () => {
    const { relay, ports, advance } = setup();
    const big = `${open().slice(0, -1)}${' '.repeat(1024 * 1024)}}`;
    for (let i = 0; i < 20; i++) relay.fromMain(big);
    const passed = ports[0]?.posted.length ?? 0;
    expect(passed).toBeGreaterThan(0);
    expect(passed).toBeLessThan(20);
    advance(1000);
    relay.fromMain(big);
    expect(ports[0]?.posted.length).toBe(passed + 1);
  });

  it('with capture off, drops traffic but still sends session events', () => {
    const { relay, ports } = setup();
    relay.fromMain(open());
    ports[0]?.emit({ type: 'set-capture', payload: { traffic: false, previewBytes: 0 } });
    const stats = JSON.stringify({
      v: 1,
      type: 'stream-open',
      id: 3,
      payload: { sessionId: 1, streamId: 1, kind: 'uni', origin: 'remote', at: 1 },
    });
    relay.fromMain(stats);
    expect(ports[0]?.posted).toHaveLength(1);
    ports[0]?.emit({ type: 'set-capture', payload: { traffic: true, previewBytes: 0 } });
    relay.fromMain(stats);
    expect(ports[0]?.posted).toHaveLength(2);
    relay.fromMain(open(2));
    expect(ports[0]?.posted).toHaveLength(3);
  });

  it('limits session events more than other messages', () => {
    const { relay, ports } = setup();
    for (let i = 0; i < 1000; i++) relay.fromMain(open(i));
    const passed = ports[0]?.posted.length ?? 0;
    expect(passed).toBeLessThan(200);
    expect(passed).toBeGreaterThan(50);
  });

  it('backs off when a port is refused at once, and not after a normal stop of the worker', () => {
    const { relay, ports, advance } = setup();
    relay.fromMain(open());
    ports[0]?.drop();
    relay.fromMain(open(2));
    expect(ports).toHaveLength(1);
    advance(1000);
    relay.fromMain(open(3));
    expect(ports).toHaveLength(2);
    ports[1]?.drop();
    advance(1000);
    relay.fromMain(open(4));
    expect(ports).toHaveLength(2);
    advance(1000);
    relay.fromMain(open(5));
    expect(ports).toHaveLength(3);
    advance(5000);
    ports[2]?.drop();
    relay.fromMain(open(6));
    expect(ports).toHaveLength(4);
  });

  it('survives a reloaded extension', () => {
    const { relay, ports } = setup(true);
    expect(() => relay.fromMain(open())).not.toThrow();
    expect(() => relay.wake()).not.toThrow();
    expect(ports).toHaveLength(0);
  });
});

describe('workers', () => {
  const wrap = (type: string, payload: unknown): unknown => ({ v: 1, type, id: 1, payload });
  const open = (sessionId: number): unknown => wrap('session-open', { sessionId, url: 'https://a.test/wt', createdAt: 1 });
  const closed = (sessionId: number): unknown => wrap('session-closed', { sessionId, closeCode: 0, reason: '', at: 1 });
  const inWorker = (message: unknown, workerId = 1): string =>
    JSON.stringify(wrap('worker-message', { workerId, url: 'https://a.test/w.js', message }));

  it('a session in a worker opens the port, as one in the frame does', () => {
    const { relay, ports } = setup();
    relay.fromMain(inWorker(open(1)));
    expect(ports).toHaveLength(1);
    expect(ports[0]?.posted).toHaveLength(1);
  });

  it('the same id in another worker is another session, for the wake after a restart', () => {
    const { relay, ports, advance } = setup();
    relay.fromMain(inWorker(open(1), 1));
    relay.fromMain(inWorker(open(1), 2));
    relay.fromMain(inWorker(closed(1), 1));
    advance(2000); // A port that lives this long died normally, so no backoff.
    ports[0]?.drop();
    relay.wake();
    expect(ports).toHaveLength(2);
  });

  it('a frame with only a skipped worker still answers the wake of a panel that opens later', () => {
    const { relay, ports, advance } = setup();
    relay.fromMain(JSON.stringify(wrap('worker-skipped', { url: 'blob:x', reason: 'blob-url' })));
    ports[0]?.emit({ type: 'set-capture', payload: { traffic: false } });
    advance(2000);
    ports[0]?.drop();
    relay.fromMain(JSON.stringify(wrap('worker-skipped', { url: 'blob:y', reason: 'blob-url' })));
    expect(ports).toHaveLength(2);
    relay.wake();
    expect(ports).toHaveLength(2);
  });

  it('a worker that ends takes its sessions out of the wake', () => {
    const { relay, ports, advance } = setup();
    relay.fromMain(inWorker(open(1), 1));
    relay.fromMain(JSON.stringify(wrap('worker-gone', { workerId: 1 })));
    advance(2000);
    ports[0]?.drop();
    relay.wake();
    expect(ports).toHaveLength(1);
  });

  it('with no panel, traffic of a worker stops here', () => {
    const { relay, ports } = setup();
    relay.fromMain(inWorker(open(1)));
    ports[0]?.emit({ type: 'set-capture', payload: { traffic: false } });
    relay.fromMain(inWorker(wrap('stats', { stats: {}, ruleHits: [], captureDropped: 0, disabledRules: [] })));
    relay.fromMain(JSON.stringify(wrap('worker-gone', { workerId: 1 })));
    expect(ports[0]?.posted).toHaveLength(1);
  });

  it('tells MAIN that no panel can answer when the extension is gone, but not when the worker only stopped', () => {
    const sessionOpen = JSON.stringify({ v: 1, type: 'session-open', id: 1, payload: { sessionId: 1, url: 'https://a.test/', createdAt: 1 } });
    let alive = true;
    const { relay, ports, toMain, advance } = setup(false, () => alive);
    relay.fromMain(sessionOpen);
    ports[0]?.drop();
    expect(toMain).not.toHaveBeenCalled();
    advance(60_000);
    relay.fromMain(sessionOpen);
    alive = false;
    ports.at(-1)?.drop();
    expect(toMain).toHaveBeenCalledTimes(1);
    expect(JSON.parse(toMain.mock.calls[0]?.[0] as string)).toMatchObject({ type: 'set-capture', payload: { traffic: false } });
  });
});
