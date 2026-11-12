import type { Page } from '@playwright/test';
import { DEFAULT_CONFIG } from '../../src/shared/rules';
import type { PanelMessage, RuntimeMessage } from '../../src/shared/protocol';
import { DEMO_URL, expect, test } from './fixtures';

declare global {
  interface Window {
    __panel: { port: chrome.runtime.Port; messages: PanelMessage[] };
  }
}

/** The real panel page, opened as a tab, with a port as the panel task will open it. */
async function openPanel(page: Page, extensionId: string): Promise<Page> {
  const panel = await page.context().newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel/panel.html`);
  await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url?.startsWith('http://localhost'));
    const port = chrome.runtime.connect({ name: `panel:${tab?.id}` });
    window.__panel = { port, messages: [] };
    port.onMessage.addListener((message: PanelMessage) => window.__panel.messages.push(message));
  });
  return panel;
}

const received = async (panel: Page): Promise<RuntimeMessage[]> =>
  panel.evaluate(() => window.__panel.messages.flatMap((m) => (m.type === 'frame-message' ? [m.payload.message] : [])));

const open = async (page: Page): Promise<void> => {
  await page.goto(DEMO_URL);
  await page.waitForFunction(() => '__demo' in window);
};

test.describe('bridge', () => {
  test('the nonce does not stay in the DOM', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-sluice-bridge'))).toBe(false);
  });

  test('a getter on CustomEvent.prototype does not see the nonce', async ({ page, extensionId }) => {
    await open(page);
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __seen: string[] }).__seen = seen;
      const original = Object.getOwnPropertyDescriptor(CustomEvent.prototype, 'detail')?.get;
      Object.defineProperty(CustomEvent.prototype, 'detail', {
        get(this: CustomEvent): unknown {
          seen.push(this.type);
          return original?.call(this) as unknown;
        },
      });
    });
    await openPanel(page, extensionId);
    await page.evaluate(() => window.__demo.echoDatagram('x'));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen.filter((t) => t.startsWith('sluice')))).toEqual([]);
  });

  test('a panel sees the session, traffic with payload, and stats', async ({ page, extensionId }) => {
    await open(page);
    const panel = await openPanel(page, extensionId);
    await page.evaluate(() => window.__demo.echoDatagram('hello'));
    await expect
      .poll(async () => {
        const messages = await received(panel);
        return ['session-open', 'traffic', 'stats'].every((type) => messages.some((m) => m.type === type));
      })
      .toBe(true);
    const messages = await received(panel);
    const opened = messages.find((m) => m.type === 'session-open');
    expect(opened?.type === 'session-open' && opened.payload.url).toMatch(/^https:\/\/localhost:\d+\/echo$/);
    const items = messages.flatMap((m) => (m.type === 'traffic' ? m.payload.items : []));
    const item = items.find((i) => i.kind === 'datagram');
    expect(item && atob(item.preview)).toBe('hello');
    expect(item?.outcome).toBe('passed');
  });

  test('a session opened before the panel is announced when it connects', async ({ page, extensionId }) => {
    await open(page);
    await page.evaluate(() => window.__demo.startPush());
    await page.waitForTimeout(300);
    const panel = await openPanel(page, extensionId);
    await expect.poll(async () => (await received(panel)).some((m) => m.type === 'session-open')).toBe(true);
    await expect.poll(async () => (await received(panel)).some((m) => m.type === 'traffic')).toBe(true);
  });

  test('a config from the panel changes the traffic that the app gets', async ({ page, extensionId }) => {
    await open(page);
    const panel = await openPanel(page, extensionId);
    await page.evaluate(() => window.__demo.startPush());
    await expect.poll(() => page.evaluate(() => window.__demo.state.counters.datagrams)).toBeGreaterThan(0);
    await panel.evaluate((config) => {
      window.__panel.port.postMessage({
        v: 1,
        type: 'set-config',
        id: 1,
        payload: {
          targetOrigin: 'http://localhost:8080',
          config: { ...config, rules: [{ id: 'all', on: ['datagram'], action: { type: 'drop' } }] },
        },
      });
    }, DEFAULT_CONFIG);
    await expect
      .poll(async () => {
        const messages = await received(panel);
        const items = messages.flatMap((m) => (m.type === 'traffic' ? m.payload.items : []));
        return items.some((i) => i.outcome === 'dropped');
      })
      .toBe(true);
    await page.waitForTimeout(100);
    const before = await page.evaluate(() => window.__demo.state.counters.datagrams);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__demo.state.counters.datagrams)).toBe(before);
  });

  test('a srcdoc frame reaches the panel too', async ({ page, extensionId }) => {
    await open(page);
    const panel = await openPanel(page, extensionId);
    // With no certificate hash the connection fails later, but the session is announced when it is created.
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.srcdoc = "<script>new WebTransport('https://localhost:1/echo')</scr" + 'ipt>';
      document.body.append(frame);
    });
    await expect
      .poll(() =>
        panel.evaluate(() =>
          window.__panel.messages.some((m) => m.type === 'frame-message' && m.payload.frameId !== 0 && m.payload.message.type === 'session-open'),
        ),
      )
      .toBe(true);
  });
});
