# Architecture

Sluice is a Manifest V3 extension with four parts. Data moves through them in this order:

```
DevTools panel (Preact UI)            src/panel/
   ⇅  port "panel:<tabId>"
Service worker (routing, storage)      src/background/
   ⇅  port "tab"
Content script, ISOLATED world         src/bridge/
   ⇅  CustomEvent with a one-time nonce
Page runtime, MAIN world               src/inject/
   (patches WebTransport, VideoDecoder, AudioDecoder at document_start)
```

## Page runtime (`src/inject/`)

- **Patch** (`patch.ts`): `WebTransport` becomes a subclass. The object stays native, so its own methods work. Streams are wrapped
  only when the app first reads them (lazy), so nothing is locked before that.
- **Byte streams** (`byte-stream.ts`): what the app reads is a `ReadableStream({ type: 'bytes' })`, so default and BYOB readers
  both work. Each chunk goes through the rule pipeline, can wait (delay, stall, bandwidth cap, hold), and is delivered in order.
  The native stream is read only when the app's queue is short, so backpressure stays real.
- **What the app sends** (`outgoing.ts`): a real `WritableStream` in front of the native one.
- **Rules** (`pipeline.ts`): plain data, validated, never run as code. Actions: log, drop, delay, modify, hold, stall, close, reset.
- **MoQ** (`moqt/`): the version of a session comes from its protocol or its SERVER_SETUP. Framers cut streams into objects (IETF
  drafts 7 to 23) or frames (moq-lite 3 to 6), and build the bytes again at delivery. Track names come from SUBSCRIBE messages.
- **Record and replay** (`recorder.ts`, `replay.ts`): a recording keeps what the network delivered; a replay is a session with the
  shape of a native one and no server.
- **Playback** (`playback.ts`): counts the frames that WebCodecs decoders and `<video>` elements give the player.
- **Channel** (`channel.ts`): sends events to the bridge in batches, and only while a panel is open.

## Bridge (`src/bridge/`)

It gives the page runtime a nonce once, then removes it from the page. It trusts no message from the page: each one passes a
validator, and it keeps a rate limit. It opens the port to the service worker only when the page has a session.

## Service worker (`src/background/`)

It keeps the rules of each site in `chrome.storage.local`, registers the content scripts for the sites the user turned on, and
routes messages between the frames of a tab and its panel. It checks every message again: it is the last stop before the panel.

## Panel (`src/panel/`)

- `main.tsx` starts it, `app.tsx` holds the top bar and the views.
- `store.ts` turns the messages of the pages into sessions, streams, rows, tracks and Monitor data (`monitor.ts`,
  `playback.ts`), and keeps the recordings (`recordings.ts`).
- Views: `monitor-view.tsx`, `tracks.tsx`, `messages.tsx` with `sessions.tsx`, `rules-page.tsx` (Simple: `rules-simple.tsx`
  with `quick-tests.ts`; Advanced: `rules.tsx` with `network.tsx` and `timeline.tsx`), `record.tsx`, `actions.tsx`,
  `inject.tsx`, `holds.tsx`. The popup is `popup.tsx`.
- Styles: `tokens.css` (colors of both themes), `controls.css` (shared form controls), `panel.css`, `popup.css`.
- `html-report.ts` writes the report, `moqtrace.ts` reads `.moqtrace` files and `moqtrace-export.ts` writes them (with the parsers
  of `src/inject/moqt/`). Nothing leaves the browser by itself.

## Shared (`src/shared/`)

The message protocol and its validators (`protocol.ts`, `validate.ts`), the rule types (`rules.ts`), network profiles, scenario
files and the catalog parser. The same code checks a message in the page, the bridge, the service worker and the panel.

## Security rules

- Sluice runs only on sites that the user turns on.
- The page is not trusted: every message is validated, the nonce only reduces noise.
- No `eval`, no `new Function`, no remote code. Workers start from packaged code through a `blob:` URL.
- Payloads leave the page only to the panel, and only while it is open. Files (recordings, reports) are saved only when the user
  asks.

## Tests

- Unit tests (`pnpm test`, Vitest): next to the code, in `__tests__/`.
- End-to-end tests (`pnpm e2e`, Playwright): the built extension in Chromium against the local test server and demo
  (`test-env/`).
- Screenshots of the docs: `pnpm docs:shots`.

The reasons for each choice are in [DECISIONS.md](DECISIONS.md).
