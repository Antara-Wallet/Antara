#!/usr/bin/env node
// Packages a production extension build for the Chrome Web Store:
//   1. copies dist-extension/ to dist-extension-store/ANTARA-<version>/
//   2. removes "key" (and any "update_url") from the copied manifest; the store
//      assigns the item ID and rejects uploads that set it
//   3. re-runs scripts/extension-check.mjs --store on the copy
//   4. writes dist-extension-store/antara-extension-<version>.zip (deterministic)
//
//   npm run build:extension && npm run package:extension
//
// The unpacked dist-extension/ keeps "key" so local loads keep the documented ID.
//
// --download packages the public "Load unpacked" zip instead: dist-extension/ as built (manifest
// "key" kept, so the installed ID is the allowlisted ckfkljfbjkmkjkkjkpbnmoehfipdcoin), checked with
// --production, zipped with manifest.json at the root to public/downloads/ANTARA-Chrome-Extension-
// <version>.zip and recorded in public/downloads/manifest.json for the /download page.
//
//   VITE_API_BASE=https://antara.tech npm run build:extension && npm run package:extension -- --download
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { DOWNLOADS_DIR, recordDownload } from './downloads-manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'dist-extension');
const outRoot = resolve(root, 'dist-extension-store');

function die(message) {
  console.error(`[extension package] ${message}`);
  process.exit(1);
}

if (!existsSync(join(source, 'manifest.json'))) die('dist-extension/manifest.json is missing. Run npm run build:extension first.');
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
if (manifest.name !== 'ANTARA') die(`dist-extension is a "${manifest.name}" build. Run npm run build:extension (production) first.`);

const download = process.argv.includes('--download');
let stage;
let zipPath;
if (download) {
  // Sideloaded installs keep "key": the ID is what the login and CORS allowlists expect.
  if (typeof manifest.key !== 'string' || !manifest.key) die('dist-extension/manifest.json has no "key"; the unpacked ID would not be stable.');
  const check = spawnSync(process.execPath, [join(root, 'scripts/extension-check.mjs'), '--dir', relative(root, source), '--production'], { cwd: root, stdio: 'inherit' });
  if (check.status !== 0) die('dist-extension failed scripts/extension-check.mjs --production; nothing was zipped.');
  stage = source;
  zipPath = join(DOWNLOADS_DIR, `ANTARA-Chrome-Extension-${manifest.version}.zip`);
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  rmSync(zipPath, { force: true });
} else {
  stage = join(outRoot, `ANTARA-${manifest.version}`);
  zipPath = join(outRoot, `antara-extension-${manifest.version}.zip`);
  rmSync(stage, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
  mkdirSync(outRoot, { recursive: true });
  cpSync(source, stage, { recursive: true });

  const storeManifest = { ...manifest };
  delete storeManifest.key;
  delete storeManifest.update_url;
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(storeManifest, null, 2)}\n`);

  const check = spawnSync(process.execPath, [join(root, 'scripts/extension-check.mjs'), '--dir', relative(root, stage), '--store'], { cwd: root, stdio: 'inherit' });
  if (check.status !== 0) die('The store package failed scripts/extension-check.mjs --store; nothing was zipped.');
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

// Minimal deterministic ZIP writer (deflate, fixed 1980-01-01 timestamps, UTF-8 names).
const crc32 = zlib.crc32 ?? (() => { throw new Error('Node 20.15+ / 22.2+ is required (zlib.crc32).'); });
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const files = walk(stage).map(path => relative(stage, path).split('\\').join('/')).sort();
if (files.length >= 0xffff) die('Too many files for a non-ZIP64 archive.');
const locals = [];
const central = [];
let offset = 0;
for (const name of files) {
  const data = readFileSync(join(stage, name));
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const stored = deflated.length >= data.length;
  const body = stored ? data : deflated;
  const crc = crc32(data);
  const nameBytes = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(stored ? 0 : 8, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  locals.push(header, nameBytes, body);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(stored ? 0 : 8, 10);
  entry.writeUInt16LE(DOS_TIME, 12);
  entry.writeUInt16LE(DOS_DATE, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(body.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(nameBytes.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, nameBytes);
  offset += header.length + nameBytes.length + body.length;
}
const centralSize = central.reduce((sum, part) => sum + part.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...locals, ...central, end]);
if (zip.length > 0xffffffff) die('Archive exceeds 4 GB.');
writeFileSync(zipPath, zip);

console.log(`${download ? 'Download package' : 'Store package'}: ${relative(root, zipPath)}`);
console.log(`  files:  ${files.length}`);
console.log(`  size:   ${(zip.length / 1024 / 1024).toFixed(1)} MB (${zip.length} bytes)`);
console.log(`  sha256: ${createHash('sha256').update(zip).digest('hex')}`);
if (download) {
  recordDownload('chrome-extension', zipPath);
  console.log('Recorded in public/downloads/manifest.json for the /download page.');
} else console.log('Upload as a draft first; see extension/EXTENSION_ID.md for the store ID procedure.');
