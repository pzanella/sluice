import { chromium, expect, test as base, type BrowserContext, type Worker } from '@playwright/test';
import { resolve } from 'node:path';

// The permission dialog cannot be clicked in a test, so most tests use a copy of the build with the demo origin
// already granted (see global-setup.ts). The scripts still come from the real registration code.
const buildPath = { granted: resolve('dist-granted'), real: resolve('dist') };

export const DEMO_URL = 'http://localhost:8080/';

export interface Options {
  /** Load the extension, or run the native browser as a baseline. */
  withExtension: boolean;
  /** Use the build with the demo origin granted. False = the real build, with no site turned on. */
  granted: boolean;
}

interface Fixtures {
  context: BrowserContext;
  extensionId: string;
  worker: Worker;
}

export const test = base.extend<Options & Fixtures>({
  withExtension: [true, { option: true }],
  granted: [true, { option: true }],
  // Extensions need a persistent context. Playwright's Chromium still accepts --load-extension.
  context: async ({ withExtension, granted }, use) => {
    const extensionPath = granted ? buildPath.granted : buildPath.real;
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: !process.env.SLUICE_HEADED,
      args: withExtension ? [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] : [],
    });
    // Registration runs in the worker after install: a page opened before it would not be patched.
    if (withExtension) {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      if (granted) {
        await expect
          .poll(() => worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length))
          .toBe(2);
      }
    }
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
  },
});

export { expect };
