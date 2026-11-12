// A small box on the page during a replay: what plays, by track. The names come from the page, so they are only set as text, in a closed
// shadow root so the CSS of the page does not change it. It never takes clicks.

interface OverlayObject {
  track?: string;
  group: number;
  object: number;
  key?: boolean;
}

export interface Overlay {
  note(info: OverlayObject): void;
  progress(elapsedMs: number, totalMs: number, ended: boolean): void;
  /** A new session plays: forget the tracks of the one before. */
  reset(): void;
  remove(): void;
}

const MAX_TRACKS = 12;
const RENDER_MS = 250;

const time = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export function createOverlay(doc: Document, setTimer: (run: () => void, ms: number) => unknown): Overlay | null {
  const root = doc.documentElement as HTMLElement | null;
  if (!root) return null;
  const host = doc.createElement('div');
  // `all:initial` first: a rule of the page for div (a max width, a transform, a zoom) must not move or cut the box.
  host.style.cssText = 'all:initial;position:fixed;top:8px;right:8px;z-index:2147483647;pointer-events:none;display:block;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const box = doc.createElement('div');
  box.style.cssText =
    'font:12px/1.5 ui-monospace,Menlo,monospace;color:#fff;background:rgba(17,19,23,.88);padding:8px 10px;border-radius:8px;border-left:3px solid #8b8fff;box-shadow:0 2px 8px rgba(0,0,0,.35);white-space:pre-wrap;overflow-wrap:anywhere;box-sizing:border-box;max-width:min(480px,calc(100vw - 16px));';
  shadow.append(box);
  root.append(host);
  const tracks = new Map<string, OverlayObject>();
  let head = 'Sluice replay';
  let pending = false;
  const render = (): void => {
    pending = false;
    const lines = [head];
    for (const [name, info] of tracks) lines.push(`${name}  group ${info.group}  frame ${info.object}${info.key ? '  key' : ''}`);
    box.textContent = lines.join('\n');
  };
  const later = (): void => {
    if (pending) return;
    pending = true;
    setTimer(render, RENDER_MS);
  };
  render();
  return {
    note(info) {
      const name = (info.track ?? `alias ${String(info.group)}`).slice(0, 64);
      if (!tracks.has(name) && tracks.size >= MAX_TRACKS) return;
      tracks.set(name, info);
      later();
    },
    progress(elapsed, total, ended) {
      head = ended ? `Sluice replay ended at ${time(total)}. Holding the last frame.` : `Sluice replay  ${time(elapsed)} / ${time(total)}`;
      later();
    },
    reset() {
      tracks.clear();
      head = 'Sluice replay';
      later();
    },
    remove() {
      host.remove();
    },
  };
}
