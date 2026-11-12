// Packs dist/ into sluice-<version>.zip, the file to upload to the Chrome Web Store. Run `pnpm build` first.
// The zip is written here, with the zlib of Node, so the release needs no other tool. Source maps stay out of it.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, resolve, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const dist = resolve(root, 'dist');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8').catch(() => 'null'));
if (!manifest) throw new Error('No dist/manifest.json: run `pnpm build` first.');
if (manifest.version !== pkg.version) throw new Error(`The manifest has version ${manifest.version}, package.json has ${pkg.version}.`);

/** Every file of a folder, in a stable order, so the same build gives the same zip. */
async function walk(dir) {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (!entry.name.endsWith('.map')) out.push(path);
  }
  return out;
}

// A fixed time (1 January 2020, in MS-DOS format) for every file, also so the zip does not change between builds.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

const locals = [];
const centrals = [];
let offset = 0;
for (const path of await walk(dist)) {
  const name = Buffer.from(relative(dist, path).split(sep).join('/'), 'utf8');
  // The maps stay out, so the line that points to one goes too: DevTools would warn that it cannot load it.
  const raw = await readFile(path);
  const data = path.endsWith('.js') ? Buffer.from(raw.toString('utf8').replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n')) : raw;
  const packed = deflateRawSync(data, { level: 9 });
  const deflate = packed.length < data.length;
  const body = deflate ? packed : data;
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0x0800, 6); // names are UTF-8
  head.writeUInt16LE(deflate ? 8 : 0, 8);
  head.writeUInt16LE(DOS_TIME, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(body.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(name.length, 26);
  locals.push(head, name, body);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // made by
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(deflate ? 8 : 0, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += head.length + name.length + body.length;
}
const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(centrals.length / 2, 8);
end.writeUInt16LE(centrals.length / 2, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const file = resolve(root, `sluice-${pkg.version}.zip`);
const zip = Buffer.concat([...locals, ...centrals, end]);
await writeFile(file, zip);
const sha = createHash('sha256').update(zip).digest('hex');
console.log(`sluice: ${relative(root, file)}, ${centrals.length / 2} files, ${((await stat(file)).size / 1024).toFixed(1)} KiB, sha256 ${sha}`);
