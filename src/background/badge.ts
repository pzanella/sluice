// The toolbar badge of a tab says what the page runs, so it holds no state: each update asks the page (ADR-13).
// Chrome clears the badge of a tab when the tab navigates, and the new page reports itself.
import { originPattern } from '../shared/origins';
import { pageState, parsePageStatus, PAGE_READY } from '../shared/page-status';

interface BadgeView {
  text: string;
  title: string;
  color?: string;
}

// The worker has no CSS. Blue is `--accent` of the light theme. Amber is the `--hold` of the design system, which comes to
// tokens.css with the hold queue. A badge always has text too, so the color is not the only signal.
const NOT_RUNNING: BadgeView = { text: '', title: 'Sluice' };
const RUNNING: BadgeView = { text: 'ON', title: 'Sluice is running on this page', color: '#0a5fc4' };
const STALE: BadgeView = { text: '!', title: 'Sluice is off for this site, but it runs on this page until you reload', color: '#b45309' };

/** No grant to check, so it says nothing about the site. */
const RUNNING_NO_SITE: BadgeView = { text: 'ON', title: 'Sluice runs on this page until you close it', color: '#0a5fc4' };

export interface BadgeApi {
  /** Rejects if the tab has no bridge. May never settle if the page hangs. */
  askPage(tabId: number): Promise<unknown>;
  isGranted(pattern: string): Promise<boolean>;
  tabIds(): Promise<number[]>;
  show(tabId: number, view: BadgeView): Promise<void>;
}

interface MessageSender {
  id?: string | undefined;
  frameId?: number | undefined;
  tab?: { id?: number | undefined } | undefined;
}

export function createBadges(api: BadgeApi, extensionId: string) {
  const update = async (tabId: number): Promise<void> => {
    let view = NOT_RUNNING;
    const status = parsePageStatus(await api.askPage(tabId).catch(() => null));
    if (status) {
      const pattern = originPattern(status.origin);
      if (pattern === null) {
        if (status.patched) view = RUNNING_NO_SITE;
      } else {
        const state = pageState(status.patched, await api.isGranted(pattern));
        if (state === 'running') view = RUNNING;
        if (state === 'stale') view = STALE;
      }
    }
    await api.show(tabId, view);
  };
  // A tab can close at any moment, and then Chrome rejects. Nothing is left to show, so it is not an error.
  const updateSafely = (tabId: number): Promise<void> => update(tabId).catch(() => undefined);

  return {
    onMessage(message: unknown, sender: MessageSender): void {
      if (sender.id !== extensionId || sender.frameId !== 0 || sender.tab?.id === undefined) return;
      if ((message as { type?: unknown } | null)?.type === PAGE_READY) void updateSafely(sender.tab.id);
    },
    /** After a grant changes. Does not wait: one hung page must not stop the others. */
    async updateAll(): Promise<void> {
      for (const tabId of await api.tabIds()) void updateSafely(tabId);
    },
  };
}
