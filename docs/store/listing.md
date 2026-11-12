# Chrome Web Store listing

What to fill in on the Chrome Web Store developer dashboard. Publishing is a step of the maintainer. Check each point again against
the store rules of the day before you submit.

## Package

`pnpm build && pnpm package` gives `sluice-<version>.zip` (or take it from the GitHub release of the tag). Upload that file.

## Store listing

**Name** (from the manifest): Sluice — WebTransport and MoQ DevTools

**Summary** (from the manifest, at most 132 characters): Monitor, test and replay the WebTransport and MoQ traffic of your web
app, in DevTools. No proxy, no server.

**Category:** Developer Tools. **Language:** English.

**Description:**

```
Sluice is a DevTools panel for developers who build web apps with WebTransport and Media over QUIC (MoQ), such as live video players.

Open the Sluice tab in DevTools, start your app, and you can:

• Monitor each MoQ track (moq-lite 3 to 6, IETF MoQT drafts 7 to 23): bitrate, frames per second, key frames, gaps, pauses, lag and A/V offset, with checks that pass or fail.
• See what the player shows: frames of its WebCodecs decoders or its <video>, decoder errors and freezes.
• Inspect every datagram and stream chunk in hex, text or JSON, with track, group and frame numbers.
• Break things on purpose: drop key frames, lose frames, delay a track, edit the catalog, or use a slow or mobile network, with one-click tests or your own rules.
• Hold a message, edit it and let it go. Inject a message the server never sent.
• Stall or close the session once, to test rebuffering and reconnects.
• Record what the server sends, and play it to your app with no server. Export a recording as a .moqtrace file, or open one.
• Save a report as one HTML file, or a scenario file for Playwright tests in CI.

Only your app sees these changes: the server, QUIC and congestion control do not change.

Sluice runs only on sites that you turn on, one at a time, from its toolbar button. It has no server, no account and no analytics. All data stays in your browser.

Source code, guides and recipes: https://github.com/pzanella/sluice
```

**Images** (all made by `pnpm docs:shots`, dark theme):

| Field | File |
|---|---|
| Store icon, 128×128 | `icon-128.png` (96 px art, 16 px padding) |
| Screenshots, 1280×800 | `screenshot-1-monitor.png`, `screenshot-2-tracks.png`, `screenshot-3-messages.png`, `screenshot-4-rules.png`, `screenshot-5-record.png` |
| Small promo tile, 440×280 | `promo-small-440x280.png` |

**Homepage URL:** https://github.com/pzanella/sluice
**Support URL:** https://github.com/pzanella/sluice/issues

## Privacy practices

**Single purpose:** Test how a web app behaves with its WebTransport and MoQ traffic, by showing and changing that traffic in
DevTools, on the sites that the user turns on.

**Permission justifications:**

| Permission | Why |
|---|---|
| Host permissions (optional, asked one site at a time) | Sluice runs only on a site after the user turns it on from the toolbar button. It then wraps `WebTransport` in the pages of that site, to show and change their traffic in DevTools. |
| `scripting` | Registers the content scripts for the sites that the user turned on, and removes them when the user turns a site off. |
| `storage` | Keeps the rules and settings of each site on this device. |
| `activeTab` | Lets the toolbar popup read the site of the tab the user clicked it on, to offer to turn that site on. |

**Remote code:** No, I am not using remote code. All code is in the package. The runtime for web workers is packaged code that
starts from a string through a `blob:` URL, so it can run inside a worker of the page; it is not downloaded and it does not use
`eval` (ADR-14). The panel reads the URL of the inspected page with `chrome.devtools.inspectedWindow.eval('location.href')`, a
fixed string.

**Data usage:** Sluice reads "Website content" (the WebTransport traffic of the sites the user turns on) only to show it in
DevTools on the same device. Tick no data type as collected: nothing leaves the browser, and the developer receives nothing.
Certify that data is not sold, not used for anything other than the single purpose, and not used for credit.

**Privacy policy URL:** https://github.com/pzanella/sluice/blob/main/docs/privacy.md

## Distribution

Public, all regions. Free.

## Notes for the reviewer

```
Sluice is a DevTools extension. To test it: load a page that uses WebTransport (the repository has a local demo: pnpm env:up,
then http://localhost:8080/), click the Sluice toolbar button, Turn on, Reload page, then open DevTools and the Sluice tab.
Host access is optional and asked per site; nothing runs on other sites. The code is not minified.
```
