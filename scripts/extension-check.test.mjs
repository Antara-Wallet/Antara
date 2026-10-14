// Policy tests for scripts/extension-check.mjs against a minimal fixture package:
// the manifest must carry exactly the committed permissions, no optional
// permissions, and minimum_chrome_version >= 122 (vault passkeys, docs/VAULT_LAYERS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXTENSION_CSP, EXTENSION_HOST_PERMISSIONS, EXTENSION_PERMISSIONS, MINIMUM_CHROME_VERSION, PASSKEY_RP_ID,
} from '../extension/policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = join(root, 'scripts/extension-check.mjs');
const key = JSON.parse(readFileSync(join(root, 'extension/extension-key.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const ICON_SIZES = [16, 32, 48, 128];

/** The 24 bytes extension-check reads: PNG signature, IHDR length/type, width, height. */
function pngHeader(size) {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data, 0);
  data.writeUInt32BE(13, 8);
  data.write('IHDR', 12, 'ascii');
  data.writeUInt32BE(size, 16);
  data.writeUInt32BE(size, 20);
  return data;
}

function baseManifest() {
  const icons = Object.fromEntries(ICON_SIZES.map(size => [String(size), `icons/icon-${size}.png`]));
  const [major, minor, patch] = /^(\d+)\.(\d+)\.(\d+)/.exec(pkg.version).slice(1).map(Number);
  return {
    manifest_version: 3,
    name: 'ANTARA',
    short_name: 'ANTARA',
    description: 'fixture',
    version: `${major}.${minor}.${patch}`,
    minimum_chrome_version: MINIMUM_CHROME_VERSION,
    key: key.key,
    icons,
    action: { default_title: 'Open ANTARA', default_icon: { 16: icons['16'], 32: icons['32'] } },
    side_panel: { default_path: 'sidepanel.html' },
    background: { service_worker: 'background.js', type: 'module' },
    permissions: [...EXTENSION_PERMISSIONS],
    host_permissions: [...EXTENSION_HOST_PERMISSIONS],
    content_security_policy: { extension_pages: EXTENSION_CSP },
  };
}

/** Writes a fixture package with `manifest` (and optionally the page's code) and runs the check on it (production mode). */
function runCheck(manifest, pageCode = 'export const page = 1;\n') {
  const dir = mkdtempSync(join(tmpdir(), 'antara-extension-check-'));
  try {
    mkdirSync(join(dir, 'icons'));
    mkdirSync(join(dir, 'assets'));
    for (const size of ICON_SIZES) writeFileSync(join(dir, `icons/icon-${size}.png`), pngHeader(size));
    for (const [page, surface] of [['sidepanel.html', 'sidepanel'], ['wallet.html', 'tab']]) {
      writeFileSync(join(dir, page), `<!doctype html><html data-surface="${surface}"><body><div id="root"></div><script type="module" src="./assets/page.js"></script></body></html>\n`);
    }
    writeFileSync(join(dir, 'assets/page.js'), pageCode);
    writeFileSync(join(dir, 'background.js'), 'chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });\n');
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const result = spawnSync(process.execPath, [check, '--dir', dir, '--production'], { cwd: root, encoding: 'utf8' });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const withManifest = (changes) => ({ ...baseManifest(), ...changes });

test('the committed policy is sidePanel + geolocation, Chrome 122 and the antara.tech passkey RP ID', () => {
  assert.deepEqual([...EXTENSION_PERMISSIONS], ['sidePanel', 'geolocation']);
  assert.equal(MINIMUM_CHROME_VERSION, '122');
  assert.equal(PASSKEY_RP_ID, 'antara.tech');
  assert.ok(EXTENSION_HOST_PERMISSIONS.includes(`https://${PASSKEY_RP_ID}/*`));
});

test('a package with exactly the committed policy passes', () => {
  const { status, output } = runCheck(baseManifest());
  assert.equal(status, 0, output);
  assert.match(output, /permissions:\s+sidePanel, geolocation \(minimum Chrome 122\)/);
  // Order does not matter; membership does.
  assert.equal(runCheck(withManifest({ permissions: ['geolocation', 'sidePanel'] })).status, 0);
});

test('a missing, extra or duplicated permission fails', () => {
  const missing = runCheck(withManifest({ permissions: ['sidePanel'] }));
  assert.equal(missing.status, 1);
  assert.match(missing.output, /Permission "geolocation" is required/);
  const extra = runCheck(withManifest({ permissions: ['sidePanel', 'geolocation', 'storage'] }));
  assert.equal(extra.status, 1);
  assert.match(extra.output, /Permission "storage" is not allowed/);
  const duplicate = runCheck(withManifest({ permissions: ['sidePanel', 'geolocation', 'geolocation'] }));
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.output, /duplicates/);
  const notArray = runCheck(withManifest({ permissions: 'sidePanel' }));
  assert.equal(notArray.status, 1);
  assert.match(notArray.output, /permissions must be an array/);
});

test('optional permissions fail even when empty', () => {
  for (const field of ['optional_permissions', 'optional_host_permissions']) {
    for (const value of [[], ['geolocation']]) {
      const { status, output } = runCheck(withManifest({ [field]: value }));
      assert.equal(status, 1, `${field}=${JSON.stringify(value)}`);
      assert.match(output, new RegExp(`"${field}" must not be present`));
    }
  }
});

test('minimum_chrome_version below 122, malformed or missing fails', () => {
  // Chrome requires a string; a number would not load, so it fails here too.
  for (const version of ['116', '121', '121.0.6167.184', '12.2', 'abc', '', '122a', ' 122', '122.0.0.0.1', 122, null]) {
    const { status, output } = runCheck(withManifest({ minimum_chrome_version: version }));
    assert.equal(status, 1, `minimum_chrome_version ${JSON.stringify(version)}`);
    assert.match(output, /minimum_chrome_version must be at least 122/);
  }
  const { minimum_chrome_version: _omitted, ...withoutVersion } = baseManifest();
  assert.equal(runCheck(withoutVersion).status, 1);
  for (const version of ['122', '122.0.6261.57', '130']) assert.equal(runCheck(withManifest({ minimum_chrome_version: version })).status, 0, version);
});

test('a package whose host permissions no longer cover the passkey RP ID fails', () => {
  const { status, output } = runCheck(withManifest({ host_permissions: ['https://api.antara.tech/*'] }));
  assert.equal(status, 1);
  assert.match(output, /must include https:\/\/antara\.tech\/\*/);
});

test('only the vault Geolocation collector may read the position the permission grants without a prompt', () => {
  const collector = 'export const read = api => new Promise((ok, fail) => { api.getCurrentPosition(ok, fail, { enableHighAccuracy: true }); });\n';
  const probe = 'export const can = typeof navigator.geolocation?.getCurrentPosition == "function";\n';
  const one = runCheck(baseManifest(), collector + probe);
  assert.equal(one.status, 0, one.output);
  assert.match(one.output, /position:\s+1 getCurrentPosition call site\(s\), at most 1/);
  // A second reader (say, a dependency update) fails, however the call is written.
  for (const extra of ['navigator.geolocation.getCurrentPosition(x => x);\n', 'g?.getCurrentPosition?.(x => x);\n', 'navigator.geolocation["getCurrentPosition"](x => x);\n']) {
    const two = runCheck(baseManifest(), collector + extra);
    assert.equal(two.status, 1, extra);
    assert.match(two.output, /2 getCurrentPosition call sites \(assets\/page\.js\)/);
  }
  const watch = runCheck(baseManifest(), collector + 'navigator.geolocation.watchPosition(x => x);\n');
  assert.equal(watch.status, 1);
  assert.match(watch.output, /watchPosition in assets\/page\.js/);
  // No reader at all is only a warning: the permission would be unused.
  const none = runCheck(baseManifest());
  assert.equal(none.status, 0, none.output);
  assert.match(none.output, /warning: No getCurrentPosition call site/);
});
