# Security

## Report a problem

Please do not open a public issue for a security problem. Use the private vulnerability reporting of the GitHub repository
(**Security** > **Report a vulnerability**). Say what you found, how to reproduce it, and what it lets someone do.

## What Sluice protects

- Sluice runs only on sites that the user turns on. Other pages are not touched.
- The page is not trusted. Every message from the page is checked before the extension uses it.
- Rules are data. Sluice never runs code that comes from a rule, a file or a page (no `eval`, no `new Function`).
- Payloads leave a page only to the open DevTools panel of the same tab. Nothing is sent to a server.

## Limits that are known

- A page can see that Sluice runs, and can reach the native `WebTransport`. See [docs/limits.md](docs/limits.md).
- A recording or a report saved by the user can hold private data of the app. Treat it as a network log.
