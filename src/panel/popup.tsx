// Turns Sluice on or off for the site of the current tab (ADR-8). The service worker registers the scripts when
// the permission changes, so this page has only the permission calls. Chrome can close it while its dialog is open.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { configKey, originPattern, readWorkerSites, WORKER_SITES_KEY } from '../shared/origins';
import { GET_PAGE_STATUS, pageState, parsePageStatus, type PageState, type PageStatus } from '../shared/page-status';
import './tokens.css';
import './popup.css';
import './controls.css';

interface Site {
  tabId: number;
  host: string;
  pattern: string;
  origin: string;
  granted: boolean;
  /** Null when the page did not answer. */
  patched: boolean | null;
  workers: boolean;
}

/** `opaque`: the page runs Sluice but has no site that a grant could cover. */
type Loaded = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'no-answer' } | { kind: 'opaque' } | { kind: 'site'; site: Site };

/** A hung page cannot answer, and this page must still work then: its buttons are the way out. */
const PAGE_ANSWER_MS = 500;

const NOT_RUNNING: PageStatus = { patched: false, origin: '' };

/** Null when the page did not answer. */
const askPage = (tabId: number): Promise<PageStatus | null> =>
  Promise.race([
    chrome.tabs
      .sendMessage(tabId, { type: GET_PAGE_STATUS }, { frameId: 0 })
      // No script answers, or the answer makes no sense: not running. A script left by an old version of the extension
      // cannot answer either, and it still runs until the page reloads (ADR-13).
      .then((answer: unknown) => parsePageStatus(answer) ?? NOT_RUNNING)
      .catch(() => NOT_RUNNING),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), PAGE_ANSWER_MS)),
  ]);

/** One short line for the state, and one for what to do. */
const STATE_TEXT: Record<PageState, { status: string; note: string }> = {
  running: { status: '● On for this site', note: 'Open DevTools, then the Sluice tab.' },
  pending: { status: '◐ On for this site: reload to start', note: 'This page was open before you turned Sluice on.' },
  stale: { status: '◐ Off for this site: reload to stop', note: 'This page still runs Sluice until you reload it.' },
  off: { status: '○ Off for this site', note: 'Sluice reads and changes WebTransport traffic only on the sites you turn on.' },
  unknown: { status: '? This page does not answer', note: 'It may be busy or hung. If it is hung, close the tab.' },
};

async function loadSite(): Promise<Loaded> {
  // activeTab gives the URL of this tab, and only after the user opens the popup.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return { kind: 'unavailable' };
  const status = await askPage(tab.id);
  // A patched page is a place Sluice runs, whatever its URL says: about:blank and blob: pages have the origin of their
  // creator. Without this, a page could navigate there and hide from the popup.
  const url = status?.patched ? status.origin : tab.url;
  const pattern = originPattern(url);
  if (!pattern) {
    // With no answer, an about:blank or blob: URL proves nothing: the page may be hung and run Sluice.
    if (status === null) return { kind: 'no-answer' };
    return status.patched ? { kind: 'opaque' } : { kind: 'unavailable' };
  }
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  const { hostname: host, origin } = new URL(url);
  const workers = readWorkerSites(await chrome.storage.local.get(WORKER_SITES_KEY)).includes(pattern);
  return { kind: 'site', site: { tabId: tab.id, host, origin, pattern, granted, patched: status?.patched ?? null, workers } };
}

function App() {
  const [state, setState] = useState<Loaded>({ kind: 'loading' });
  const [error, setError] = useState('');
  const [rulesStep, setRulesStep] = useState<'idle' | 'confirm' | 'deleted'>('idle');
  const [workersChanged, setWorkersChanged] = useState(false);

  useEffect(() => {
    loadSite()
      .then(setState)
      .catch(() => setState({ kind: 'unavailable' }));
  }, []);

  if (state.kind === 'loading') {
    return (
      <main class="popup">
        <h1>Sluice</h1>
      </main>
    );
  }
  if (state.kind === 'unavailable') {
    return (
      <main class="popup">
        <h1>Sluice</h1>
        <p>Sluice cannot run on this page. It runs on https pages and on localhost.</p>
      </main>
    );
  }

  if (state.kind === 'opaque') {
    return (
      <main class="popup">
        <h1>Sluice</h1>
        <div class="status" role="status">● Running on this page</div>
        <p>This page has no site of its own, so Sluice cannot turn it off from here. Close the page to stop it.</p>
      </main>
    );
  }
  if (state.kind === 'no-answer') {
    return (
      <main class="popup">
        <h1>Sluice</h1>
        <div class="status" role="status">{STATE_TEXT.unknown.status}</div>
        <p>{STATE_TEXT.unknown.note} If it is hung, close the tab.</p>
      </main>
    );
  }

  const { site } = state;
  const current = pageState(site.patched, site.granted);
  const text = STATE_TEXT[current];
  const needsReload = current === 'pending' || current === 'stale' || workersChanged || rulesStep === 'deleted';
  const toggle = async (): Promise<void> => {
    setError('');
    const origins = [site.pattern];
    try {
      // Must be the first await: the request needs the user's click.
      const done = site.granted
        ? await chrome.permissions.remove({ origins })
        : await chrome.permissions.request({ origins });
      // Read it back: with a broad grant, Chrome can accept the removal and keep the site on.
      const granted = await chrome.permissions.contains({ origins });
      // The service worker ends the worker switch when a grant ends.
      setState({ kind: 'site', site: { ...site, granted, workers: site.workers && granted } });
      if (site.granted && (!done || granted)) {
        setError('Chrome did not turn this site off. Check the site access of Sluice in chrome://extensions.');
      }
    } catch {
      setError('Chrome did not accept the change. Check the site access of Sluice in chrome://extensions.');
    }
  };
  // Here and not only in the panel: the panel cannot help if a rule hangs the page.
  const deleteRules = async (): Promise<void> => {
    // Two clicks, as this cannot be undone. The button stays enabled, so keyboard focus does not drop.
    if (rulesStep === 'idle') return setRulesStep('confirm');
    if (rulesStep === 'deleted') return;
    await chrome.storage.local.remove(configKey(site.origin));
    setRulesStep('deleted');
  };
  // Off by default, because it changes how the workers of the page run (ADR-14).
  const toggleWorkers = async (on: boolean): Promise<void> => {
    const sites = readWorkerSites(await chrome.storage.local.get(WORKER_SITES_KEY)).filter((pattern) => pattern !== site.pattern);
    await chrome.storage.local.set({ [WORKER_SITES_KEY]: on ? [...sites, site.pattern] : sites });
    setWorkersChanged(true);
    setState({ kind: 'site', site: { ...site, workers: on } });
  };
  const reload = async (): Promise<void> => {
    await chrome.tabs.reload(site.tabId);
    window.close();
  };

  // One main button: the step that comes next. A reload comes first when the page does not match the switch yet.
  const toggleLabel = site.granted ? 'Turn off' : 'Turn on';
  return (
    <main class="popup">
      <h1>{site.host}</h1>
      <div class="status" role="status">{text.status}</div>
      {current === 'unknown' && <p>{site.granted ? 'Sluice is on for this site.' : 'Sluice is off for this site.'}</p>}
      <p>{text.note}</p>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {needsReload ? (
        <div class="actions">
          <button type="button" class="primary main" onClick={() => void reload()}>
            Reload page
          </button>
          <button type="button" class="link" onClick={() => void toggle()}>
            {toggleLabel}
          </button>
        </div>
      ) : (
        <div class="actions">
          <button type="button" class={site.granted ? 'main' : 'primary main'} onClick={() => void toggle()}>
            {toggleLabel}
          </button>
          {current === 'unknown' && (
            <button type="button" class="link" onClick={() => void reload()}>
              Reload page
            </button>
          )}
        </div>
      )}
      {(site.granted || site.patched !== false) && (
        // Closed, as most people never need it. Open on a page that does not answer: it holds the way out of a hung page.
        <details class="more" open={current === 'unknown' || rulesStep !== 'idle'}>
          <summary>More options</summary>
          {site.granted && (
            <div class="option">
              <label>
                <input type="checkbox" checked={site.workers} onChange={(event) => void toggleWorkers(event.currentTarget.checked)} />
                Also inspect workers on this site
              </label>
              <p>This can change how workers run, or stop them. Reload the page to apply a change.</p>
            </div>
          )}
          <div class="option">
            <button type="button" aria-disabled={rulesStep === 'deleted'} onClick={() => void deleteRules()}>
              {rulesStep === 'idle' ? 'Delete rules of this site' : rulesStep === 'confirm' ? 'Click again to delete' : 'Rules deleted'}
            </button>
            <p>
              {rulesStep === 'deleted'
                ? 'The rules of this site are deleted. A page that is open keeps them until you reload it.'
                : 'If a rule hangs this page: delete the rules or turn Sluice off, then reload. If that does not work, close the tab.'}
            </p>
          </div>
        </details>
      )}
    </main>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
