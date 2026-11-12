// Makes the screenshots of the docs and of the store listing, from the real panel and the local demo, in the dark theme.
// Run it with `pnpm docs:shots`. It is skipped in a normal run.
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from './fixtures';
import { choose, openDemo, openPanel } from './helpers';

const OUT = 'docs/images';
const STORE = 'docs/store';
const size = { width: 1200, height: 680 };
/** The size of a Chrome Web Store screenshot. */
const storeSize = { width: 1280, height: 800 };

test.skip(!process.env.SHOTS, 'Set SHOTS=1 to make the screenshots of the docs.');
test.describe.configure({ mode: 'serial' });

const shot = (panel: Page, name: string): Promise<Buffer> => panel.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' });
/** The same view at the size of the store, then back to the size of the docs. */
const storeShot = async (panel: Page, name: string): Promise<void> => {
  await panel.setViewportSize(storeSize);
  // A resize lays the panel out again on the next frames: wait for them, or the shot has parts of the old size.
  await panel.waitForTimeout(500);
  await panel.screenshot({ path: `${STORE}/${name}.png`, animations: 'disabled' });
  await panel.setViewportSize(size);
  await panel.waitForTimeout(300);
};

/** The panel in the dark theme of DevTools, as on a dark system. */
const darkPanel = async (page: Page, worker: Parameters<typeof openPanel>[1], extensionId: string, rulesMode?: 'simple' | 'advanced'): Promise<Page> => {
  const panel = await openPanel(page, worker, extensionId, 'dark', rulesMode);
  await panel.emulateMedia({ colorScheme: 'dark' });
  await panel.setViewportSize(size);
  return panel;
};

test('first run', async ({ page, worker, extensionId }) => {
  await openDemo(page);
  const panel = await darkPanel(page, worker, extensionId);
  await panel.getByText('No WebTransport sessions yet.').waitFor();
  await shot(panel, 'first-run');
});

test('tracks, messages, monitor, rules and record', async ({ page, worker, extensionId }) => {
  await openDemo(page);
  const panel = await darkPanel(page, worker, extensionId);
  await page.evaluate(() => window.__demo.startMoq());
  await page.evaluate(() => window.__demo.startVideo());
  await panel.getByRole('tab', { name: 'Tracks' }).click();
  await panel.getByRole('article', { name: 'Track video' }).waitFor();
  await panel.waitForTimeout(4000);
  await shot(panel, 'tracks');
  await storeShot(panel, 'screenshot-2-tracks');

  await panel.getByRole('tab', { name: 'Messages' }).click();
  await panel.getByRole('listbox').getByRole('option').filter({ hasText: 'key' }).first().click();
  await shot(panel, 'messages');
  await storeShot(panel, 'screenshot-3-messages');

  await panel.getByRole('tab', { name: 'Monitor' }).click();
  await panel.locator('.monitor-table tr', { hasText: 'video' }).waitFor();
  await shot(panel, 'monitor');
  await storeShot(panel, 'screenshot-1-monitor');

  await panel.evaluate(() => localStorage.setItem('sluice.rules.mode', 'simple'));
  await panel.getByRole('tab', { name: 'Rules' }).click();
  await panel.getByRole('radio', { name: 'Simple' }).click();
  await panel.getByRole('radio', { name: /Congested/ }).click();
  await panel.getByRole('article', { name: 'Lose frames' }).getByRole('switch').check();
  await panel.waitForTimeout(2500);
  await shot(panel, 'rules-simple');
  await storeShot(panel, 'screenshot-4-rules');
  await panel.getByRole('article', { name: 'Lose frames' }).getByRole('switch').uncheck();
  await panel.getByRole('radio', { name: /None/ }).click();

  const rebuffer = panel.getByRole('article', { name: 'Rebuffer' });
  await rebuffer.getByRole('button', { name: 'Run once now' }).click();
  await rebuffer.locator('.quick-note').getByText('gets nothing').waitFor();
  await rebuffer.scrollIntoViewIfNeeded();
  await shot(panel, 'actions');
  await panel.getByRole('radio', { name: 'Advanced' }).click();

  // The report is a file with its own light look: it is shown as a browser shows it.
  await panel.getByRole('tab', { name: 'Monitor' }).click();
  const [download] = await Promise.all([panel.waitForEvent('download'), panel.getByRole('button', { name: 'Save HTML report' }).click()]);
  const viewer = await page.context().newPage();
  await viewer.setViewportSize({ width: 1000, height: 900 });
  const file = join(tmpdir(), `sluice-report-${Date.now()}.html`);
  await download.saveAs(file);
  await viewer.goto(`file://${file}`);
  await viewer.screenshot({ path: `${OUT}/html-report.png` });
  await viewer.close();

  await panel.getByRole('tab', { name: 'Record' }).click();
  await panel.getByRole('button', { name: 'Start recording' }).click();
  await panel.waitForTimeout(3000);
  await shot(panel, 'recording');
  await panel.getByRole('button', { name: 'Stop recording' }).click();
  await panel.locator('.recording-facts tr', { hasText: 'video' }).waitFor({ timeout: 20_000 });
  await shot(panel, 'record');
  await storeShot(panel, 'screenshot-5-record');
  await panel.getByRole('button', { name: 'Play', exact: true }).click();
  await page.evaluate(() => window.__demo.startMoq());
  await page.setViewportSize({ width: 900, height: 420 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/replay-overlay.png` });
});

test('rules from a template, a rule with an error, and inject', async ({ page, worker, extensionId }) => {
  await openDemo(page);
  const panel = await darkPanel(page, worker, extensionId);
  await panel.getByRole('tab', { name: 'Rules' }).click();
  await choose(panel.getByLabel('Add a rule from a template'), 'drop-key');
  await shot(panel, 'rules-template');
  await panel.getByRole('button', { name: 'Use the example' }).click();
  await panel.locator('.timeline').scrollIntoViewIfNeeded();
  await panel.locator('.timeline').screenshot({ path: `${OUT}/timeline.png`, animations: 'disabled' });
  await page.evaluate(() => window.__demo.startPush());
  await panel.getByRole('tab', { name: 'Messages' }).click();
  await panel.getByRole('button', { name: 'Inject', exact: true }).click();
  await panel.waitForTimeout(1500);
  await shot(panel, 'inject');

  await panel.reload();
  await panel.getByRole('tab', { name: 'Rules' }).click();
  await panel.getByRole('button', { name: 'Add rule' }).click();
  await panel.getByLabel('Payload matches regex').fill('(a+)+$');
  await panel.getByRole('button', { name: 'Save and apply' }).click();
  await panel.getByRole('alert').first().waitFor();
  await shot(panel, 'rules-error');
});

test('popup states', async ({ page, worker }) => {
  const id = new URL(worker.url()).host;
  const local = 'http://localhost:8080/';
  const running = { patched: true, origin: 'http://localhost:8080' };
  const states: [string, string, unknown, boolean | null][] = [
    ['on', local, running, true],
    ['pending', local, null, true],
    ['stale', local, running, false],
    ['off', 'https://example.test/', null, false],
    ['unknown', local, 'silent', true],
    ['no-site', 'data:text/html,x', { patched: true, origin: 'null' }, null],
    ['cannot-run', 'chrome://extensions/', null, null],
  ];
  for (const [name, url, answer, granted] of states) {
    const popup = await page.context().newPage();
    await popup.setViewportSize({ width: 280, height: 520 });
    await popup.emulateMedia({ colorScheme: 'dark' });
    // The popup asks Chrome about the active tab. Here a test gives the answers of each state.
    await popup.addInitScript(
      ([tabUrl, reply, grant]) => {
        Object.defineProperty(chrome.tabs, 'query', { value: () => Promise.resolve([{ id: 1, url: tabUrl }]) });
        Object.defineProperty(chrome.tabs, 'sendMessage', {
          value: () => (reply === 'silent' ? new Promise(() => undefined) : reply === null ? Promise.reject(new Error('none')) : Promise.resolve(reply)),
        });
        if (grant !== null) Object.defineProperty(chrome.permissions, 'contains', { value: () => Promise.resolve(grant) });
      },
      [url, answer, granted] as const,
    );
    await popup.goto(`chrome-extension://${id}/panel/popup.html`);
    await popup.getByRole('status').first().waitFor({ timeout: 3000 }).catch(() => undefined);
    await popup.waitForTimeout(700);
    await popup.screenshot({ path: `${OUT}/popup-${name}.png`, animations: 'disabled' });
    await popup.close();
  }
});

test('store icon and promo tile', async ({ page }) => {
  // The store wants the art of a 128 px icon in 96 px, with 16 px of empty space around it.
  const svg = await readFile('src/icons/icon.svg', 'utf8');
  await page.setViewportSize({ width: 128, height: 128 });
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:96px;height:96px;margin:16px}</style>${svg}`);
  await page.screenshot({ path: `${STORE}/icon-128.png`, omitBackground: true });

  await page.setViewportSize({ width: 440, height: 280 });
  await page.setContent(`<!doctype html>
<style>
  html, body { margin: 0; height: 100%; }
  body { display: flex; align-items: center; gap: 22px; padding: 0 32px; box-sizing: border-box; background: #111317;
    color: #e8eaf0; font: 14px/1.45 system-ui, sans-serif; }
  svg { flex: 0 0 auto; width: 88px; height: 88px; }
  div { min-width: 0; }
  h1 { margin: 0 0 6px; font-size: 34px; letter-spacing: 0.3px; }
  p { margin: 0; color: #b4b8c4; }
</style>
${svg}
<div><h1>Sluice</h1><p>Monitor, test and replay WebTransport and MoQ traffic in DevTools.</p></div>`);
  await page.screenshot({ path: `${STORE}/promo-small-440x280.png` });

  // Wide banners: the name and summary on the left, the Monitor view on the right, cut by the edge.
  const monitor = (await readFile(`${STORE}/screenshot-1-monitor.png`)).toString('base64');
  const banner = async (width: number, height: number, path: string): Promise<void> => {
    await page.setViewportSize({ width, height });
    await page.setContent(`<!doctype html>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body { position: relative; display: flex; align-items: center; box-sizing: border-box; padding: 0 0 0 ${Math.round(height * 0.14)}px;
    background: radial-gradient(circle at 20% 30%, #1d2533 0, #111317 60%); color: #e8eaf0; font: 16px/1.45 system-ui, sans-serif; }
  .text { position: relative; z-index: 1; width: ${Math.round(width * 0.4)}px; }
  .brand { display: flex; align-items: center; gap: 20px; margin-bottom: 20px; }
  svg { width: ${Math.round(height * 0.17)}px; height: ${Math.round(height * 0.17)}px; }
  h1 { margin: 0; font-size: ${Math.round(height * 0.12)}px; letter-spacing: 0.5px; }
  p { margin: 0 0 14px; color: #b4b8c4; font-size: ${Math.round(height * 0.045)}px; }
  .tag { color: #8ab4ff; font-size: ${Math.round(height * 0.034)}px; }
  img { position: absolute; top: ${Math.round(height * 0.14)}px; left: ${Math.round(width * 0.52)}px; height: ${Math.round(height * 0.86)}px;
    border: 1px solid #2c313c; border-radius: 10px 0 0 0; box-shadow: 0 10px 40px rgb(0 0 0 / 50%); }
</style>
<div class="text"><div class="brand">${svg}<h1>Sluice</h1></div>
<p>Monitor, test and replay WebTransport and MoQ traffic in DevTools.</p>
<div class="tag">No proxy · No server · Data stays in your browser</div></div>
<img alt="" src="data:image/png;base64,${monitor}">`);
    await page.screenshot({ path });
  };
  // The Chrome Web Store marquee tile, and the social preview of the repository.
  await banner(1400, 560, `${STORE}/promo-marquee-1400x560.png`);
  await banner(1280, 640, `${OUT}/social-preview.png`);
});
