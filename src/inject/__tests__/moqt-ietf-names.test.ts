// A rule by track name on an IETF session: the name comes from SUBSCRIBE and SUBSCRIBE_OK (ADR-45).
import { describe, expect, it } from 'vitest';
import type { MoqtObjectInfo } from '../moqt/objects';
import { install, type Runtime } from '../patch';
import { makeConfig, settle } from './helpers';
import { createMockWebTransport } from './mock-webtransport';

const hex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));

describe('IETF track names in a session', () => {
  it('draft 22: objects of the subscribed track carry its name, and a rule by name applies', async () => {
    const kit = createMockWebTransport();
    const scope: { WebTransport?: typeof WebTransport } = {};
    Object.defineProperty(scope, 'WebTransport', { value: kit.Native, writable: true, configurable: true });
    const seen: (MoqtObjectInfo | undefined)[] = [];
    install(scope, {
      config: makeConfig({ rules: [{ id: 'drop-video', on: ['uni'], match: { moqt: { track: 'video' } }, action: { type: 'drop' } }] }),
      random: () => 0.5,
      log: () => undefined,
      events: { chunk: (ctx) => seen.push(ctx.moqt) },
    }) as Runtime;
    const Sluice = scope.WebTransport as typeof WebTransport;
    const wt = new Sluice('https://relay.test/moq', { protocols: ['moqt-22'] } as WebTransportOptions);
    await wt.ready;
    await settle();
    const control = await wt.createBidirectionalStream();
    const controlReader = control.readable.getReader();
    const writer = control.writable.getWriter();
    // SUBSCRIBE, request 1, namespace "live", track "video" (test vector draft22/subscribe "minimal").
    await writer.write(hex('03000e0101046c69766505766964656f00'));
    const session = kit.sessions[0];
    if (!session) throw new Error('no session');
    // SUBSCRIBE_OK on the same stream: track alias 1, no parameters.
    session.createdBidis[0]?.source.push(hex('0400020100'));
    await controlReader.read();
    // A subgroup stream of alias 1 with one object (test vector draft22/subgroup "subgroup-single-object").
    session.openUni().push(hex('100100800004deadbeef')).close();
    const streams = wt.incomingUnidirectionalStreams.getReader();
    const uni = (await streams.read()).value as ReadableStream<Uint8Array>;
    const reader = uni.getReader();
    const got: number[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      got.push(...value);
    }
    expect(seen.find((info) => info?.trackAlias === 1)?.track).toBe('video');
    // The object was dropped: only the stream header may remain.
    expect(got.includes(0xde)).toBe(false);
  });
});
