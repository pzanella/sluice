# Privacy

Last updated: 12 November 2026. This policy covers the Sluice extension for Chrome.

Sluice is a developer tool that runs in your browser. It has no server, no account, no analytics and no remote code.

## What it reads

On the sites that you turn on, and only there, Sluice reads the WebTransport traffic of the page and counts the frames of its
video and audio decoders. It does this to show them in the DevTools panel and to apply your rules.

## Where data goes

- Traffic and counts go from the page to the DevTools panel of the same tab, only while the panel is open.
- Rules and settings are saved in the storage of the extension, on your device.
- A recording, a report or a scenario becomes a file only when you click **Save** (or **Export .moqtrace**). The file stays on
  your device unless you share it. A session URL in a file has no query, so a token there is not saved. A `.moqtrace` file keeps
  only the host and port of the URL.
- Nothing is sent to the developers of Sluice or to anyone else. Sluice does not sell, share or use data for anything other
  than what the panel shows.
- Traffic in the panel lives only while the panel is open; closing DevTools clears it.

## Permissions

- **Access to a site**, optional, one site at a time: to read and change the WebTransport traffic of that site.
- **`scripting`**: to start Sluice on the sites that you turned on.
- **`storage`**: to keep your rules and settings.
- **`activeTab`**: so the toolbar button works on the tab that you click it on.

You can turn a site off at any time from the toolbar button, and remove the extension to delete all its data.

## Contact

Questions about privacy: open an issue at https://github.com/pzanella/sluice/issues, or report it in private as
[SECURITY.md](../SECURITY.md) says.
