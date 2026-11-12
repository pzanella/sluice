import { describe, expect, it, vi } from 'vitest';
import { connectPanel, type ConnectionPort } from '../connection';

function setup(failFirst = 0) {
  const ports: (ConnectionPort & { posted: unknown[]; emit(m: unknown): void; drop(): void })[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const messages: unknown[] = [];
  const statuses: boolean[] = [];
  let time = 0;
  let failures = failFirst;
  const connection = connectPanel(
    {
      connect: () => {
        if (failures-- > 0) throw new Error('no');
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
      setTimeout: (run, ms) => void timers.push({ run, ms }),
      now: () => time,
    },
    (m) => messages.push(m),
    (s) => statuses.push(s),
  );
  return { connection, ports, timers, messages, statuses, advance: (ms: number) => void (time += ms) };
}

describe('connectPanel', () => {
  it('passes on only valid messages', () => {
    const { ports, messages } = setup();
    ports[0]?.emit({ type: 'bad' });
    expect(messages).toEqual([]);
    const gone = { v: 1, type: 'frame-gone', id: 1, payload: { frameId: 0, documentId: 'd' } };
    ports[0]?.emit(gone);
    expect(messages).toEqual([gone]);
  });

  it('connects again when the worker stops, with a short wait after a port that lived', () => {
    const { ports, timers, statuses, advance } = setup();
    advance(40_000);
    ports[0]?.drop();
    expect(statuses).toEqual([true, false]);
    expect(timers[0]?.ms).toBe(100);
    timers[0]?.run();
    expect(ports).toHaveLength(2);
    expect(statuses).toEqual([true, false, true]);
  });

  it('waits longer each time a port dies at once, up to a limit', () => {
    const { ports, timers } = setup();
    for (let i = 0; i < 10; i++) {
      ports.at(-1)?.drop();
      timers.at(-1)?.run();
    }
    expect(timers.map((t) => t.ms).slice(0, 4)).toEqual([100, 200, 400, 800]);
    expect(timers.at(-1)?.ms).toBe(5000);
  });

  it('survives a connect that throws', () => {
    const { ports, timers, statuses } = setup(1);
    expect(ports).toHaveLength(0);
    expect(statuses).toEqual([false]);
    timers[0]?.run();
    expect(ports).toHaveLength(1);
  });

  it('send never throws', () => {
    const { connection, ports } = setup();
    connection.send({ a: 1 });
    expect(ports[0]?.posted).toEqual([{ a: 1 }]);
    const failing = ports[0];
    if (failing) failing.postMessage = vi.fn(() => { throw new Error('closed'); });
    expect(() => connection.send({ a: 2 })).not.toThrow();
  });
});
