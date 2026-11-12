// The runtime inside an instrumented worker. Bundled into a string in the runtime of the frame (see workers.ts).
// It runs before the script of the app. The worker has a blob: base URL, so this also corrects relative URLs (ADR-14).
import { createChannel, type ChannelEnv } from './channel';
import { WORKER_BYE } from './workers';
import { install } from './patch';
import { installPlayback } from './playback';
import type { RuntimeConfig } from '../shared/rules';

/** Reports from before the first message of the page. A session opened in the first turn must not be lost. */
const MAX_EARLY = 256;

/** The globals of a dedicated worker. The project types the window scope only. */
interface Scope {
  URL: typeof URL;
  Request: typeof Request;
  fetch: typeof fetch;
  importScripts(...urls: (string | URL)[]): void;
  close(): void;
  XMLHttpRequest?: typeof XMLHttpRequest;
  setTimeout: typeof setTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

/** The APIs that take a relative URL. Others, such as a stack trace or the Cache API, still use the blob: URL (ADR-14). */
export function correctUrls(scope: Scope, base: string): void {
  const NativeURL = scope.URL;
  // Text that is no URL goes on as it is, so the native API raises its own error, and fetch rejects and does not throw.
  const absolute = (url: unknown): string => {
    const text = `${url as string}`;
    try {
      return new NativeURL(text, base).href;
    } catch {
      return text;
    }
  };

  const nativeImportScripts = scope.importScripts.bind(scope);
  scope.importScripts = (...urls) => nativeImportScripts(...urls.map(absolute));

  const NativeRequest = scope.Request;
  // A blob: client sends no Referer, and a native worker sends the URL of its script.
  // A Proxy, not a copy: the browser also reads inherited members of `init`, and `new Request(url, oldRequest)` has only those.
  const withReferrer = (init: unknown): unknown => {
    if (init === undefined || init === null) return { referrer: base };
    if (typeof init !== 'object' && typeof init !== 'function') return init; // The native API raises its own TypeError.
    return new Proxy(init, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        return key === 'referrer' && (value === undefined || value === 'about:client') ? base : value;
      },
    });
  };
  const nativeFetch = scope.fetch.bind(scope);
  scope.fetch = (...args: unknown[]) => {
    if (args.length === 0) return (nativeFetch as () => Promise<Response>)();
    const [input, init] = args as Parameters<typeof fetch>;
    return input instanceof NativeRequest ? nativeFetch(input, init) : nativeFetch(absolute(input), withReferrer(init) as RequestInit);
  };

  const keepShape = (proxy: object, Native: { prototype: object }): void => {
    Object.defineProperty(Native.prototype, 'constructor', { value: proxy, writable: true, configurable: true });
  };

  const RequestProxy = new Proxy(NativeRequest, {
    construct(target, args: unknown[], newTarget) {
      if (args.length === 0 || args[0] instanceof NativeRequest) return Reflect.construct(target, args, newTarget) as object;
      return Reflect.construct(target, [absolute(args[0]), withReferrer(args[1])], newTarget) as object;
    },
  });
  scope.Request = RequestProxy;
  keepShape(RequestProxy, NativeRequest);

  const wrapConstructor = (name: 'Worker' | 'WebSocket' | 'EventSource'): void => {
    const globals = scope as unknown as Record<string, unknown>;
    const Native = globals[name] as (new (url: string, ...rest: unknown[]) => object) | undefined;
    if (typeof Native !== 'function') return;
    const proxy = new Proxy(Native, {
      construct(target, args: unknown[], newTarget) {
        if (args.length > 0) args[0] = absolute(args[0]);
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
    globals[name] = proxy;
    keepShape(proxy, Native);
  };
  wrapConstructor('Worker');
  wrapConstructor('WebSocket');
  wrapConstructor('EventSource');

  const xhr = scope.XMLHttpRequest?.prototype;
  const open = xhr?.open;
  if (xhr && open) {
    xhr.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
      if (args.length >= 2) args[1] = absolute(args[1]);
      (open as (...a: unknown[]) => void).apply(this, args);
    } as typeof open;
  }

  Object.defineProperty(scope, 'location', { value: new NativeURL(base), configurable: true });
}

/**
 * The URL that a native worker would have. A blob: start has no way to read it, and a redirect changes the base URL.
 * A native worker refuses a redirect to another origin, and `importScripts` does not, so this stops the worker there: code of
 * another site must not get the rules. HEAD first, as it costs less. A service worker of the page can fail on a HEAD, so a GET,
 * the request that native makes, has the last word.
 */
export function finalUrl(scope: Scope, url: string): string {
  const Xhr = scope.XMLHttpRequest;
  if (!Xhr) return url;
  const responseUrl = (method: string): string => {
    const request = new Xhr();
    request.open(method, url, false);
    request.send();
    return request.responseURL;
  };
  let received: string;
  try {
    received = responseUrl('HEAD');
  } catch {
    received = responseUrl('GET');
  }
  const final = new scope.URL(received || url);
  const requested = new scope.URL(url);
  if (final.origin !== requested.origin) throw new TypeError('The worker script redirected to another origin.');
  // A response URL has no fragment, and a worker can read its settings from `location.hash`.
  if (!final.hash) final.hash = requested.hash;
  return final.href;
}

export function start({ url: requested, token, config }: { url: string; token: string; config?: RuntimeConfig }): void {
  const scope = globalThis as unknown as Scope;
  const NativeURL = scope.URL;
  const url = finalUrl(scope, requested);
  const absolute = (text: string): string => new NativeURL(text, url).href;
  correctUrls(scope, url);

  // Taken now: code in the worker runs later, and it could replace these to get hold of the port.
  const { apply } = Reflect;
  const postToPort = MessagePort.prototype.postMessage;
  const post = (target: MessagePort, text: string): void => void apply(postToPort, target, [text]);
  let port: MessagePort | null = null;
  const early: string[] = [];
  let onControl: (detail: unknown) => void = () => undefined;
  const { now } = Date;
  const { stringify, parse } = JSON;
  const nativeSetTimeout = scope.setTimeout.bind(scope);
  const nativeSetInterval = scope.setInterval.bind(scope);
  const nativeClearInterval = scope.clearInterval.bind(scope);
  const env: ChannelEnv = {
    dispatch(_type, detail) {
      if (port) post(port, detail);
      else if (early.length < MAX_EARLY) early.push(detail);
    },
    listen(_type, handler) {
      onControl = handler;
    },
    setTimeout: (run, ms) => void nativeSetTimeout(run, ms),
    setInterval: (run, ms) => nativeSetInterval(run, ms) as unknown as number,
    clearInterval: (id) => nativeClearInterval(id),
    now: () => now(),
    stringify: (value) => stringify(value),
    parse: (text) => parse(text) as unknown,
    absoluteUrl: absolute,
  };
  const channel = createChannel('worker', env, true);
  const runtime = install(scope as unknown as Parameters<typeof install>[0], {
    events: channel.events,
    gate: channel.gate,
    resolveUrl: absolute,
    ...(config ? { config } : {}),
  });
  if (runtime) channel.attach(runtime);
  installPlayback(scope as unknown as Parameters<typeof installPlayback>[0], { now: () => now(), setInterval: (run, ms) => nativeSetInterval(run, ms), report: (report) => channel.playback(report) });

  // First, so it runs before any listener of the app. The first message of the page is for this one, and the app must not
  // see it. Later messages pass, also one that looks the same but has another token.
  const onHello = (event: MessageEvent<unknown>): void => {
    if ((event.data as { sluice?: unknown } | null)?.sluice !== token) return;
    event.stopImmediatePropagation();
    scope.removeEventListener('message', onHello);
    const [received] = event.ports;
    if (!received) return;
    port = received;
    port.onmessage = (message: MessageEvent<unknown>) => onControl(message.data);
    post(port, ''); // The blob can go now.
    for (const text of early.splice(0)) post(port, text);
  };
  scope.addEventListener('message', onHello);

  // Chromium fires no `close` on the other port when a worker closes itself, so MAIN must be told, or the slot stays taken.
  const nativeClose = scope.close.bind(scope);
  scope.close = () => {
    if (port) post(port, WORKER_BYE);
    nativeClose();
  };
}
