import type { Page } from '@playwright/test';
import { DEMO_URL, expect, test } from './fixtures';

test.describe('frames with no origin of their own', () => {
  test('a srcdoc iframe is patched before its own scripts run', async ({ page }) => {
    await page.goto(DEMO_URL);
    const patched = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          window.addEventListener('message', (event) => resolve(event.data === true), { once: true });
          const frame = document.createElement('iframe');
          frame.srcdoc =
            '<script>parent.postMessage(Object.getPrototypeOf(WebTransport) !== Function.prototype, "*")</scr' + 'ipt>';
          document.body.append(frame);
        }),
    );
    expect(patched).toBe(true);
  });

  const probe = "parent.postMessage(typeof WebTransport === 'undefined' ? 'none' : Object.getPrototypeOf(WebTransport) !== Function.prototype ? 'patched' : 'native', '*')";
  const askFrame = (page: Page, setup: string): Promise<string> =>
    page.evaluate(
      ({ setup, html }) =>
        new Promise<string>((resolve) => {
          window.addEventListener('message', (event) => resolve(String(event.data)), { once: true });
          setTimeout(() => resolve('no answer'), 5000);
          const frame = document.createElement('iframe');
          if (setup === 'data') frame.src = `data:text/html,${encodeURIComponent(html)}`;
          else {
            frame.setAttribute('sandbox', 'allow-scripts');
            frame.srcdoc = html;
          }
          document.body.append(frame);
        }),
      { setup, html: `<script>${probe}</scr` + 'ipt>' },
    );

  test('a data: iframe has no WebTransport, so there is nothing to patch', async ({ page }) => {
    await page.goto(DEMO_URL);
    expect(await askFrame(page, 'data')).toBe('none');
  });

  test('a sandboxed srcdoc iframe is patched', async ({ page }) => {
    await page.goto(DEMO_URL);
    expect(await askFrame(page, 'sandbox')).toBe('patched');
  });

  test('an about:blank iframe is patched after it loads', async ({ page }) => {
    await page.goto(DEMO_URL);
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'blank';
      document.body.append(frame);
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const win = (document.getElementById('blank') as HTMLIFrameElement).contentWindow;
          return win ? Object.getPrototypeOf((win as Window & typeof globalThis).WebTransport) !== Function.prototype : false;
        }),
      )
      .toBe(true);
  });
});

test.describe('patch depth and more frame kinds', () => {
  // One Sluice class over the native one. Two would mean that rules and delays run twice.
  const depth = (ctor: object): number => {
    let count = 0;
    for (let c = ctor; c !== Function.prototype; c = Object.getPrototypeOf(c) as object) count++;
    return count;
  };

  test('a frame that goes from about:blank to a same-origin URL is patched once', async ({ page }) => {
    await page.goto(DEMO_URL);
    const depthText = depth.toString();
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'nav';
      document.body.append(frame);
    });
    await page.waitForTimeout(200);
    await page.evaluate(
      (url) =>
        new Promise<void>((resolve) => {
          const frame = document.getElementById('nav') as HTMLIFrameElement;
          frame.addEventListener('load', () => resolve(), { once: true });
          frame.src = url;
        }),
      `${DEMO_URL}config.json`,
    );
    const frame = page.frames().find((f) => f.url().endsWith('/config.json'));
    expect(await frame?.evaluate(`(${depthText})(WebTransport)`)).toBe(2);
  });

  test('a normal page is patched once', async ({ page }) => {
    await page.goto(DEMO_URL);
    expect(await page.evaluate(`(${depth.toString()})(WebTransport)`)).toBe(2);
  });

  test('a blob: iframe and a window.open popup are patched', async ({ page }) => {
    await page.goto(DEMO_URL);
    const blob = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          window.addEventListener('message', (event) => resolve(event.data === true), { once: true });
          const html = '<script>parent.postMessage(Object.getPrototypeOf(WebTransport) !== Function.prototype, "*")</scr' + 'ipt>';
          const frame = document.createElement('iframe');
          frame.src = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
          document.body.append(frame);
        }),
    );
    expect(blob).toBe(true);
    const popup = await page.evaluate(() => {
      const win = window.open('about:blank');
      return new Promise<boolean>((resolve) =>
        setTimeout(() => {
          resolve(Object.getPrototypeOf((win as Window & typeof globalThis).WebTransport) !== Function.prototype);
          win?.close();
        }, 300),
      );
    });
    expect(popup).toBe(true);
  });

  test('an about:blank frame is patched in the same task as append', async ({ page }) => {
    await page.goto(DEMO_URL);
    const patched = await page.evaluate(() => {
      const frame = document.createElement('iframe');
      document.body.append(frame);
      const win = frame.contentWindow as Window & typeof globalThis;
      return Object.getPrototypeOf(win.WebTransport) !== Function.prototype;
    });
    expect(patched).toBe(true);
  });
});

test.describe('constructor shape, same as native', () => {
  for (const withExtension of [true, false]) {
    test.describe(withExtension ? 'with extension' : 'native', () => {
      test.use({ withExtension });
      test('no arguments give a TypeError, and length is 1', async ({ page }) => {
        await page.goto(DEMO_URL);
        const result = await page.evaluate(() => {
          let error = '';
          try {
            new (WebTransport as unknown as new () => unknown)();
          } catch (e) {
            error = (e as Error).name;
          }
          return { error, length: WebTransport.length, patched: Object.getPrototypeOf(WebTransport) !== Function.prototype };
        });
        expect(result).toEqual({ error: 'TypeError', length: 1, patched: withExtension });
      });
    });
  }
});
