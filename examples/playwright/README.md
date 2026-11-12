# Use Sluice in your Playwright tests

Build Sluice, then copy `sluice.ts` to your project. In a test:

1. `extensionFor(dist, pattern)` makes a copy of the extension with your site turned on.
2. `launchWithSluice(extension)` starts Chromium with it.
3. `applyScenario(worker, origin, file)` applies a scenario file. Do this before you open the page.

4. `openSluicePanel(context, worker, page)` opens the panel next to your page. `report()` gives the Monitor report of each
   session: tracks with their checks (`gaps`, `pauses`, `key-frames`, `receiving`), and `pass` when all of them passed. See
   `checks.spec.ts` and `docs/guide/monitor.md`.

To make a scenario, set up rules and the simulated network in the panel, then click **Export scenario** in the Rules view. To change the example here,
see `lossy.scenario.json`: half of the datagrams are lost, with seed 42.

`example.spec.ts` and `checks.spec.ts` run on the local demo, and Sluice runs them in its own e2e tests. The first: two runs lose
the same messages. The second: a player that loses its key frames fails a check.

## What a seed repeats
The same message gets the same decision. It does not repeat exact times. On a datagram, "the same message" means the same index in the session, so a real loss or a change in
order on the network shifts the ones after it. On a stream in chunk mode it means the same chunk index, and the network can cut chunks in a different way. MoQT objects use
their IDs, so they repeat also in another order. For bytes that repeat exactly, use a recording and a replay. See ADR-25.

## Limits
This writes to the storage of the extension, with a key that can change between versions of Sluice, and the extension needs a browser with extension support.
