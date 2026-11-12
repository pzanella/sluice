// Helpers to use Sluice in your own Playwright tests. Copy this file to your project.
import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A copy of the built extension with your site turned on. Sluice runs only on sites that you turn on, and a test cannot click the
 * permission prompt. `pattern` is a match pattern such as `https://app.example.com/*`.
 */
export function extensionFor(dist: string, pattern: string): string {
  const copy = mkdtempSync(join(tmpdir(), 'sluice-'));
  cpSync(dist, copy, { recursive: true });
  const manifestPath = join(copy, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.host_permissions = [pattern];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return copy;
}

/** Starts Chromium with the extension. It returns when Sluice is ready for pages. */
export async function launchWithSluice(extension: string): Promise<{ context: BrowserContext; worker: Worker }> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', // Extensions need the new headless mode.
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  for (let i = 0; i < 100; i++) {
    const scripts = await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
    if (scripts >= 2) return { context, worker };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Sluice did not register its scripts');
}

/** Applies a scenario file to a site. Call it before you open the page. `origin` is a URL origin such as `https://app.example.com`. */
export async function applyScenario(worker: Worker, origin: string, file: string): Promise<void> {
  const scenario = JSON.parse(readFileSync(file, 'utf8')) as { format?: string; config?: unknown };
  if (scenario.format !== 'sluice-scenario') throw new Error(`${file} is not a Sluice scenario`);
  // Sluice checks this config when it reads it. If it is not valid, it logs an error in the service worker and ignores it.
  await worker.evaluate(({ key, config }) => chrome.storage.local.set({ [key]: config }), { key: `config:${origin}`, config: scenario.config });
}

/** One session in the report of the Monitor. See `docs/guide/monitor.md`. */
export interface SluiceReport {
  session: number;
  url: string | null;
  open: boolean;
  /** True when every check of every track passed. */
  pass: boolean;
  tracks: {
    name: string;
    frames: number;
    gaps: number;
    pauses: number;
    lateKeys: number;
    keysDropped: number;
    keyIntervalMs: number | null;
    bitsPerSecond: number;
    framesPerSecond: number;
    checks: { id: 'gaps' | 'pauses' | 'key-frames' | 'receiving'; pass: boolean; detail: string }[];
  }[];
  events: { at: number; kind: string; track: string | null; text: string }[];
}

/**
 * Opens the Sluice panel for `page` in a tab of its own, as DevTools would show it, and gives a way to read its Monitor report.
 * Open it before the page starts its sessions: the panel sees traffic from the moment it is open.
 */
export async function openSluicePanel(context: BrowserContext, worker: Worker, page: { url(): string }): Promise<{ report(): Promise<SluiceReport[]>; close(): Promise<void> }> {
  const url = page.url();
  const tabId = await worker.evaluate(async (target) => (await chrome.tabs.query({})).find((tab) => tab.url === target)?.id, url);
  if (tabId === undefined) throw new Error(`No tab with ${url}. Open the page first.`);
  const panel = await context.newPage();
  // The panel reads these two values of DevTools. Here a test gives them.
  await panel.addInitScript(
    ({ id, href }) => {
      Object.defineProperty(chrome, 'devtools', {
        value: {
          inspectedWindow: { tabId: id, eval: (_code: string, done: (value: string) => void) => done(href) },
          panels: { themeName: 'default' },
          network: { onNavigated: { addListener: () => undefined } },
        },
      });
    },
    { id: tabId, href: url },
  );
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/panel/panel.html`);
  return {
    report: () => panel.evaluate(() => (window as unknown as { sluice: { report(): SluiceReport[] } }).sluice.report()),
    close: () => panel.close(),
  };
}
