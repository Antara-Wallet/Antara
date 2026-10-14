#!/usr/bin/env node
// Records a release file in public/downloads/manifest.json, the list the public /download page reads.
//
//   node scripts/downloads-manifest.mjs desktop-windows public/downloads/ANTARA-Setup-1.0.0-x64.exe
//   node scripts/downloads-manifest.mjs chrome-extension public/downloads/ANTARA-Chrome-Extension-1.0.0.zip
//   node scripts/downloads-manifest.mjs desktop-windows --unavailable     (page shows "Coming soon")
//
// The file must already be in public/downloads/ (Vite copies it to dist/downloads/, which Express
// serves as an attachment). Size and SHA-256 are computed from the file; nothing is typed by hand.
// `npm run package:extension -- --download` builds the extension zip and records it here.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DOWNLOADS_DIR = resolve(root, 'public', 'downloads');
export const MANIFEST_PATH = resolve(DOWNLOADS_DIR, 'manifest.json');
export const DOWNLOADS = Object.freeze({
  'desktop-windows': { name: 'ANTARA for Windows (64-bit installer)', extension: '.exe', fileName: version => `ANTARA-Setup-${version}-x64.exe` },
  'chrome-extension': { name: 'ANTARA Chrome extension (zip, load unpacked)', extension: '.zip', fileName: version => `ANTARA-Chrome-Extension-${version}.zip` },
});
const ORDER = Object.keys(DOWNLOADS);
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function readManifest() {
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const manifest = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : { version, files: [] };
  if (!Array.isArray(manifest.files)) throw new Error(`${relative(root, MANIFEST_PATH)} has no "files" list.`);
  return { ...manifest, version };
}

function writeEntry(entry) {
  const manifest = readManifest();
  const files = [...manifest.files.filter(file => file && file.id !== entry.id), entry]
    .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  writeFileSync(MANIFEST_PATH, `${JSON.stringify({ version: manifest.version, files }, null, 2)}\n`);
  return entry;
}

/** Hashes a file in public/downloads/ and records it as available. */
export function recordDownload(id, filePath) {
  const spec = DOWNLOADS[id];
  if (!spec) throw new Error(`Unknown download id "${id}" (expected ${ORDER.join(' or ')}).`);
  const path = resolve(filePath);
  const name = basename(path);
  if (dirname(path) !== DOWNLOADS_DIR) throw new Error(`${filePath} must be directly inside ${relative(root, DOWNLOADS_DIR)}${sep}.`);
  if (!FILE_NAME.test(name) || !name.toLowerCase().endsWith(spec.extension)) throw new Error(`${name} must be a plain ${spec.extension} file name.`);
  if (!existsSync(path)) throw new Error(`${filePath} does not exist.`);
  const data = readFileSync(path);
  if (!data.length) throw new Error(`${filePath} is empty.`);
  return writeEntry({ id, name: spec.name, file: `/downloads/${name}`, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}

/** Keeps the entry but marks it unavailable; the page shows "Coming soon". */
export function markUnavailable(id, fileName) {
  const spec = DOWNLOADS[id];
  if (!spec) throw new Error(`Unknown download id "${id}".`);
  const manifest = readManifest();
  const file = `/downloads/${fileName ?? spec.fileName(manifest.version)}`;
  return writeEntry({ id, name: spec.name, file, available: false });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [id, target] = process.argv.slice(2);
  try {
    const entry = target === '--unavailable' ? markUnavailable(id) : recordDownload(id, target ?? '');
    console.log(`${relative(root, MANIFEST_PATH)}: ${JSON.stringify(entry)}`);
  } catch (error) {
    console.error(`[downloads manifest] ${error instanceof Error ? error.message : error}`);
    console.error('Usage: node scripts/downloads-manifest.mjs <desktop-windows|chrome-extension> <public/downloads/file | --unavailable>');
    process.exit(1);
  }
}
