// Keeps the registered content scripts in line with the granted origins (ADR-8).
// The grants in Chrome are the source of truth. Registered scripts can lag behind them if a sync fails, until the
// next start of the worker, but a script does not run on an origin with no grant (e2e checked).
type RegisteredScript = chrome.scripting.RegisteredContentScript;

export interface ContentScriptApi {
  getAll(): Promise<{ origins?: string[] }>;
  /** Sites with the worker switch on (ADR-14). */
  getWorkerSites(): Promise<string[]>;
  getRegistered(): Promise<{ id: string }[]>;
  register(scripts: RegisteredScript[]): Promise<void>;
  update(scripts: RegisteredScript[]): Promise<void>;
  unregister(ids: string[]): Promise<void>;
}

const definition = (id: string, file: string, world: 'ISOLATED' | 'MAIN', matches: string[], excludeMatches: string[] = []): RegisteredScript => ({
  id,
  js: [file],
  matches,
  excludeMatches,
  world,
  runAt: 'document_start',
  allFrames: true,
  // about:blank, srcdoc and blob: frames of a granted origin.
  matchOriginAsFallback: true,
});

/**
 * A site with the worker switch on gets a bigger runtime in place of the normal one. It must be there before page scripts
 * run, and reading a setting is async, so the registration itself is the setting. A site with no grant does not run it.
 */
const definitions = (matches: string[], workerSites: string[]): RegisteredScript[] => [
  definition('sluice-bridge', 'bridge.js', 'ISOLATED', matches),
  definition('sluice-main', 'inject.js', 'MAIN', matches, workerSites),
  ...(workerSites.length > 0 ? [definition('sluice-main-workers', 'inject-workers.js', 'MAIN', workerSites)] : []),
];

const OWN_IDS = ['sluice-bridge', 'sluice-main', 'sluice-main-workers'];

export async function syncContentScripts(api: ContentScriptApi): Promise<void> {
  const origins = (await api.getAll()).origins ?? [];
  // Read also with no grant left: this read ends the switch of a site whose grant is gone.
  // A failure here must not stop the normal scripts of all sites.
  const workerSites = await api.getWorkerSites().catch(() => []);
  const wanted = origins.length === 0 ? [] : definitions(origins, workerSites);
  const wantedIds = new Set(wanted.map((script) => script.id));
  const present = new Set((await api.getRegistered()).map((script) => script.id).filter((id) => OWN_IDS.includes(id)));

  const stale = [...present].filter((id) => !wantedIds.has(id));
  if (stale.length > 0) await api.unregister(stale);
  const toUpdate = wanted.filter((script) => present.has(script.id));
  const toRegister = wanted.filter((script) => !present.has(script.id));
  // Update, not unregister and register again: a page that loads between the two calls would not be patched. A change of
  // the worker switch does have such a moment, and a page that loads in it runs with no patch until it reloads. The popup
  // asks for that reload anyway.
  if (toUpdate.length > 0) await api.update(toUpdate);
  if (toRegister.length > 0) await api.register(toRegister);
}

/**
 * The switch ends when the grant ends, also a broad one, and also if the worker stopped before it could act on the event.
 * Turning a site on again must not bring back a change to how its workers run.
 */
export async function keepGrantedWorkerSites(
  sites: string[],
  isGranted: (site: string) => Promise<boolean>,
  save: (sites: string[]) => Promise<void>,
): Promise<string[]> {
  // Chrome rejects a pattern that is not valid. It can never have a grant, and it must not stop the sync of the others.
  const granted = await Promise.all(sites.map((site) => isGranted(site).catch(() => false)));
  const kept = sites.filter((_, i) => granted[i]);
  if (kept.length !== sites.length) await save(kept);
  return kept;
}

/** Runs syncs one at a time, so a late one always reads the final state. A failure does not stop the next one. */
export function createSyncQueue(run: () => Promise<void>, report: (err: unknown) => void): () => Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  return () => {
    queue = queue.then(run).catch(report);
    return queue;
  };
}
