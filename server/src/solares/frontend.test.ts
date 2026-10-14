import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { SPA_ROUTES, frontendRouter } from './frontend.js';

function binary(pending: request.Test) {
  return pending.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });
}

test('the download page routes load the app and release files download as attachments', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'antara-frontend-'));
  try {
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>ANTARA</title><div id="root"></div>');
    mkdirSync(join(dist, 'downloads'));
    const zip = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
    const exe = Buffer.from('MZ fake installer bytes');
    writeFileSync(join(dist, 'downloads', 'ANTARA-Chrome-Extension-1.0.0.zip'), zip);
    writeFileSync(join(dist, 'downloads', 'ANTARA-Setup-1.0.0-x64.exe'), exe);
    writeFileSync(join(dist, 'downloads', 'manifest.json'), JSON.stringify({ version: '1.0.0', files: [] }));
    const app = express();
    app.use(frontendRouter(dist));
    app.use((_req, res) => { res.status(404).json({ error: 'Route not found' }); });

    assert.ok(SPA_ROUTES.includes('/download') && SPA_ROUTES.includes('/downloads'));
    for (const path of ['/download', '/downloads', '/downloads/', '/docs/faq', '/']) {
      const page = await request(app).get(path);
      assert.equal(page.status, 200, path);
      assert.match(page.headers['content-type'], /^text\/html/, path);
      assert.match(page.text, /<div id="root">/, path);
    }

    const extension = await binary(request(app).get('/downloads/ANTARA-Chrome-Extension-1.0.0.zip'));
    assert.equal(extension.status, 200);
    assert.equal(extension.headers['content-type'], 'application/zip');
    assert.equal(extension.headers['content-disposition'], 'attachment; filename="ANTARA-Chrome-Extension-1.0.0.zip"');
    assert.deepEqual(extension.body, zip);

    const installer = await binary(request(app).get('/downloads/ANTARA-Setup-1.0.0-x64.exe'));
    assert.equal(installer.status, 200);
    assert.equal(installer.headers['content-type'], 'application/vnd.microsoft.portable-executable');
    assert.equal(installer.headers['content-disposition'], 'attachment; filename="ANTARA-Setup-1.0.0-x64.exe"');
    assert.deepEqual(installer.body, exe);

    // The list the page reads stays JSON and is not forced to download.
    const manifest = await request(app).get('/downloads/manifest.json');
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers['content-type'], /^application\/json/);
    assert.equal(manifest.headers['content-disposition'], undefined);
    assert.equal(manifest.body.version, '1.0.0');

    // Missing files and traversal attempts do not fall back to the app or escape the folder.
    assert.equal((await request(app).get('/downloads/ANTARA-Setup-9.9.9-x64.exe')).status, 404);
    assert.equal((await request(app).get('/downloads/%2e%2e/index.html')).headers['content-disposition'], undefined);
    assert.equal((await request(app).get('/unknown-page')).status, 404);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
