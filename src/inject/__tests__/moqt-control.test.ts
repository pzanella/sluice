// Track names of IETF MoQT, from SUBSCRIBE and SUBSCRIBE_OK, checked with the MIT test vectors in the fixtures (see THIRD_PARTY_NOTICES.md) (ADR-45).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIetfTracker } from '../moqt/control';

interface Vector {
  id: string;
  hex: string;
  decoded: Record<string, unknown>;
  error?: unknown;
}
const vectors = (draft: number, message: string): Vector[] => {
  const file = join(__dirname, 'fixtures/ietf-control-vectors', `draft${String(draft).padStart(2, '0')}`, `${message}.json`);
  return (JSON.parse(readFileSync(file, 'utf8')) as { vectors: Vector[] }).vectors.filter((vector) => vector.error === undefined && typeof vector.hex === 'string');
};
const bytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));

const DRAFTS = Array.from({ length: 17 }, (_, i) => i + 7);

describe('IETF track names', () => {
  it.each(DRAFTS)('draft %i: the alias of a SUBSCRIBE gets its track name', (draft) => {
    const subscribe = vectors(draft, 'subscribe')[0];
    const ok = vectors(draft, 'subscribe-ok').find((vector) => draft >= 17 || draft <= 11 || vector.decoded.request_id === subscribe?.decoded.request_id) ?? vectors(draft, 'subscribe-ok')[0];
    if (!subscribe || !ok) throw new Error(`no vectors for draft ${draft}`);
    const tracker = createIetfTracker(draft);
    tracker.sent(4, bytes(subscribe.hex));
    if (draft >= 12) tracker.received(4, bytes(ok.hex));
    const alias = Number(draft <= 11 ? subscribe.decoded.track_alias : ok.decoded.track_alias);
    expect(tracker.nameOf(alias)).toBe(subscribe.decoded.track_name);
  });

  it.each(DRAFTS)('draft %i: a message that comes byte by byte gives the same name', (draft) => {
    const subscribe = vectors(draft, 'subscribe')[0];
    const ok = vectors(draft, 'subscribe-ok').find((vector) => draft >= 17 || draft <= 11 || vector.decoded.request_id === subscribe?.decoded.request_id) ?? vectors(draft, 'subscribe-ok')[0];
    if (!subscribe || !ok) throw new Error(`no vectors for draft ${draft}`);
    const tracker = createIetfTracker(draft);
    for (const byte of bytes(subscribe.hex)) tracker.sent(4, Uint8Array.of(byte));
    if (draft >= 12) for (const byte of bytes(ok.hex)) tracker.received(4, Uint8Array.of(byte));
    const alias = Number(draft <= 11 ? subscribe.decoded.track_alias : ok.decoded.track_alias);
    expect(tracker.nameOf(alias)).toBe(subscribe.decoded.track_name);
  });

  it('draft 22: an answer on another stream does not name the track', () => {
    const subscribe = vectors(22, 'subscribe')[0];
    const ok = vectors(22, 'subscribe-ok')[0];
    if (!subscribe || !ok) throw new Error('no vectors');
    const tracker = createIetfTracker(22);
    tracker.sent(4, bytes(subscribe.hex));
    tracker.received(8, bytes(ok.hex));
    expect(tracker.nameOf(Number(ok.decoded.track_alias))).toBeUndefined();
  });

});
