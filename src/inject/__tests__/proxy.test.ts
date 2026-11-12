import { describe, expect, it } from 'vitest';
import { proxyPlatform } from '../proxy';
import { MockBidi, MockDatagramDuplex, NativeSource } from './mock-webtransport';

const makeDuplex = () => new MockDatagramDuplex(new NativeSource());

describe('mock sanity: native getters throw on a wrong receiver', () => {
  it('throws Illegal invocation when the receiver is not the target', () => {
    const duplex = makeDuplex();
    const desc = Object.getOwnPropertyDescriptor(MockDatagramDuplex.prototype, 'readable');
    expect(() => desc?.get?.call({})).toThrow('Illegal invocation');
    expect(() => Reflect.get(duplex, 'readable', {})).toThrow('Illegal invocation');
    expect(() => duplex.ping.call({})).toThrow('Illegal invocation');
  });
  it('a naive Proxy without receiver handling breaks', () => {
    const naive = new Proxy(makeDuplex(), {});
    expect(() => naive.maxDatagramSize).toThrow('Illegal invocation');
  });
});

describe('invariant 8: platform object proxy', () => {
  it('invariant 8: getters run with receiver = target', () => {
    const duplex = makeDuplex();
    const proxy = proxyPlatform(duplex, {});
    expect(proxy.maxDatagramSize).toBe(1200);
    expect(proxy.incomingHighWaterMark).toBe(1);
    expect(proxy.writable).toBe(duplex.writable);
  });

  it('invariant 8: methods are bound to the target and work', () => {
    const proxy = proxyPlatform(makeDuplex(), {});
    expect(proxy.ping()).toBe('pong-datagram');
    const { ping } = proxy;
    expect(ping()).toBe('pong-datagram'); // Detached call still works.
  });

  it('invariant 8: a method has the same reference on each access', () => {
    const proxy = proxyPlatform(makeDuplex(), {});
    expect(proxy.ping).toBe(proxy.ping);
  });

  it('invariant 8: constructor is not bound', () => {
    const duplex = makeDuplex();
    const proxy = proxyPlatform(duplex, {});
    expect(proxy.constructor).toBe(MockDatagramDuplex);
    expect(proxy.constructor).toBe(duplex.constructor);
  });

  it('invariant 8: a setter is forwarded to the target', () => {
    const duplex = makeDuplex();
    const proxy = proxyPlatform(duplex, {});
    proxy.incomingHighWaterMark = 5;
    expect(duplex.incomingHighWaterMark).toBe(5);
    expect(proxy.incomingHighWaterMark).toBe(5);
  });

  it('invariant 8: a setter with a wrong receiver throws on the raw object, but not through the proxy', () => {
    const duplex = makeDuplex();
    const proxy = proxyPlatform(duplex, {});
    expect(() => Reflect.set(duplex, 'incomingHighWaterMark', 3, {})).toThrow('Illegal invocation');
    expect(() => {
      proxy.incomingHighWaterMark = 7;
    }).not.toThrow();
    expect(duplex.incomingHighWaterMark).toBe(7);
  });

  it('invariant 8: writable stays native', () => {
    const bidi = new MockBidi(new NativeSource());
    const proxy = proxyPlatform(bidi, { readable: () => 'wrapped' as unknown as ReadableStream });
    expect(proxy.writable).toBe(bidi.writable);
  });

  it('invariant 8: an override replaces the property, others stay native', () => {
    const source = new NativeSource();
    const bidi = new MockBidi(source);
    const replacement = new ReadableStream();
    const proxy = proxyPlatform(bidi, { readable: () => replacement });
    expect(proxy.readable).toBe(replacement);
    expect(bidi.readable).toBe(source.stream);
    expect(proxy.ping()).toBe('pong-bidi');
  });

  it('invariant 8: the override function runs on each access', () => {
    let calls = 0;
    const bidi = new MockBidi(new NativeSource());
    const proxy = proxyPlatform(bidi, { readable: () => (calls++, new ReadableStream()) });
    void proxy.readable;
    void proxy.readable;
    expect(calls).toBe(2);
  });

  it('invariant 8: inherited names like toString are not mistaken for overrides', () => {
    const proxy = proxyPlatform(makeDuplex(), {});
    expect(typeof proxy.toString).toBe('function');
    expect(proxy.toString()).toBe('[object Object]');
    expect(Object.hasOwn(proxy, 'x')).toBe(false);
  });

  it('invariant 8: non-function values are returned as they are', () => {
    const proxy = proxyPlatform({ n: 3, nested: { a: 1 } }, {});
    expect(proxy.n).toBe(3);
    expect(proxy.nested).toBe(proxy.nested);
  });
});
