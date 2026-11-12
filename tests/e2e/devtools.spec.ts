// The real panel, inside real DevTools. Playwright does not expose DevTools targets, so this test uses CDP directly.
// Showing the panel uses an inner module of DevTools. If a new Chromium moves it, this test fails at that step.
import { chromium, expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEMO_URL } from './fixtures';

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** Evaluates in one CDP target and returns the value. */
async function evaluate<T>(target: Target, expression: string): Promise<T> {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = fail;
  });
  try {
    return await new Promise<T>((done, fail) => {
      socket.onmessage = (event) => {
        const reply = JSON.parse(String(event.data)) as {
          id: number;
          result: { result: { value: T }; exceptionDetails?: { text: string } };
        };
        if (reply.id !== 1) return;
        if (reply.result.exceptionDetails) fail(new Error(reply.result.exceptionDetails.text));
        else done(reply.result.result.value);
      };
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally {
    socket.close();
  }
}

test.describe('real DevTools', () => {
  let browser: ChildProcess;
  let profile: string;
  let port: number;
  let browserLog = '';

  const targets = async (): Promise<Target[]> => (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Promise<Target[]>;
  const find = async (start: string): Promise<Target> => {
    let found: Target | undefined;
    try {
      await expect
        .poll(
          async () => {
            found = (await targets().catch(() => [])).find((t) => t.url.startsWith(start) || t.url.includes(start));
            return Boolean(found);
          },
          { timeout: 15_000 },
        )
        .toBe(true);
    } catch (err) {
      // With no target, the reason is usually that the browser did not start.
      throw new Error(`no target "${start}". Browser exit code: ${browser.exitCode}. Log:\n${browserLog.slice(-2000)}`, { cause: err });
    }
    return found as Target;
  };

  // eslint-disable-next-line no-empty-pattern -- Playwright needs the first argument to be a pattern.
  test.beforeEach(({}, testInfo) => {
    port = 9400 + testInfo.workerIndex;
    profile = mkdtempSync(join(tmpdir(), 'sluice-devtools-'));
    const extension = resolve('dist-granted');
    browser = spawn(
      chromium.executablePath(),
      [
        '--headless=new',
        '--no-first-run',
        // Same as Playwright's own launch. Linux CI has no usable sandbox for a browser started this way.
        '--no-sandbox',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        '--auto-open-devtools-for-tabs',
        DEMO_URL,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    browserLog = '';
    browser.stderr?.on('data', (data: Buffer) => {
      browserLog += data.toString();
    });
  });

  test.afterEach(async () => {
    browser.kill();
    await new Promise((done) => setTimeout(done, 300));
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  });

  test('the panel opens, connects and shows the traffic of its tab', async () => {
    const devtools = await find('devtools://devtools/bundled/devtools_app.html');
    await expect
      .poll(
        () =>
          evaluate<boolean>(
            devtools,
            `(async () => {
              const UI = await import('./ui/legacy/legacy.js');
              const view = UI.InspectorView.InspectorView.instance();
              const id = view.tabbedPane.tabIds().find((tab) => tab.endsWith('Sluice'));
              if (!id) return false;
              await view.showPanel(id);
              return true;
            })()`,
          ).catch(() => false),
        { timeout: 15_000 },
      )
      .toBe(true);

    const panel = await find('/panel/panel.html');
    const demo = await find(DEMO_URL);
    await expect
      .poll(
        async () => {
          // The first load comes before the worker registers the scripts, as with a real grant: reload.
          const patched = await evaluate<boolean>(demo, "'__demo' in window && Object.getPrototypeOf(WebTransport) !== Function.prototype").catch(() => false);
          if (!patched) await evaluate(demo, 'location.reload()').catch(() => undefined);
          return patched;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // Before the panel gets its port, a message would be missed, so send until one shows.
    await expect
      .poll(
        async () => {
          await evaluate(demo, "window.__demo.echoDatagram('from-real-panel-test').catch(() => undefined)");
          return evaluate<string>(panel, 'document.body.innerText');
        },
        { timeout: 20_000 },
      )
      .toContain('from-real-panel-test');
    expect(await evaluate<string>(panel, 'document.body.innerText')).not.toContain('Not connected');
    expect(await evaluate<string>(panel, 'document.body.innerText')).toMatch(/localhost:\d+\/echo/);

    // The site of the tab comes from the real DevTools APIs, which a test page cannot run.
    await evaluate(panel, "[...document.querySelectorAll('[role=tab]')].find((tab) => tab.textContent === 'Rules').click()");
    // The Rules view opens simple; Advanced shows the site it saves for.
    await evaluate(panel, "[...document.querySelectorAll('[role=radio]')].find((button) => button.textContent === 'Advanced').click()");
    await expect.poll(() => evaluate<string>(panel, 'document.body.innerText')).toContain('Rules for http://localhost:8080');
  });
});
