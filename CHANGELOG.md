# Changelog

All notable changes to this project are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/)
(ADR-53). Nothing is published in a store yet: install from source.

## [Unreleased]

## [0.9.1] - 2026-11-12

### Changed
- **Save and apply** closes the open rule, so the list shows one line per rule. **Edit** opens it again.

## [0.9.0] - 2026-11-12

### Changed
- The toolbar popup is simpler: one main button with the next step (**Turn on**, **Turn off** or **Reload page**), one
  short line of state, and **More options** (workers, delete rules) closed until you need it. It opens by itself on a page
  that does not answer.

## [0.8.0] - 2026-11-12

### Added
- `pnpm package` packs `dist/` into `sluice-<version>.zip` for the Chrome Web Store, with no other tool (ADR-60). CI builds it
  on each run, and a version tag attaches it to a GitHub release.
- Store listing, permission reasons, store screenshots (1280×800), store icon and promo tile in `docs/store/`.
- Issue and pull request templates, and monthly dependency updates.

### Changed
- All screenshots of the docs are in the dark theme. A rule with an error has its screenshot made again with the others.
- The manifest names MoQ in its name and summary, and links to the repository.
- The demo, the docs and the comments no longer name an outside media library: the demo broadcast is `demo`.
- `CONTRIBUTING.md` says where things are and how a release works. The roadmap lists only what comes next.
- **Actions** left the top bar: **Run once now** on the quick tests **Rebuffer** and **Reconnect** (Rules > Simple) stalls or
  closes the newest open session once. The reset of one stream by hand is gone: the rule action **Reset the stream** does it on
  each stream that matches (ADR-41).

### Fixed
- A moq-lite replay follows a change of quality in the recording (2.avc3, then 1.avc3): the player gets the next quality on the
  subscription it has, so video goes on (ADR-59).
- The panel fits its window at any width and never scrolls sideways: the counters are cut when narrow, and long rows of Messages end with an ellipsis (Detail shows all).
- The filter, **Clear** and **Inject** are in a bar of the Messages view, so the toolbar never changes between views.
- **Start recording**, the replay state and **Stop playing** moved from the top bar to the top of the Record view. The top bar
  keeps the name and the **Session** picker; the Record tab shows a dot while it records, and **ready** or **playing** for a replay.
- Two quick clicks on quick tests no longer turn one back off for a moment.
- A moq-lite replay plays video when the player, made again, asks for another quality than the one recorded (for example
  `0.avc3` when the recording has `1.avc3`): it gets the recorded track of the same kind. A recording keeps the subscribe ID of
  each track for this (ADR-59).
- A moq-lite replay keeps the groups that come before the player asks for their track, and gives them when it asks: the first
  key frame of the video is no longer lost (ADR-59).
- The top bar no longer moves when the recording or the replay state changes: the state has its own place, and buttons keep
  their size.
- The box on the page during a replay is never cut: long lines wrap, and the CSS of the page cannot change it.
- A content script sync that fails while `dist/` is built again tries again quietly; it says "failed" only when all tries fail.
- A replay of a moq-lite player that starts on another quality plays video again: groups of a recorded track that the app did
  not ask for no longer reach it (ADR-59).
- Lists of selects open inside the panel, also near its edges (ADR-58).
- **Export .moqtrace** keeps the track of a stream whose first frame came in several chunks (a big key frame): video was
  missing from such files.
- **Delete** on a recording that waits or plays stops its replay. The top bar says **Replay ended: the app shows the last
  frame**, with a tip on what Stop playing does.

## [0.7.0] - 2026-11-11

### Added
- **Export .moqtrace** on each MoQ recording: a version-2 `.moqtrace` file with control messages, streams, objects with their
  payload, and the close, for other MoQ tools (ADR-57). **Open a .moqtrace** reads the track names of moq-lite in it, and the
  close code.
- **Delete** on each recording, and a clearer bar while the panel gets a recording from the page.
- Simple Rules: an **Active** line with **Turn all off**, quick tests in groups that show their controls when on, line icons.
- Tracks and Monitor say when the player left a track (another quality): **not received now** / **Not received**, with no failed
  check.
- **Simple Rules**: network profiles as cards, quick tests with a switch, a track picker and a slider, and a switch on each rule.
  The full editor is **Advanced** (ADR-55).

### Fixed
- A recording keeps the MoQ protocol that the page offered when the server chose none, so a replay of such a session matches
  moq-lite requests by track again.
- A replay no longer stops the video when the player subscribes again or asks for another quality: it gets the recorded track
  again (ADR-56).
- A recording no longer holds a session that plays a recording. The sessions of one recording show in one card.
- The catalog is a card of its own in Tracks, with its JSON, and is never "not received" or "Stalled".
- All selects, inputs and file buttons share one look in the panel and the popup, with the arrow of a select away from its border.
- A build no longer leaves `dist/` empty for some seconds: an unpacked Sluice could fail to register its scripts ("content
  script sync failed") and stop working on the sites. The service worker also tries the registration again.
- Templates use the real track names of the player, and a rule says when its track is not one that the player gets.

### Changed
- Docs: a one-page architecture, a short decision log, `CONTRIBUTING.md`, `SECURITY.md`, a privacy page, and test data
  licences in `THIRD_PARTY_NOTICES.md`. Internal notes are out of the tree (ADR-54).

## [0.6.0] - 2026-11-09

Player testing.

### Added
- **Timeline**: network, stall and close steps in time for each session, with an example (ADR-47).
- **Bandwidth cap** with a queue, in profiles and timeline steps, to test ABR (ADR-48).
- **Playback** in the Monitor: frames of WebCodecs decoders and `<video>`, decoder errors, freezes (ADR-49).
- **Lag** per track and **A/V** offset in the Monitor (ADR-50).
- **Save HTML report**: one file with charts, checks and events (ADR-51).

### Changed
- `moql` sessions are named, the UI says "key frame" everywhere, and a template that did nothing on live streams is replaced
  (ADR-52).

## [0.5.0] - 2026-11-08

A complete test and monitor tool for WebTransport and MoQ.

### Added
- moq-lite 3 to 6: groups and frames with track names, and rules on frames (ADR-30). Tracks view with catalog and key frames
  (ADR-31).
- **Monitor**: health of each track, bitrate chart, gaps, pauses, late and dropped key frames, events, a JSON report (ADR-42).
- **Checks** with pass or fail, readable in Playwright through `openSluicePanel` (ADR-44).
- **Actions**: stall, close or reset a session, by hand or as rule actions (ADR-41).
- What the app sends: in the list, with rules and hold (ADR-29).
- Record and replay that work on a real player: the start of the session, whole streams, hold at the end, Stop playing, a box on
  the page, answers matched to each request (ADR-33 to ADR-39, ADR-43). A recording shows what it holds (ADR-37).
- Track names for IETF MoQT drafts 7 to 23 (ADR-45). **Open a .moqtrace** file for analysis (ADR-46).
- Seed, network profiles, datagram order, scenario files and a Playwright example (ADR-25).
- A new look, rule templates, recipes and screenshots made from the panel (ADR-40). A top bar with a session picker (ADR-38).

## [0.4.0] - 2026-11-06

### Added
- MoQT draft detection, and rules on whole objects for drafts 7 to 23 (ADR-21, ADR-23, ADR-27).

## [0.3.0] - 2026-11-06

### Added
- **Hold**: a rule can stop a message until you forward, edit or drop it, with a timeout in the page (ADR-16).
- **Inject**: send the app a datagram or a new uni stream (ADR-17).
- **Record and replay** with no server (ADR-19).

## [0.2.0] - 2026-11-05

### Added
- Per-site opt-in with a toolbar popup and badge (ADR-8, ADR-13).
- DevTools panel: sessions, streams, messages with hex, text and JSON views, filter, keyboard.
- Rules form, saved for each site (ADR-11). Dedicated workers behind a switch (ADR-14).

## [0.1.0] - 2026-11-04

### Added
- Page runtime that patches `WebTransport`, with byte streams, a rule engine and backpressure (ADR-1, ADR-5, ADR-7).
- Local WebTransport test server and demo page (ADR-6). Unit and end-to-end tests.
