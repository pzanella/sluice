---
name: moqt-framing
description: Incremental parsing of MoQT framing on streams and datagrams for per-object rules (track alias, group, subgroup, object). Use it to work on src/inject/moqt.
---
# MoQT framing

- Always check the negotiated draft version (SETUP) before you apply a parser: formats change
  between drafts. Never assume a layout from memory: compare with the draft text or public test vectors.
- **Incremental** parser: collect bytes across chunks, emit complete objects. One object can span
  many chunks and one chunk can hold many objects.
- QUIC varint (RFC 9000 §16): 2-bit prefix → 1/2/4/8 bytes.
- Per-object rules act on whole objects; re-serialize and keep headers and lengths correct.
- Dropping an object on a stream: remove the whole object, never partial bytes.
- Fallback: unknown version → raw chunk mode + warning in the UI.
- Test with public test vectors from the MoQT community where the license allows it.
