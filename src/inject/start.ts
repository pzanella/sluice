// Starts the runtime of a frame. Runs at document_start, before page scripts.
// Must not use chrome.* and must not import runtime dependencies.
import { browserEnv, createChannel, type Channel } from './channel';
import { install } from './patch';
import { installPlayback } from './playback';

const NONCE_ATTRIBUTE = 'data-sluice-bridge';

export function start(withChannel?: (channel: Channel) => void): void {
  const root = document.documentElement;
  // `root` can be null in documents that are not HTML. With no bridge the patch still works, with no panel.
  const nonce = root?.getAttribute(NONCE_ATTRIBUTE) ?? null;
  root?.removeAttribute(NONCE_ATTRIBUTE);

  if (nonce) {
    const channel = createChannel(nonce, browserEnv());
    const runtime = install(globalThis as Parameters<typeof install>[0], { events: channel.events, gate: channel.gate });
    if (runtime) channel.attach(runtime);
    installPlayback(globalThis as Parameters<typeof installPlayback>[0], { now: () => Date.now(), setInterval: (run, ms) => setInterval(run, ms), report: (report) => channel.playback(report) });
    withChannel?.(channel);
  } else {
    install();
  }
}
