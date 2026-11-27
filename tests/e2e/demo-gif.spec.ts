// Makes the demo GIF of the README (docs/images/demo.gif) from the real panel and the local demo, in the dark theme.
// Run it with `pnpm docs:gif`. It needs ffmpeg on the PATH. It is skipped in a normal run.
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from './fixtures';
import { openDemo, openPanel } from './helpers';

const OUT = 'docs/images/demo.gif';
const size = { width: 1200, height: 680 };

test.skip(!process.env.GIF, 'Set GIF=1 to make the demo GIF.');
// ffmpeg can take a few minutes on a slow machine.
test.setTimeout(600_000);

/** Takes screenshots of the panel until stop() is called, and keeps the time of each one. */
function film(panel: Page, dir: string): { stop: () => Promise<{ file: string; at: number }[]> } {
  const frames: { file: string; at: number }[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const file = join(dir, `${String(frames.length).padStart(5, '0')}.png`);
      const at = Date.now();
      await panel.screenshot({ path: file, animations: 'disabled' });
      frames.push({ file, at });
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return frames;
    },
  };
}

/** A caption at the bottom of the panel, only for the film. It is not part of the panel. */
const caption = (panel: Page, text: string): Promise<void> =>
  panel.evaluate((value) => {
    let box = document.getElementById('demo-caption');
    if (!box) {
      box = document.createElement('div');
      box.id = 'demo-caption';
      box.style.cssText =
        'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;padding:10px 18px;border-radius:8px;' +
        'background:#ff5ca8;color:#14060d;font:600 18px/1.3 system-ui,sans-serif;box-shadow:0 4px 18px #0008;pointer-events:none';
      document.body.append(box);
    }
    box.textContent = value;
  }, text);

test('demo gif', async ({ page, worker, extensionId }) => {
  await openDemo(page);
  const panel = await openPanel(page, worker, extensionId, 'dark', 'simple');
  await panel.emulateMedia({ colorScheme: 'dark' });
  await panel.setViewportSize(size);
  await page.evaluate(() => window.__demo.startMoq());
  await page.evaluate(() => window.__demo.startVideo());
  await panel.getByRole('tab', { name: 'Monitor' }).click();
  await panel.locator('.monitor-table tr', { hasText: 'video' }).waitFor();
  await panel.waitForTimeout(3000);

  const dir = mkdtempSync(join(tmpdir(), 'sluice-gif-'));
  const camera = film(panel, dir);
  await caption(panel, '1 · Your MoQ player runs: Sluice watches each track');
  await panel.waitForTimeout(3500);

  await caption(panel, '2 · One switch: drop the key frames of the video');
  await panel.getByRole('tab', { name: 'Rules' }).click();
  await panel.waitForTimeout(1200);
  const card = panel.getByRole('article', { name: 'No key frames' });
  await card.scrollIntoViewIfNeeded();
  await panel.waitForTimeout(800);
  await card.getByRole('switch').check();
  await panel.waitForTimeout(1800);

  await caption(panel, '3 · The Monitor flags the track and logs each drop');
  await panel.getByRole('tab', { name: 'Monitor' }).click();
  await panel.waitForTimeout(6000);
  const frames = await camera.stop();
  await card.getByRole('switch').uncheck().catch(() => undefined);

  // Each frame lasts until the next one, so the GIF keeps real time. The last one is held for 2 s.
  const list = frames.map((frame, i) => `file '${frame.file}'\nduration ${(((frames[i + 1]?.at ?? frame.at + 2000) - frame.at) / 1000).toFixed(3)}`);
  const last = frames.at(-1);
  if (last) list.push(`file '${last.file}'`);
  const listFile = join(dir, 'list.txt');
  writeFileSync(listFile, list.join('\n'));
  const filter = 'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4';
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', filter, '-loop', '0', OUT]);
  rmSync(dir, { recursive: true, force: true });
});
