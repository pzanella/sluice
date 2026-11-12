---
name: wt-wrapper-invariants
description: Required rules to change the WebTransport/Streams wrapper in src/inject. Use it before you touch the constructor patch, the byte-stream wrapper or the proxies.
---
# Wrapper invariants

1. **Patch**: `class WebTransport extends Native`. Override only the getters `datagrams`,
   `incomingUnidirectionalStreams`, `incomingBidirectionalStreams` and `createBidirectionalStream()`.
   The instance stays native → native methods work without bind.
2. **Lazy**: wrap on first access, cache the result in a private field. If disabled on first access,
   cache the native object (do not wrap later: lock risk).
3. **Byte stream**: `type: 'bytes'`. Skip chunks with `byteLength === 0`. Do not read `data` after `enqueue`
   (buffer is transferred). After `close()`: `controller.byobRequest?.respond(0)`.
4. **Pump** independent from `pull()`; `pull()` only releases the backpressure wait.
   `highWaterMark: 1`, so `pull()` also runs when the queue becomes empty with no read pending.
   Threshold: queued `> 0` or delayed bytes of the whole session `> maxDelayedBytes`. Read native only on an empty queue: a stream
   read then merges what arrived, and the native datagram limits keep working.
5. **Order**: streams always in order (promise chain + inflight counter). Datagrams can be reordered only
   with `preserveOrder: false`, by a delay or a hold.
6. **Stream end**: wait for pending deliveries and an empty queue before `close()` (with bytes queued, a BYOB
   read with `min` would error the stream). Native error → `controller.error()` at once.
7. **App cancel** → `reader.cancel(reason)` on the native reader + clear timers.
8. **Platform object Proxy**: `Reflect.get(t, p, t)`, methods bound and cached, `constructor` excluded,
   `set` with receiver = target.
9. **Hold**: always with a timeout in the page; action on timeout is configurable (forward | drop). With no panel, nothing
   holds. While a chunk of an ordered stream is held, the pump reads no more of it, so one hold cannot fill the budget of the
   session (ADR-16).
10. A regression test for each point in `src/inject/__tests__/`.
