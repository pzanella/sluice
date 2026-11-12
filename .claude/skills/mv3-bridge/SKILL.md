---
name: mv3-bridge
description: Message protocol between the MAIN world runtime, the isolated content script, the service worker and the DevTools panel. Use it when you add or change a message type.
---
# MV3 bridge

## Chain
MAIN ⇄ (CustomEvent `sluice:<nonce>`) ⇄ ISOLATED ⇄ (`chrome.runtime.connect`, name `tab`) ⇄
SW ⇄ (`connect`, name `panel:<tabId>`) ⇄ PANEL

## Rules
- Nonce created by ISOLATED at `document_start`, put in the attribute `data-sluice-bridge` of the root element, read and
  removed by MAIN. ISOLATED must be registered first. With no nonce, MAIN still patches but has no channel.
- A frame connects only when it sends its first valid message. Commands to MAIN are `set-config`, `set-capture` and `hold-resolve`.
- Capture: with no panel open for the tab, MAIN sends only session open and close, never payload bytes.
- `set-config` names `targetOrigin`. It goes only to frames with that origin, in a tab with that origin. Others get none.
- Every message: `{ v: 1, type, id, payload }`, validated with the schema in `src/shared/protocol.ts`.
- Binary payloads: base64 strings. Chrome ports use JSON, so an `ArrayBuffer` does not survive (docs checked 2026-11-04).
- MAIN sends each message as a JSON string. ISOLATED checks the string length before it parses, reads `event.detail`
  in `try`, and validates there: the page can replace globals in MAIN, so MAIN cannot be the place that checks.
- Rate limit per port: a batch can be about 4.4 MB, and the service worker is shared by all tabs.
- Frame fields come only from `port.sender`. Key state by `documentId` + `sessionId`, and cap the sessions per frame.
- The sender resolves the session URL to an absolute `href` (relative URLs are valid in `new WebTransport`) and shortens
  long URLs and `frameUrl` to the limit. If not, the validator rejects the message and the session stays hidden.
- Panel: show page values as text only, never as `href` or HTML. Keep rule ids in a `Map`. `ruleHits` ids can repeat,
  and all counters are claims of the page. `preview` holds app payload, so it never leaves the browser.
- Hold: MAIN sends `hold`, waits for `hold-resolve { holdId, workerId, action, data }`, local timeout in MAIN (not in the panel), then sends `hold-end`.
- The MV3 SW can stop, and it has no state to lose: all of it comes from live ports. A panel reconnects its port, and
  that sends `wake` to the tab: frames with a live session connect again. There is no timer, so an idle page does not
  keep waking the worker. Rules are saved by origin in `chrome.storage.local`, sent on connect before `set-capture`.
- Volume: logs in batches (max 50 msg / 100 ms) so the channel does not get flooded.
- No message from the panel is run as code: only the validated rule DSL.
- The nonce reduces noise, it is not authentication: a same-origin parent can reach an about:blank or srcdoc frame.
  Treat every MAIN message as hostile. One nonce per frame. Key state by `port.sender`, never by the payload.
