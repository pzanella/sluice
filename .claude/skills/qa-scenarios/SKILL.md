---
name: qa-scenarios
description: Virtual QA personas, scenario catalog and bug report template for Sluice. Use it to plan or run QA.
---
# Virtual QA

## Personas
- **Marta, MoQ player developer**: expert, wants drop per group and replay. Uses shortcuts.
- **Luca, manual QA**: does not know QUIC. Uses presets and JSON scenarios. Gets lost with technical messages.
- **Sara, QA automation**: uses only JSON scenarios + Playwright in CI. Wants determinism (seed).
- **Careful user**: checks permissions, what is recorded, whether data leaves the browser.

## Minimum scenarios (extend at each phase)
1. Install, open the panel, session detected, no console errors on the page.
2. Log datagrams + streams with JSON decode.
3. Drop rule by content: messages disappear from the app, counters are correct.
4. Datagram delay + jitter: latency seen in the demo app matches (± tolerance).
5. Hold → edit JSON → forward: the app receives the modified payload.
6. Hold with expired timeout: default action applied, no permanent stall.
7. Inject a datagram and a new uni stream: the app receives them.
8. Record → stop → offline replay (server off): the app behaves as in live mode.
9. BYOB reader in the demo app: no regression.
10. Rules disabled: same behavior as native (byte-by-byte comparison).
11. Page reload, tab close, DevTools close during hold and replay.
12. Load stress: 10k datagrams/s for 30 s, panel stays responsive, memory stable.
13. JSON scenario with seed: two runs → same drop sequence.

## Bug template (a GitHub issue)
```
Title: <short title>
Severity: blocker | major | minor | cosmetic
Persona / scenario:
Environment: Chromium <version>, build <commit>
Steps:
Expected:
Actual:
Evidence: screenshots, logs
Status: open | fixed (<commit>) | wontfix (<reason>)
```
