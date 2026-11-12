import { describe, expect, it, vi } from 'vitest';
import { correctUrls, finalUrl } from '../worker-entry';

const BASE = 'https://a.test/app/w.js';

function scope() {
  const importScripts = vi.fn();
  const fetch = vi.fn(() => Promise.resolve('ok'));
  const made: unknown[][] = [];
  class Fake {
    args: unknown[];
    constructor(...args: unknown[]) {
      this.args = args;
      made.push(args);
    }
  }
  const open = vi.fn();
  const target = {
    URL,
    Request,
    fetch,
    importScripts,
    Worker: class extends Fake {},
    WebSocket: class extends Fake {},
    EventSource: class extends Fake {},
    XMLHttpRequest: class {
      open = undefined;
      static prototype_open = open;
    },
  };
  (target.XMLHttpRequest.prototype as unknown as { open: unknown }).open = open;
  return { target, importScripts, fetch, open, made };
}

const run = () => {
  const s = scope();
  correctUrls(s.target as unknown as Parameters<typeof correctUrls>[0], BASE);
  return s;
};

describe('correctUrls', () => {
  it('importScripts resolves against the real script', () => {
    const { target, importScripts } = run();
    target.importScripts('b.js', '/c.js');
    expect(importScripts).toHaveBeenCalledWith('https://a.test/app/b.js', 'https://a.test/c.js');
  });

  it('fetch resolves a string and a URL, and leaves a Request as it is', async () => {
    const { target, fetch } = run();
    await (target.fetch as unknown as (input: unknown, init?: unknown) => Promise<unknown>)('x', { method: 'POST' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://a.test/app/x');
    expect(init.referrer).toBe(BASE);
    expect(init.method).toBe('POST');
    const request = new Request('https://b.test/y');
    await (target.fetch as unknown as (input: unknown) => Promise<unknown>)(request);
    expect(fetch).toHaveBeenLastCalledWith(request, undefined);
  });

  it('new Request resolves a relative URL', () => {
    const { target } = run();
    const request = new target.Request('x');
    expect(request.url).toBe('https://a.test/app/x');
    expect(request).toBeInstanceOf(Request);
  });

  it.each(['Worker', 'WebSocket', 'EventSource'] as const)('new %s resolves a relative URL and keeps the other arguments', (name) => {
    const { target, made } = run();
    new (target[name] as unknown as new (...a: unknown[]) => object)('x.js', { o: 1 });
    expect(made[0]).toEqual(['https://a.test/app/x.js', { o: 1 }]);
  });

  it('XMLHttpRequest.open resolves a relative URL and keeps the other arguments', () => {
    const { target, open } = run();
    (target.XMLHttpRequest.prototype as unknown as { open: (...a: unknown[]) => void }).open.call({}, 'GET', 'x', true);
    expect(open).toHaveBeenCalledWith('GET', 'https://a.test/app/x', true);
  });

  it('a referrer of the app wins over the one a native worker would send', async () => {
    const { target, fetch } = run();
    await (target.fetch as unknown as (input: unknown, init?: unknown) => Promise<unknown>)('x', { referrer: '' });
    expect(fetch).toHaveBeenCalledWith('https://a.test/app/x', { referrer: '' });
  });

  it('keeps inherited members of init, as a Request used as init has only those', () => {
    const { target } = run();
    const old = new Request('https://b.test/', { method: 'PUT', headers: { 'x-a': '1' } });
    const next = new target.Request('y', old);
    expect(next.url).toBe('https://a.test/app/y');
    expect(next.method).toBe('PUT');
    expect(next.headers.get('x-a')).toBe('1');
    expect(new target.Request('y', Object.create({ method: 'PUT' }) as RequestInit).method).toBe('PUT');
  });

  it('a Request as init gets the referrer of the script, and a value of the app stays', () => {
    const { target } = run();
    expect(new target.Request('y', new Request('https://b.test/')).referrer).toBe(BASE);
    expect(new target.Request('y', { referrer: '' }).referrer).toBe('');
  });

  it('an init that is no dictionary reaches the native API', () => {
    const { target } = run();
    expect(() => new (target.Request as unknown as new (u: string, i: number) => object)('y', 1)).toThrow(TypeError);
  });

  it('leaves text that is no URL to the native API, so it raises its own error', () => {
    const { target, importScripts } = run();
    target.importScripts('http://[');
    expect(importScripts).toHaveBeenCalledWith('http://[');
  });

  it('calls with missing arguments reach the native API', async () => {
    const { target, fetch, open } = run();
    await (target.fetch as unknown as () => Promise<unknown>)();
    expect(fetch).toHaveBeenCalledWith();
    (target.XMLHttpRequest.prototype as unknown as { open: (...a: unknown[]) => void }).open.call({}, 'GET');
    expect(open).toHaveBeenCalledWith('GET');
    expect(() => new (target.Request as unknown as new () => object)()).toThrow(TypeError);
  });

  it('the constructor link points to the wrapper', () => {
    const { target } = run();
    expect(new target.Request('x').constructor).toBe(target.Request);
    expect(target.Worker.prototype.constructor).toBe(target.Worker);
  });

  it('location shows the real script', () => {
    const { target } = run();
    const { location } = target as unknown as { location: URL };
    expect(location.href).toBe(BASE);
    expect(location.origin).toBe('https://a.test');
  });
});

describe('finalUrl', () => {
  const REQUESTED = 'https://a.test/app/w.js';

  function scopeWith(answers: Record<string, string | Error>) {
    const methods: string[] = [];
    class Xhr {
      private method = '';
      responseURL = '';
      open(method: string): void {
        this.method = method;
        methods.push(method);
      }
      send(): void {
        const answer = answers[this.method];
        if (answer instanceof Error) throw answer;
        this.responseURL = answer ?? '';
      }
    }
    return { scope: { URL, XMLHttpRequest: Xhr } as unknown as Parameters<typeof finalUrl>[0], methods };
  }

  it('follows a redirect on the same origin', () => {
    const { scope } = scopeWith({ HEAD: 'https://a.test/sub/w2.js' });
    expect(finalUrl(scope, REQUESTED)).toBe('https://a.test/sub/w2.js');
  });

  it('stops on a redirect to another origin', () => {
    const { scope } = scopeWith({ HEAD: 'https://b.test/w.js' });
    expect(() => finalUrl(scope, REQUESTED)).toThrow('another origin');
  });

  it('keeps the fragment, which a response URL does not have', () => {
    const { scope } = scopeWith({ HEAD: REQUESTED });
    expect(finalUrl(scope, `${REQUESTED}#cfg=1`)).toBe(`${REQUESTED}#cfg=1`);
  });

  it('tries a GET when the HEAD fails, and the worker runs', () => {
    const { scope, methods } = scopeWith({ HEAD: new Error('NetworkError'), GET: REQUESTED });
    expect(finalUrl(scope, REQUESTED)).toBe(REQUESTED);
    expect(methods).toEqual(['HEAD', 'GET']);
  });

  it('stops when the GET fails too', () => {
    const { scope } = scopeWith({ HEAD: new Error('NetworkError'), GET: new Error('NetworkError') });
    expect(() => finalUrl(scope, REQUESTED)).toThrow('NetworkError');
  });
});
