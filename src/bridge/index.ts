// ISOLATED world entry: relays messages between the MAIN world runtime and the service worker.
import { GET_PAGE_STATUS, type PageStatus } from '../shared/page-status';
import { announcePage } from './page-ready';
import { createRelay } from './relay';

const NONCE_ATTRIBUTE = 'data-sluice-bridge';
const root = document.documentElement;

if (root) {
  const nonce = crypto.randomUUID();
  const relay = createRelay({
    connect: () => chrome.runtime.connect({ name: 'tab' }),
    toMain: (text) => void window.dispatchEvent(new CustomEvent(`sluice:${nonce}:to-main`, { detail: text })),
    now: () => Date.now(),
    alive: () => chrome.runtime?.id !== undefined,
  });
  window.addEventListener(`sluice:${nonce}:to-bridge`, (event) => {
    try {
      relay.fromMain((event as CustomEvent<unknown>).detail);
    } catch {
      // Reading a hostile detail can throw.
    }
  });
  let patched = false;
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    const type = (message as { type?: unknown } | null)?.type;
    if (type === 'wake') relay.wake((message as { force?: unknown }).force === true);
    if (type === GET_PAGE_STATUS) sendResponse({ patched, origin: self.origin !== 'null' ? self.origin : location.origin } satisfies PageStatus);
  });
  // Page content can run before the timeout and add the attribute again, so its value then proves nothing. A record that
  // the nonce was removed does: the page does not know the nonce, and it cannot undo a record.
  const nonceTaken = (records: MutationRecord[]): void => {
    if (records.some((record) => record.oldValue === nonce)) patched = true;
  };
  const nonceWatch = new MutationObserver(nonceTaken);
  nonceWatch.observe(root, { attributeFilter: [NONCE_ATTRIBUTE], attributeOldValue: true });
  // The MAIN script runs next and removes this. The timeout is for the case when it does not run.
  root.setAttribute(NONCE_ATTRIBUTE, nonce);
  setTimeout(() => {
    nonceTaken(nonceWatch.takeRecords());
    nonceWatch.disconnect();
    root.removeAttribute(NONCE_ATTRIBUTE);
    if (window !== window.top) return;
    announcePage({
      prerendering: (document as Document & { prerendering?: boolean }).prerendering === true,
      // `pageshow` fires on the window, `prerenderingchange` on the document.
      on: (type: string, handler: (event: never) => void) =>
        (type === 'pageshow' ? window : document).addEventListener(type, handler as EventListener),
      send: (message) => void chrome.runtime.sendMessage(message).catch(() => undefined),
    });
  }, 0);
}
