// Saved config by site, in chrome.storage.local. What is read goes through the validator again: storage can hold data
// from an older version of the extension, and only a valid config may reach a page.
import { configKey } from '../shared/origins';
import { DEFAULT_CONFIG, type RuntimeConfig } from '../shared/rules';
import { validateConfig } from '../shared/validate';

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** One site must not fill the 10 MB of the storage area. JSON can be far larger than the validator's count of patterns. */
const MAX_SAVED_CHARS = 2 * 1024 * 1024;

interface ConfigStore {
  load(origin: string): Promise<RuntimeConfig | null>;
  /** Resolves to an error text, or null. It does not reject. */
  save(origin: string, config: RuntimeConfig): Promise<string | null>;
}

export function createConfigStore(area: StorageArea): ConfigStore {
  return {
    async load(origin) {
      try {
        const key = configKey(origin);
        const stored = (await area.get(key))[key];
        if (stored === undefined) return null;
        const parsed = validateConfig(stored);
        if (parsed.ok) return parsed.value;
        console.error('[Sluice] saved config is not valid and was ignored:', origin, parsed.errors);
        return null;
      } catch (err) {
        console.error('[Sluice] could not read saved config:', err);
        return null;
      }
    },
    async save(origin, config) {
      try {
        const text = JSON.stringify(config);
        // A config with nothing in it needs no place in storage.
        if (text === JSON.stringify(DEFAULT_CONFIG)) {
          await area.remove(configKey(origin));
          return null;
        }
        if (text.length > MAX_SAVED_CHARS) return 'The rules apply to this page, but they are too large to save.';
        await area.set({ [configKey(origin)]: config });
        return null;
      } catch (err) {
        return `The rules apply to this page, but could not be saved: ${String(err).slice(0, 200)}`;
      }
    },
  };
}
