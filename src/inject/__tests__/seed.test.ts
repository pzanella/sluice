import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Rule, type RuntimeConfig } from '../../shared/rules';
import { IMPAIRMENT_PROFILES, profileOf, withProfile } from '../../shared/profiles';
import { validateConfig } from '../../shared/validate';
import { createPipeline, createStats, type ChunkContext } from '../pipeline';
import { createRandom } from '../prng';

const message = (seq: number, extra: Partial<ChunkContext> = {}): ChunkContext => ({
  kind: 'datagram', origin: 'remote', sessionId: 1, url: 'https://x/', streamId: null, seq, data: Uint8Array.of(1), ...extra,
});
const lost = (config: RuntimeConfig, seqs: number[], random = (): number => 0.5): number[] => {
  const pipeline = createPipeline({ getConfig: () => config, stats: createStats(), random, log: () => undefined });
  return seqs.filter((seq) => pipeline.run(message(seq)).data === null);
};
const lossy = (seed?: number): RuntimeConfig => ({
  ...DEFAULT_CONFIG,
  datagram: { ...DEFAULT_CONFIG.datagram, dropRate: 0.3 },
  ...(seed === undefined ? {} : { seed }),
});
const seqs = Array.from({ length: 1000 }, (_, i) => i);

describe('seed', () => {
  it('gives the same decisions in two runs', () => {
    expect(lost(lossy(7), seqs)).toEqual(lost(lossy(7), seqs));
  });

  it('gives other decisions with another seed', () => {
    expect(lost(lossy(7), seqs)).not.toEqual(lost(lossy(8), seqs));
  });

  it('keeps the rate', () => {
    const count = lost(lossy(7), seqs).length;
    expect(count).toBeGreaterThan(240);
    expect(count).toBeLessThan(360);
  });

  it('does not depend on the order of arrival', () => {
    const shuffled = [...seqs].reverse();
    expect(lost(lossy(7), shuffled).sort((a, b) => a - b)).toEqual(lost(lossy(7), seqs));
  });

  it('uses the injected random with no seed', () => {
    expect(lost(lossy(), [1, 2], () => 0.1)).toEqual([1, 2]);
    expect(lost(lossy(), [1, 2], () => 0.9)).toEqual([]);
  });

  it('repeats a rule probability and a jitter', () => {
    const rule: Rule = { id: 'r', probability: 0.5, action: { type: 'delay', delayMs: 10, jitterMs: 5 } };
    const config: RuntimeConfig = { ...DEFAULT_CONFIG, rules: [rule], seed: 3 };
    const run = (): number[] => {
      const pipeline = createPipeline({ getConfig: () => config, stats: createStats(), random: () => 0.5, log: () => undefined });
      return seqs.map((seq) => pipeline.run(message(seq)).delayMs);
    };
    expect(run()).toEqual(run());
    expect(new Set(run()).size).toBeGreaterThan(50);
  });

  it('keys a MoQT object by its IDs, not by its index', () => {
    const moqt = { trackAlias: 1, group: 2, subgroup: 0, object: 3 };
    const config = lossy(7);
    const decide = (seq: number, object: number): boolean => {
      const pipeline = createPipeline({ getConfig: () => config, stats: createStats(), random: () => 0.5, log: () => undefined });
      return pipeline.run(message(seq, { moqt: { ...moqt, object } })).data === null;
    };
    for (let object = 0; object < 50; object++) expect(decide(0, object)).toBe(decide(99, object));
  });

  it('gives numbers in 0..1', () => {
    const next = createRandom(1, 'k');
    for (let i = 0; i < 1000; i++) {
      const value = next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it.each([[-1], [1.5], [2 ** 32], ['1']])('refuses the seed %j', (seed) => {
    expect(validateConfig({ ...DEFAULT_CONFIG, seed }).ok).toBe(false);
  });

  it('takes a valid seed, and no seed', () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, seed: 0 }).ok).toBe(true);
    expect(validateConfig({ ...DEFAULT_CONFIG, seed: 0xffffffff }).ok).toBe(true);
    const result = validateConfig(DEFAULT_CONFIG);
    expect(result.ok && 'seed' in result.value).toBe(false);
  });
});

describe('impairment profiles', () => {
  it.each(IMPAIRMENT_PROFILES.map((p) => [p.id]))('%s is a valid config, and is found again', (id) => {
    const config = withProfile(DEFAULT_CONFIG, id);
    expect(validateConfig(config).ok).toBe(true);
    expect(profileOf(config)).toBe(id);
  });

  it('leaves other settings as they are', () => {
    const config = withProfile({ ...DEFAULT_CONFIG, datagram: { ...DEFAULT_CONFIG.datagram, preserveOrder: false } }, 'bad');
    expect(config.datagram.preserveOrder).toBe(false);
    expect(config.rules).toEqual([]);
  });

  it('calls other values custom, and leaves a config alone for an unknown ID', () => {
    expect(profileOf({ ...DEFAULT_CONFIG, stream: { delayMs: 1, jitterMs: 0 } })).toBeNull();
    expect(withProfile(DEFAULT_CONFIG, 'x')).toBe(DEFAULT_CONFIG);
  });
});
