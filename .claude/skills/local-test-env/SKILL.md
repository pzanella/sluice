---
name: local-test-env
description: How to build and start the local test environment (WebTransport server, demo app, Chromium with the extension) with no external services. Use it for e2e tests and QA.
---
# Local test environment

## Parts (`test-env/`)
- **WebTransport server** (`server.py`, aioquic, ADR-6), on loopback:
  - `/echo`: echo of datagrams and bidi streams
  - `/push`: JSON datagrams, uni streams (JSON and binary) and one server bidi stream
  - `/moq`: a small moq-lite-04 publisher with a catalog.json, video (a key frame per group) and audio
- **Certificate**: a new self-signed ECDSA one at each start, used through `serverCertificateHashes` (no CA, no flags).
- **Demo app** (`test-env/demo/`): `window.__demo` with `startPush`, `startMoq`, `startVideo`, `echoDatagram`, `echoStream`,
  counters and payloads, for Playwright.

## Start
`pnpm env:up` → server + demo on localhost. `pnpm env:down`.

## Chromium
- Playwright with `--disable-extensions-except=dist` and `--load-extension=dist`.
- The `chromium` channel of Playwright runs extensions in headless mode. Tests open the panel page in a tab, with the two
  DevTools values it reads (see `tests/e2e/helpers.ts`).
