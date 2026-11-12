// Service worker: keeps the content scripts in line with the granted origins, routes messages by tabId, stores rules.
import { CONFIG_KEY_PREFIX, originPattern, readWorkerSites, WORKER_SITES_KEY } from '../shared/origins';
import { GET_PAGE_STATUS } from '../shared/page-status';
import { createBadges } from './badge';
import { createConfigStore } from './config-store';
import { createSyncQueue, keepGrantedWorkerSites, syncContentScripts } from './content-scripts';
import { createRouter } from './router';

/**
 * A sync can fail while dist/ is being built again: Chrome checks that each file exists, and for a moment it does not. It tries
 * again a few times, and says it failed only when all tries failed: a failed try that the next one fixes is not an error.
 */
const SYNC_TRIES = 5;
let syncRetries = 0;
const sync = createSyncQueue(
  async () => {
    await syncContentScripts({
      getAll: () => chrome.permissions.getAll(),
      getWorkerSites: async () =>
        keepGrantedWorkerSites(
          readWorkerSites(await chrome.storage.local.get(WORKER_SITES_KEY)),
          (site) => chrome.permissions.contains({ origins: [site] }),
          (sites) => chrome.storage.local.set({ [WORKER_SITES_KEY]: sites }),
        ),
      getRegistered: () => chrome.scripting.getRegisteredContentScripts(),
      register: (scripts) => chrome.scripting.registerContentScripts(scripts),
      update: (scripts) => chrome.scripting.updateContentScripts(scripts),
      unregister: (ids) => chrome.scripting.unregisterContentScripts({ ids }),
    });
    syncRetries = 0;
  },
  (err) => {
    if (syncRetries >= SYNC_TRIES) {
      syncRetries = 0;
      console.error('[Sluice] content script sync failed: Sluice does not run on the sites. Reload the extension.', err);
      return;
    }
    syncRetries++;
    console.info(`[Sluice] content script sync: try ${syncRetries} of ${SYNC_TRIES} failed, trying again.`, err);
    setTimeout(() => void sync(), 1000 * syncRetries);
  },
);

// Listeners must be added in the first turn of the worker, so Chrome can wake it for these events.
// An update of the extension clears registered scripts, so onInstalled must sync too.
chrome.runtime.onInstalled.addListener(() => void sync());
chrome.runtime.onStartup.addListener(() => void sync());
const badges = createBadges(
  {
    askPage: (tabId) => chrome.tabs.sendMessage(tabId, { type: GET_PAGE_STATUS }, { frameId: 0 }),
    isGranted: (pattern) => chrome.permissions.contains({ origins: [pattern] }),
    tabIds: async () => (await chrome.tabs.query({})).flatMap((tab) => (tab.id === undefined ? [] : [tab.id])),
    show: async (tabId, view) => {
      await chrome.action.setBadgeText({ tabId, text: view.text });
      await chrome.action.setTitle({ tabId, title: view.title });
      if (view.color) await chrome.action.setBadgeBackgroundColor({ tabId, color: view.color });
    },
  },
  chrome.runtime.id,
);
const onGrantChange = (): void => {
  void sync();
  void badges.updateAll();
  router.siteChanged();
};
chrome.permissions.onAdded.addListener(onGrantChange);
chrome.permissions.onRemoved.addListener(onGrantChange);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (WORKER_SITES_KEY in changes) void sync();
  if (Object.keys(changes).some((key) => key.startsWith(CONFIG_KEY_PREFIX))) router.siteChanged();
});
chrome.runtime.onMessage.addListener((message: unknown, sender) => badges.onMessage(message, sender));

const configs = createConfigStore(chrome.storage.local);
// By default content scripts can read this area. Rules of all sites are here, and no content script needs them.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch((err: unknown) => {
  console.error('[Sluice] could not restrict the storage:', err);
});

const router = createRouter({
  loadConfig: (origin, done) => void configs.load(origin).then(done),
  saveConfig: (origin, config, done) => void configs.save(origin, config).then(done),
  isGranted: (origin, done) => {
    const pattern = originPattern(origin);
    if (!pattern) return done(false);
    chrome.permissions.contains({ origins: [pattern] }).then(done, () => done(false));
  },
  extensionId: chrome.runtime.id,
  panelUrl: chrome.runtime.getURL('panel/panel.html'),
  now: () => Date.now(),
  wakeTab: (tabId, force) => {
    // No listener answers when no frame of the tab has a script. That is normal, so the error is ignored.
    chrome.tabs.sendMessage(tabId, { type: 'wake', force: force === true }).catch(() => undefined);
  },
});
chrome.runtime.onConnect.addListener((port) => router.connect(port));

// Each start of the worker repairs a sync that failed, or that stopped when the worker was killed.
void sync();
