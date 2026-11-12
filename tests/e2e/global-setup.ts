import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

/** The tests load the build, so make it first. See fixtures.ts for the granted copy. */
export default function globalSetup(): void {
  execFileSync('node', ['scripts/build.mjs'], { stdio: 'inherit' });
  rmSync('dist-granted', { recursive: true, force: true });
  cpSync('dist', 'dist-granted', { recursive: true });
  const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8')) as Record<string, unknown>;
  manifest.host_permissions = ['http://localhost/*'];
  writeFileSync('dist-granted/manifest.json', JSON.stringify(manifest, null, 2));
}
