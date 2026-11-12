import type { Locator, Page, Worker } from '@playwright/test';
import { DEMO_URL } from './fixtures';

/**
 * The real panel page, in a tab. `chrome.devtools` exists only in DevTools, so the test gives the two values it reads.
 */
/** `rulesMode`: most tests use the full editor, so the default is `advanced`. */
export async function openPanel(page: Page, worker: Worker, extensionId: string, theme = 'default', rulesMode: 'simple' | 'advanced' = 'advanced'): Promise<Page> {
  // With no grant a tab has no URL here, so this falls back to the tab opened last. Tab ids grow.
  const tabId = await worker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url?.startsWith('http://localhost'))?.id ?? Math.max(...tabs.map((t) => t.id ?? -1));
  });
  const panel = await page.context().newPage();
  await panel.addInitScript(
    ({ id, name }) => {
      Object.defineProperty(chrome, 'devtools', {
        value: {
          inspectedWindow: { tabId: id, eval: (_code: string, done: (value: string) => void) => done('http://localhost:8080/') },
          panels: { themeName: name },
          network: { onNavigated: { addListener: () => undefined } },
        },
      });
    },
    { id: tabId, name: theme },
  );
  await panel.addInitScript((mode) => {
    try {
      localStorage.setItem('sluice.rules.mode', mode);
    } catch {
      // No storage: the default applies.
    }
  }, rulesMode);
  await panel.goto(`chrome-extension://${extensionId}/panel/panel.html`);
  return panel;
}

export const openDemo = async (page: Page): Promise<void> => {
  await page.goto(DEMO_URL);
  await page.waitForFunction(() => '__demo' in window);
};


/** Picks an option of a select of the panel (`select.tsx`) by its value, as a user does: open the list, click the option. */
export async function choose(control: Locator, value: string): Promise<void> {
  await control.click();
  await control.page().locator(`[role="listbox"] [role="option"][data-value="${value}"]`).click();
}
