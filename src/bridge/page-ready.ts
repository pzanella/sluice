// Tells the service worker that a top page is ready, so it can set the badge. The script runs once for each document,
// and Chrome clears the badge at each navigation, so two cases need more than one call at the start.
import { PAGE_READY } from '../shared/page-status';

interface PageReadyEnv {
  prerendering: boolean;
  /** `persisted` is true when the page comes back from the back/forward cache, with no new script run. */
  on(type: 'pageshow', handler: (event: { persisted: boolean; isTrusted: boolean }) => void): void;
  on(type: 'prerenderingchange', handler: (event: { isTrusted: boolean }) => void): void;
  send(message: { type: string }): void;
}

export function announcePage(env: PageReadyEnv): void {
  const send = (): void => env.send({ type: PAGE_READY });
  // The page can dispatch a false event, which would wake the worker for nothing.
  env.on('pageshow', (event) => {
    if (event.persisted && event.isTrusted) send();
  });
  // A prerendered page is not the page of the tab yet, so it must not set its badge.
  if (!env.prerendering) {
    send();
    return;
  }
  // Not `once`: a false event from the page would use up the listener.
  let activated = false;
  env.on('prerenderingchange', (event) => {
    if (activated || !event.isTrusted) return;
    activated = true;
    send();
  });
}
