// A worker for tests. It works as a classic and as a module worker: it uses WebTransport and relative URLs from inside.
/* global importScripts */
const seen = [];
self.WT_MAIN = true;

self.addEventListener('message', async (event) => {
  seen.push(event.data);
  if (event.data?.type === 'close') self.close();
  if (event.data?.type !== 'echo') return;
  const { wtPort, certHash, text } = event.data;
  const out = { location: self.location.href, seen };
  out.relativeFetch = await fetch('config.json').then((r) => r.ok, (e) => `FAIL ${e.name}`);
  // Neither is allowed in a module worker with a relative URL of this form, or at all, so only a classic one tries.
  if (typeof importScripts === 'function' && event.data.relativeImport) {
    try {
      importScripts('wt-dep.js');
      out.relativeImport = self.WT_DEP;
    } catch (error) {
      out.relativeImport = `FAIL ${error.name}`;
    }
  }
  if (event.data.nested) {
    out.nested = await new Promise((resolve) => {
      const nested = new Worker('wt-dep.js');
      nested.onmessage = (message) => resolve(message.data);
      nested.onerror = () => resolve('FAIL');
    });
  }
  const hash = Uint8Array.from(certHash.match(/../g), (byte) => parseInt(byte, 16));
  const session = new WebTransport(`https://localhost:${wtPort}/echo`, {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }],
  });
  await session.ready;
  out.patched = Object.getPrototypeOf(WebTransport) !== Function.prototype;
  const writer = session.datagrams.writable.getWriter();
  const reader = session.datagrams.readable.getReader();
  await writer.write(new TextEncoder().encode(text));
  const answer = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve(null), 1500))]);
  out.echo = answer?.value ? new TextDecoder().decode(answer.value) : null;
  postMessage(out);
});
postMessage({ loaded: true });
