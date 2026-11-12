import type { KindCounters } from '../../shared/protocol';
import type { TrafficKind } from '../../shared/rules';

export function createStatsForTest(): Record<TrafficKind, KindCounters> {
  const zero = (): KindCounters => ({ streams: 0, chunks: 0, bytes: 0, dropped: 0, modified: 0, delayed: 0 });
  return { datagram: zero(), uni: zero(), bidi: zero() };
}
