# Contributing

Thank you for helping. This page says how to build, test and send a change.

## Set up

You need Node 22 or newer, [pnpm](https://pnpm.io/) (`corepack enable`) and, for end-to-end tests, Python 3.

```sh
pnpm install
pnpm build        # the extension in dist/
pnpm env:up       # local WebTransport server and demo on http://localhost:8080/
```

Load `dist/` in Chrome: `chrome://extensions` > **Developer mode** > **Load unpacked**. With `pnpm dev` the build runs again at
each change; click the reload button of Sluice in `chrome://extensions`, then reload the page.

The first `pnpm env:up` makes a Python virtual environment in `test-env/.venv` with `aioquic`. The server makes a new
self-signed certificate at each start, so you need no flags and no CA.

## Where things are

| Folder | What it holds |
|---|---|
| `src/inject/` | The page runtime: it replaces `WebTransport` in the page, runs rules, records and replays. No dependency, no extension API |
| `src/inject/moqt/` | MoQ parsers: IETF drafts 7 to 23 and moq-lite 3 to 6 |
| `src/bridge/` | The content script between the page and the extension |
| `src/background/` | The service worker: sites that are on, saved rules, the link to the panel |
| `src/panel/` | The DevTools panel and the toolbar popup (Preact) |
| `src/shared/` | Types, the message protocol and its validators, used by all parts |
| `tests/e2e/` | Playwright tests with the extension loaded, against `test-env/` |
| `test-env/` | Local WebTransport server (Python) and demo page with a small MoQ player |
| `examples/` | Scenario files and the Playwright helper for tests in CI |

Read [docs/architecture.md](docs/architecture.md) for how the parts talk, and [docs/DECISIONS.md](docs/DECISIONS.md) for why.
A comment `ADR-N` in the code points to a decision there.

## Before you send a change

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm e2e
```

- A new feature comes with tests: unit tests next to the code in `__tests__/`, and an end-to-end test in `tests/e2e/` when it
  touches the panel. On Linux with no display, run `xvfb-run -a pnpm e2e`.
- A change that the user sees updates the guide in `docs/guide/` and, if a screenshot changes, `pnpm docs:shots` (it makes all
  screenshots again, in the dark theme, also those of the store in `docs/store/`).
- A choice that is not obvious gets a short entry in `docs/DECISIONS.md`.
- A change for users gets a line in `CHANGELOG.md`, under **Unreleased**.

## Rules of the code

- English only, plain words: code, comments, docs, UI text and commit messages.
- TypeScript strict. No runtime dependency in the page runtime (`src/inject/`); the panel uses only Preact.
- The page is not trusted: every message from it goes through a validator in `src/shared/`. Rules are data, never code: no
  `eval`, no `new Function`.
- The page runtime must keep its invariants: lazy wraps, byte streams that work with default and BYOB readers, order on
  streams, real backpressure, a timeout on every hold.
- Every list of the panel opens inside the panel: use `select.tsx`, not a native `<select>` (ADR-58).
- Do not name other products or companies in docs, UI or comments. Test data from others stays in its fixture folder, with
  its licence in `THIRD_PARTY_NOTICES.md`.
- Small commits with conventional messages: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

## Pull requests

Open a pull request against `main`. CI runs the same checks as above, and builds the store zip. Describe what changed and how
you tested it. A pull request is merged only when all checks pass.

## Releases

Maintainers only. Follow [the release checklist](.claude/skills/release-checklist/SKILL.md): bump the version in
`package.json` and `src/manifest.json`, move **Unreleased** in `CHANGELOG.md` to the new version, then push a tag `vX.Y.Z`. The
`release` workflow builds `sluice-X.Y.Z.zip` (also `pnpm package` by hand) and attaches it to a GitHub release. The store
listing, its screenshots, the icon and the promo tile are in [docs/store/](docs/store/listing.md).

## Working with an AI agent

`CLAUDE.md` and `.claude/` hold the setup for Claude Code: short rules, skills for one kind of task each (such as the page
runtime invariants or the MoQ framing), and the commands `/next`, `/review` and `/qa`. You do not need them to contribute.
