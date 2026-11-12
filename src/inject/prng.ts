// Seeded random numbers for repeatable runs (ADR-25). Pure code: no page global, no dependency.

/** 32-bit FNV-1a of the text, started from the seed. */
function hash(seed: number, text: string): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** mulberry32. Gives numbers in 0..1, like Math.random. Good enough for test decisions, not for security. */
export function createRandom(seed: number, key: string): () => number {
  let state = hash(seed, key);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
