---
name: release-checklist
description: Checklist for release and publishing on the Chrome Web Store. Use it before every version tag.
---
# Release

1. `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` green.
2. Security review inline, with the rules of `extension-security-reviewer`: no serious open problem.
3. README and guides match the features; no other product named (ADR-54); `THIRD_PARTY_NOTICES.md` and `docs/privacy.md`
   up to date.
4. Same version in `package.json` and `manifest.json`; CHANGELOG updated.
5. `pnpm build && pnpm package`; load `dist/` unpacked in a fresh profile and run the first-run flow of the README.
6. Store listing from `docs/store/listing.md`: single purpose, reason for each permission, privacy (data stays local),
   screenshots, icon and promo tile in `docs/store/` (`pnpm docs:shots`). Explain that the
   worker runtime is packaged code, run from a string through a blob: URL, not remote code and not `eval` (ADR-14). The store icon is `docs/store/icon-128.png` (96 px art, 16 px padding).
7. Annotated SemVer tag (ADR-53): the `release` workflow attaches `sluice-<version>.zip` to a GitHub release. Upload that
   zip, never `dist-granted/`: that test copy has a host granted at install.
