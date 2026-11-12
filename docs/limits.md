# Limits

What Sluice cannot do, or does with limits. The README lists the main ones.

- **Impairment is only seen by the app.** QUIC, congestion control and the server do not change.
  Proxy tools can shape the real network.
- **On streams, a chunk is not a frame**, unless the session uses a draft from 7 to 23 or moq-lite 3 to 6, and a panel is open or a rule has MoQ
  fields. A recording also turns it on. This applies from the next stream, and adds up to one frame of delay. Objects wait until they are complete, up to 16 MiB. With IETF drafts, a track has its name once
  its SUBSCRIBE went by (and SUBSCRIBE_OK from draft 12); a track that the server publishes on its own (PUBLISH) has only its alias. Names were checked with a real server on draft 22 only. With moq-lite, rules can use the track name. Fetch streams stay in chunks. If the last object of a stream with the END_OF_GROUP bit is dropped, the app
  takes the object before it as the end of the group (ADR-23). Object datagrams were tested only with vectors and unit tests. Only draft 22 streams were tested with a real server.
- **Workers with a CSP `worker-src` without `blob:` cannot be instrumented.** They stay native (ADR-14), and the panel
  lists them. Workers are off by default: turn on "Also inspect workers on this site" in the popup, for each site, then
  reload. A worker then starts from a `blob:` URL under the CSP of the page, Sluice corrects its relative URLs, and each
  worker makes one more `HEAD` request, so it can behave differently or stop. A `connect-src` of the page can block its
  session. The server also sees 404s for `/__sluice_probe__`. A worker also stays native if it starts from a `blob:` or
  `data:` URL, past 32 workers in a frame, or before Sluice has a result for the CSP: on a first load that is common,
  and a reload fixes it. `SharedWorker`, service workers and nested workers are not instrumented, and the panel does not
  list them. See the [workers guide](guide/workers.md).
- **The simulated network acts only on what the app receives.** Rules can also act on what the app sends (ADR-29): then the
  server gets what the rule lets pass.
- **Sluice also replaces `VideoDecoder` and `AudioDecoder`** in the page and its workers, to count the frames they give back
  (ADR-49). The decoders stay native objects, but a page can see the change as it can see the one of `WebTransport`.
- **A page can detect the extension** and can reach the native constructor. For example,
  `Function.prototype.toString` on `WebTransport` shows source text, and `WebTransport.prototype` has
  different own members. No app behavior was seen to depend on this.
- **Delay limits the throughput of a session**, all its streams and datagrams together, to about
  `(maxDelayedBytes + one chunk for each stream) / delay`. With the default
  8 MiB and a 10 s delay, that is about 6.7 Mbit/s. While a delay is active, a slow reader gets small
  chunks (ADR-5, ADR-7).
- **Jitter is less exact when order is kept**, and order is kept by default. A chunk cannot pass the one before it, so at a
  high rate the delay moves up toward delay + jitter and varies less. 100 ms ± 50 ms on datagrams gave a mean of 107 ms at
  20 per second, and 138 ms at 700 per second. Delay with no jitter was exact.
- **A page that is open keeps deleted rules until it reloads.** The popup says so (ADR-15).
- **A replay is not the real connection** (ADR-19). What the app writes goes nowhere, and the app gets the same messages whatever it
  sends. A recording started in the middle of a session keeps the start of the session, but no media of it: media starts at the
  first whole group after Start recording, so up to one group is missing (ADR-34, ADR-35). The start of the session plays fast
  (ADR-39). Only what the app read during the recording is in it, up to 32 MiB. A session that starts before you click Play, also at page
  load, is live. Sessions in workers are recorded, but they do not play. A recording holds full payloads: treat its file as private.
- **Inject reaches only the app** (ADR-17). The server never sees the message, and rules do not change it. It works only on a
  session where the app already reads that kind of message. A new bidi stream or data in an existing stream cannot be sent. A
  datagram can be larger than the real limit of the connection, and it is not lost as a real one can be. "Queued" does not
  mean that the app read it.
- **A hold works only while the panel is open, and it has limits** (ADR-16). With no panel the message passes. A held message
  stops later data of its stream, or later datagrams of its session, and the browser can then drop those datagrams. At most 64
  messages wait in one page or worker: more pass with no hold. A message over 64 KiB can be forwarded or dropped, not edited.
  A hidden tab can make the timeout late.
- **Sluice runs only on sites you turn on** (ADR-8), on all ports of that host, and in their frames with no origin of
  their own (`about:blank`, `srcdoc`, `blob:`). A cross-origin frame in such a page is not patched, unless you
  also turn on its own site. A change applies after a page reload. The popup and the toolbar badge (`ON`, or `!` when the
  site is off but the page still runs Sluice) show what the top page runs. A page can make the state look on, and a hung page
  gives no answer. A frame of a site you turned on runs Sluice inside a page of another site, and the badge and the popup do
  not show it. After an update of Sluice, an open page keeps the old script and its rules, and both can wrongly say that it
  does not run: reload the page to be sure.
- **The install warning stays.** Chrome shows "Read and change all your data on all websites" for any extension with
  a DevTools panel. Per-site grants do not remove it.
- **Tested only on Chromium 156.** The checks for `WebTransportReceiveStream` and
  `WebTransportSendStream` have never run, because that browser does not expose these globals (ADR-6).
  A sandboxed `srcdoc` frame is patched, and a `data:` frame has no `WebTransport`. The manifest says Chrome 119, because `matchOriginAsFallback`
  needs it, but no version below 156 was tested. The Chrome permission dialog was not tested either: e2e uses a build
  with the demo origin already granted.
- **A slow regex can hang the page.** A rule's regex runs on the main thread of the page, on the first 4 KiB of each
  payload, and JavaScript cannot stop it while it runs. The form rejects the common bad shape, such as `(a+)+`, but not
  all of them, such as `(a|aa)+`. After one test over 50 ms that regex is off for that page. If a page hangs, click the
  Sluice button, delete the rules of the site or turn Sluice off, then reload, or close the tab. With a payload over 4 KiB,
  a regex with `$` does not match.
- **Rules can be late.** The first read waits up to 500 ms for saved rules. Past that, chunks pass with no rules until
  the rules arrive. Rules reach only frames of the site in the tab, not frames of other sites.
- **Rules are saved in plain text** in `chrome.storage.local`, in your browser profile, for each origin.
- **The panel list is a sample under load.** At most 500 messages/s per frame or worker reach it, and it keeps the newest 5000. The
  status shows how many are not shown. Counters come from the page, so a hostile page can report false numbers. The
  panel shows at most the first 4 KiB of a chunk.
- **A chunk in the panel is not a message of the app** on a stream, unless the row shows a MoQT group and object.
- **Other browsers are not supported.** Firefox and Safari are not tested.
