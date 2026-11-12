---
name: design-system
description: Tokens, layout and components of the Sluice UI (DevTools panel, popup). Use it before any visual work.
---
# Sluice design system

## Tokens (`src/panel/tokens.css`, CSS custom properties)
- Semantic colors, never raw values in components: `--bg`, `--bg-alt`, `--surface`, `--surface-2`, `--fg`, `--fg-muted`,
  `--border`, `--control-border`, `--accent`, `--accent-soft`, `--accent-fg`, `--record`, `--hold` (amber), `--drop` (red),
  `--modified` (purple), `--injected` (green), `--delayed` (blue), `--key` (key frames), `--kind-uni|bidi|datagram|out`.
- Shape and type: `--radius`, `--radius-lg`, `--shadow`, `--font-ui`, `--font-mono`.
- Light and dark: `prefers-color-scheme`, and `chrome.devtools.panels.themeName` sets `data-theme` when it is known.
- Form controls share one look in `controls.css` (selectors start with `:root`, as it loads before the view CSS).
- Every color state comes with an icon or a label (never color alone). Icons: line icons in `icons.tsx`, drawn for Sluice.
- UI text in English only, short and plain.

## Panel layout
```
┌ top bar: Sluice                                                      Session [picker ▾] ┐
├ tabs: Monitor | Tracks | Messages | Rules (Simple / Advanced) | Record                  stats      ┤
│ the view of the tab                                                                               │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```
- Messages: sidebar with sessions and streams, a virtual list, a detail with Hex / Text / JSON (frames show their track, group and frame).
- Held messages: always visible while one waits, with a countdown. Keys: F forward, E edit, D drop, arrows move.
- Tabs move with the left and right arrows.
- Record: [Start recording] (time, replay state, Stop playing) at the top of the view; its tab shows a dot while it records.
- Every list opens inside the panel: `select.tsx`, never a native `<select>` (ADR-58). No horizontal scroll at any width.

## Stack
Preact + TypeScript, plain CSS. No UI framework. Check a visual change with `pnpm docs:shots` or a Playwright screenshot.
