import { describe, expect, it, vi } from 'vitest';
import { installWorkers, PROBE_PATH, type WorkerLink, type WorkerScope } from '../workers';
import type { ControlMessage } from '../../shared/protocol';

type Probe = 'ok' | 'csp' | 'starting';

function setup(probe: Probe = 'ok', { throwOnBlob = false, metaCsp = false, storage = undefined as Storage | undefined, origin = 'https://a.test', timers = [] as (() => void)[] } = {}) {
  const made: FakeWorker[] = [];
  const probeSources: string[] = [];
  const blobs = new Map<string, string>();
  const revoked: string[] = [];
  let blobSeq = 0;

  class FakeWorker extends EventTarget {
    posted: unknown[] = [];
    terminated = false;
    constructor(public url: string | object, public options?: WorkerOptions) {
      super();
      if (arguments.length === 0) throw new TypeError('needs a URL');
      const source = typeof url === 'string' ? blobs.get(url) : undefined;
      if (source?.includes(PROBE_PATH)) {
        probeSources.push(source);
        if (probe !== 'starting') queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: probe === 'ok' ? 1 : 0 })));
        return;
      }
      if (throwOnBlob && typeof url === 'string' && url.startsWith('blob:fake')) throw new TypeError('Trusted Types');
      made.push(this);
    }
    postMessage(message: unknown, transfer?: unknown): void {
      this.posted.push([message, transfer]);
    }
    terminate(): void {
      this.terminated = true;
    }
  }

  const sent: [string, unknown][] = [];
  const forwarded: string[] = [];
  let control: (text: string, message: ControlMessage) => void = () => undefined;
  const link: WorkerLink = {
    forward: (text) => forwarded.push(text),
    send: (type, payload) => void sent.push([type, payload]),
    onControl: (listener) => {
      control = listener;
    },
  };

  const FakeURL = class extends URL {
    static override createObjectURL(blob: Blob | MediaSource): string {
      const url = `blob:fake/${++blobSeq}`;
      blobs.set(url, (blob as unknown as { text: string }).text);
      return url;
    }
    static override revokeObjectURL(url: string): void {
      revoked.push(url);
    }
  };
  const FakeBlob = class {
    text: string;
    constructor(parts: string[]) {
      this.text = parts.join('');
    }
  };

  const scope = {
    Worker: FakeWorker,
    Blob: FakeBlob,
    URL: FakeURL,
    MessageChannel,
    MessagePort,
    TrustedScriptURL: FakeTrusted,
    crypto: { randomUUID: () => 'token' },
    setTimeout: (run: () => void) => void timers.push(run),
    document: { baseURI: 'https://a.test/app/', querySelector: () => (metaCsp ? {} : null) },
    origin,
    sessionStorage: storage,
  } as unknown as WorkerScope;
  installWorkers(scope, link, 'RUNTIME');
  const construct = (...args: unknown[]): FakeWorker => new (scope.Worker as unknown as new (...a: unknown[]) => FakeWorker)(...args);
  return { scope, made, blobs, revoked, probeSources, sent, forwarded, FakeWorker, construct, control: (t: string, m: ControlMessage) => control(t, m) };
}

class FakeTrusted {
  toString(): string {
    return 'w.js';
  }
}

const ready = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('installWorkers', () => {
  it('runs a worker native until it knows if the CSP allows blob:', () => {
    const { construct, sent } = setup('starting');
    const worker = construct('w.js');
    expect(worker.url).toBe('w.js');
    expect(sent).toEqual([['worker-skipped', { url: 'https://a.test/app/w.js', reason: 'starting' }]]);
  });

  it('runs a worker native under a CSP with no blob:', async () => {
    const { construct, sent } = setup('csp');
    await ready();
    expect(construct('w.js').url).toBe('w.js');
    expect(sent[0]?.[1]).toMatchObject({ reason: 'csp' });
  });

  it('starts a classic worker from a script with the runtime and the absolute URL', async () => {
    const { construct, blobs } = setup();
    await ready();
    const worker = construct('w.js', { name: 'n' });
    const source = blobs.get(worker.url as string) ?? '';
    expect(source).toContain('RUNTIME');
    expect(source).toContain('sluice_worker.start({"url":"https://a.test/app/w.js","token":"token"})');
    expect(source).toContain('importScripts("https://a.test/app/w.js")');
    expect(worker.options).toEqual({ name: 'n' });

  });

  it('starts a module worker with two static imports, the runtime first', async () => {
    const { construct, blobs } = setup();
    await ready();
    const worker = construct('w.js', { type: 'module' });
    const source = blobs.get(worker.url as string) ?? '';
    const [first, second] = source.split('\n');
    expect(blobs.get(/import "(.*)";/.exec(first ?? '')?.[1] ?? '')).toContain('RUNTIME');
    expect(second).toBe('import "https://a.test/app/w.js";');
  });

  it('sends the token and a port as the first message', async () => {
    const { construct } = setup();
    await ready();
    const [first] = construct('w.js').posted as [[unknown, MessagePort[]]];
    expect(first[0]).toEqual({ sluice: 'token' });
    expect(first[1][0]).toBeInstanceOf(MessagePort);
  });

  it.each([
    ['blob:https://a.test/1', 'blob-url'],
    ['data:text/javascript,1', 'data-url'],
  ])('leaves %s native, and reports it', async (url, reason) => {
    const { construct, sent } = setup();
    await ready();
    expect(construct(url).url).toBe(url);
    expect(sent[0]?.[1]).toMatchObject({ reason });
  });

  it('leaves a cross-origin URL to the native constructor, which throws its own error', async () => {
    const { construct, sent } = setup();
    await ready();
    expect(construct('https://b.test/w.js').url).toBe('https://b.test/w.js');
    expect(sent).toEqual([]);
  });

  it('falls back to the native arguments if the browser refuses a blob:', async () => {
    const { construct, sent, revoked } = setup('ok', { throwOnBlob: true });
    await ready();
    const trusted = new FakeTrusted();
    expect(construct(trusted).url).toBe(trusted);
    expect(sent[0]?.[1]).toMatchObject({ reason: 'refused' });
    expect(revoked.length).toBeGreaterThan(0);
  });

  it('stops at the limit, and the worker still runs', async () => {
    const { construct, sent } = setup();
    await ready();
    for (let i = 0; i < 32; i++) construct('w.js');
    expect(construct('w.js').url).toBe('w.js');
    expect(sent.at(-1)?.[1]).toMatchObject({ reason: 'limit' });
  });

  it('a terminate frees the slot, and is reported once', async () => {
    const { construct, sent } = setup();
    await ready();
    const worker = construct('w.js');
    worker.terminate();
    worker.terminate();
    expect(worker.terminated).toBe(true);
    expect(sent).toEqual([['worker-gone', { workerId: 1 }]]);
  });

  it('keeps the shape of the constructor', () => {
    const { scope, FakeWorker } = setup();
    const Patched = scope.Worker as unknown as typeof FakeWorker;
    expect(Patched.prototype).toBe(FakeWorker.prototype);
    expect(Patched.name).toBe('FakeWorker');
    expect(Patched).not.toBe(FakeWorker);
    expect(Patched.prototype.constructor).toBe(Patched);
    expect(Object.getPrototypeOf(Patched)).toBe(Object.getPrototypeOf(FakeWorker));
  });

  it('a worker that says bye is gone, and frees its slot', async () => {
    const { construct, sent, forwarded } = setup();
    await ready();
    const [[, ports]] = construct('w.js').posted as [[unknown, MessagePort[]]];
    const port = ports[0] as MessagePort;
    port.postMessage('bye');
    await vi.waitFor(() => expect(sent).toEqual([['worker-gone', { workerId: 1 }]]));
    expect(forwarded).toEqual([]);
    port.close();
  });

  it('a worker that never says hello is gone after the timer, and one that did stays', async () => {
    const timers: (() => void)[] = [];
    const { construct, sent } = setup('ok', { timers });
    await ready();
    construct('never.js');
    const [[, ports]] = construct('hello.js').posted as [[unknown, MessagePort[]]];
    const port = ports[0] as MessagePort;
    port.postMessage('');
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const run of timers) run();
    expect(sent).toEqual([['worker-gone', { workerId: 1 }]]);
    port.close();
  });

  it('a slow worker comes back with its hello, and gets the last commands', async () => {
    const timers: (() => void)[] = [];
    const { construct, sent, control } = setup('ok', { timers });
    await ready();
    const [[, ports]] = construct('slow.js').posted as [[unknown, MessagePort[]]];
    const port = ports[0] as MessagePort;
    for (const run of timers) run();
    expect(sent).toEqual([['worker-gone', { workerId: 1 }]]);
    const got: unknown[] = [];
    port.onmessage = (event) => got.push(event.data);
    control('CONFIG', { v: 1, type: 'set-config', id: 2, payload: {} } as unknown as ControlMessage);
    port.postMessage('');
    await vi.waitFor(() => expect(got).toEqual(['CONFIG']));
    control('CAPTURE', { v: 1, type: 'set-capture', id: 3, payload: { traffic: false, previewBytes: 1 } });
    await vi.waitFor(() => expect(got).toEqual(['CONFIG', 'CAPTURE']));
    port.close();
  });

  it('a terminated worker does not come back', async () => {
    const timers: (() => void)[] = [];
    const { construct, control } = setup('ok', { timers });
    await ready();
    const worker = construct('slow.js');
    const [[, ports]] = worker.posted as [[unknown, MessagePort[]]];
    const port = ports[0] as MessagePort;
    for (const run of timers) run();
    worker.terminate();
    const got: unknown[] = [];
    port.onmessage = (event) => got.push(event.data);
    port.postMessage('');
    await new Promise((resolve) => setTimeout(resolve, 20));
    control('CONFIG', { v: 1, type: 'set-config', id: 2, payload: {} } as unknown as ControlMessage);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(got).toEqual([]);
    port.close();
  });

  it('reads inherited options, and sends a value that is no dictionary to the native constructor', async () => {
    const { construct, blobs } = setup();
    await ready();
    const inherited = construct('w.js', Object.create({ type: 'module' }) as object);
    expect(blobs.get(inherited.url as string)).toContain('import "https://a.test/app/w.js"');
    expect(construct('w.js', 1).url).toBe('w.js');
  });

  it('runs a worker native when a meta CSP came after the probe', async () => {
    const { construct, sent } = setup('ok', { metaCsp: true });
    await ready();
    expect(construct('w.js').url).toBe('w.js');
    expect(sent[0]?.[1]).toMatchObject({ reason: 'csp' });
  });

  it('the probe tries what an instrumented worker does', () => {
    const { probeSources } = setup();
    expect(probeSources[0]).toContain('importScripts("https://a.test/__sluice_probe__")');
    expect(probeSources[0]).toContain("x.open('HEAD'");
    expect(probeSources[0]).toContain('securitypolicyviolation');
  });

  it('uses the last result of this path until the new one comes, and saves the new one', async () => {
    const store = new Map([['sluice-worker-probe:/app/', 'ok']]);
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as unknown as Storage;
    const { construct, blobs } = setup('csp', { storage });
    const early = construct('w.js');
    expect(blobs.get(early.url as string)).toContain('RUNTIME');
    await ready();
    expect(store.get('sluice-worker-probe:/app/')).toBe('csp');
    expect(construct('w.js').url).toBe('w.js');
  });

  it('works when the storage throws', () => {
    const storage = { getItem: () => { throw new Error('off'); }, setItem: () => { throw new Error('off'); } } as unknown as Storage;
    expect(() => setup('ok', { storage })).not.toThrow();
  });

  it('an opaque frame is no match, so the native constructor decides', async () => {
    const { construct, sent } = setup('ok', { origin: 'null' });
    await ready();
    expect(construct('w.js').url).toBe('w.js');
    expect(sent).toEqual([]);
  });

  it('reads the type of the options once, and as text', async () => {
    const { construct, blobs } = setup();
    await ready();
    const getter = vi.fn(() => ({ toString: () => 'module' }));
    const worker = construct('w.js', { get type() { return getter(); } });
    expect(getter).toHaveBeenCalledTimes(1);
    expect(worker.options?.type).toBe('module');
    expect(blobs.get(worker.url as string)).toContain('import "https://a.test/app/w.js"');
  });

  it('converts a plain object URL once', async () => {
    const { construct } = setup('csp');
    await ready();
    let n = 0;
    expect(construct({ toString: () => `w${++n}.js` }).url).toBe('w1.js');
  });

  it('gives the last config to a new worker from its start, so a first access has it', async () => {
    const { construct, control, blobs } = setup();
    await ready();
    control('CONFIG', { v: 1, type: 'set-config', id: 2, payload: { config: { enabled: false } } } as unknown as ControlMessage);
    expect(blobs.get(construct('w.js').url as string)).toContain('"config":{"enabled":false}');
  });

  it('a worker cannot break out of the message that wraps its report', async () => {
    const { construct, forwarded } = setup();
    await ready();
    const [[, ports]] = construct('w.js').posted as [[unknown, MessagePort[]]];
    const port = ports[0] as MessagePort;
    port.postMessage('1},"payload":{"workerId":99,"url":"u","message":{"a":1}');
    port.postMessage('{"a":1}');
    await vi.waitFor(() => expect(forwarded).toHaveLength(1));
    expect(JSON.parse(forwarded[0] as string)).toMatchObject({ type: 'worker-message', payload: { workerId: 1, message: { a: 1 } } });
    port.close();
  });

  it('throws the native error with no arguments', async () => {
    const { construct } = setup();
    await ready();
    expect(() => construct()).toThrow('needs a URL');
  });

  it('tells a panel that opens later about skipped workers', async () => {
    const { construct, sent, control } = setup();
    await ready();
    construct('blob:https://a.test/1');
    sent.length = 0;
    const capture = (traffic: boolean): ControlMessage => ({ v: 1, type: 'set-capture', id: 1, payload: { traffic, previewBytes: 1 } });
    control('off', capture(false));
    expect(sent).toEqual([]);
    control('on', capture(true));
    expect(sent).toEqual([['worker-skipped', { url: 'blob:https://a.test/1', reason: 'blob-url' }]]);
  });

  it('gives a new worker the last commands, the config first', async () => {
    const { construct, control } = setup();
    await ready();
    control('CAPTURE', { v: 1, type: 'set-capture', id: 1, payload: { traffic: true, previewBytes: 1 } });
    control('CONFIG', { v: 1, type: 'set-config', id: 2, payload: {} } as unknown as ControlMessage);
    const [[, ports]] = construct('w.js').posted as [[unknown, MessagePort[]]];
    const port = ports[0] as MessagePort;
    const got: unknown[] = [];
    port.onmessage = (event) => got.push(event.data);
    await vi.waitFor(() => expect(got).toEqual(['CONFIG', 'CAPTURE']));
    port.close();
  });
});
