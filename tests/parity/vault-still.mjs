// Renders public/antara/planet/vault-still.webp from the live vault planet (docs/UI_ARGUS_PARITY.md 7.4)
// and writes vault-still-provenance.json next to it.
//
//   node tests/parity/vault-still.mjs            (PARITY_STILL_PORT overrides the dev-server port, default 1448)
//
// Headless Chromium with software WebGL renders tests/parity/planet.html?scene=still: AntaraSculpture,
// variant "vault", every station "on", no text, over space-terrain.png at 35% (the same backdrop as
// VaultPlanet). The page is re-encoded to WebP in the browser. The dev server gets fixture-only
// public values (no Privy app id, no API base) and every request off the local origin is aborted.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const PORT = Number(process.env.PARITY_STILL_PORT || 1448);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SCENE = '/tests/parity/planet.html?scene=still';
const VIEWPORT = { width: 1600, height: 900 };
const OUT = path.resolve('public/antara/planet/vault-still.webp');
const PROVENANCE = path.resolve('public/antara/planet/vault-still-provenance.json');
const MAX_BYTES = 250 * 1024;
const SOURCES = [
  'src/solares/landing/AntaraSculpture.tsx',
  'src/solares/verification/VaultPlanet.tsx',
  'src/solares/verification/verification.css',
  'tests/parity/planet.tsx',
  'public/antara/planet/earth-obsidian.png',
  'public/antara/planet/space-terrain.png',
];
const FIXTURE_ENV = {
  VITE_PRIVY_APP_ID: '', VITE_PRIVY_CLIENT_ID: '', VITE_API_BASE: '', VITE_SOLANA_CLUSTER: 'mainnet-beta',
  VITE_SOLANA_RPC_URL: 'https://rpc.parity.invalid', VITE_SOLANA_WS_URL: 'wss://rpc.parity.invalid',
  VITE_ETHEREUM_RPC_URL: 'https://ethereum.rpc.parity.invalid', VITE_BSC_RPC_URL: 'https://bsc.rpc.parity.invalid',
  VITE_ROBINHOOD_RPC_URL: 'https://robinhood.rpc.parity.invalid', VITE_BASE_RPC_URL: 'https://base.rpc.parity.invalid',
  VITE_ANTARA_GUARDIAN_SOLANA: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB',
  VITE_COMMUNITY_URL: '', VITE_DESKTOP_DOWNLOAD_URL: '', VITE_UPDATE_MANIFEST_URL: '',
};
const sha256 = data => createHash('sha256').update(data).digest('hex');
const git = args => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return null; } };

async function waitForServer(deadline) {
  while (Date.now() < deadline) {
    try { if ((await fetch(ORIGIN)).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Dev server did not start on ${ORIGIN}.`);
}

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  env: { ...process.env, ...FIXTURE_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', chunk => process.stderr.write(chunk));
let browser;
try {
  await waitForServer(Date.now() + 60_000);
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.routeWebSocket(() => true, () => undefined);
  await context.route('**/*', route => (new URL(route.request().url()).origin === ORIGIN ? route.continue() : route.abort('blockedbyclient')));
  const page = await context.newPage();
  await page.goto(`${ORIGIN}${SCENE}`);
  await page.waitForFunction(() => document.documentElement.dataset.parityReady === '1', null, { timeout: 60_000 });
  await page.waitForSelector('.landing-sculpture[data-renderer="ready"] canvas[data-variant="vault"]', { timeout: 60_000 });
  await page.waitForLoadState('networkidle');
  // The Earth texture loads after the first frame; give the on-demand renderer time to draw it.
  await page.waitForTimeout(2_500);
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  const png = await page.locator('.planet-still').screenshot({ animations: 'disabled' });
  let quality = 0.86, webp;
  for (;;) {
    const dataUrl = await page.evaluate(async ({ base64, quality }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return canvas.toDataURL('image/webp', quality);
    }, { base64: png.toString('base64'), quality });
    if (!dataUrl.startsWith('data:image/webp')) throw new Error('This Chromium cannot encode WebP.');
    webp = Buffer.from(dataUrl.split(',')[1], 'base64');
    if (webp.length <= MAX_BYTES || quality <= 0.5) break;
    quality = Math.round((quality - 0.06) * 100) / 100;
  }
  fs.writeFileSync(OUT, webp);
  const status = git(['status', '--porcelain', '--', ...SOURCES]);
  const provenance = {
    created: new Date().toISOString().slice(0, 10),
    file: 'vault-still.webp',
    sha256: sha256(webp),
    bytes: webp.length,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    purpose: 'Static fallback of the vault verification planet when WebGL is unavailable or its context is lost (docs/UI_ARGUS_PARITY.md 7.1, 7.4). No text; the station list carries every state.',
    tool: `Playwright headless Chromium ${browser.version()} (software WebGL: ${renderer}), canvas WebP encoder at quality ${quality}`,
    command: 'node tests/parity/vault-still.mjs',
    scene: SCENE,
    parameters: {
      component: 'AntaraSculpture variant="vault" through VaultPlanet labels="none"',
      stations: 'all "on" (landing order: Bluetooth, Wi-Fi, Biometrics, Safe Zones, MFA, Limits)',
      animated: false,
      reducedMotion: 'reduce',
      backdrop: 'public/antara/planet/space-terrain.png at 35% opacity over #030303',
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      text: 'none',
    },
    commit: git(['rev-parse', 'HEAD']),
    workingTree: status ? 'uncommitted changes in the source files below at capture time' : 'clean for the source files below',
    sources: Object.fromEntries(SOURCES.map(file => [file, sha256(fs.readFileSync(file))])),
  };
  fs.writeFileSync(PROVENANCE, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)} (${webp.length} bytes, quality ${quality}) and ${path.relative(process.cwd(), PROVENANCE)}`);
} finally {
  await browser?.close();
  server.kill();
}
