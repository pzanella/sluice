// Shown as text only: Preact escapes every value from the page, and nothing from the page becomes a link or HTML.
import { useEffect, useState } from 'preact/hooks';
import { PanelStore } from './store';

/** Longest wait between a message and the screen. */
const RENDER_MS = 200;

/** The one store of the panel. */
export const store = new PanelStore();

export function useStoreVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setVersion(store.version), RENDER_MS);
    return () => clearInterval(id);
  }, []);
  return version;
}
