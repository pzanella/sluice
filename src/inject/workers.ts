// Runs the workers of a page through a blob: script that starts a runtime first, then loads the script of the app (ADR-14).
// A blob: base URL changes how relative URLs resolve, so `worker-entry.ts` corrects them inside the worker.
// A worker must not fail because of this: when in doubt, it runs native, and the panel is told. See ADR-14 for the cases
// that cannot be found in advance.
import { PROTOCOL_LIMITS, PROTOCOL_VERSION, type WorkerSkipReason } from '../shared/protocol';
import type { Channel } from './channel';

/** A page can make many workers, and each one holds a port and gets each command. */
const MAX_WORKERS = 32;
/** For the panel that opens later. */
const MAX_SKIPPED = 16;
/** A worker with no hello by then likely failed to load. A slow one says hello later, and it comes back then. */
const REVOKE_AFTER_MS = 30_000;

export interface WorkerScope {
  Worker?: typeof Worker;
  Blob: typeof Blob;
  URL: typeof URL;
  MessageChannel: typeof MessageChannel;
  crypto: Crypto;
  setTimeout: typeof setTimeout;
  document: { baseURI: string; querySelector(selector: string): unknown };
  /** Not `location.origin`: that is 'null' in an about:blank frame, and it is the URL origin in a sandboxed one. */
  origin: string;
  MessagePort?: typeof MessagePort;
  TrustedScriptURL?: new () => object;
  sessionStorage?: Storage;
}

export type WorkerLink = Pick<Channel, 'forward' | 'send' | 'onControl'>;

type ProbeState = 'starting' | 'ok' | 'csp';

/** No such file: the probe needs only the answer of the CSP, which comes before the network. The server sees a 404. */
export const PROBE_PATH = '/__sluice_probe__';
const PROBE_CACHE_KEY = 'sluice-worker-probe';
/** The result of a CSP violation event, which comes after the failed call. */
const PROBE_WAIT_MS = 50;
/** Not JSON, so it cannot be a report. */
export const WORKER_BYE = 'bye';
const META_CSP = 'meta[http-equiv="Content-Security-Policy" i]';

export function installWorkers(scope: WorkerScope, link: WorkerLink, runtimeSource: string): void {
  const Native = scope.Worker;
  if (typeof Native !== 'function') return;
  // The page can replace globals later, so these are taken once at install.
  const { Blob: NativeBlob, URL: NativeURL, MessageChannel: NativeChannel } = scope;
  const createObjectURL = NativeURL.createObjectURL.bind(NativeURL);
  const revokeObjectURL = NativeURL.revokeObjectURL.bind(NativeURL);
  const randomUUID = scope.crypto.randomUUID.bind(scope.crypto);
  const nativeSetTimeout = scope.setTimeout.bind(scope);
  const { stringify } = JSON;
  const nativePost = Native.prototype.postMessage;
  const nativeTerminate = Native.prototype.terminate;
  const querySelector = scope.document.querySelector.bind(scope.document);
  const baseURI = (): string => scope.document.baseURI;
  const pageOrigin = scope.origin;
  const { apply } = Reflect;
  const postToPort = scope.MessagePort?.prototype.postMessage;
  const NativeTrustedUrl = scope.TrustedScriptURL;
  const { parse } = JSON;
  const send = (port: MessagePort, text: string): void => {
    if (postToPort) apply(postToPort, port, [text]);
    else port.postMessage(text);
  };

  const ports = new Map<number, MessagePort>();
  const ids = new WeakMap<Worker, number>();
  let nextId = 0;
  let forwardId = 0;
  let lastConfig: string | null = null;
  let lastConfigValue: unknown;
  let lastCapture: string | null = null;
  const skipped = new Map<string, WorkerSkipReason>();

  const blobUrl = (source: string): string => createObjectURL(new NativeBlob([source], { type: 'text/javascript' }));

  const report = (url: string, reason: WorkerSkipReason): void => {
    const short = url.slice(0, PROTOCOL_LIMITS.url);
    if (skipped.size < MAX_SKIPPED) skipped.set(short, reason);
    link.send('worker-skipped', { url: short, reason });
  };

  link.onControl((text, message) => {
    if (message.type === 'hold-resolve' || message.type === 'inject' || message.type === 'connection') {
      // A payload is only for the worker it is about.
      const port = message.payload.workerId === null ? undefined : ports.get(message.payload.workerId);
      if (port) send(port, text);
      return;
    }
    if (message.type === 'replay-arm' || message.type === 'replay-clear') return;
    if (message.type === 'record') {
      for (const port of ports.values()) send(port, text);
      return;
    }
    if (message.type === 'set-config') {
      lastConfig = text;
      lastConfigValue = message.payload.config;
    } else {
      lastCapture = text;
    }
    for (const port of ports.values()) send(port, text);
    // set-capture with traffic on means that a panel is there, and it has not seen these.
    if (message.type === 'set-capture' && message.payload.traffic) {
      for (const [url, reason] of skipped) link.send('worker-skipped', { url, reason });
    }
  });

  // A CSP can make an instrumented worker fail with only a late error event, when the constructor has long returned. The
  // worker has the CSP of the page, not the one of its script. So a worker that does nothing first tries the three things
  // an instrumented worker does: start from a blob:, load a script of the site, and make the request of `start`.
  // The result takes two round trips and the wait for a violation, and many pages make a worker sooner.
  // So the last result of this tab and path is used until the new one comes.
  const cacheKey = `${PROBE_CACHE_KEY}:${(() => {
    try {
      return new NativeURL(baseURI()).pathname;
    } catch {
      return '';
    }
  })()}`;
  const storage = ((): Storage | null => {
    try {
      return scope.sessionStorage ?? null; // The getter throws in a sandboxed frame.
    } catch {
      return null;
    }
  })();
  let probe: ProbeState = 'starting';
  try {
    const cached = storage?.getItem(cacheKey);
    if (cached === 'ok' || cached === 'csp') probe = cached;
  } catch {
    // Storage can be off.
  }
  try {
    const target = stringify(`${pageOrigin}${PROBE_PATH}`);
    const url = blobUrl(
      `let blocked=false;addEventListener('securitypolicyviolation',()=>{blocked=true});` +
        `try{importScripts(${target})}catch{}` +
        `try{const x=new XMLHttpRequest();x.open('HEAD',${target},false);x.send()}catch{}` +
        `setTimeout(()=>postMessage(blocked?0:1),${PROBE_WAIT_MS})`,
    );
    const worker = new Native(url);
    const done = (state: ProbeState): void => {
      probe = state;
      nativeTerminate.call(worker);
      revokeObjectURL(url);
      try {
        storage?.setItem(cacheKey, state);
      } catch {
        // Storage can be full or off. The next load then has no early result.
      }
    };
    worker.addEventListener('message', (event) => done((event as MessageEvent).data === 1 ? 'ok' : 'csp'), { once: true });
    worker.addEventListener('error', () => done('csp'), { once: true });
  } catch {
    probe = 'csp';
  }

  const instrumentedArgs = (scriptUrl: string, isModule: boolean, token: string): { url: string; revoke: () => void } => {
    const start = `(function(){${runtimeSource}\n;sluice_worker.start(${stringify({ url: scriptUrl, token, config: lastConfigValue })});})();`;
    if (!isModule) {
      const url = blobUrl(`${start}\nimportScripts(${stringify(scriptUrl)});`);
      return { url, revoke: () => revokeObjectURL(url) };
    }
    // Two static imports, in order. A dynamic import would end the first turn with no listener of the app, so its first
    // message would be lost.
    const runtimeUrl = blobUrl(start);
    const url = blobUrl(`import ${stringify(runtimeUrl)};\nimport ${stringify(scriptUrl)};`);
    return {
      url,
      revoke: () => {
        revokeObjectURL(url);
        revokeObjectURL(runtimeUrl);
      },
    };
  };

  /** Null when the worker must run with the arguments of the app. */
  const prepare = (url: string): string | null => {
    let parsed: URL;
    try {
      parsed = new NativeURL(url, baseURI());
    } catch {
      return null; // The native constructor throws its own error.
    }
    if (parsed.protocol === 'blob:') return report(parsed.href, 'blob-url'), null;
    if (parsed.protocol === 'data:') return report(parsed.href.slice(0, 64), 'data-url'), null;
    // Cross-origin: the native constructor throws its own SecurityError.
    if (parsed.origin !== pageOrigin) return null;
    // A meta CSP comes after the probe, so the probe cannot know it.
    if (querySelector(META_CSP)) return report(parsed.href, 'csp'), null;
    if (probe !== 'ok') return report(parsed.href, probe), null;
    if (ports.size >= MAX_WORKERS) return report(parsed.href, 'limit'), null;
    return parsed.href;
  };

  const gone = (id: number): void => {
    if (ports.delete(id)) link.send('worker-gone', { workerId: id });
  };

  const SluiceWorker = function (this: unknown, ...args: unknown[]): Worker {
    if (!new.target) return (Native as unknown as (...a: unknown[]) => Worker)(...args);
    // Rest arguments: with no arguments the native constructor throws its own TypeError.
    if (args.length === 0) return Reflect.construct(Native, args, new.target) as Worker;
    const first = args[0];
    // A TrustedScriptURL stays as it is if the worker runs native. Anything else is converted once: toString() can change.
    const text = `${first as string}`;
    const nativeArgs = [NativeTrustedUrl && first instanceof NativeTrustedUrl ? first : text, ...args.slice(1)];
    const scriptUrl = prepare(text);
    if (scriptUrl === null) return Reflect.construct(Native, nativeArgs, new.target) as Worker;

    const token = randomUUID();
    // Read once, in the order and with the rules of the browser: inherited members count, and a `type` object becomes text.
    // A value that is no dictionary goes to the native constructor, which raises its own TypeError.
    const raw = args[1];
    if (raw !== undefined && raw !== null && typeof raw !== 'object' && typeof raw !== 'function') {
      return Reflect.construct(Native, nativeArgs, new.target) as Worker;
    }
    const options: WorkerOptions = {};
    const given = (raw ?? {}) as WorkerOptions;
    const { credentials, name, type } = given;
    if (credentials !== undefined) options.credentials = credentials;
    if (name !== undefined) options.name = name;
    if (type !== undefined) options.type = `${type}` as WorkerType;
    const blob = instrumentedArgs(scriptUrl, options.type === 'module', token);
    let worker: Worker;
    try {
      worker = Reflect.construct(Native, [blob.url, options], new.target) as Worker;
    } catch {
      // For example Trusted Types, which refuses a plain string.
      blob.revoke();
      report(scriptUrl, 'refused');
      return Reflect.construct(Native, nativeArgs, new.target) as Worker;
    }

    const id = ++nextId;
    const channel = new NativeChannel();
    const shortUrl = scriptUrl.slice(0, PROTOCOL_LIMITS.url);
    let revoked = false;
    let helloed = false;
    let lateHello = false;
    const revoke = (): void => {
      if (revoked) return;
      revoked = true;
      blob.revoke();
    };
    channel.port1.onmessage = (event: MessageEvent<unknown>): void => {
      revoke();
      if (event.data === WORKER_BYE) return gone(id);
      helloed = true;
      if (lateHello && ids.has(worker) && ports.size < MAX_WORKERS) {
        lateHello = false;
        ports.set(id, channel.port1);
        if (lastConfig !== null) send(channel.port1, lastConfig);
        if (lastCapture !== null) send(channel.port1, lastCapture);
      }
      if (typeof event.data !== 'string' || event.data.length === 0) return; // The empty string is the hello.
      try {
        // Parsed first: the text comes from a worker, and pasted as it is, it could close this object and set other fields.
        link.forward(
          stringify({ v: PROTOCOL_VERSION, type: 'worker-message', id: ++forwardId, payload: { workerId: id, url: shortUrl, message: parse(event.data) } }),
        );
      } catch {
        // Not JSON. Only code in the worker that got hold of the port can do this.
      }
    };
    ports.set(id, channel.port1);
    ids.set(worker, id);
    nativeSetTimeout(() => {
      revoke();
      if (helloed) return;
      lateHello = true;
      gone(id); // It failed to load, or it closed itself at once, or it is slow.
    }, REVOKE_AFTER_MS);
    // Before any message of the app, so it is the first one that the worker gets. The runtime stops it there.
    (nativePost as (this: Worker, message: unknown, transfer: Transferable[]) => void).call(worker, { sluice: token }, [channel.port2]);
    if (lastConfig !== null) send(channel.port1, lastConfig);
    if (lastCapture !== null) send(channel.port1, lastCapture);
    return worker;
  };

  // Same prototype object: `instanceof` works both ways.
  Object.defineProperty(SluiceWorker, 'prototype', { value: Native.prototype, writable: false });
  Object.defineProperty(Native.prototype, 'constructor', { value: SluiceWorker, writable: true, configurable: true });
  Object.setPrototypeOf(SluiceWorker, Object.getPrototypeOf(Native) as object);
  Object.defineProperty(SluiceWorker, 'name', { value: Native.name, configurable: true });
  Object.defineProperty(SluiceWorker, 'length', { value: Native.length, configurable: true });
  Object.defineProperty(SluiceWorker, 'toString', { value: () => Function.prototype.toString.call(Native), configurable: true });

  Object.defineProperty(Native.prototype, 'terminate', {
    ...Object.getOwnPropertyDescriptor(Native.prototype, 'terminate'),
    value: function terminate(this: Worker): void {
      nativeTerminate.call(this);
      const id = ids.get(this);
      if (id === undefined) return;
      ids.delete(this);
      gone(id);
    },
  });
  Object.defineProperty(scope, 'Worker', { ...Object.getOwnPropertyDescriptor(scope, 'Worker'), value: SluiceWorker });
}
