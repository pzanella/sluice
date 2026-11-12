// Ready-made settings for the simulated network. Values are simple round numbers to test an app with, not measurements of a real network.
import type { RuntimeConfig } from './rules';

interface ImpairmentProfile {
  id: string;
  label: string;
  /** 0..1 of datagrams lost. Streams are reliable, so they lose nothing. */
  dropRate: number;
  delayMs: number;
  jitterMs: number;
  /** A cap in kbit/s, with a queue of 1 s for datagrams (ADR-48). */
  kbps?: number;
}

/** Datagrams that would wait longer than this in the queue of a cap are lost, as on a real link. */
export const DEFAULT_QUEUE_MS = 1000;

export const IMPAIRMENT_PROFILES: readonly ImpairmentProfile[] = [
  { id: 'none', label: 'None', dropRate: 0, delayMs: 0, jitterMs: 0 },
  { id: 'wifi', label: 'Good Wi-Fi (10 ms, 0.1% loss)', dropRate: 0.001, delayMs: 10, jitterMs: 5 },
  { id: 'mobile', label: 'Mobile (50 ms, 1% loss)', dropRate: 0.01, delayMs: 50, jitterMs: 20 },
  { id: 'slow', label: 'Slow mobile (150 ms, 3% loss)', dropRate: 0.03, delayMs: 150, jitterMs: 80 },
  { id: 'bad', label: 'Bad network (300 ms, 10% loss)', dropRate: 0.1, delayMs: 300, jitterMs: 150 },
  { id: 'cap-8m', label: '4G, 8 Mbit/s (40 ms)', dropRate: 0, delayMs: 40, jitterMs: 10, kbps: 8000 },
  { id: 'cap-3m', label: '3 Mbit/s (60 ms)', dropRate: 0, delayMs: 60, jitterMs: 15, kbps: 3000 },
  { id: 'cap-1m', label: 'Congested, 1 Mbit/s (80 ms, 1% loss)', dropRate: 0.01, delayMs: 80, jitterMs: 30, kbps: 1000 },
  { id: 'cap-400k', label: 'Slow 3G, 400 kbit/s (200 ms)', dropRate: 0.01, delayMs: 200, jitterMs: 50, kbps: 400 },
];

/** The profile that the config has, or null for other values. */
export function profileOf(config: Pick<RuntimeConfig, 'datagram' | 'stream' | 'bandwidth'>): string | null {
  const { datagram, stream } = config;
  const found = IMPAIRMENT_PROFILES.find(
    (p) =>
      p.dropRate === datagram.dropRate &&
      p.delayMs === datagram.delayMs &&
      p.jitterMs === datagram.jitterMs &&
      p.delayMs === stream.delayMs &&
      p.jitterMs === stream.jitterMs &&
      p.kbps === config.bandwidth?.kbps,
  );
  return found ? found.id : null;
}

export function withProfile(config: RuntimeConfig, id: string): RuntimeConfig {
  const profile = IMPAIRMENT_PROFILES.find((p) => p.id === id);
  if (!profile) return config;
  const { dropRate, delayMs, jitterMs, kbps } = profile;
  const next: RuntimeConfig = { ...config, datagram: { ...config.datagram, dropRate, delayMs, jitterMs }, stream: { delayMs, jitterMs } };
  if (kbps === undefined) delete next.bandwidth;
  else next.bandwidth = { kbps, queueMs: config.bandwidth?.queueMs ?? DEFAULT_QUEUE_MS };
  return next;
}
