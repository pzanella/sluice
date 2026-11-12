// The DevTools panel: a basic inspector (ADR-3). Every value from the page is shown as text. Preact escapes it, and
// nothing from the page becomes a link or HTML.
import { render } from 'preact';
import { connectPanel, type Connection } from './connection';
import { hostAndPath } from './format';
import { originPattern } from '../shared/origins';
import { TRACE_PART_EVENTS } from '../shared/protocol';
import { playbackReport } from './playback';
import { monitorReport } from './monitor';
import { store } from './panel-state';
import { App, type SiteConfig } from './app';
import './tokens.css';
import './panel.css';
import './controls.css';

let isConnected = false;
let siteOrigin: string | null | undefined;
let hasNavigated = false;
let siteConfig: SiteConfig | null = null;
let requestId = 0;
const tabId = chrome.devtools.inspectedWindow.tabId;
// Follow DevTools, which can differ from the system.
document.documentElement.dataset.theme = chrome.devtools.panels.themeName === 'dark' ? 'dark' : 'light';

const askForConfig = (connection: Connection): void => {
  if (siteOrigin) connection.send({ v: 1, type: 'get-config', id: ++requestId, payload: { targetOrigin: siteOrigin } });
};

/** The site of the tab. `location` cannot be replaced by a page, and the worker checks the value too. */
const setSite = (url: string | undefined): void => {
  let origin: string | null;
  try {
    origin = url && originPattern(url) ? new URL(url).origin : null;
  } catch {
    origin = null;
  }
  if (origin === siteOrigin) return;
  siteOrigin = origin;
  siteConfig = null;
  askForConfig(connection);
  store.version++;
};

const connection: Connection = connectPanel(
  {
    connect: () => chrome.runtime.connect({ name: `panel:${tabId}` }),
    setTimeout: (run, ms) => void setTimeout(run, ms),
    now: () => Date.now(),
  },
  (message) => {
    if (message.type === 'config') {
      const { targetOrigin, config, error, granted } = message.payload;
      siteConfig = { origin: targetOrigin, config, error, granted };
      store.version++;
    } else if (message.type === 'site-changed') {
      askForConfig(connection);
    } else {
      store.handle(message);
    }
  },
  (connected) => {
    isConnected = connected;
    store.version++;
    // The worker can have restarted, and a save could have been missed.
    if (connected && typeof connection !== 'undefined') askForConfig(connection);
  },
);

chrome.devtools.network.onNavigated.addListener((url) => {
  hasNavigated = true;
  setSite(url);
});
chrome.devtools.inspectedWindow.eval('location.href', (...args) => {
  const url: unknown = args[0];
  // An answer that comes after a navigation is about the last page.
  if (typeof url === 'string' && !hasNavigated) setSite(url);
});

// For tests that open this page, such as the Playwright helper in `examples/playwright`. It is the page of the extension: a site
// cannot read it. No payloads (ADR-44).
Object.defineProperty(window, 'sluice', {
  value: Object.freeze({
    playback: () => Array.from(store.playback.values(), (state) => playbackReport(state, Date.now())),
    report: () =>
      Array.from(store.sessions.values(), (session) => ({
        session: session.sessionId,
        ...monitorReport(session.url && hostAndPath(session.url), session.monitor, store.thresholds, Date.now(), session.closed === null),
      })),
  }),
});

const root = document.getElementById('app');
if (root) {
  render(
    <App
      connected={() => isConnected}
      origin={() => siteOrigin}
      site={() => siteConfig}
      // The origin comes from the form, and it is the one on the screen. The site of the tab can be newer.
      onSave={(origin, config) => connection.send({ v: 1, type: 'set-config', id: ++requestId, payload: { config, targetOrigin: origin } })}
      onRecord={(on) => connection.send({ v: 1, type: 'record', id: ++requestId, payload: { recordId: requestId, on } })}
      onDisarm={() => connection.send({ v: 1, type: 'replay-clear', id: ++requestId, payload: {} })}
      onConnection={(session, action) =>
        connection.send({ v: 1, type: 'connection', id: ++requestId, payload: { documentId: session.documentId, sessionId: session.sessionId, workerId: session.workerId, action } })
      }
      onArm={({ url, protocol, offered, close, events }, { end, overlay }) => {
        const replayId = ++requestId;
        let at = 0;
        do {
          const part = events.slice(at, at + TRACE_PART_EVENTS);
          at += TRACE_PART_EVENTS;
          const sent = connection.send({ v: 1, type: 'replay-arm', id: ++requestId, payload: { replayId, url, ...(protocol === undefined ? {} : { protocol }), ...(offered === undefined ? {} : { offered }), end, overlay, close, events: part, last: at >= events.length } });
          if (!sent) return false;
        } while (at < events.length);
        return true;
      }}
      onInject={(target, kind, data) => {
        const injectId = ++requestId;
        const sent = connection.send({
          v: 1,
          type: 'inject',
          id: injectId,
          payload: { documentId: target.documentId, workerId: target.workerId, injectId, sessionId: target.sessionId, kind, data },
        });
        return sent ? injectId : null;
      }}
      onResolve={(row, { action, data }) =>
        connection.send({
          v: 1,
          type: 'hold-resolve',
          id: ++requestId,
          payload: { documentId: row.documentId, workerId: row.workerId, holdId: row.holdId, action, data },
        })
      }
    />,
    root,
  );
}
