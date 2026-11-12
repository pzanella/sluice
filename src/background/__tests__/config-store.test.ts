import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type RuntimeConfig } from '../../shared/rules';
import { createConfigStore } from '../config-store';

const memory = (): { data: Record<string, unknown>; get(k: string): Promise<Record<string, unknown>>; set(i: Record<string, unknown>): Promise<void>; remove(k: string): Promise<void> } => ({
  data: {},
  remove(key) {
    Reflect.deleteProperty(this.data, key);
    return Promise.resolve();
  },
  get(key) {
    return Promise.resolve(key in this.data ? { [key]: this.data[key] } : {});
  },
  set(items) {
    Object.assign(this.data, items);
    return Promise.resolve();
  },
});

const withRule: RuntimeConfig = { ...DEFAULT_CONFIG, rules: [{ id: 'r', action: { type: 'drop' } }] };

describe('config store', () => {
  it('removes a site when its config has nothing in it', async () => {
    const area = memory();
    const store = createConfigStore(area);
    await store.save('https://a.test', withRule);
    await store.save('https://a.test', DEFAULT_CONFIG);
    expect(area.data).toEqual({});
  });

  it('does not save a config that is too large', async () => {
    const area = memory();
    const big: RuntimeConfig = { ...DEFAULT_CONFIG, rules: [{ id: 'r', match: { contains: ['x'.repeat(3 * 1024 * 1024)] }, action: { type: 'drop' } }] };
    expect(await createConfigStore(area).save('https://a.test', big)).toContain('too large');
    expect(area.data).toEqual({});
  });

  it('keeps each site apart', async () => {
    const store = createConfigStore(memory());
    expect(await store.save('https://a.test', withRule)).toBeNull();
    expect(await store.load('https://a.test')).toEqual(withRule);
    expect(await store.load('https://b.test')).toBeNull();
  });

  it('ignores a saved value that is no longer valid', async () => {
    const area = memory();
    area.data['config:https://a.test'] = { ...DEFAULT_CONFIG, maxDelayedBytes: -1 };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await createConfigStore(area).load('https://a.test')).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('turns a failed read into nothing, and a failed save into a text', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = createConfigStore({
      get: () => Promise.reject(new Error('read')),
      set: () => Promise.reject(new Error('QUOTA')),
      remove: () => Promise.resolve(),
    });
    expect(await store.load('https://a.test')).toBeNull();
    expect(await store.save('https://a.test', withRule)).toContain('QUOTA');
    error.mockRestore();
  });
});
