# Decisions

Short records of the choices that shape Sluice. Each one says what was decided and why. The numbers stay the same, as code
comments point to them (`ADR-N`). For the big picture, read [architecture.md](architecture.md) first.

## Foundations

**ADR-1 — Patch `WebTransport` in the page.** The runtime replaces `WebTransport` with a subclass in the MAIN world, before page
scripts run. `webRequest`, `declarativeNetRequest` and the DevTools protocol see only the handshake, not the data.

**ADR-2 — English only, plain words.** Code, comments, docs, UI and commits are in English with plain words: short sentences, common
words.

**ADR-3 — A workbench, not only an inspector.** Sluice shows traffic and also changes it (drop, delay, change, hold, inject,
replay), as testing an app needs both.

**ADR-4 — Toolchain.** TypeScript strict, ESM, Vite for the build, Vitest and Playwright for tests, pnpm. No runtime dependency in
the page.

**ADR-5 — Rules of the page runtime.** Lazy wrap (a native stream is locked only on first use by the app), byte streams so default
and BYOB readers both work, Proxies with the native object as receiver, order kept on streams, always a timeout on a hold.

**ADR-6 — Local test server in Python (aioquic).** It runs on loopback with a new self-signed certificate at each start, used
through `serverCertificateHashes`: no CA and no browser flags.

**ADR-7 — Read the native stream only when the app's queue is empty.** Backpressure stays the native one, and a slow app gets
larger chunks instead of many tiny ones.

**ADR-8 — Only on sites the user turns on.** Host access is optional and per site. The toolbar popup turns a site on or off;
nothing runs elsewhere.

**ADR-9 — Hand-written validators, base64 on the wire.** Every message between the page, the bridge, the service worker and the
panel is checked by a small validator. Rules are data, never code: no `eval`, no `new Function`.

**ADR-10 — A lazy bridge.** A page opens its link to the extension only when it has a session, and sends traffic only while a
panel is open.

**ADR-11 — Rules per site.** Rules are saved for each origin. The first read waits up to 500 ms for them. A slow regex turns itself
off after one test over 50 ms.

**ADR-12 — Delayed bytes are limited per session.** All delays of a session share one budget, so a server cannot fill the memory
of the page.

**ADR-13 — The popup asks the page what it runs.** The popup and the badge show the real state of the page: on, off, or waiting for
a reload.

**ADR-14 — Workers behind a switch.** With the switch on, a dedicated worker starts from a `blob:` script that patches it first. A
worker that the page security policy blocks stays native, and the panel says so.

**ADR-15 — The panel hears when a grant or saved rules change.**

## Testing features

**ADR-16 — Hold and edit.** A rule action stops a message until the user forwards, edits or drops it, with the timer in the page so
a closed panel can never stall the app.

**ADR-17 — Inject.** The panel sends the app a datagram or a new uni stream, only on a session where the app already reads that
kind of message. The server never sees it.

**ADR-18 — Small, focused agent work.** An AI agent that works on this repo does reviews and tests inline, reads only what a
task needs and keeps reports short. It starts a subagent only when the person who runs it asks. This keeps changes easy to
review and the cost low.

**ADR-19 — Record and replay in the page.** A recording keeps what the network delivered, before rules. A replay plays it to the
app with no server, with the normal wrappers on top, so rules and the panel work as live.

**ADR-20, ADR-24 — `.moqtrace` import waited for MoQT framing.** Superseded by ADR-46.

**ADR-21 — MoQT version.** From the WebTransport protocol (drafts 15 and later, moq-lite), or from SERVER_SETUP (drafts 7 to 14).

**ADR-22 — Superseded by ADR-28.**

**ADR-23 — Rules on whole MoQT objects.** A framer cuts streams into objects and builds the bytes again at delivery, so a dropped
or changed object keeps the framing right.

**ADR-25 — A seed for each message.** With a seed, the same message gets the same random decision in each run, whatever the other
streams do.

**ADR-26 — Merge chunks that came due while the app was slow.**

**ADR-27 — Objects of drafts 7 to 23.** Each draft has its layout table, checked with MIT test vectors (see
`THIRD_PARTY_NOTICES.md`).

## MoQ and media

**ADR-28 — Goal: a complete test and monitor tool for WebTransport and MoQ.** IETF MoQT drafts and moq-lite are both supported.

**ADR-29 — What the app sends.** Outgoing data goes through a real `WritableStream`, so rules and the list see it too. The
simulated network acts only on what the app receives.

**ADR-30 — moq-lite 3 to 6.** Groups and frames with track names, from the SUBSCRIBE and TRACK streams of the app. Other versions
stay in chunks.

**ADR-31 — Tracks view.** The catalog gives codec and size; key frames come from the frames themselves (H.264, H.265, CMAF).

**ADR-32 — No empty string as a child in the panel.** Preact writes it on each render, and Chromium then closes an open select.

**ADR-33 — A replay matches on origin and path, not the query.** A token in the query changes at each start, and the file must not
keep it. The replay keeps the protocol of the session.

**ADR-34 — A recording keeps the start of each open session.** An app needs its setup to play, so a recording can start at any
time.

**ADR-35, ADR-36 — How a replay ends.** Media starts at the first whole group. At the end the app holds its last frame (default),
plays again, or goes live; **Stop playing** ends it. One box on the page shows track, group and frame.

**ADR-37 — A recording counts what it holds.** Time, size, and groups, frames and key frames for each track.

**ADR-38 — Layout.** A top bar with the name and the session picker; views for Monitor, Tracks, Messages, Rules and Record.
Recording and replay controls are at the top of Record (its tab shows a dot while it records, and the state of a replay), so
the top bar never changes.

**ADR-39 — The start of a session plays fast in a replay.** Gaps between its events are at most 20 ms.

**ADR-40 — Look, templates and screenshots.** Design tokens for light and dark, rule templates for common tests, recipes with
scenario files, and screenshots made from the real panel in the dark theme (`pnpm docs:shots`), also those of the store.

**ADR-41 — Actions on the connection.** Stall, close or reset, as rule actions; stall and close also once by hand, with **Run once now**
on the quick tests Rebuffer and Reconnect in Rules (once a menu of the top bar: it was test setup, not state, and the bar moved;
a reset by hand was taken out, as MoQ streams live less than a second). A stall is a delay of all that
the app receives until its end; a close uses the native `close()`; a reset errors the stream with a stream error code.

**ADR-42 — Monitor.** 120 s of counts per track, and problems found: gaps, pauses, late key frames. It counts what reaches the
panel.

**ADR-43 — A replay answers each request by its content.** A recording keeps the first bytes the app wrote on each stream it
opened; a replay gives each new stream the answer to the same request, and maps moq-lite subscribe IDs.

**ADR-44 — Checks with pass or fail.** Per track: `gaps`, `pauses`, `key-frames`, `receiving`. Tests read them through
`window.sluice.report()` on the panel page, which a site cannot reach.

**ADR-45 — Track names for IETF MoQT.** From SUBSCRIBE and SUBSCRIBE_OK, with the layout of each draft. Checked with test vectors
and with a real server on draft 22.

**ADR-46 — Open a `.moqtrace` file for analysis.** A small CBOR reader turns the file into a closed session. No replay: the format
keeps decoded fields, not stream bytes.

**ADR-47 — Timeline.** Network, stall and close steps in time from the open of each session.

**ADR-48 — Bandwidth cap.** Each session is a link of a set rate with a queue; late datagrams are lost, and the session reads the
network more slowly so the server slows down too.

**ADR-49 — What the player shows.** Frames and errors of WebCodecs decoders and of `<video>`, counted in the page and sent once a
second while a panel is open. No frame data leaves the page.

**ADR-50 — Lag and A/V offset.** From the timestamps in the frames: how late a track is compared with its best moment, and how far
video and audio are apart in the stream.

**ADR-51 — HTML report.** One file with no script, no outside resource, no payloads and no URL query.

**ADR-52 — Protocol names.** `moql` is shown as moq-lite with its version in the setup (chunks only); moq-lite 7 stays in chunks
until it is final.

## Project

**ADR-53 — SemVer.** Tags are `vMAJOR.MINOR.PATCH`; before a public release each phase bumps the minor. `package.json` and the
manifest carry the same version.

**ADR-54 — Neutral and clean.** Docs, UI and comments name no other product or company: Sluice is described by what it
does. The only names are the web platform (Chrome, WebTransport, WebCodecs), the tools that build and test it, the AI agent
that the files `CLAUDE.md` and `.claude/` are for, and the authors of third-party test data, whose licence stays with the
data in `THIRD_PARTY_NOTICES.md`. No tokens, keys, personal data or real service URLs: tests use `example.test` and
localhost.

**ADR-55 — Simple and Advanced Rules.** The Rules view opens in a simple mode: network profiles as cards with a line that says
what they do to the sessions of the tab, one-click tests with a switch, a track picker and a slider, and the rules of the user
with a switch each. Every change saves at once. Advanced is the full editor. Quick tests are normal rules with ids `quick-*`,
so both modes show the same rules. Held messages show in Simple only when one waits.

**ADR-56 — A replay answers a request made again.** A player subscribes again to the same track (after a pause or a seek), or
asks for another quality of the same kind. The replay gives the recorded answer again: the same groups that went out so far,
then the new ones. The groups of that track go to the newest subscription, as a player drops the old one. A track that is not in the recording gets the recorded track of the same
kind (the part after the last dot of the name) in the same broadcast. Without this, the video stopped after a new subscription.

**ADR-57 — Export a recording as `.moqtrace`.** A recording is written as a version-2 `.moqtrace` file, so other MoQ tools can
read what Sluice records. The bytes go through the parsers of the page (control messages, subgroup streams, datagrams, moq-lite
groups), so the file has what the page saw, with whole payloads (`detail: full`, `perspective: client`). moq-lite has no
SUBSCRIBE of type 3: its subscribe stream is written as a control message of type 2 with the same fields, and the reader of
Sluice takes names from it. Only host and port of the URL go in the file. A recording now keeps the start time of the session
and, when the server chose no protocol, the MoQ protocol that the page offered, so the version is known for the export and for
a replay.

**ADR-58 — Lists stay in the panel.** A native select opens its list as a window of the system, which can go out of the DevTools
panel. Every select of the panel is `select.tsx`: a button with the combobox role and a list in the page, placed in the panel
(above the button when there is more room there) with the keyboard of a select.

**ADR-59 — A replay gives a track only when the app asks for it.** In a moq-lite replay, a group of a recorded subscription that
the app has not made yet waits for it (up to 5 s and 16 MiB), then goes to the app with the new subscribe ID. The start of a
recording plays in a few ms, so the first groups can come before the player asks: a video group lost then is a lost key frame.
A group whose track the app never asks for never goes to it: its recorded subscribe ID can be the ID of another track now (a
player that starts on another quality), and the decoder would get two tracks on one subscription: audio plays, video does not.
When the app asks for a track that has no groups in the recording (a player made again asks for one quality, and the recording
has another), the recorded track of the same kind (`1.avc3` for `0.avc3`) plays in its place. The summary of a recording keeps
the subscribe ID of each track (`alias`), so this works also when the request of that track is not in the recording. When the
recording changes quality (2.avc3, then 1.avc3) and the app asked for one of them only, the groups of the other go to the newest
subscription of the app of the same kind, as from a server that changes quality.

**ADR-60 — A store zip with no other tool.** `pnpm package` writes `sluice-<version>.zip` from `dist/` with the zlib of Node:
files in a stable order with a fixed time, so the same build gives the same zip, and no source maps. The code is not minified,
so a store review can read it. A version tag builds the zip in CI and attaches it to a GitHub release; the upload to the store
stays a step of the maintainer.
