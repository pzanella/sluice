import type { Page, Worker } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { DEMO_URL, expect, test } from './fixtures';

const isPatched = (): boolean => Object.getPrototypeOf(WebTransport) !== Function.prototype;

/** Tab ids grow, so this is the tab opened last. A query by URL finds no tab on an origin with no grant. */
const newestTabId = (worker: Worker): Promise<number> =>
  worker.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map((tab) => tab.id ?? -1)));

const badgeOf = (worker: Worker, tabId: number): Promise<string> =>
  worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);

test.describe('real build, with no site turned on', () => {
  test.use({ granted: false });

  test('the manifest has no static content scripts and asks for no host at install', () => {
    const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8')) as Record<string, unknown>;
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.minimum_chrome_version).toBe('119');
  });

  test('every icon of the manifest is in the build', () => {
    const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8')) as {
      icons: Record<string, string>;
      action: { default_icon: Record<string, string> };
    };
    const paths = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(existsSync(`dist/${path}`), path).toBe(true);
    expect(existsSync('dist/icons/icon.svg')).toBe(false);
  });

  test('no script is registered and the page is not patched', async ({ page, worker }) => {
    const state = await worker.evaluate(async () => ({
      origins: (await chrome.permissions.getAll()).origins,
      scripts: await chrome.scripting.getRegisteredContentScripts(),
    }));
    expect(state).toEqual({ origins: [], scripts: [] });
    await page.goto(DEMO_URL);
    expect(await page.evaluate(isPatched)).toBe(false);
  });
});

test.describe('a registered script with no grant', () => {
  test.use({ granted: false });

  test('does not run, so a sync that failed cannot keep patching a site after its grant is removed', async ({ page, worker }) => {
    await worker.evaluate(() =>
      chrome.scripting.registerContentScripts([
        { id: 'stale', js: ['inject.js'], matches: ['http://localhost/*'], world: 'MAIN', runAt: 'document_start', allFrames: true },
      ]),
    );
    await page.goto(DEMO_URL);
    expect(await page.evaluate(isPatched)).toBe(false);
  });
});

test.describe('a granted origin', () => {
  test('both scripts are registered for that origin only', async ({ worker }) => {
    const scripts = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    expect(scripts.map((s) => [s.id, s.world, s.matches, s.runAt, s.allFrames, s.matchOriginAsFallback])).toEqual([
      ['sluice-bridge', 'ISOLATED', ['http://localhost/*'], 'document_start', true, true],
      ['sluice-main', 'MAIN', ['http://localhost/*'], 'document_start', true, true],
    ]);
  });

  test('the page is patched, and an origin that is not granted is not', async ({ page }) => {
    await page.goto(DEMO_URL);
    expect(await page.evaluate(isPatched)).toBe(true);
    await page.goto('http://127.0.0.1:8080/');
    expect(await page.evaluate(isPatched)).toBe(false);
  });

  test('a cross-origin frame in a granted page is not patched, until its own origin is granted', async ({ page }) => {
    await page.goto(DEMO_URL);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const frame = document.createElement('iframe');
          frame.src = 'http://127.0.0.1:8080/';
          frame.addEventListener('load', () => resolve(), { once: true });
          document.body.append(frame);
        }),
    );
    const child = page.frames().find((frame) => frame.url().startsWith('http://127.0.0.1'));
    expect(child).toBeDefined();
    expect(await child?.evaluate(isPatched)).toBe(false);
  });
});

test.describe('badge', () => {
  test('says ON on a patched page, and nothing after the tab leaves for a page with no patch', async ({ page, worker }) => {
    await page.goto(DEMO_URL);
    const tabId = await newestTabId(worker);
    await expect.poll(() => badgeOf(worker, tabId)).toBe('ON');
    expect(await worker.evaluate((id) => chrome.action.getTitle({ tabId: id }), tabId)).toContain('running on this page');
    await page.goto('http://127.0.0.1:8080/');
    await expect.poll(() => badgeOf(worker, tabId)).toBe('');
  });

  test('a frame of a page does not set it', async ({ page, worker }) => {
    await page.goto('http://127.0.0.1:8080/');
    await page.evaluate(
      (src) =>
        new Promise<void>((resolve) => {
          const frame = document.createElement('iframe');
          frame.src = src;
          frame.addEventListener('load', () => resolve(), { once: true });
          document.body.append(frame);
        }),
      DEMO_URL,
    );
    const child = page.frames().find((frame) => frame.url().startsWith(DEMO_URL));
    expect(await child?.evaluate(isPatched)).toBe(true);
    // Its message would have arrived by now: the frame has run the script and answered above.
    await page.waitForTimeout(300);
    expect(await badgeOf(worker, await newestTabId(worker))).toBe('');
  });
});

test.describe('badge in the real build, with no site turned on', () => {
  test.use({ granted: false });

  test('stays empty', async ({ page, worker }) => {
    await page.goto(DEMO_URL);
    await page.waitForTimeout(300);
    expect(await badgeOf(worker, await newestTabId(worker))).toBe('');
  });
});

test.describe('popup', () => {
  /** A popup opened as a tab sees itself as the active tab, so the test gives it the tab to work on. */
  const openPopup = async (page: Page, extensionId: string, url: string): Promise<void> => {
    await page.addInitScript((tabUrl) => {
      Object.defineProperty(chrome.tabs, 'query', { value: () => Promise.resolve([{ id: 1, url: tabUrl }]) });
    }, url);
    await page.goto(`chrome-extension://${extensionId}/panel/popup.html`);
  };

  test.describe('on a real tab', () => {
    /** Opens the page in its own tab, and the popup in another one, as a popup sees it. */
    const openOnTab = async (page: Page, worker: Worker, extensionId: string, url: string, granted?: boolean): Promise<Page> => {
      const target = await page.context().newPage();
      await target.goto(url);
      const id = await newestTabId(worker);
      await page.addInitScript(
        ([tabId, tabUrl, grant]) => {
          Object.defineProperty(chrome.tabs, 'query', { value: () => Promise.resolve([{ id: tabId, url: tabUrl }]) });
          if (grant !== null) Object.defineProperty(chrome.permissions, 'contains', { value: () => Promise.resolve(grant) });
        },
        [id, url, granted ?? null] as const,
      );
      await page.goto(`chrome-extension://${extensionId}/panel/popup.html`);
      return target;
    };

    test('says it runs on a patched page', async ({ page, worker, extensionId }) => {
      await openOnTab(page, worker, extensionId, DEMO_URL);
      await expect(page.getByRole('status')).toHaveText('● On for this site');
      // All is fine: one step only, and the options stay closed.
      await expect(page.getByRole('button', { name: 'Turn off' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Reload page' })).toHaveCount(0);
      await expect(page.getByRole('checkbox', { name: 'Also inspect workers on this site' })).toBeHidden();
    });

    test('says a page still runs it after the grant is gone, and asks for a reload', async ({ page, worker, extensionId }) => {
      await openOnTab(page, worker, extensionId, DEMO_URL, false);
      await expect(page.getByRole('status')).toHaveText('◐ Off for this site: reload to stop');
      await expect(page.getByRole('button', { name: 'Reload page' })).toHaveClass(/\bprimary\b/);
    });

    test('says a page does not run it yet after a grant, and asks for a reload', async ({ page, worker, extensionId }) => {
      await openOnTab(page, worker, extensionId, 'http://127.0.0.1:8080/', true);
      await expect(page.getByRole('status')).toHaveText('◐ On for this site: reload to start');
      await expect(page.getByRole('button', { name: 'Reload page' })).toHaveClass(/\bprimary\b/);
    });

    test('a page cannot hide that it runs Sluice by adding the nonce attribute again', async ({ page, context, worker, extensionId }) => {
      await context.route('http://localhost:8080/forged', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><script>document.documentElement.setAttribute('data-sluice-bridge', '')</script><html data-sluice-bridge><body>x`,
        }),
      );
      const target = await openOnTab(page, worker, extensionId, 'http://localhost:8080/forged');
      expect(await target.evaluate(isPatched)).toBe(true);
      await expect(page.getByRole('status')).toHaveText('● On for this site');
      await expect.poll(async () => badgeOf(worker, await newestTabId(worker))).toBe('ON');
    });

    test('finds the site of an about:blank page that a granted page opened', async ({ page, worker, extensionId }) => {
      const opener = await page.context().newPage();
      await opener.goto(DEMO_URL);
      const [blank] = await Promise.all([page.context().waitForEvent('page'), opener.evaluate(() => void window.open('about:blank'))]);
      expect(await blank.evaluate(isPatched)).toBe(true);
      const id = await newestTabId(worker);
      await page.addInitScript((tabId) => {
        Object.defineProperty(chrome.tabs, 'query', { value: () => Promise.resolve([{ id: tabId, url: 'about:blank' }]) });
      }, id);
      await page.goto(`chrome-extension://${extensionId}/panel/popup.html`);
      await expect(page.getByRole('heading')).toHaveText('localhost');
      await expect(page.getByRole('status')).toHaveText('● On for this site');
      await expect(page.getByRole('button', { name: 'Turn off' })).toBeVisible();
    });

    test('a sandboxed page keeps its site, so it can still be turned off', async ({ page, context, worker, extensionId }) => {
      await context.route('http://localhost:8080/sandboxed', (route) =>
        route.fulfill({
          contentType: 'text/html',
          headers: { 'Content-Security-Policy': 'sandbox allow-scripts' },
          body: '<!doctype html><body>x',
        }),
      );
      const target = await openOnTab(page, worker, extensionId, 'http://localhost:8080/sandboxed');
      expect(await target.evaluate(() => self.origin)).toBe('null');
      expect(await target.evaluate(isPatched)).toBe(true);
      await expect(page.getByRole('heading')).toHaveText('localhost');
      await expect(page.getByRole('status')).toHaveText('● On for this site');
      await expect(page.getByRole('button', { name: 'Turn off' })).toBeVisible();
    });

    test('does not say Sluice cannot run on a silent page whose URL has no site', async ({ page, extensionId }) => {
      await page.addInitScript(() => {
        Object.defineProperty(chrome.tabs, 'query', { value: () => Promise.resolve([{ id: 1, url: 'about:blank' }]) });
        Object.defineProperty(chrome.tabs, 'sendMessage', { value: () => new Promise(() => undefined) });
      });
      await page.goto(`chrome-extension://${extensionId}/panel/popup.html`);
      await expect(page.getByRole('status')).toHaveText('? This page does not answer');
      await expect(page.getByText('cannot run on this page')).toHaveCount(0);
    });

    test('says how to stop a running page with no site', async ({ page, extensionId }) => {
      await page.addInitScript(() => {
        Object.defineProperty(chrome.tabs, 'query', { value: () => Promise.resolve([{ id: 1, url: 'data:text/html,x' }]) });
        Object.defineProperty(chrome.tabs, 'sendMessage', { value: () => Promise.resolve({ patched: true, origin: 'null' }) });
      });
      await page.goto(`chrome-extension://${extensionId}/panel/popup.html`);
      await expect(page.getByRole('status')).toHaveText('● Running on this page');
      await expect(page.getByText('Close the page to stop it.')).toBeVisible();
    });

    test('still works on a hung page', async ({ page, worker, extensionId }) => {
      const target = await openOnTab(page, worker, extensionId, DEMO_URL);
      // Never settles: the page is stuck from here on. Reload it now, so the popup asks a hung page.
      void target.evaluate(() => {
        for (;;);
      }).catch(() => undefined);
      await page.reload();
      await expect(page.getByRole('status')).toHaveText('? This page does not answer');
      await expect(page.getByText('Sluice is on for this site.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Delete rules of this site' })).toBeEnabled();
    });
  });

  test('shows On for a granted origin', async ({ page, extensionId }) => {
    await openPopup(page, extensionId, DEMO_URL);
    await expect(page.getByRole('heading')).toHaveText('localhost');
    await expect(page.getByText('On for this site')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Turn off' })).toBeVisible();
  });

  test('shows Off for an origin that is not granted', async ({ page, extensionId }) => {
    await openPopup(page, extensionId, 'https://example.test/page');
    await expect(page.getByRole('heading')).toHaveText('example.test');
    await expect(page.getByText('Off for this site')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Turn on' })).toBeVisible();
    // Nothing runs here, so a rule cannot hang this page.
    await expect(page.getByRole('button', { name: 'Delete rules of this site' })).toHaveCount(0);
  });

  test('offers nothing on a page where Sluice cannot run', async ({ page, extensionId }) => {
    await openPopup(page, extensionId, 'chrome://extensions/');
    await expect(page.getByText('cannot run on this page')).toBeVisible();
    await expect(page.getByRole('button')).toHaveCount(0);
  });

  test('deletes the rules of the site, and of no other site', async ({ page, extensionId, worker }) => {
    await worker.evaluate(() =>
      chrome.storage.local.set({ 'config:http://localhost:8080': { a: 1 }, 'config:https://other.test': { a: 2 } }),
    );
    await openPopup(page, extensionId, DEMO_URL);
    const before = await worker.evaluate(() => chrome.storage.local.get(null));
    await page.getByText('More options').click();
    await page.getByRole('button', { name: 'Delete rules of this site' }).click();
    expect(await worker.evaluate(() => chrome.storage.local.get(null))).toEqual(before);
    await page.getByRole('button', { name: 'Click again to delete' }).click();
    await expect(page.getByRole('button', { name: 'Rules deleted' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('button', { name: 'Rules deleted' })).toBeFocused();
    expect(await worker.evaluate(() => chrome.storage.local.get(null))).toEqual({ 'config:https://other.test': { a: 2 } });
  });

  test('shows an error if Chrome refuses to turn a site off', async ({ page, extensionId }) => {
    // In this build the origin is a required permission, so Chrome refuses to remove it.
    await openPopup(page, extensionId, DEMO_URL);
    await page.getByRole('button', { name: 'Turn off' }).click();
    await expect(page.getByRole('alert')).toContainText('chrome://extensions');
    await expect(page.getByText('On for this site')).toBeVisible();
  });
});
