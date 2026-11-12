// Renders src/icons/icon.svg to the PNG sizes that Chrome needs. Run it by hand after a change to the SVG: the PNGs are
// committed, so a build needs no browser.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const dir = resolve(fileURLToPath(import.meta.url), '../../src/icons');
const browser = await chromium.launch({ channel: 'chromium' });
for (const size of [16, 32, 48, 128]) {
  const svg = await readFile(resolve(dir, size === 16 ? 'icon-16.svg' : 'icon.svg'), 'utf8');
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: resolve(dir, `icon-${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
