// Holds chunks until the user decides in the panel. Every hold has a timer here in the page, so no panel, a closed panel
// or a lost message can stall the app for good. See the skill `wt-wrapper-invariants`, point 9.
import type { HoldOutcome } from '../shared/protocol';
import type { HoldTimeoutAction } from '../shared/rules';
import type { ChunkContext } from './pipeline';

/** A page can hold this many chunks at once. More would pass with no hold, as memory must stay bounded. */
export const MAX_HELD = 64;

export interface HoldOffer {
  ruleId: string;
  timeoutMs: number;
  onTimeout: HoldTimeoutAction;
}

export interface HeldChunk extends HoldOffer {
  holdId: number;
  ctx: ChunkContext;
  data: Uint8Array<ArrayBuffer>;
}

/** `gone`: the stream ended first, so nothing is delivered and nothing counts as dropped. */
export type HoldDecision = { action: 'forward' | 'drop' | 'gone' } | { action: 'edit'; data: Uint8Array<ArrayBuffer> };

interface HoldQueueDeps {
  announce(chunk: HeldChunk): void;
  ended(holdId: number, outcome: HoldOutcome): void;
  setTimeout(run: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
  now(): number;
}

interface HoldQueue {
  /** Only with a panel to answer. With none, a hold rule must not slow the app. */
  accepting(): boolean;
  hold(ctx: ChunkContext, data: Uint8Array<ArrayBuffer>, offer: HoldOffer): { decision: Promise<HoldDecision>; cancel: () => void };
  resolve(holdId: number, decision: { action: 'forward' } | { action: 'drop' } | { action: 'edit'; data: Uint8Array<ArrayBuffer> }): void;
  /** With no panel left, each held chunk gets the action of its timeout at once. */
  setActive(active: boolean): void;
  /** For a panel that connected again. It gets the time that is left. */
  announceAll(): void;
}

interface Entry {
  chunk: HeldChunk;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  settle: (decision: HoldDecision, outcome: HoldOutcome) => void;
}

export function createHoldQueue(deps: HoldQueueDeps): HoldQueue {
  const entries = new Map<number, Entry>();
  let active = false;
  let nextId = 0;

  const expire = (entry: Entry): void => {
    if (entry.chunk.onTimeout === 'drop') entry.settle({ action: 'drop' }, 'timeout-dropped');
    else entry.settle({ action: 'forward' }, 'timeout-forwarded');
  };

  return {
    accepting: () => active && entries.size < MAX_HELD,
    hold(ctx, data, offer) {
      const holdId = ++nextId;
      let settle!: Entry['settle'];
      const decision = new Promise<HoldDecision>((resolve) => {
        settle = (result, outcome) => {
          if (!entries.delete(holdId)) return;
          deps.clearTimeout(entry.timer);
          resolve(result);
          deps.ended(holdId, outcome);
        };
      });
      const chunk: HeldChunk = { ...offer, holdId, ctx, data };
      const entry: Entry = {
        chunk,
        deadline: deps.now() + offer.timeoutMs,
        timer: deps.setTimeout(() => expire(entry), offer.timeoutMs),
        settle,
      };
      entries.set(holdId, entry);
      deps.announce(chunk);
      return { decision, cancel: () => entry.settle({ action: 'gone' }, 'gone') };
    },
    resolve(holdId, decision) {
      const entry = entries.get(holdId);
      if (!entry) return;
      if (decision.action === 'forward') entry.settle(decision, 'forwarded');
      else if (decision.action === 'drop') entry.settle(decision, 'dropped');
      // A byte stream cannot deliver an empty chunk.
      else if (decision.data.byteLength === 0) entry.settle({ action: 'drop' }, 'dropped');
      else entry.settle(decision, 'edited');
    },
    setActive(next) {
      active = next;
      if (!next) for (const entry of [...entries.values()]) expire(entry);
    },
    announceAll() {
      const now = deps.now();
      for (const { chunk, deadline } of entries.values()) deps.announce({ ...chunk, timeoutMs: Math.max(0, deadline - now) });
    },
  };
}
