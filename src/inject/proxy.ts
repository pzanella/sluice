// Proxy for platform objects (datagram duplex, bidi stream). Native getters and methods run with
// receiver = target, or they throw "Illegal invocation".

export function proxyPlatform<T extends object>(target: T, overrides: Partial<Record<PropertyKey, () => unknown>>): T {
  // By function, not by name: the same function keeps its reference, and a new one is never stale.
  const bound = new WeakMap<CallableFunction, unknown>();
  return new Proxy(target, {
    get(t, prop) {
      const override = Object.prototype.hasOwnProperty.call(overrides, prop) ? overrides[prop as string] : undefined;
      if (override) return override();
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== 'function' || prop === 'constructor') return value;
      if (!bound.has(value)) bound.set(value, value.bind(t));
      return bound.get(value);
    },
    set(t, prop, value) {
      return Reflect.set(t, prop, value, t);
    },
  });
}
