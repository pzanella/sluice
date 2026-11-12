// Which pages Sluice can run on. WebTransport needs a secure context, so https pages and localhost are enough.
// Keep this in line with `optional_host_permissions` in the manifest.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Where the rules of a site are saved in chrome.storage.local. */
export const CONFIG_KEY_PREFIX = 'config:';
export const configKey = (origin: string): string => `${CONFIG_KEY_PREFIX}${origin}`;

/** Where the list of sites with the worker switch on is saved in chrome.storage.local, as match patterns (ADR-14). */
export const WORKER_SITES_KEY = 'worker-sites';

export function readWorkerSites(stored: Record<string, unknown>): string[] {
  const list = stored[WORKER_SITES_KEY];
  return Array.isArray(list) ? list.filter((site): site is string => typeof site === 'string') : [];
}

/** The match pattern to grant for a page, or null if Sluice cannot run there. It covers every port of the host. */
export function originPattern(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const { protocol, hostname, pathname } = parsed;
  // `*` is legal in a URL host and means every host in a match pattern: `https://*/` would ask for all sites.
  if (hostname.includes('*')) return null;
  // Chrome does not let extensions run on its store, so the popup would say "On" with no effect.
  if (hostname === 'chromewebstore.google.com') return null;
  if (hostname === 'chrome.google.com' && pathname.startsWith('/webstore')) return null;
  if (protocol === 'https:' && hostname) return `https://${hostname}/*`;
  if (protocol === 'http:' && LOCAL_HOSTS.includes(hostname)) return `http://${hostname}/*`;
  return null;
}
