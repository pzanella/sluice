# Roadmap

Current version: **v0.9.1**. Tags follow SemVer (ADR-53). For what each version brought, see [CHANGELOG.md](../CHANGELOG.md).

**Next step:** the [v1.0 milestone](https://github.com/pzanella/sluice/milestone/1), starting from #6.

## v1.0: read the whole protocol

- Read all IETF MoQT control messages (#6)
- Show the life of each subscription (#7)
- Show connection stats in the Monitor (#8)
- Show where an outgoing message comes from (#9)
- Find key frames in AV1 and VP9 (#10)

## After v1.0

- **v1.1, work with other tools:** qlog export, tests against several real servers in CI, checks of protocol rules
- **v1.2, see more at a glance:** a time view of streams and groups, a score of what the viewer saw, previews of decoded key
  frames, a badge on the tab when a track stalls or a check fails, compare two recordings
- **v1.3, more real networks:** burst loss, network traces, late or starved tracks, regex rules that cannot hang the page
- **v1.4, in teams:** a Playwright package and a GitHub Action, a panel that shows more under load
- **v2.0:** Firefox
- When final: moq-lite 7, and the setup of `moql` sessions
