import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { formatSize, parseDownloadManifest } from './downloadManifest';

const sha = 'a'.repeat(64);
const desktop = { id: 'desktop-windows', name: 'ANTARA for Windows', file: '/downloads/ANTARA-Setup-1.0.0-x64.exe', size: 12_345_678, sha256: sha };
const extension = { id: 'chrome-extension', name: 'ANTARA Chrome extension', file: '/downloads/ANTARA-Chrome-Extension-1.0.0.zip', size: 8_000_000, sha256: sha };

test('complete entries are offered with their version, size and hash', () => {
  const manifest = parseDownloadManifest({ version: '1.0.0', files: [desktop, extension] });
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.files['desktop-windows']?.fileName, 'ANTARA-Setup-1.0.0-x64.exe');
  assert.equal(manifest.files['desktop-windows']?.version, '1.0.0');
  assert.equal(manifest.files['chrome-extension']?.size, 8_000_000);
});

test('unavailable, incomplete or unsafe entries are never offered', () => {
  const rejected = [
    { ...desktop, available: false },
    { id: 'desktop-windows', name: 'ANTARA for Windows', file: desktop.file, available: false },
    { ...desktop, sha256: 'A'.repeat(64) },
    { ...desktop, sha256: undefined },
    { ...desktop, size: 0 },
    { ...desktop, size: 1.5 },
    { ...desktop, file: 'https://example.com/ANTARA-Setup.exe' },
    { ...desktop, file: '//example.com/downloads/ANTARA-Setup.exe' },
    { ...desktop, file: '/downloads/../index.html' },
    { ...desktop, file: '/downloads/sub/ANTARA-Setup.exe' },
    { ...desktop, file: '/downloads/ANTARA-Chrome-Extension-1.0.0.zip' },
    { ...extension, file: '/downloads/ANTARA-Setup-1.0.0-x64.exe' },
    { ...desktop, id: 'mac' },
  ];
  for (const entry of rejected) assert.deepEqual(parseDownloadManifest({ version: '1.0.0', files: [entry] }).files, {}, JSON.stringify(entry));
  assert.throws(() => parseDownloadManifest({ version: '1.0.0' }));
  assert.throws(() => parseDownloadManifest([desktop]));
});

test('sizes are shown in readable units', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(20_480), '20 KB');
  assert.equal(formatSize(8_388_608), '8.0 MB');
});

test('the published download list matches the files next to it', () => {
  const manifestPath = 'public/downloads/manifest.json';
  assert.ok(existsSync(manifestPath), 'public/downloads/manifest.json is published with the site');
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifest = parseDownloadManifest(raw);
  assert.deepEqual(raw.files.map((file: { id: string }) => file.id), ['desktop-windows', 'chrome-extension']);
  for (const entry of Object.values(manifest.files)) {
    const local = `public${entry.file}`;
    assert.ok(existsSync(local), `${entry.file} is listed and must exist`);
    assert.equal(statSync(local).size, entry.size, `${entry.file} size`);
    assert.equal(createHash('sha256').update(readFileSync(local)).digest('hex'), entry.sha256, `${entry.file} SHA-256`);
  }
});
