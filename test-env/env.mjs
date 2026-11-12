// Starts and stops the local test environment.
//   node test-env/env.mjs run    server in the foreground (used by Playwright)
//   node test-env/env.mjs up     server in the background
//   node test-env/env.mjs down   stops the background server
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const venv = join(here, '.venv');
const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const stamp = join(venv, '.requirements');
const requirementsPath = join(here, 'requirements.txt');
const pidFile = join(here, '.server.pid');
const logFile = join(here, 'server.log');
const server = join(here, 'server.py');
const DEMO_URL = 'http://localhost:8080/config.json';

function ensureVenv() {
  const requirements = readFileSync(requirementsPath, 'utf8');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === requirements) return;
  if (!existsSync(python)) execFileSync('python3', ['-m', 'venv', venv], { stdio: 'inherit' });
  execFileSync(python, ['-m', 'pip', 'install', '--quiet', '-r', requirementsPath], { stdio: 'inherit' });
  writeFileSync(stamp, requirements);
}

async function waitForServer(child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server stopped. See ${logFile}`);
    try {
      if ((await fetch(DEMO_URL)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start. See ${logFile}`);
}

function readPid() {
  return existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null;
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const command = process.argv[2];
if (command === 'run') {
  ensureVenv();
  const child = spawn(python, [server], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
  child.on('exit', (code) => process.exit(code ?? 0));
} else if (command === 'up') {
  const pid = readPid();
  if (pid !== null && isRunning(pid)) {
    console.log(`already running (pid ${pid})`);
  } else {
    ensureVenv();
    const log = openSync(logFile, 'w');
    const child = spawn(python, [server], { detached: true, stdio: ['ignore', log, log] });
    child.unref();
    await waitForServer(child);
    writeFileSync(pidFile, String(child.pid));
    console.log(`demo: http://localhost:8080/ (pid ${child.pid})`);
  }
} else if (command === 'down') {
  const pid = readPid();
  if (pid !== null && isRunning(pid)) process.kill(pid);
  rmSync(pidFile, { force: true });
  console.log('stopped');
} else {
  console.error('usage: node test-env/env.mjs run | up | down');
  process.exit(1);
}
