# Sluice

MV3 DevTools extension: monitor, test and replay WebTransport and MoQ traffic inside the page, with no proxy.
Read `docs/architecture.md` for the parts, `docs/DECISIONS.md` for the why, `docs/ROADMAP.md` for the next step.

## Project rules
- **English only, plain words**: code, comments, docs, UI text, commits, agent and skill files (ADR-2).
- **Small and focused**: no subagents unless the user names one; do reviews and tests inline. Read only what the task needs,
  batch edits, wait for CI once in the background, keep reports short (ADR-18).
- **Neutral text**: no references to other products or companies in docs, UI or comments. Test data of others stays in its
  fixture folder, listed in `THIRD_PARTY_NOTICES.md` (ADR-54).
- **No secrets**: no tokens, keys, personal data or real service URLs in code, tests or docs; use `example.test` and localhost.
- Merge a pull request only after all CI checks pass. Never push to `main` directly, force-push, publish or change repo
  settings without the maintainer.

## Commands
`pnpm build` · `pnpm test` · `pnpm e2e` (needs Python 3) · `pnpm lint` · `pnpm typecheck` · `pnpm env:up` / `env:down` ·
`pnpm docs:shots`

## Page runtime invariants (`src/inject/`, never break)
Lazy wrap on the app's first access · byte streams that work with default and BYOB readers, `byobRequest?.respond(0)` after
`close()` · Proxies with receiver = target · order kept on streams · real backpressure · a timeout on every hold · no `eval` or
`new Function` · no trust in page messages · no runtime dependency. Details: skill `wt-wrapper-invariants`.

## Work mode
Start with the skill `autonomy-loop`. It says how to pick a task, when to stop and ask, and how to leave the state for the next
session. Release: skill `release-checklist`.
