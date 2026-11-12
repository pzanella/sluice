import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { DEFAULT_CONFIG } from '../../src/shared/rules';
import { expect, test } from './fixtures';
import { choose, openDemo, openPanel } from './helpers';

test.describe('panel on a site that is off', () => {
  test.use({ granted: false });

  test('the Rules view says that saved rules wait', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await expect(panel.getByText('turn it on for this site')).toBeVisible();
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await expect(panel.getByText('Sluice is off for this site.')).toBeVisible();
  });
});

test.describe('MoQT version', () => {
  /** /echo sends back what the app writes, so the app can make the server seem to send a SERVER_SETUP. */
  const echoOnFirstStream = (page: Page, bytes: number[]) =>
    page.evaluate(async (bytes) => {
      const config = (await (await fetch('config.json')).json()) as { wtPort: number; certHash: string };
      const hash = Uint8Array.from(config.certHash.match(/../g) ?? [], (byte) => parseInt(byte, 16));
      const transport = new WebTransport(`https://localhost:${config.wtPort}/echo`, { serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }] });
      await transport.ready;
      const stream = await transport.createBidirectionalStream();
      const reader = stream.readable.getReader();
      const writer = stream.writable.getWriter();
      await writer.write(Uint8Array.from(bytes));
      await reader.read();
    }, bytes);

  test('a session that gets a SERVER_SETUP shows its draft, and other sessions show nothing', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await echoOnFirstStream(page, [0x47, 0x45, 0x54, 0x20, 0x2f]);
    await expect(panel.locator('.session-state').first()).toHaveText(/open/, { timeout: 10_000 });
    await expect(panel.locator('.session-state', { hasText: 'MoQT draft' })).toHaveCount(0);
    await echoOnFirstStream(page, [0x21, 0x00, 0x09, 0xc0, 0, 0, 0, 0xff, 0, 0, 14, 0]);
    await expect(panel.locator('.session-state', { hasText: 'MoQT draft 14' })).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('record and replay', () => {
  /** A session on /push: returns what the app got. */
  const runApp = (page: Page, ms: number) =>
    page.evaluate(async (ms) => {
      const config = (await (await fetch('config.json')).json()) as { wtPort: number; certHash: string };
      const hash = Uint8Array.from(config.certHash.match(/../g) ?? [], (byte) => parseInt(byte, 16));
      const transport = new WebTransport(`https://localhost:${config.wtPort}/push`, { serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }] });
      await transport.ready;
      const decoder = new TextDecoder();
      const datagrams: string[] = [];
      const uni: string[] = [];
      void (async () => {
        const reader = transport.datagrams.readable.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          datagrams.push(decoder.decode(value));
        }
      })().catch(() => undefined);
      void (async () => {
        const streams = transport.incomingUnidirectionalStreams.getReader();
        for (;;) {
          const { value, done } = await streams.read();
          if (done) return;
          const reader = (value as ReadableStream<Uint8Array>).getReader();
          let text = '';
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            text += decoder.decode(part.value);
          }
          uni.push(text);
        }
      })().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, ms));
      transport.close();
      await transport.closed.catch(() => undefined);
      return { datagrams, uni };
    }, ms);

  test('the app gets the same data with no server', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Record' }).click();
    await panel.getByRole('button', { name: 'Start recording' }).click();
    const live = await runApp(page, 1500);
    expect(live.datagrams.length).toBeGreaterThan(3);
    await panel.getByRole('button', { name: 'Stop recording' }).click();
    await expect(panel.locator('.rule-summary')).toContainText('localhost:4433/push', { timeout: 10_000 });
    await expect(panel.locator('.record-wait')).toHaveCount(0);
    await expect(panel.locator('.rule-summary')).not.toContainText('Not complete');
    await expect(panel.locator('.recording-facts .chip').first()).toHaveText(/^\d+\.\d s recorded$/);
    await expect(panel.locator('.recording-facts')).toContainText(/\d+ streams/);
    await expect(panel.locator('.recording-facts')).toContainText(/\d+ datagrams/);

    const [download] = await Promise.all([panel.waitForEvent('download'), panel.getByRole('button', { name: 'Save', exact: true }).click()]);
    expect(download.suggestedFilename()).toBe('localhost_4433.sluicetrace.json');
    // Not MoQ: nothing to write as a .moqtrace file.
    await expect(panel.getByRole('button', { name: 'Export .moqtrace' })).toHaveCount(0);

    await panel.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(panel.locator('.note[role="status"]')).toContainText('Ready to play');
    const played = await runApp(page, 1800);
    // The replay runs a bit longer than the live run, and the recording also holds what the network sent while the live session
    // closed. So what the app saw live must come first, in the same order, and at most one more of each kind can follow.
    expect(played.datagrams.slice(0, live.datagrams.length)).toEqual(live.datagrams);
    expect(played.uni.slice(0, live.uni.length)).toEqual(live.uni);
    expect(played.uni.length - live.uni.length).toBeLessThanOrEqual(1);
    await expect(panel.locator('.note[role="status"]')).toContainText('Playing to');

    // With hold (the default), a new session plays the recording again (ADR-36).
    const again = await runApp(page, 500);
    expect(again.datagrams[0]).toBe(live.datagrams[0]);
    // Stop playing: the next session is live.
    await panel.getByRole('button', { name: 'Stop playing' }).click();
    const after = await runApp(page, 500);
    expect(after.datagrams[0]).not.toBe(live.datagrams[0]);
    // Delete forgets the recording in this panel, and stops its replay.
    await panel.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(panel.locator('.replay-state')).toHaveText('Replay ready: start a new session in the app');
    await panel.getByRole('button', { name: /^Delete recording of localhost:4433\/push/ }).click();
    await expect(panel.locator('.recording-card')).toHaveCount(0);
    await expect(panel.locator('.replay-state')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Cancel play' })).toHaveCount(0);
  });

  test('a file that is not a recording is refused', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Record' }).click();
    await panel.getByLabel('Play a saved file').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"other"}') });
    await expect(panel.getByRole('alert')).toContainText('not a Sluice recording');
  });
});

test.describe('inject', () => {
  /** A session on /echo where the app reads all it can, as an app does. */
  const startApp = (page: Page, read: { uni: boolean; datagrams: boolean }) =>
    page.evaluate(async ({ read }) => {
      const config = (await (await fetch('config.json')).json()) as { wtPort: number; certHash: string };
      const hash = Uint8Array.from(config.certHash.match(/../g) ?? [], (byte) => parseInt(byte, 16));
      const transport = new WebTransport(`https://localhost:${config.wtPort}/echo`, { serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }] });
      await transport.ready;
      const got: { kind: string; text: string; isReceive?: boolean }[] = [];
      const decoder = new TextDecoder();
      if (read.datagrams) {
        void (async () => {
          const reader = transport.datagrams.readable.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            got.push({ kind: 'datagram', text: decoder.decode(value) });
          }
        })();
      }
      if (read.uni) {
        void (async () => {
          const streams = transport.incomingUnidirectionalStreams.getReader();
          for (;;) {
            const { value, done } = await streams.read();
            if (done) return;
            const stream = value as ReadableStream<Uint8Array>;
            // BYOB, the harder reader.
            const reader = stream.getReader({ mode: 'byob' });
            const { value: bytes } = await reader.read(new Uint8Array(64));
            const { done: end } = await reader.read(new Uint8Array(64));
            got.push({ kind: 'uni', text: decoder.decode(bytes) + (end ? '' : ' NOT CLOSED'), isReceive: stream instanceof ReadableStream });
          }
        })().catch((err: unknown) => got.push({ kind: 'error', text: String(err) }));
      }
      (window as unknown as { __got: typeof got }).__got = got;
    }, { read });
  const got = (page: Page) => page.evaluate(() => (window as unknown as { __got: { kind: string; text: string; isReceive?: boolean }[] }).__got);

  test('what the app sends is in the list, and a rule can change it', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await panel.getByRole('button', { name: 'Add rule' }).click();
    await choose(panel.getByLabel('Action'), 'modify-replace');
    await choose(panel.getByLabel('Direction'), 'out');
    await panel.getByLabel('Find').fill('cat');
    await panel.getByLabel('Replace with').fill('dog');
    await panel.getByRole('button', { name: 'Save and apply' }).click();
    await expect(panel.locator('.rules-state')).toHaveText('Saved');
    await expect(panel.getByLabel('Find')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-expanded', 'false');
    // The echo server sends back what it got, so the change reached the network.
    await expect.poll(() => page.evaluate(() => window.__demo.echoStream('a cat'))).toBe('a dog');
    await panel.getByRole('tab', { name: 'Messages' }).click();
    await expect(panel.locator('.row', { has: panel.locator('.badge.outgoing') }).first()).toBeVisible({ timeout: 10_000 });
    await expect(panel.locator('.row', { has: panel.locator('.badge.modified') }).first()).toContainText('dog');
  });

  test('ADR-32: nothing next to a select changes on each render', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await panel.getByRole('button', { name: 'Add rule' }).click();
    await panel.evaluate(() => {
      (window as unknown as { __changes: number }).__changes = 0;
      new MutationObserver((list) => {
        (window as unknown as { __changes: number }).__changes += list.length;
      }).observe(document.querySelector('.network') as Element, { subtree: true, characterData: true, childList: true });
    });
    await page.evaluate(async () => {
      for (let i = 0; i < 4; i++) await window.__demo.echoDatagram(`m${i}`);
    });
    await expect(panel.locator('.counters')).toContainText(/[1-9]\d* chunks/, { timeout: 10_000 });
    expect(await panel.evaluate(() => (window as unknown as { __changes: number }).__changes)).toBe(0);
  });

  test('a long row is cut in the list, not scrolled sideways, and JSON is a tree to open', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.setViewportSize({ width: 500, height: 700 });
    await page.evaluate(() => window.__demo.echoDatagram(JSON.stringify({ long: 'x'.repeat(150), list: [1, { deep: true }] })));
    const row = panel.getByRole('listbox').getByRole('option').last();
    await expect(row).toBeVisible({ timeout: 10_000 });
    const list = await panel.locator('.list').evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    expect(list.scroll).toBeLessThanOrEqual(list.client);
    await row.click();
    await panel.getByRole('tab', { name: 'JSON' }).click();
    const tree = panel.locator('.json-tree');
    await expect(tree.locator('summary').first()).toContainText('object (2)');
    await expect(tree.getByText('deep:')).toBeHidden();
    await panel.getByRole('button', { name: 'Expand all' }).click();
    await expect(tree.getByText('deep:')).toBeVisible();
    await panel.getByRole('button', { name: 'Collapse all' }).click();
    await expect(tree.getByText('long:')).toBeHidden();
  });

  test('the Tracks view says what it needs when there are no MoQ tracks', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Tracks' }).click();
    await expect(panel.getByText('No MoQ tracks yet.')).toBeVisible();
  });

  test('a moq-lite player: Tracks shows the catalog and the key frames, and a recording counts them', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await page.evaluate(() => window.__demo.startMoq());
    await panel.getByRole('tab', { name: 'Tracks' }).click();
    const video = panel.getByRole('article', { name: 'Track video' });
    await expect(video).toContainText('1280x720', { timeout: 10_000 });
    await expect(video).toContainText('avc1.64001f');
    await expect.poll(async () => Number(await video.locator('div', { hasText: /^Key frames/ }).locator('dd').innerText()), { timeout: 10_000 }).toBeGreaterThan(0);
    await panel.getByRole('tab', { name: 'Record' }).click();
    await panel.getByRole('button', { name: 'Start recording' }).click();
    await panel.waitForTimeout(2500);
    await panel.getByRole('button', { name: 'Stop recording' }).click();
    const row = panel.locator('.recording-facts tr', { hasText: 'video' });
    await expect(row).toBeVisible({ timeout: 15_000 });
    expect(Number(await row.locator('td').nth(3).innerText())).toBeGreaterThan(0);

    // Export .moqtrace writes a file that other tools read, and that Sluice opens again with the same tracks (ADR-57).
    const [download] = await Promise.all([panel.waitForEvent('download'), panel.getByRole('button', { name: 'Export .moqtrace' }).click()]);
    expect(download.suggestedFilename()).toBe('localhost_4433.moqtrace');
    const file = readFileSync((await download.path()) as string);
    expect(file.subarray(0, 8).toString('latin1')).toBe('MOQTRACE');
    await panel.getByLabel('Open a .moqtrace').setInputFiles({ name: 'export.moqtrace', mimeType: 'application/octet-stream', buffer: file });
    await expect(panel.getByRole('tab', { name: 'Monitor' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('.monitor-table tr', { hasText: 'video' }).first()).toBeVisible();
    await expect(panel.locator('.monitor-table tr', { hasText: 'audio' }).first()).toBeVisible();
  });

  test('Monitor shows the health of each track, and Run once now stalls and closes a session', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId, 'default', 'simple');
    await page.evaluate(() => window.__demo.startMoq());
    await panel.getByRole('tab', { name: 'Monitor' }).click();
    const video = panel.locator('.monitor-table tr', { hasText: 'video' });
    await expect(video.locator('.health-word')).toHaveText('OK', { timeout: 10_000 });
    await expect(panel.locator('.monitor-session .summary')).toHaveText('No problems in the last minute');

    await panel.getByRole('tab', { name: 'Rules' }).click();
    const rebuffer = panel.getByRole('article', { name: 'Rebuffer' });
    await rebuffer.getByRole('button', { name: 'Run once now' }).click();
    await expect(rebuffer.locator('.quick-note')).toContainText('gets nothing of this session for 3 s');
    // Only once: the quick test itself stays off.
    await expect(rebuffer.getByRole('switch')).not.toBeChecked();
    await panel.getByRole('tab', { name: 'Monitor' }).click();
    await expect(panel.locator('.events')).toContainText('Sluice stalled the session for 3.0 s');
    await expect(panel.locator('.chip.stall')).toBeVisible();

    await panel.getByRole('tab', { name: 'Rules' }).click();
    await panel.getByRole('article', { name: 'Reconnect' }).getByRole('button', { name: 'Run once now' }).click();
    await panel.getByRole('tab', { name: 'Monitor' }).click();
    await expect(panel.locator('.events')).toContainText('Sluice closed the session (code 0)');
    await expect(panel.locator('.events')).toContainText('the session closed');
  });

  test('a rule closes the session when a frame matches', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await panel.getByRole('button', { name: 'Add rule' }).click();
    await choose(panel.getByLabel('Action'), 'close-session');
    await panel.getByLabel('Reason').fill('rule test');
    await panel.getByLabel('MoQ track name').fill('audio');
    await panel.getByRole('button', { name: 'Save and apply' }).click();
    await expect(panel.locator('.rules-state')).toHaveText('Saved');
    await page.evaluate(() => window.__demo.startMoq());
    await panel.getByRole('tab', { name: 'Monitor' }).click();
    await expect(panel.locator('.events')).toContainText('Sluice closed the session (code 0)', { timeout: 10_000 });
  });

  test('a .moqtrace file opens as a session in Monitor and Messages', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Record' }).click();
    await panel.getByLabel('Open a .moqtrace').setInputFiles('src/panel/__tests__/fixtures/trace-corpus/capture-observer-draft16-moq-rs/capture.moqtrace');
    await expect(panel.getByRole('tab', { name: 'Monitor' })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('.monitor-table tbody tr').first()).toBeVisible();
    await expect(panel.locator('.events')).toContainText('the session closed (code 0, end of the .moqtrace file)');
    await panel.getByRole('tab', { name: 'Messages' }).click();
    await expect(panel.getByRole('listbox').getByRole('option').first()).toBeVisible();
  });

  test('a timeline stalls, then closes each new session at its times', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await panel.getByRole('button', { name: 'Use the example' }).click();
    await expect(panel.locator('.timeline-steps li')).toHaveCount(5);
    for (let i = 5; i > 0; i--) await panel.getByRole('button', { name: `Delete step ${i}` }).click();
    await panel.getByRole('button', { name: 'Add step' }).click();
    await panel.locator('.timeline-steps li').first().getByLabel('At (s)').fill('1');
    await panel.getByRole('button', { name: 'Add step' }).click();
    const second = panel.locator('.timeline-steps li').nth(1);
    await second.getByLabel('At (s)').fill('2');
    await choose(second.getByLabel('Do'), 'close-session');
    await panel.getByRole('button', { name: 'Apply timeline' }).click();
    await expect(panel.getByRole('button', { name: 'Apply timeline' })).toBeDisabled();
    // The timeline is for the next session: a reload makes sure that the page has it before the session opens.
    await openDemo(page);
    await page.evaluate(() => window.__demo.startMoq());
    await panel.getByRole('tab', { name: 'Monitor' }).click();
    await expect(panel.locator('.events')).toContainText('Sluice stalled the session for 3.0 s', { timeout: 10_000 });
    await expect(panel.locator('.events')).toContainText('Sluice closed the session (code 0)', { timeout: 10_000 });
  });

  test('the Playback card shows what a <video> of the page plays', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Monitor' }).click();
    // A page talks to the panel once it has a WebTransport session, as a MoQ player does.
    await page.evaluate(() => window.__demo.startMoq());
    await page.evaluate(() => window.__demo.startVideo());
    const card = panel.locator('.monitor-session.playback');
    await expect(card.locator('.health-word')).toHaveText('Playing', { timeout: 10_000 });
    await expect.poll(async () => Number(await card.locator('.track-stats > div').first().locator('dd').innerText()), { timeout: 10_000 }).toBeGreaterThan(5);
    const report = await panel.evaluate(() => (window as unknown as { sluice: { playback(): { health: string }[] } }).sluice.playback());
    expect(report[0]?.health).toBe('playing');
  });

  test('Save HTML report gives one file with the tracks and checks', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await page.evaluate(() => window.__demo.startMoq());
    await panel.getByRole('tab', { name: 'Monitor' }).click();
    await expect(panel.locator('.monitor-table tr', { hasText: 'video' })).toBeVisible({ timeout: 10_000 });
    const [download] = await Promise.all([panel.waitForEvent('download'), panel.getByRole('button', { name: 'Save HTML report' }).click()]);
    expect(download.suggestedFilename()).toBe('sluice-report.html');
    const html = readFileSync((await download.path()) as string, 'utf8');
    expect(html).toContain('<title>Sluice report</title>');
    expect(html).toContain('localhost:4433/moq');
    expect(html).toMatch(/<td>video<\/td>/);
  });

  test('simple Rules: a network preset says what it does, a quick test turns on and counts hits, a rule turns off', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId, 'default', 'simple');
    await page.evaluate(() => window.__demo.startMoq());
    await panel.getByRole('tab', { name: 'Tracks' }).click();
    await panel.getByRole('article', { name: 'Track video' }).waitFor({ timeout: 10_000 });
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await panel.getByRole('radio', { name: /Slow 3G/ }).click();
    await expect(panel.locator('.network-effect')).toContainText('each session gets at most 400 kbit/s');
    await panel.getByRole('radio', { name: /None/ }).click();
    await expect(panel.locator('.network-effect')).toHaveText('The app gets the real network.');

    const card = panel.getByRole('article', { name: 'Lose frames' });
    await card.getByRole('switch', { name: 'Lose frames on' }).check();
    await expect(card.getByRole('combobox')).toHaveAttribute('data-value', 'video');
    await expect(card.locator('.quick-hits')).toContainText(/[1-9]\d* match(es)?/, { timeout: 10_000 });
    await card.getByRole('switch', { name: 'Lose frames on' }).uncheck();
    await expect(card.locator('.quick-controls')).toHaveCount(0);

    await panel.getByRole('radio', { name: 'Advanced' }).click();
    await panel.getByRole('button', { name: 'Add rule' }).click();
    await panel.getByRole('button', { name: 'Save and apply' }).click();
    await expect(panel.locator('.rules-state')).toHaveText('Saved');
    await panel.getByRole('radio', { name: 'Simple' }).click();
    const row = panel.locator('.active-rules li').first();
    await row.getByRole('switch').uncheck();
    await expect(row).toHaveClass(/off/);
  });

  test('each quick test does what it says on a moq-lite player', async ({ page, worker, extensionId }) => {
    test.setTimeout(120_000);
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId, 'default', 'simple');
    await page.evaluate(() => window.__demo.startMoq());
    await panel.getByRole('tab', { name: 'Tracks' }).click();
    await panel.getByRole('article', { name: 'Track video' }).waitFor({ timeout: 10_000 });
    await panel.getByRole('tab', { name: 'Rules' }).click();
    const card = (name: string) => panel.getByRole('article', { name });
    const turn = async (name: string, on: boolean) => {
      const toggle = card(name).getByRole('switch');
      if (on) await toggle.check();
      else await toggle.uncheck();
    };

    // Frames, key frames, a late track and a missing track: each one matches what it names.
    for (const [name, track] of [['Lose frames', 'video'], ['No key frames', 'video'], ['Late track', 'audio'], ['Missing track', 'audio']] as const) {
      await turn(name, true);
      await expect(card(name).getByRole('combobox')).toHaveAttribute('data-value', track);
      await expect(card(name).locator('.quick-hits')).toContainText(/[1-9]\d* match(es)?/, { timeout: 10_000 });
      await turn(name, false);
    }
    await expect(panel.locator('.now-strip')).toContainText('Nothing is changed');

    // Rebuffer and reconnect show in the Monitor.
    await turn('Rebuffer', true);
    await panel.getByRole('tab', { name: 'Monitor' }).click();
    await expect(panel.locator('.events')).toContainText('Sluice stalled the session', { timeout: 10_000 });
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await turn('Rebuffer', false);
    await card('Reconnect').getByRole('switch').check();
    await card('Reconnect').getByRole('slider').fill('2');
    await expect(card('Reconnect').locator('.quick-field b')).toHaveText('2 s');
    await panel.getByRole('tab', { name: 'Monitor' }).click();
    await expect(panel.locator('.events')).toContainText('Sluice closed the session', { timeout: 20_000 });
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await expect(panel.locator('.now-strip')).toContainText('Reconnect');
    await panel.getByRole('button', { name: 'Turn all off' }).click();
    await expect(panel.locator('.now-strip')).toContainText('Nothing is changed');

    // The catalog of a new session waits at the top, to edit by hand. The card needs a session to know the catalog track.
    await page.evaluate(() => window.__demo.startMoq());
    await expect(card('Edit the catalog').getByRole('switch')).toBeEnabled({ timeout: 10_000 });
    await turn('Edit the catalog', true);
    await page.evaluate(() => window.__demo.startMoq());
    await expect(panel.locator('.held-section .hold-row')).toHaveCount(1, { timeout: 10_000 });
    await turn('Edit the catalog', false);
  });

  test('Lose datagrams takes datagrams away from the app', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId, 'default', 'simple');
    await page.evaluate(() => window.__demo.startPush());
    await panel.getByRole('tab', { name: 'Rules' }).click();
    const card = panel.getByRole('article', { name: 'Lose datagrams' });
    await card.getByRole('switch').check();
    await card.getByRole('slider').fill('100');
    await expect(card.locator('.quick-hits')).toContainText(/[1-9]\d* match(es)?/, { timeout: 10_000 });
    const before = await page.evaluate(() => window.__demo.state.counters.datagrams);
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => window.__demo.state.counters.datagrams)).toBe(before);
  });

  test('a rule says when its track is not one that the player gets, and the form offers the real names', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await page.evaluate(() => window.__demo.startMoq());
    await panel.getByRole('tab', { name: 'Tracks' }).click();
    await panel.getByRole('article', { name: 'Track video' }).waitFor({ timeout: 10_000 });
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await choose(panel.getByLabel('Add a rule from a template'), 'lose-frames');
    await expect(panel.getByLabel('MoQ track name')).toHaveValue('video');
    await expect(panel.locator('.rule-warning')).toHaveCount(0);
    await panel.getByLabel('MoQ track name').fill('2.avc3');
    await expect(panel.locator('.rule-warning')).toContainText('No track "2.avc3" in this tab: it matches nothing. Tracks the player gets: ');
  });

  test('another extension patched WebTransport first: streams and chunks still show', async ({ page, worker, extensionId }) => {
    await page.addInitScript(() => {
      // The shape of the hook of some inspector tools: a function that returns a native object, with own methods.
      const Original = window.WebTransport;
      function Patched(url: string, options?: WebTransportOptions): WebTransport {
        const instance = new Original(url, options);
        const create = instance.createBidirectionalStream.bind(instance);
        instance.createBidirectionalStream = (...rest) => create(...rest);
        return instance;
      }
      Patched.prototype = Original.prototype;
      (window as unknown as { WebTransport: unknown }).WebTransport = Patched;
    });
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await expect.poll(() => page.evaluate(() => window.__demo.echoStream('both'))).toBe('both');
    await expect(panel.locator('.row', { hasText: 'both' }).first()).toBeVisible({ timeout: 10_000 });
    await expect(panel.locator('.session').first()).toBeVisible();
  });

  test('a server that names no protocol: the one MoQT draft that the page offered is shown', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await page.evaluate(async () => {
      const config = (await (await fetch('/config.json')).json()) as { wtPort: number; certHash: string };
      const value = Uint8Array.from(config.certHash.match(/../g) ?? [], (byte) => parseInt(byte, 16));
      const options = { protocols: ['moqt-16'], serverCertificateHashes: [{ algorithm: 'sha-256', value }] } as WebTransportOptions;
      const transport = new WebTransport(`https://localhost:${config.wtPort}/echo`, options);
      await transport.ready;
      (window as unknown as { __keep: unknown }).__keep = transport;
    });
    await expect(panel.locator('.session-state').first()).toContainText('MoQT draft 16', { timeout: 10_000 });
  });

  test('a scenario can be exported and imported, and a bad file is refused', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await panel.getByRole('button', { name: 'Add rule' }).click();
    await panel.getByRole('button', { name: 'Save and apply' }).click();
    await expect(panel.locator('.rules-state')).toHaveText('Saved');
    const [download] = await Promise.all([panel.waitForEvent('download'), panel.getByRole('button', { name: 'Export scenario' }).click()]);
    const path = await download.path();
    await panel.getByRole('button', { name: 'Delete rule 1' }).click();
    await panel.getByRole('button', { name: 'Save and apply' }).click();
    await expect(panel.locator('.rule-summary')).toHaveCount(0);
    await expect(panel.locator('.rules-state')).toHaveText('Saved');

    const input = panel.locator('.rules-head input[type="file"]');
    await input.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"other"}') });
    await expect(panel.getByRole('alert')).toContainText('not a Sluice scenario');
    await input.setInputFiles(path);
    await expect(panel.locator('.rule-summary')).toHaveCount(1);
    await expect(panel.locator('.rules-state')).toHaveText('Saved');
  });

  test('a network profile and a seed reach the page, and stay after the panel opens again', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await panel.getByLabel('Seed').fill('x');
    await panel.getByRole('button', { name: 'Apply network' }).click();
    await expect(panel.getByRole('alert')).toContainText('whole number');
    await panel.getByLabel('Seed').fill('42');
    await choose(panel.getByLabel('Profile'), 'mobile');
    await panel.getByRole('button', { name: 'Apply network' }).click();
    await expect(panel.getByRole('button', { name: 'Apply network' })).toBeDisabled();
    await page.evaluate(async () => {
      await window.__demo.connect('/echo');
      for (let i = 0; i < 5; i++) await window.__demo.echoDatagram(`m${i}`);
    });
    await panel.getByRole('tab', { name: 'Messages' }).click();
    // The echo calls use sessions that are closed by now, and an open session hides them.
    await panel.getByRole('button', { name: /Show \d+ closed session/ }).click();
    await expect(panel.locator('.row .badge.delayed').first()).toBeVisible({ timeout: 10_000 });
    await panel.reload();
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await expect(panel.getByLabel('Profile')).toHaveAttribute('data-value', 'mobile');
    await expect(panel.getByLabel('Seed')).toHaveValue('42');
  });

  test('a datagram and a new uni stream reach the app, and the list marks them', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await startApp(page, { uni: true, datagrams: true });
    await panel.getByRole('button', { name: 'Inject', exact: true }).click();
    await panel.getByLabel('Payload', { exact: true }).fill('hello');
    await panel.getByRole('button', { name: 'Send to the app' }).click();
    await expect(panel.locator('.note[role="status"]')).toContainText('Queued for the app');
    await expect.poll(() => got(page)).toContainEqual({ kind: 'datagram', text: 'hello' });

    await panel.getByRole('radio', { name: /New uni stream/ }).check();
    await panel.getByRole('radio', { name: 'Hex' }).check();
    await panel.getByLabel('Payload', { exact: true }).fill('68 69');
    await panel.getByRole('button', { name: 'Send to the app' }).click();
    await expect.poll(() => got(page)).toContainEqual({ kind: 'uni', text: 'hi', isReceive: true });

    await panel.getByRole('tab', { name: 'Messages' }).click();
    await expect(panel.locator('.row .badge.injected')).toHaveCount(2, { timeout: 10_000 });
  });

  test('it says so when the app does not read that kind of message', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await startApp(page, { uni: false, datagrams: false });
    await panel.getByRole('button', { name: 'Inject', exact: true }).click();
    await panel.getByLabel('Payload', { exact: true }).fill('x');
    await panel.getByRole('button', { name: 'Send to the app' }).click();
    await expect(panel.locator('.note[role="status"]')).toContainText('does not read');
  });

  test('bad input is refused, and with no session it says how to start', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('button', { name: 'Inject', exact: true }).click();
    await expect(panel.getByText('No open session.')).toBeVisible();
    await startApp(page, { uni: true, datagrams: true });
    await panel.getByRole('button', { name: 'Send to the app' }).click();
    await expect(panel.getByRole('alert')).toContainText('Write a message first');
    await panel.getByRole('radio', { name: 'Hex' }).check();
    await panel.getByLabel('Payload', { exact: true }).fill('zz');
    await panel.getByRole('button', { name: 'Send to the app' }).click();
    await expect(panel.getByRole('alert')).toContainText('not valid hex');
  });

  test('rules do not change an injected message', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await panel.getByRole('button', { name: 'Add rule' }).click();
    await panel.getByRole('button', { name: 'Save and apply' }).click();
    await expect(panel.locator('.rules-state')).toHaveText('Saved');
    await startApp(page, { uni: false, datagrams: true });
    await panel.getByRole('tab', { name: 'Messages' }).click();
    await panel.getByRole('button', { name: 'Inject', exact: true }).click();
    await panel.getByLabel('Payload', { exact: true }).fill('stays');
    await panel.getByRole('button', { name: 'Send to the app' }).click();
    await expect.poll(() => got(page)).toContainEqual({ kind: 'datagram', text: 'stays' });
  });
});

test.describe('hold', () => {
  const holdRule = async (panel: Page, seconds = '30', onTimeout = 'forward'): Promise<void> => {
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await panel.getByRole('button', { name: 'Add rule' }).click();
    await choose(panel.getByLabel('Action'), 'hold');
    await panel.getByLabel('Wait at most').fill(seconds);
    await choose(panel.getByLabel('If time runs out'), onTimeout);
    await panel.getByRole('checkbox', { name: 'Uni streams' }).uncheck();
    await panel.getByRole('checkbox', { name: 'Bidi streams' }).uncheck();
    await panel.getByRole('button', { name: 'Save and apply' }).click();
    await expect(panel.locator('.rules-state')).toHaveText('Saved');
    await panel.getByRole('tab', { name: /Rules/ }).click();
  };
  const echo = (page: Page, text: string): Promise<unknown> => page.evaluate((value) => window.__demo.echoDatagram(value), text);
  const rows = (panel: Page) => panel.locator('.hold-row');

  test('the app gets nothing until Forward', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await holdRule(panel);
    let done = false;
    const answer = echo(page, 'wait').then((value) => ((done = true), value));
    await expect(rows(panel)).toHaveCount(1, { timeout: 10_000 });
    await expect(panel.locator('.hold-time')).toContainText('then forward');
    await expect(panel.getByRole('tab', { name: /Rules/ })).toContainText('1');
    await panel.waitForTimeout(300);
    expect(done).toBe(false);
    await panel.getByRole('button', { name: 'Forward', exact: true }).click();
    expect(await answer).toBe('wait');
    await expect(panel.getByText('Nothing is held.')).toBeVisible();
  });

  test('after a decision, the next message to come can be decided with the keyboard', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await holdRule(panel);
    // Datagrams in order: the second is seen only after the first is decided.
    const answer = page.evaluate(async () => {
      const config = (await (await fetch('config.json')).json()) as { wtPort: number; certHash: string };
      const hash = Uint8Array.from(config.certHash.match(/../g) ?? [], (byte) => parseInt(byte, 16));
      const transport = new WebTransport(`https://localhost:${config.wtPort}/echo`, { serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }] });
      await transport.ready;
      const writer = transport.datagrams.writable.getWriter();
      const reader = transport.datagrams.readable.getReader();
      await writer.write(new TextEncoder().encode('a'));
      await writer.write(new TextEncoder().encode('b'));
      const decoder = new TextDecoder();
      const out = [decoder.decode((await reader.read()).value), decoder.decode((await reader.read()).value)];
      transport.close();
      return out;
    });
    const list = panel.getByRole('listbox');
    await expect(rows(panel)).toHaveCount(1, { timeout: 10_000 });
    await list.press('f');
    await expect(panel.getByRole('button', { name: 'Forward', exact: true })).toBeEnabled({ timeout: 10_000 });
    await expect(panel.locator('.hold-time').first()).toContainText('then forward');
    await list.press('f');
    expect((await answer).sort()).toEqual(['a', 'b']);
  });

  test('an edit reaches the app, with the keyboard', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await holdRule(panel);
    const answer = echo(page, 'old');
    await expect(rows(panel)).toHaveCount(1, { timeout: 10_000 });
    await panel.getByRole('listbox').press('e');
    await expect(panel.getByLabel('New payload')).toHaveValue('old');
    await panel.getByLabel('New payload').fill('new');
    await panel.getByRole('button', { name: 'Forward edited' }).click();
    expect(await answer).toBe('new');
    await panel.getByRole('tab', { name: 'Messages' }).click();
    await expect(panel.locator('.row .badge.modified')).toHaveCount(1, { timeout: 10_000 });
    await expect(panel.locator('.counters')).toContainText('1 modified', { timeout: 5_000 });
  });

  test('bad hex and an empty edit are refused, and the message stays held', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await holdRule(panel);
    const answer = echo(page, 'x');
    await expect(rows(panel)).toHaveCount(1, { timeout: 10_000 });
    await panel.getByRole('region', { name: 'Held messages' }).getByRole('button', { name: 'Edit' }).click();
    await panel.getByRole('radio', { name: 'Hex' }).check();
    await expect(panel.getByLabel('New payload')).toHaveValue('78');
    await panel.getByLabel('New payload').fill('zz');
    await panel.getByRole('button', { name: 'Forward edited' }).click();
    await expect(panel.getByRole('alert')).toContainText('not valid hex');
    await panel.getByLabel('New payload').fill('');
    await panel.getByRole('button', { name: 'Forward edited' }).click();
    await expect(panel.getByRole('alert')).toContainText('Use Drop');
    await panel.getByLabel('New payload').fill('79');
    await panel.getByRole('button', { name: 'Forward edited' }).click();
    expect(await answer).toBe('y');
  });

  test('time running out applies the action of the rule', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await holdRule(panel, '0.5', 'forward');
    expect(await echo(page, 'late')).toBe('late');
    await expect(panel.getByText('Nothing is held.')).toBeVisible();
  });

  test('closing the panel lets go of held messages, and with no panel nothing waits', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await holdRule(panel);
    const answer = echo(page, 'first');
    await expect(rows(panel)).toHaveCount(1, { timeout: 10_000 });
    await panel.close();
    expect(await answer).toBe('first');
    const start = Date.now();
    expect(await echo(page, 'second')).toBe('second');
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test('Drop stops the message', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await holdRule(panel);
    void echo(page, 'gone').catch(() => undefined);
    await expect(rows(panel)).toHaveCount(1, { timeout: 10_000 });
    await panel.getByRole('listbox').press('d');
    await expect(panel.getByText('Nothing is held.')).toBeVisible();
    await expect(panel.locator('.counters')).toContainText('1 dropped', { timeout: 5_000 });
  });
});

test.describe('panel', () => {
  test('a narrow panel never scrolls sideways, while it records and plays', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId, 'default', 'simple');
    await panel.setViewportSize({ width: 480, height: 800 });
    const fits = async (where: string): Promise<void> => {
      const wide = await panel.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(wide, `${where}: the panel is wider than its window`).toBeLessThanOrEqual(0);
      // No part of the panel goes out at the right, except what scrolls in its own box (wide tables, the tabs).
      const out = await panel.evaluate(() =>
        [...document.querySelectorAll('body *')]
          .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > innerWidth + 1 && !el.closest('table, .view-tabs'))
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className)}`),
      );
      expect(out, `${where}: these go out of the panel`).toEqual([]);
    };
    const everyView = async (when: string): Promise<void> => {
      for (const name of ['Monitor', 'Tracks', 'Messages', 'Rules', 'Record']) {
        await panel.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
        await fits(`${when}, ${name}`);
      }
    };
    await page.evaluate(() => window.__demo.startMoq());
    await expect(panel.getByRole('tab', { name: /^Tracks \d/ })).toBeVisible({ timeout: 10_000 });
    await everyView('live');
    await panel.getByRole('tab', { name: /^Record/ }).click();
    await panel.getByRole('button', { name: 'Start recording' }).click();
    await panel.waitForTimeout(2500);
    await expect(panel.getByRole('tab', { name: 'Record, recording' })).toBeVisible();
    await everyView('recording');
    await panel.getByRole('tab', { name: /^Record/ }).click();
    await panel.getByRole('button', { name: 'Stop recording' }).click();
    await expect(panel.locator('.recording-card')).toHaveCount(1, { timeout: 15_000 });
    await panel.getByRole('button', { name: 'Play', exact: true }).first().click();
    await fits('ready to play');
    await page.evaluate(() => window.__demo.startMoq());
    await expect(panel.locator('.replay-state')).toHaveText(/Replaying|Replay ended/, { timeout: 10_000 });
    await everyView('replaying');
  });

  test('rules deleted outside the panel leave its list, and a site that is on does not say it is off', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await expect(panel.getByText('Sluice is on for this site.')).toBeVisible();
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await panel.getByRole('button', { name: 'Add rule' }).click();
    await panel.getByRole('button', { name: 'Save and apply' }).click();
    await expect(panel.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await expect(panel.getByText('Drop, for every message')).toBeVisible();
    await expect(panel.getByText('Sluice is off for this site.')).toHaveCount(0);
    await worker.evaluate(() => chrome.storage.local.remove('config:http://localhost:8080'));
    await expect(panel.getByText('No rules.')).toBeVisible();
  });

  test('a worker that stays native gives its reason as text', async ({ page, worker, extensionId }) => {
    await worker.evaluate(() => chrome.storage.local.set({ 'worker-sites': ['http://localhost/*'] }));
    await expect
      .poll(() => worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id)))
      .toContain('sluice-main-workers');
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await page.evaluate(() => {
      new Worker(URL.createObjectURL(new Blob(['self.onmessage = () => undefined;'], { type: 'text/javascript' })));
    });
    await panel.getByText('1 worker script is not inspected').click();
    await expect(panel.getByText('It starts from a blob: URL')).toBeVisible();
  });

  test('the message list moves with Home, End, PageUp and PageDown', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await page.evaluate(async () => {
      for (let i = 0; i < 6; i++) await window.__demo.echoDatagram(`m${i}`);
    });
    const rows = panel.getByRole('listbox').getByRole('option');
    // Datagrams can be lost on the way, so the number of rows can be less than 12.
    await expect(rows.filter({ hasText: 'm5' }).first()).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(6);
    const selected = panel.locator('.row[aria-selected="true"]');
    await rows.first().click();
    const count = await rows.count();
    await panel.getByRole('listbox').press('End');
    await expect(selected).toHaveAttribute('aria-posinset', String(count));
    await panel.getByRole('listbox').press('Home');
    await expect(selected).toHaveAttribute('aria-posinset', '1');
    await panel.getByRole('listbox').press('PageDown');
    await expect(selected).not.toHaveAttribute('aria-posinset', '1');
    await panel.getByRole('listbox').press('PageUp');
    await expect(selected).toHaveAttribute('aria-posinset', '1');
  });

  test('Clear starts the counters from zero', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await page.evaluate(() => window.__demo.echoDatagram('before'));
    await expect(panel.locator('.counters')).toContainText(/[1-9]\d* chunks/, { timeout: 10_000 });
    await panel.getByRole('button', { name: 'Clear' }).click();
    await expect(panel.locator('.counters')).toContainText(/^0 chunks/);
  });

  test('with no session it says how to start', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await expect(panel.getByText('No WebTransport sessions yet.')).toBeVisible();
    await expect(panel.getByRole('status')).not.toContainText('Not connected');
    await expect(panel.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('shows a session, a message, and its payload as text, hex and JSON', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await page.evaluate(() => window.__demo.echoDatagram('{"hello":1}'));

    await expect(panel.getByRole('button', { name: /localhost:\d+\/echo/ })).toBeVisible();
    const row = panel.getByRole('listbox').getByRole('option').filter({ hasText: '{"hello":1}' }).last();
    await row.click();
    await expect(panel.locator('.detail pre')).toHaveText('{"hello":1}');
    await panel.getByRole('tab', { name: 'JSON' }).click();
    await expect(panel.locator('.json-tree')).toContainText('hello: 1');
    await panel.getByRole('tab', { name: 'Hex' }).click();
    await expect(panel.locator('.detail pre')).toContainText('7b 22 68 65');
    await expect(panel.locator('.counters')).toContainText('chunks');
  });

  test('shows a dropped message with a word, not only a color', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await page.evaluate(() => window.__demo.startPush());
    await expect(panel.getByRole('listbox').getByRole('option').first()).toBeVisible();
    const control = await page.context().newPage();
    await control.goto(`chrome-extension://${extensionId}/panel/panel.html`);
    await control.evaluate(
      async ({ config }) => {
        const tab = (await chrome.tabs.query({})).find((t) => t.url?.startsWith('http://localhost'));
        const port = chrome.runtime.connect({ name: `panel:${tab?.id}` });
        port.postMessage({
          v: 1,
          type: 'set-config',
          id: 1,
          payload: { targetOrigin: 'http://localhost:8080', config: { ...config, rules: [{ id: 'd', on: ['datagram'], action: { type: 'drop' } }] } },
        });
      },
      { config: DEFAULT_CONFIG },
    );
    await expect(panel.locator('.badge.dropped').last()).toHaveText('dropped', { timeout: 10000 });
  });

  test('page text is never markup', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await page.evaluate(() => window.__demo.echoDatagram('<img src=x onerror="window.__pwned=1"><b>bold</b>'));
    const row = panel.getByRole('listbox').getByRole('option').filter({ hasText: '<b>bold</b>' }).last();
    await row.click();
    await expect(panel.locator('.detail pre')).toContainText('<b>bold</b>');
    expect(await panel.locator('.detail b, .row b, .row img, .detail img').count()).toBe(0);
    expect(await panel.evaluate(() => '__pwned' in window)).toBe(false);
    await page.evaluate(() => window.__demo.echoDatagram('live\u202eevil'));
    await expect(panel.getByRole('listbox').getByRole('option').filter({ hasText: 'live\\u{202e}evil' }).last()).toBeVisible();
  });

  test('the filter, the scope and Clear work', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await page.evaluate(async () => {
      await window.__demo.echoDatagram('apple');
      await window.__demo.echoDatagram('pear');
    });
    await expect(panel.getByRole('listbox').getByRole('option').filter({ hasText: 'pear' }).last()).toBeVisible();
    await panel.getByLabel('Filter payload text').fill('apple');
    await expect(panel.getByRole('listbox').getByRole('option').filter({ hasText: 'pear' })).toHaveCount(0);
    await expect(panel.getByRole('listbox').getByRole('option').filter({ hasText: 'apple' }).last()).toBeVisible();
    await panel.getByLabel('Filter payload text').fill('');
    await panel.getByRole('button', { name: 'datagrams' }).first().click();
    await expect(panel.getByRole('listbox').getByRole('option').first()).toBeVisible();
    await panel.getByRole('button', { name: 'Clear' }).click();
    // The sessions of these calls are closed by now, so nothing stays.
    await expect(panel.getByText('No WebTransport sessions yet.')).toBeVisible();
  });

  test('keyboard moves the selection', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await page.evaluate(async () => {
      await window.__demo.echoDatagram('one');
      await window.__demo.echoDatagram('two');
    });
    await expect(panel.getByRole('listbox').getByRole('option').filter({ hasText: 'two' }).last()).toBeVisible();
    await panel.getByRole('listbox').focus();
    await panel.keyboard.press('ArrowDown');
    await expect(panel.locator('.detail pre')).toHaveText('one');
    // Each message has two rows: what the app sent, then what came back.
    await panel.keyboard.press('ArrowDown');
    await panel.keyboard.press('ArrowDown');
    await expect(panel.locator('.detail pre')).toHaveText('two');
    await panel.getByRole('tab', { name: 'Text' }).focus();
    await panel.keyboard.press('ArrowRight');
    await expect(panel.getByRole('tab', { name: 'JSON' })).toBeFocused();
    await expect(panel.locator('#payload')).toContainText('Not valid JSON');
  });

  test('renders only the visible rows of a long list', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await page.evaluate(() => window.__demo.startPush());
    await expect(panel.getByRole('listbox').getByRole('option').first()).toBeVisible();
    // More than one row of overflow: within one row of the end, the list counts as being at the bottom.
    await expect.poll(() => panel.locator('.list').evaluate((list) => list.scrollHeight > list.clientHeight + 100), { timeout: 20_000 }).toBe(true);
    const boxes = await panel.getByRole('listbox').getByRole('option').evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().top));
    expect(new Set(boxes).size).toBe(boxes.length);
    expect(boxes.length).toBeLessThan(50);
    // It follows the newest row, and stops when the user scrolls up.
    const list = panel.locator('.list');
    await expect.poll(() => list.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 44)).toBe(true);
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    await panel.waitForTimeout(600);
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
  });

  test('a rule made in the form changes the traffic, and stays after a reload', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await expect(panel.getByRole('heading')).toHaveText('Rules for http://localhost:8080');
    await expect(panel.getByText('No rules.')).toBeVisible();

    await panel.getByRole('button', { name: 'Add rule' }).click();
    await panel.getByRole('checkbox', { name: 'Uni streams' }).uncheck();
    await panel.getByRole('checkbox', { name: 'Bidi streams' }).uncheck();
    await expect(panel.getByText('Not saved')).toBeVisible();
    await panel.getByRole('button', { name: 'Save and apply' }).click();
    await expect(panel.locator('.rules-state')).toHaveText('Saved');

    // Reloading the page proves that it is saved, and that the first datagram does not pass before the rules arrive.
    await page.reload();
    await page.waitForFunction(() => '__demo' in window);
    await page.evaluate(() => window.__demo.startPush());
    await expect.poll(() => page.evaluate(() => window.__demo.state.counters.uniStreams), { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(panel.locator('.counters')).toContainText(/[1-9]\d* dropped/, { timeout: 10_000 });
    expect(await page.evaluate(() => window.__demo.state.counters.datagrams)).toBe(0);

    // The panel shows the saved rule when it opens again.
    const again = await openPanel(page, worker, extensionId);
    await again.getByRole('tab', { name: 'Rules' }).click();
    await expect(again.getByText('Drop, only datagrams')).toBeVisible();
  });

  test('unsaved edits stay when the view changes, and the keyboard reaches the tabs', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await panel.getByRole('button', { name: 'Add rule' }).click();
    await expect(panel.getByLabel('Action')).toBeFocused();
    await panel.getByRole('tab', { name: 'Messages' }).click();
    await panel.getByRole('tab', { name: 'Messages' }).focus();
    await panel.keyboard.press('ArrowLeft');
    await expect(panel.getByRole('tab', { name: 'Tracks' })).toBeFocused();
    await panel.keyboard.press('ArrowRight');
    await panel.keyboard.press('ArrowRight');
    await expect(panel.getByRole('tab', { name: 'Rules' })).toBeFocused();
    await expect(panel.locator('.rules-state')).toHaveText('Not saved');
    await panel.getByRole('button', { name: 'Delete rule 1' }).click();
    await expect(panel.getByRole('button', { name: 'Add rule' })).toBeFocused();
  });

  test('Save stays off until the saved rules are known, so it cannot replace them', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await page.context().newPage();
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.startsWith('http://localhost'))?.id);
    // This page never says its URL, as a hung page would not.
    await panel.addInitScript((id) => {
      Object.defineProperty(chrome, 'devtools', {
        value: { inspectedWindow: { tabId: id, eval: () => undefined }, panels: { themeName: 'default' }, network: { onNavigated: { addListener: () => undefined } } },
      });
    }, tabId);
    await panel.goto(`chrome-extension://${extensionId}/panel/panel.html`);
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await expect(panel.getByText('Waiting for the page.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Save and apply' })).toHaveCount(0);
  });

  test('the form shows why a rule is not valid, and saves nothing', async ({ page, worker, extensionId }) => {
    await openDemo(page);
    const panel = await openPanel(page, worker, extensionId);
    await panel.getByRole('tab', { name: 'Rules' }).click();
    await panel.getByRole('button', { name: 'Add rule' }).click();
    await panel.getByLabel('Payload matches regex').fill('(a+)+$');
    await panel.getByRole('button', { name: 'Save and apply' }).click();
    await expect(panel.getByRole('alert')).toContainText('Rule 1, Payload matches regex');
    await expect(panel.getByRole('alert')).toContainText('repeat inside a repeat');
    await expect(panel.getByLabel('Payload matches regex')).toHaveAttribute('aria-invalid', 'true');
    await expect(panel.locator('.rules-state')).toHaveText('Not saved');
    const stored = await worker.evaluate(() => chrome.storage.local.get(null));
    expect(stored).toEqual({});
  });
});
