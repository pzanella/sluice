import type { Page, Worker as ServiceWorker } from '@playwright/test';
import { DEFAULT_CONFIG } from '../../src/shared/rules';
import type { PanelMessage, RuntimeMessage } from '../../src/shared/protocol';
import { DEMO_URL, expect, test } from './fixtures';

declare global {
  interface Window {
    __panel: { port: chrome.runtime.Port; messages: PanelMessage[] };
  }
}

const switchOn = async (worker: ServiceWorker): Promise<void> => {
  await worker.evaluate(() => chrome.storage.local.set({ 'worker-sites': ['http://localhost/*'] }));
  await expect
    .poll(() => worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).sort()))
    .toEqual(['sluice-bridge', 'sluice-main', 'sluice-main-workers']);
};

const openPanel = async (page: Page, extensionId: string): Promise<Page> => {
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
};

const received = (panel: Page): Promise<RuntimeMessage[]> =>
  panel.evaluate(() => window.__panel.messages.flatMap((m) => (m.type === 'frame-message' ? [m.payload.message] : [])));

interface Echo {
  location: string;
  seen: unknown[];
  relativeFetch: unknown;
  relativeImport?: unknown;
  nested?: unknown;
  patched: boolean;
  echo: string | null;
}

/** Waits for the probe of the page (it has no saved result yet), then runs the test worker and returns what it found from inside. */
const runWorker = (page: Page, options: WorkerOptions = {}, text = 'from worker', script = 'wt-worker.js', extra: object = {}): Promise<Echo> =>
  page.evaluate(
    async ({ options, text, script, extra }) => {
      const config = (await (await fetch('config.json')).json()) as object;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const worker = new Worker(script, options);
      return new Promise<Echo>((resolve, reject) => {
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessage = (event: MessageEvent<Echo & { loaded?: boolean }>) => {
          if (event.data.loaded) worker.postMessage({ type: 'echo', text, ...config, ...extra });
          else resolve(event.data);
        };
      });
    },
    { options, text, script, extra },
  );

const workerReports = (messages: RuntimeMessage[]) =>
  messages.flatMap((m) => (m.type === 'worker-message' ? [m.payload.message] : []));

test.describe('with the switch off', () => {
  test('a worker runs native, from its real URL', async ({ page }) => {
    await page.goto(DEMO_URL);
    const out = await runWorker(page);
    expect(out.location).toBe(`${DEMO_URL}wt-worker.js`);
    expect(out.patched).toBe(false);
    expect(out.echo).toBe('from worker');
  });
});

test.describe('with the switch on', () => {
  for (const options of [{}, { type: 'module' }] as WorkerOptions[]) {
    const name = options.type ?? 'classic';

    test(`a ${name} worker is patched, and looks as if it runs from its real URL`, async ({ page, worker }) => {
      await switchOn(worker);
      await page.goto(DEMO_URL);
      const out = await runWorker(page, options);
      expect(out.patched).toBe(true);
      expect(out.location).toBe(`${DEMO_URL}wt-worker.js`);
      expect(out.relativeFetch).toBe(true);
      expect(out.echo).toBe('from worker');
    });

    test(`the app in a ${name} worker gets its own messages only`, async ({ page, worker }) => {
      await switchOn(worker);
      await page.goto(DEMO_URL);
      const out = await runWorker(page, options);
      expect(out.seen).toEqual([expect.objectContaining({ type: 'echo' })]);
    });

    test(`a panel sees the traffic of a ${name} worker, and its rules apply there`, async ({ page, worker, extensionId }) => {
      await switchOn(worker);
      await page.goto(DEMO_URL);
      const panel = await openPanel(page, extensionId);
      expect((await runWorker(page, options, 'first')).echo).toBe('first');
      await expect
        .poll(async () => {
          const reports = workerReports(await received(panel));
          return ['session-open', 'traffic'].every((type) => reports.some((m) => m.type === type));
        })
        .toBe(true);
      const config = {
        ...DEFAULT_CONFIG,
        rules: [{ id: 'drop-it', on: ['datagram'], action: { type: 'drop' } }],
      };
      await panel.evaluate(
        (message) => window.__panel.port.postMessage(message),
        { v: 1, type: 'set-config', id: 1, payload: { config, targetOrigin: new URL(DEMO_URL).origin } },
      );
      await panel.waitForTimeout(200);
      expect((await runWorker(page, options, 'second')).echo).toBeNull();
    });
  }

  test('a hold in a worker is decided in the panel, and an edit reaches only that worker', async ({ page, worker, extensionId }) => {
    await switchOn(worker);
    await page.goto(DEMO_URL);
    const panel = await openPanel(page, extensionId);
    const config = { ...DEFAULT_CONFIG, rules: [{ id: 'h', on: ['datagram'], action: { type: 'hold', timeoutMs: 20_000, onTimeout: 'drop' } }] };
    await panel.evaluate(
      (message) => window.__panel.port.postMessage(message),
      { v: 1, type: 'set-config', id: 1, payload: { config, targetOrigin: new URL(DEMO_URL).origin } },
    );
    await panel.waitForTimeout(200);
    const out = runWorker(page, {}, 'old');
    const held = await expect
      .poll(() =>
        panel.evaluate(() =>
          window.__panel.messages.flatMap((m) =>
            m.type === 'frame-message' && m.payload.message.type === 'worker-message' && m.payload.message.payload.message.type === 'hold'
              ? [{ documentId: m.payload.documentId, workerId: m.payload.message.payload.workerId, holdId: m.payload.message.payload.message.payload.holdId }]
              : [],
          ).length,
        ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0)
      .then(() =>
        panel.evaluate(() => {
          for (const m of window.__panel.messages) {
            if (m.type === 'frame-message' && m.payload.message.type === 'worker-message' && m.payload.message.payload.message.type === 'hold') {
              return { documentId: m.payload.documentId, workerId: m.payload.message.payload.workerId, holdId: m.payload.message.payload.message.payload.holdId };
            }
          }
          throw new Error('no hold');
        }),
      );
    await panel.evaluate(
      (payload) => window.__panel.port.postMessage({ v: 1, type: 'hold-resolve', id: 2, payload }),
      { ...held, action: 'edit', data: btoa('new') },
    );
    expect((await out).echo).toBe('new');
  });

  test('an inject reaches a session in a worker', async ({ page, worker, extensionId }) => {
    await switchOn(worker);
    await page.goto(DEMO_URL);
    const panel = await openPanel(page, extensionId);
    const config = { ...DEFAULT_CONFIG, rules: [{ id: 'h', on: ['datagram'], action: { type: 'hold', timeoutMs: 20_000, onTimeout: 'drop' } }] };
    await panel.evaluate(
      (message) => window.__panel.port.postMessage(message),
      { v: 1, type: 'set-config', id: 1, payload: { config, targetOrigin: new URL(DEMO_URL).origin } },
    );
    await panel.waitForTimeout(200);
    // The first datagram stays held, so the session of the worker is open and reading.
    const out = runWorker(page, {}, 'real');
    const target = await expect
      .poll(() =>
        panel.evaluate(() => window.__panel.messages.some((m) => m.type === 'frame-message' && m.payload.message.type === 'worker-message' && m.payload.message.payload.message.type === 'hold')),
        { timeout: 15_000 },
      )
      .toBe(true)
      .then(() =>
        panel.evaluate(() => {
          for (const m of window.__panel.messages) {
            if (m.type === 'frame-message' && m.payload.message.type === 'worker-message' && m.payload.message.payload.message.type === 'hold') {
              const held = m.payload.message.payload.message.payload;
              return { documentId: m.payload.documentId, workerId: m.payload.message.payload.workerId, sessionId: held.sessionId, holdId: held.holdId };
            }
          }
          throw new Error('no hold');
        }),
      );
    const { holdId, ...to } = target;
    await panel.evaluate(
      (payload) => window.__panel.port.postMessage({ v: 1, type: 'inject', id: 3, payload }),
      { ...to, injectId: 77, kind: 'datagram', data: btoa('made') },
    );
    await expect
      .poll(() =>
        panel.evaluate(() =>
          window.__panel.messages.some(
            (m) => m.type === 'frame-message' && m.payload.message.type === 'worker-message' && m.payload.message.payload.message.type === 'inject-result' && m.payload.message.payload.message.payload.injectId === 77 && m.payload.message.payload.message.payload.failure === null,
          ),
        ),
      )
      .toBe(true);
    await panel.evaluate(
      (payload) => window.__panel.port.postMessage({ v: 1, type: 'hold-resolve', id: 4, payload }),
      { documentId: to.documentId, workerId: to.workerId, holdId, action: 'forward', data: null },
    );
    expect((await out).patched).toBe(true);
  });

  test('relative importScripts and a nested worker work from a classic worker', async ({ page, worker }) => {
    await switchOn(worker);
    await page.goto(DEMO_URL);
    const out = await runWorker(page, {}, 'x', 'wt-worker.js', { relativeImport: true, nested: true });
    expect(out.relativeImport).toBe('dep');
    expect(out.nested).toBe('dep');
  });

  test('a redirect gives the worker the final URL as its base, as native does', async ({ page, context, worker }) => {
    await switchOn(worker);
    await context.route(`${DEMO_URL}moved/w.js`, (route) => route.fulfill({ status: 302, headers: { location: `${DEMO_URL}wt-worker.js` } }));
    await page.goto(DEMO_URL);
    const out = await runWorker(page, {}, 'x', 'moved/w.js');
    expect(out.patched).toBe(true);
    expect(out.location).toBe(`${DEMO_URL}wt-worker.js`);
    expect(out.relativeFetch).toBe(true);
  });

  test('the fragment of a worker URL stays', async ({ page, worker }) => {
    await switchOn(worker);
    await page.goto(DEMO_URL);
    const out = await runWorker(page, {}, 'x', 'wt-worker.js#cfg=1');
    expect(out.patched).toBe(true);
    expect(out.location).toBe(`${DEMO_URL}wt-worker.js#cfg=1`);
  });

  test('a redirect to another origin fails, as native does', async ({ page, context, worker }) => {
    await switchOn(worker);
    await context.route(`${DEMO_URL}away.js`, (route) => route.fulfill({ status: 302, headers: { location: 'http://127.0.0.1:8080/wt-worker.js' } }));
    await page.goto(DEMO_URL);
    const outcome = await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const blocked = new Worker('away.js');
      return new Promise((resolve) => {
        blocked.onmessage = () => resolve('ran');
        blocked.onerror = (event) => {
          event.preventDefault();
          resolve('error');
        };
      });
    });
    expect(outcome).toBe('error');
  });

  test('a worker in a srcdoc frame is instrumented too', async ({ page, worker, extensionId }) => {
    await switchOn(worker);
    await page.goto(DEMO_URL);
    const panel = await openPanel(page, extensionId);
    await page.evaluate(async (base) => {
      const frame = document.createElement('iframe');
      frame.srcdoc = '<!doctype html><body>x';
      await new Promise((resolve) => {
        frame.onload = resolve;
        document.body.append(frame);
      });
      const win = frame.contentWindow as unknown as typeof globalThis;
      await new Promise((resolve) => setTimeout(resolve, 400));
      new win.Worker(`${base}wt-worker.js`).terminate();
    }, DEMO_URL);
    await expect.poll(async () => (await received(panel)).some((m) => m.type === 'worker-gone')).toBe(true);
    expect((await received(panel)).filter((m) => m.type === 'worker-skipped')).toEqual([]);
  });

  test('a worker that closes itself is reported as gone', async ({ page, worker, extensionId }) => {
    await switchOn(worker);
    await page.goto(DEMO_URL);
    const panel = await openPanel(page, extensionId);
    await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const closing = new Worker('wt-worker.js');
      closing.onmessage = () => closing.postMessage({ type: 'close' });
    });
    await expect.poll(async () => (await received(panel)).some((m) => m.type === 'worker-gone'), { timeout: 10_000 }).toBe(true);
  });

  test('a worker in the first scripts of a page runs native at first, and is instrumented after a reload', async ({ page, context, worker, extensionId }) => {
    await switchOn(worker);
    await context.route(`${DEMO_URL}early`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><script>window.early = new Worker("wt-worker.js"); window.first = new Promise((r) => { window.early.onmessage = () => { window.early.postMessage({ type: "where" }); r(); }; });</script><body>x',
      }),
    );
    await page.goto(`${DEMO_URL}early`);
    const panel = await openPanel(page, extensionId);
    await expect.poll(async () => (await received(panel)).some((m) => m.type === 'worker-skipped' && m.payload.reason === 'starting')).toBe(true);
    await page.waitForTimeout(500);
    await panel.evaluate(() => (window.__panel.messages.length = 0));
    await page.reload();
    await page.waitForTimeout(500);
    expect((await received(panel)).filter((m) => m.type === 'worker-skipped')).toEqual([]);
  });

  for (const [name, csp] of [
    ['a script-src that does not cover the site', "script-src 'unsafe-inline' 'unsafe-eval' https://cdn.test; worker-src 'self' blob:"],
    ['a connect-src that blocks the site', "connect-src 'none'; worker-src 'self' blob:"],
  ] as const) {
    test(`under ${name}, a worker runs native`, async ({ page, context, worker, extensionId }) => {
      await switchOn(worker);
      await context.route(DEMO_URL, async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
      });
      await page.goto(DEMO_URL);
      const panel = await openPanel(page, extensionId);
      await page.waitForTimeout(500);
      const loaded = await page.evaluate(async () => {
        const native = new Worker('wt-worker.js');
        return new Promise((resolve) => {
          native.onerror = () => resolve('error');
          native.onmessage = () => resolve('loaded');
        });
      });
      expect(loaded).toBe('loaded');
      await expect
        .poll(async () => (await received(panel)).some((m) => m.type === 'worker-skipped' && m.payload.reason === 'csp'))
        .toBe(true);
    });
  }

  test('a meta CSP after the start of the page: a worker runs native', async ({ page, context, worker, extensionId }) => {
    await switchOn(worker);
    await context.route(`${DEMO_URL}meta`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta http-equiv="Content-Security-Policy" content="worker-src 'self'"><body>x`,
      }),
    );
    await page.goto(`${DEMO_URL}meta`);
    const panel = await openPanel(page, extensionId);
    const loaded = await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const native = new Worker('wt-worker.js');
      return new Promise((resolve) => {
        native.onerror = () => resolve('error');
        native.onmessage = () => resolve('loaded');
      });
    });
    expect(loaded).toBe('loaded');
    await expect
      .poll(async () => (await received(panel)).some((m) => m.type === 'worker-skipped' && m.payload.reason === 'csp'))
      .toBe(true);
  });

  test('a worker that the app ends is reported as gone', async ({ page, worker, extensionId }) => {
    await switchOn(worker);
    await page.goto(DEMO_URL);
    const panel = await openPanel(page, extensionId);
    await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      new Worker('wt-worker.js').terminate();
    });
    await expect.poll(async () => (await received(panel)).some((m) => m.type === 'worker-gone')).toBe(true);
  });

  test('a worker from a blob: URL still runs, and the panel is told', async ({ page, worker, extensionId }) => {
    await switchOn(worker);
    await page.goto(DEMO_URL);
    const panel = await openPanel(page, extensionId);
    const answer = await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const url = URL.createObjectURL(new Blob(['postMessage(self.location.protocol)'], { type: 'text/javascript' }));
      const blobWorker = new Worker(url);
      URL.revokeObjectURL(url);
      return new Promise((resolve) => {
        blobWorker.onmessage = (event) => resolve(event.data);
      });
    });
    expect(answer).toBe('blob:');
    await expect
      .poll(async () => (await received(panel)).some((m) => m.type === 'worker-skipped' && m.payload.reason === 'blob-url'))
      .toBe(true);
  });

  test('under a CSP with no blob:, a worker still runs native, and the panel is told', async ({ page, context, worker, extensionId }) => {
    await switchOn(worker);
    await context.route(DEMO_URL, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "worker-src 'self'" } });
    });
    await page.goto(DEMO_URL);
    const panel = await openPanel(page, extensionId);
    const out = await runWorker(page);
    expect(out.location).toBe(`${DEMO_URL}wt-worker.js`);
    expect(out.patched).toBe(false);
    expect(out.echo).toBe('from worker');
    await expect
      .poll(async () => (await received(panel)).some((m) => m.type === 'worker-skipped' && m.payload.reason === 'csp'))
      .toBe(true);
  });

  test('an about:blank frame gets one runtime, not two', async ({ page, worker }) => {
    await switchOn(worker);
    await page.goto(DEMO_URL);
    const depth = await page.evaluate(() => {
      const frame = document.createElement('iframe');
      document.body.append(frame);
      const child = frame.contentWindow as unknown as { WebTransport: object; Function: { prototype: object } };
      let n = 0;
      for (let p: object | null = child.WebTransport; p && p !== child.Function.prototype; p = Object.getPrototypeOf(p) as object | null) n++;
      return n;
    });
    // The patched class, then the native one.
    expect(depth).toBe(2);
  });

  test('a switch for a site with no grant is dropped, and the site gets the normal runtime', async ({ page, worker }) => {
    await worker.evaluate(() => chrome.storage.local.set({ 'worker-sites': ['https://other.test/*'] }));
    await expect.poll(() => worker.evaluate(() => chrome.storage.local.get('worker-sites'))).toEqual({ 'worker-sites': [] });
    expect(await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)).toBe(2);
    await page.goto(DEMO_URL);
    expect((await runWorker(page)).patched).toBe(false);
  });
});

test.describe('popup', () => {
  test('the switch saves the site and asks for a reload', async ({ page, worker, extensionId }) => {
    await page.addInitScript((url) => {
      Object.defineProperty(chrome.tabs, 'query', { value: () => Promise.resolve([{ id: 1, url }]) });
    }, DEMO_URL);
    await page.goto(`chrome-extension://${extensionId}/panel/popup.html`);
    await page.getByText('More options').click();
    const box = page.getByRole('checkbox', { name: 'Also inspect workers on this site' });
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(page.getByText('Reload the page to apply a change.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload page' })).toHaveClass(/\bprimary\b/);
    await expect.poll(() => worker.evaluate(() => chrome.storage.local.get('worker-sites'))).toEqual({ 'worker-sites': ['http://localhost/*'] });
    await box.uncheck();
    await expect.poll(() => worker.evaluate(() => chrome.storage.local.get('worker-sites'))).toEqual({ 'worker-sites': [] });
  });

  test('is not offered on a site that is off', async ({ page, extensionId }) => {
    await page.addInitScript(() => {
      Object.defineProperty(chrome.tabs, 'query', { value: () => Promise.resolve([{ id: 1, url: 'https://example.test/' }]) });
    });
    await page.goto(`chrome-extension://${extensionId}/panel/popup.html`);
    await expect(page.getByRole('heading')).toHaveText('example.test');
    await expect(page.getByRole('checkbox')).toHaveCount(0);
  });
});
