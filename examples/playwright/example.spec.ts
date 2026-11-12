// A test with a seeded loss of datagrams: two runs lose the same messages. It needs the local demo (`node test-env/env.mjs up`).
// For your app, change the URL, the pattern and the code in `runApp`.
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { applyScenario, extensionFor, launchWithSluice } from './sluice';

const ORIGIN = 'http://localhost:8080';
const SCENARIO = fileURLToPath(new URL('./lossy.scenario.json', import.meta.url));

async function runApp(extension: string): Promise<string[]> {
  const { context, worker } = await launchWithSluice(extension);
  try {
    await applyScenario(worker, ORIGIN, SCENARIO);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    return await page.evaluate(async () => {
      const config = (await (await fetch('/config.json')).json()) as { wtPort: number; certHash: string };
      const value = Uint8Array.from(config.certHash.match(/../g) ?? [], (byte) => parseInt(byte, 16));
      const transport = new WebTransport(`https://localhost:${config.wtPort}/echo`, { serverCertificateHashes: [{ algorithm: 'sha-256', value }] });
      await transport.ready;
      const got: string[] = [];
      void (async () => {
        const reader = transport.datagrams.readable.getReader();
        for (;;) {
          const { value: data, done } = await reader.read();
          if (done) return;
          got.push(new TextDecoder().decode(data));
        }
      })().catch(() => undefined);
      const writer = transport.datagrams.writable.getWriter();
      for (let i = 0; i < 40; i++) {
        await writer.write(new TextEncoder().encode(`m${i}`));
        // Slow enough that the order stays the same: the seed decides by the order of arrival.
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      // Wait until nothing more comes: under load an echo can be late, and a cut would lose it as a real loss would.
      let count = -1;
      for (let i = 0; i < 30 && count !== got.length; i++) {
        count = got.length;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      transport.close();
      return got;
    });
  } finally {
    await context.close();
  }
}

test('the same seed loses the same datagrams in two runs', async () => {
  const extension = extensionFor('dist', 'http://localhost/*');
  const first = await runApp(extension);
  const second = await runApp(extension);
  expect(first.length).toBeGreaterThan(5);
  expect(first.length).toBeLessThan(35);
  expect(second).toEqual(first);
});
