# Third-party notices

Sluice is MIT licensed (see `LICENSE`). Its tests use data from other open-source projects. That data is not part of the
extension that you install: it stays in the test folders below, with its own licence file.

| Folder | What it is | Licence |
|---|---|---|
| `src/inject/__tests__/fixtures/ietf-object-vectors/` | Byte-level test vectors for MoQT object streams and datagrams, drafts 7 to 23 | MIT, see the `LICENSE` file in the folder |
| `src/inject/__tests__/fixtures/ietf-control-vectors/` | Byte-level test vectors for MoQT SUBSCRIBE and SUBSCRIBE_OK, drafts 7 to 23 | MIT, see the `LICENSE` file in the folder |
| `src/panel/__tests__/fixtures/trace-corpus/` | Conformance files for the `.moqtrace` trace format, versions 1 and 2 | MIT, see the `LICENSE` file in the folder |

The copyright notice of each licence file must stay with the data, as the MIT licence asks. File names and text inside this
data come from its authors and are kept as they are.
