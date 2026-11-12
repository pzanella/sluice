// Builds the extension into dist/.
// Content scripts must be classic scripts (no ESM imports), so each one is a separate IIFE bundle.
import { build } from 'vite';
import { cp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const watch = process.argv.includes('--watch');
const finalDir = resolve(root, 'dist');
// A one-time build goes to a new folder, then takes the place of dist/ in one step. A Chrome that loaded dist/ never sees it
// half built: with missing files, the registration of the content scripts fails and Sluice stops running on the sites.
const outDir = watch ? finalDir : resolve(root, 'dist.next');

const common = {
  root,
  configFile: false,
  logLevel: 'warn',
  publicDir: false,
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
};

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// The runtime inside a worker travels as a string in the runtime of the frame, because a page cannot load a file from the
// extension unless the extension exposes it to all pages. In watch mode a change here needs a new start.
const workerTmp = resolve(root, 'node_modules/.sluice-worker');
await build({
  ...common,
  build: {
    outDir: workerTmp,
    emptyOutDir: true,
    minify: false,
    lib: { entry: resolve(root, 'src/inject/worker-entry.ts'), formats: ['iife'], name: 'sluice_worker', fileName: () => 'worker.js' },
  },
});
const workerRuntime = await readFile(resolve(workerTmp, 'worker.js'), 'utf8');

/** One self-contained bundle per script entry. */
const scriptEntries = [
  { name: 'inject', entry: 'src/inject/index.ts', format: 'iife' },
  { name: 'inject-workers', entry: 'src/inject/index-workers.ts', format: 'iife' },
  { name: 'bridge', entry: 'src/bridge/index.ts', format: 'iife' },
  { name: 'background', entry: 'src/background/index.ts', format: 'es' },
];

for (const { name, entry, format } of scriptEntries) {
  await build({
    ...common,
    define: { __SLUICE_WORKER_RUNTIME__: JSON.stringify(workerRuntime) },
    build: {
      outDir,
      emptyOutDir: false,
      watch: watch ? {} : null,
      minify: false,
      sourcemap: true,
      lib: { entry: resolve(root, entry), formats: [format], name: `sluice_${name.replace('-', '_')}`, fileName: () => `${name}.js` },
    },
  });
}

// DevTools page + panel: normal multi-page HTML build.
await build({
  ...common,
  root: resolve(root, 'src/panel'),
  base: './',
  build: {
    outDir: resolve(outDir, 'panel'),
    emptyOutDir: false,
    watch: watch ? {} : null,
    sourcemap: true,
    // Not minified, like the scripts: a store review reads the code as it is (ADR-60).
    minify: false,
    modulePreload: false,
    rollupOptions: {
      input: {
        devtools: resolve(root, 'src/panel/devtools.html'),
        panel: resolve(root, 'src/panel/panel.html'),
        popup: resolve(root, 'src/panel/popup.html'),
      },
    },
  },
});

await cp(resolve(root, 'src/manifest.json'), resolve(outDir, 'manifest.json'));
// The PNGs come from `scripts/make-icons.mjs`. The SVG is the source, and Chrome does not need it.
await cp(resolve(root, 'src/icons'), resolve(outDir, 'icons'), { recursive: true, filter: (path) => !path.endsWith('.svg') });
if (!watch) {
  const oldDir = resolve(root, 'dist.old');
  await rm(oldDir, { recursive: true, force: true });
  await rename(finalDir, oldDir).catch(() => undefined);
  await rename(outDir, finalDir);
  await rm(oldDir, { recursive: true, force: true });
}
console.log(watch ? 'sluice: watching for changes' : 'sluice: built to dist/');
