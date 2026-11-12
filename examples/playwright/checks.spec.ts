// Pass or fail from the Monitor of Sluice: a player that loses its key frames fails the check. It needs the local demo
// (`node test-env/env.mjs up`), which has a small moq-lite player. For your app, change the URL, the pattern and the code that
// starts the player.
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { applyScenario, extensionFor, launchWithSluice, openSluicePanel, type SluiceReport } from './sluice';

const ORIGIN = 'http://localhost:8080';
const KEY_FRAME_LOSS = fileURLToPath(new URL('../scenarios/moq-keyframe-loss.json', import.meta.url));

async function play(scenario: string | null): Promise<SluiceReport[]> {
  const extension = extensionFor('dist', 'http://localhost/*');
  const { context, worker } = await launchWithSluice(extension);
  try {
    if (scenario) await applyScenario(worker, ORIGIN, scenario);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => '__demo' in window);
    const sluice = await openSluicePanel(context, worker, page);
    await page.evaluate(() => (window as unknown as { __demo: { startMoq(): Promise<void> } }).__demo.startMoq());
    await page.waitForTimeout(3500);
    return await sluice.report();
  } finally {
    await context.close();
  }
}

const video = (reports: SluiceReport[]) => reports.flatMap((report) => report.tracks).find((track) => track.name === 'video');

test('with no rules, the video track passes its checks', async () => {
  const track = video(await play(null));
  expect(track?.frames).toBeGreaterThan(20);
  expect(track?.checks.every((check) => check.pass)).toBe(true);
});

test('when key frames are lost, the key-frames check fails', async () => {
  const track = video(await play(KEY_FRAME_LOSS));
  expect(track?.checks.find((check) => check.id === 'key-frames')).toMatchObject({ pass: false, detail: expect.stringMatching(/key frames? dropped/) });
});
