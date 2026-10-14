import { test, expect, chromium, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CORS_ORIGINS, EXTENSION_DEV_HOST_PERMISSIONS, EXTENSION_PERMISSIONS, FRAME_ORIGINS, MINIMUM_CHROME_VERSION, PASSKEY_RP_ID,
} from '../../extension/policy.mjs';

// Headless checks for the unpacked MV3 test builds (see playwright.extension.config.ts):
// project "unconfigured" has no Privy app ID, project "privy" mounts PrivyProvider
// with a well-formed placeholder ID. `npm run test:extension` builds both and runs
// this file; `npm run test:extension:run` reuses existing builds.

const root = process.cwd();
const PLACEHOLDER_PRIVY_APP_ID = 'cm0000000000000000000test';
// Test builds are development builds: the ANTARA API defaults to the local dev server.
const DEV_API_ORIGINS = ['http://localhost:8787', 'http://127.0.0.1:8787'];
const CONNECT_ORIGINS = new Set([...CORS_ORIGINS, ...DEV_API_ORIGINS]);

// The ID documented for the owner (Privy allowed origin, server CORS) must be the one Chrome derives.
const documentedId = /Extension ID\s*\|\s*`([a-p]{32})`/.exec(readFileSync(resolve(root, 'extension/EXTENSION_ID.md'), 'utf8'))?.[1];
const keyFileId = JSON.parse(readFileSync(resolve(root, 'extension/extension-key.json'), 'utf8')).id as string;

let context: BrowserContext;
let profile: string;
let extensionId: string;
let privy = false;
let shots: string;

test.beforeAll(async ({}, testInfo) => {
  const metadata = testInfo.project.metadata as { dir: string; privy: boolean };
  const dist = resolve(root, metadata.dir);
  // A missing build is a failure, not a skip: a green run must mean the extension was tested.
  if (!existsSync(join(dist, 'manifest.json'))) throw new Error(`${metadata.dir}/manifest.json is missing. Run npm run test:extension to build the test variants.`);
  privy = metadata.privy;
  // Kept outside the Playwright outputDir, which is cleaned per run.
  shots = resolve(root, 'test-results/extension-screens', testInfo.project.name);
  mkdirSync(shots, { recursive: true });
  profile = mkdtempSync(join(tmpdir(), 'antara-extension-'));
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

// Errors that are expected when the ANTARA API (http://localhost:8787 in test builds)
// or a public RPC is not reachable from the test machine. Everything else is a failure.
const EXPECTED_NETWORK_ERROR = /Failed to load resource|net::ERR_|Failed to fetch|NetworkError|ERR_CONNECTION_REFUSED|API (is )?unavailable|localhost:8787/i;
// Privy's rejection of the placeholder app ID (privy project only).
const EXPECTED_PLACEHOLDER_ERROR = /Invalid Privy app ID|missing_or_invalid_privy_app_id/i;
const CSP_OR_CORS = /Content Security Policy|Refused to (load|execute|frame|connect|apply|evaluate)|blocked by CORS policy/i;

function watch(page: Page) {
  const problems: string[] = [];
  const remote: string[] = [];
  page.on('console', message => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const text = message.text();
    // CSP and CORS violations always fail, even when they mention an expected host.
    if (CSP_OR_CORS.test(text)) { problems.push(`csp/cors: ${text}`); return; }
    if (message.type() !== 'error') return;
    if (EXPECTED_NETWORK_ERROR.test(text)) return;
    if (privy && EXPECTED_PLACEHOLDER_ERROR.test(text)) return;
    problems.push(`console: ${text}`);
  });
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol === 'chrome-extension:') {
      if (url.host !== extensionId) problems.push(`foreign extension request: ${request.url()}`);
      return;
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    remote.push(`${request.resourceType()} ${url.origin}${url.pathname}`);
    // No remote code: every script must come from the extension package.
    if (request.resourceType() === 'script') problems.push(`remote script: ${request.url()}`);
    // Host permissions cover only ANTARA's own API: every other remote origin must be
    // on the committed CORS list (extension/policy.mjs) or be the dev API.
    else if (!CONNECT_ORIGINS.has(url.origin)) problems.push(`non-allowlisted origin: ${request.resourceType()} ${request.url()}`);
  });
  page.on('requestfailed', request => {
    if (request.url().startsWith(`chrome-extension://${extensionId}/`)) problems.push(`missing bundled file: ${request.url()}`);
  });
  return { problems, remote };
}

function expectOnlyAllowedFrames(page: Page) {
  for (const frame of page.frames()) {
    const url = frame.url();
    if (!url || url === 'about:blank' || url.startsWith(`chrome-extension://${extensionId}/`)) continue;
    expect(FRAME_ORIGINS, `unexpected frame ${url}`).toContain(new URL(url).origin);
  }
}

// Disconnected wallet: honest empty state, no figures, sign-in offered.
async function expectDisconnectedWallet(page: Page) {
  await expect(page.getByRole('button', { name: /sign in|connect|sign-in setup required|open setup/i }).first()).toBeVisible({ timeout: 20_000 });
  // The shared wallet shell mounts, not the public landing page or the failure screen.
  await expect(page.locator('.antara-landing, [data-landing]')).toHaveCount(0);
  await expect(page.getByText('Wallet failed to start')).toHaveCount(0);
  const balance = page.locator('.desktop-balance-number').first();
  await expect(balance).toBeVisible();
  // Signed out: a muted "0.00" stand-in, never "—".
  await expect(balance).toHaveText('0.00');
  await expect(balance.locator('[data-placeholder]')).toHaveText('0.00');
  // No fabricated amounts anywhere on the page. Muted zero stand-ins ([data-placeholder]) are the only
  // figures allowed while signed out, and they must be zeros.
  for (const value of await page.locator('[data-placeholder]').allTextContents()) expect(value).toMatch(/^0(?:\.00)?(?: [A-Za-z() -]+)?$/);
  const text = await page.locator('body').evaluate((body: HTMLElement) => {
    const stand = [...body.querySelectorAll<HTMLElement>('[data-placeholder]')];
    const shown = stand.map(node => node.style.display);
    stand.forEach(node => { node.style.display = 'none'; });
    try { return body.innerText; } finally { stand.forEach((node, index) => { node.style.display = shown[index]; }); }
  });
  expect(text).not.toMatch(/\$\s?\d|\b\d[\d,]*\.\d+\s?(USD|USDC|USDT|SOL|ETH|BNB)\b/);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

// The side panel bar plus the wallet shell fill the panel exactly; the page itself never scrolls.
async function expectNoPageScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function screenshot(page: Page, name: string, testInfo: TestInfo) {
  await page.screenshot({ path: join(shots, name) });
  testInfo.annotations.push({ type: 'screenshot', description: join(shots, name) });
}

test('loads with the documented stable extension ID and a listener-free, storage-free service worker', async () => {
  expect(documentedId, 'extension/EXTENSION_ID.md must state the ID').toBeTruthy();
  expect(keyFileId).toBe(documentedId);
  expect(extensionId).toBe(documentedId);
  const worker = context.serviceWorkers().find(w => w.url().includes(extensionId))!;
  expect(new URL(worker.url()).pathname).toBe('/background.js');
  // The worker is a side-panel router only: it accepts no messages or connections
  // (so nothing can ask it for wallet state) and has no chrome.storage access.
  const state = await worker.evaluate(() => {
    type Event = { hasListeners: () => boolean };
    const runtime = (globalThis as unknown as { chrome: { runtime: Record<string, Event> } }).chrome.runtime;
    return {
      onMessage: runtime.onMessage.hasListeners(),
      onMessageExternal: runtime.onMessageExternal.hasListeners(),
      onConnect: runtime.onConnect.hasListeners(),
      onConnectExternal: runtime.onConnectExternal.hasListeners(),
      storage: typeof (globalThis as unknown as { chrome: { storage?: unknown } }).chrome.storage,
    };
  });
  expect(state).toEqual({ onMessage: false, onMessageExternal: false, onConnect: false, onConnectExternal: false, storage: 'undefined' });
});

test('toolbar icon opens the side panel directly: no action popup, panel behavior set', async () => {
  const worker = context.serviceWorkers().find(w => w.url().includes(extensionId))!;
  const result = await worker.evaluate(async () => {
    type PanelApi = {
      runtime: { getManifest: () => Record<string, unknown> };
      sidePanel: { getPanelBehavior: () => Promise<{ openPanelOnActionClick?: boolean }> };
    };
    const api = (globalThis as unknown as { chrome: PanelApi }).chrome;
    // setPanelBehavior runs at worker start-up; poll briefly instead of racing it.
    let behavior = await api.sidePanel.getPanelBehavior();
    for (let i = 0; i < 20 && !behavior.openPanelOnActionClick; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      behavior = await api.sidePanel.getPanelBehavior();
    }
    return { manifest: api.runtime.getManifest(), behavior };
  });
  const manifest = result.manifest as { action?: Record<string, unknown>; side_panel?: { default_path?: string }; host_permissions?: string[] };
  expect(manifest.action).toBeTruthy();
  expect(manifest.action).not.toHaveProperty('default_popup');
  expect(manifest.side_panel?.default_path).toBe('sidepanel.html');
  // Test builds are development builds: production API plus the local API server only.
  expect(manifest.host_permissions).toEqual([...EXTENSION_DEV_HOST_PERMISSIONS]);
  expect(result.behavior.openPanelOnActionClick).toBe(true);
});

for (const [surface, file, attr] of [['side panel', 'sidepanel.html', 'sidepanel'], ['wallet tab', 'wallet.html', 'tab']] as const) {
  test(`${surface} renders the disconnected ANTARA wallet at 400x800`, async ({}, testInfo) => {
    const page = await context.newPage();
    const { problems, remote } = watch(page);
    const privyConfig = privy ? page.waitForResponse(response => response.url().startsWith(`https://auth.privy.io/api/v1/apps/${PLACEHOLDER_PRIVY_APP_ID}`), { timeout: 20_000 }) : null;
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/${file}`);
    await expect(page.locator('html')).toHaveAttribute('data-surface', attr);
    await expectDisconnectedWallet(page);
    if (privyConfig) {
      // PrivyProvider mounted and reached Privy through CORS alone (no host permission);
      // a CORS failure would surface as a console error above.
      const response = await privyConfig;
      expect(response.status()).toBe(400);
    }
    // Primary navigation (mobile layout at panel width).
    const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Wallet' })).toBeVisible();
    // Only the side panel offers "Open in full tab"; the tab is already full size.
    await expect(page.getByRole('button', { name: 'Open in full tab' })).toHaveCount(attr === 'sidepanel' ? 1 : 0);
    await expectNoHorizontalOverflow(page);
    if (attr === 'sidepanel') await expectNoPageScroll(page);
    await page.waitForTimeout(750);
    expectOnlyAllowedFrames(page);
    await screenshot(page, `${attr}-400x800.png`, testInfo);
    expect(problems, `remote requests seen: ${remote.join(', ') || 'none'}`).toEqual([]);
    await page.close();
  });
}

for (const width of [360, 420]) {
  test(`side panel fits ${width}px without overflow`, async () => {
    const page = await context.newPage();
    const { problems } = watch(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expectDisconnectedWallet(page);
    await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open in full tab' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectNoPageScroll(page);
    await page.waitForTimeout(500);
    expect(problems).toEqual([]);
    await page.close();
  });
}

test('wallet tab at desktop width shows the desktop navigation', async ({}, testInfo) => {
  const page = await context.newPage();
  const { problems } = watch(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`chrome-extension://${extensionId}/wallet.html#portfolio`);
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'tab');
  await expectDisconnectedWallet(page);
  await expect(page.getByRole('complementary', { name: 'App navigation' }).locator('nav.shell-nav')).toBeVisible();
  await page.waitForTimeout(500);
  expectOnlyAllowedFrames(page);
  await screenshot(page, 'wallet-tab-1280.png', testInfo);
  expect(problems).toEqual([]);
  await page.close();
});

test('side panel "Open in full tab" opens the same wallet in a tab', async ({}, testInfo) => {
  const page = await context.newPage();
  const { problems } = watch(page);
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expectDisconnectedWallet(page);
  const button = page.getByRole('button', { name: 'Open in full tab' });
  await expect(button).toBeEnabled();
  await screenshot(page, 'sidepanel-bar.png', testInfo);
  const tab = context.waitForEvent('page');
  await button.click();
  const opened = await tab;
  await opened.waitForLoadState();
  expect(opened.url()).toBe(`chrome-extension://${extensionId}/wallet.html`);
  await expect(opened.locator('html')).toHaveAttribute('data-surface', 'tab');
  expect(problems).toEqual([]);
  await opened.close();
  if (!page.isClosed()) await page.close();
});

test('side panel "Open in full tab" carries the wallet route (the vault-layer hand-off)', async () => {
  const page = await context.newPage();
  const { problems } = watch(page);
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html#vault`);
  await expectDisconnectedWallet(page);
  const tab = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open in full tab' }).click();
  const opened = await tab;
  await opened.waitForLoadState();
  expect(opened.url()).toBe(`chrome-extension://${extensionId}/wallet.html#vault`);
  expect(problems).toEqual([]);
  await opened.close();
  if (!page.isClosed()) await page.close();
});

// ---- Vault protection layers (docs/VAULT_LAYERS.md §2, §13.4) ----------------------

test('vault layers: manifest asks for exactly sidePanel + geolocation and Chrome 122 or later', async () => {
  const worker = context.serviceWorkers().find(w => w.url().includes(extensionId))!;
  const { manifest, userAgent } = await worker.evaluate(() => ({
    manifest: (globalThis as unknown as { chrome: { runtime: { getManifest: () => Record<string, unknown> } } }).chrome.runtime.getManifest(),
    userAgent: navigator.userAgent,
  }));
  expect(manifest.permissions).toEqual(['sidePanel', 'geolocation']);
  expect(manifest.permissions).toEqual([...EXTENSION_PERMISSIONS]);
  expect(manifest.minimum_chrome_version).toBe('122');
  expect(manifest.minimum_chrome_version).toBe(MINIMUM_CHROME_VERSION);
  expect(manifest).not.toHaveProperty('optional_permissions');
  expect(manifest).not.toHaveProperty('optional_host_permissions');
  // The passkey RP ID is claimable only through this host permission.
  expect(manifest.host_permissions).toContain(`https://${PASSKEY_RP_ID}/*`);
  // The test browser must itself meet the floor, or the checks below prove nothing.
  const major = Number(/Chrome\/(\d+)\./.exec(userAgent)?.[1]);
  expect(major).toBeGreaterThanOrEqual(Number(MINIMUM_CHROME_VERSION));
});

// Headless Playwright cannot open Chrome's real side-panel host, so "sidepanel.html" below is that document
// loaded in an ordinary tab. These tests prove the document's behaviour, not the side panel itself; ceremonies,
// location and the Bluetooth chooser in the real side panel stay on the manual list (docs/VAULT_LAYERS.md §15).
test('vault layers: the sidepanel.html document (in a tab) hands ceremonies to the full tab; the wallet tab runs them inline', async () => {
  for (const [file, attr, ceremony] of [['sidepanel.html', 'sidepanel', 'tab'], ['wallet.html', 'tab', 'inline']] as const) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/${file}`);
    await expect(page.locator('html')).toHaveAttribute('data-surface', attr);
    // Set by mountWallet from the bundled layerCapabilities().ceremonyInline.
    await expect(page.locator('html')).toHaveAttribute('data-layer-ceremony', ceremony);
    await page.close();
  }
});

type CeremonyAttempt = { ok: true; clientData: { type: string; challenge: string; origin: string; crossOrigin?: boolean }; flags?: number; rpIdHashMatches?: boolean }
  | { ok: false; name: string; message: string };

test('vault layers: wallet tab passkeys use the antara.tech RP ID (Chrome 122 host-permission rule); other RP IDs are refused', async () => {
  const page = await context.newPage();
  const { problems } = watch(page);
  await page.goto(`chrome-extension://${extensionId}/wallet.html`);
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'tab');
  await page.bringToFront();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  try {
    const result = await page.evaluate(async (rpId: string) => {
      const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const clientDataOf = (response: AuthenticatorResponse) => JSON.parse(new TextDecoder().decode(response.clientDataJSON));
      const failure = (error: unknown) => ({ ok: false as const, name: (error as Error)?.name ?? 'Error', message: String((error as Error)?.message ?? error) });
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const user = { id: crypto.getRandomValues(new Uint8Array(32)), name: 'ANTARA vault test', displayName: 'ANTARA vault test' };
      const create = async (id: string) => {
        try {
          const credential = await navigator.credentials.create({
            publicKey: {
              rp: { id, name: 'ANTARA' }, user, challenge,
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
              authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
              attestation: 'none', timeout: 30_000,
            },
          }) as PublicKeyCredential;
          return { ok: true as const, clientData: clientDataOf(credential.response), rawId: credential.rawId };
        } catch (error) { return failure(error); }
      };
      const get = async (id: string, rawId: ArrayBuffer) => {
        try {
          const credential = await navigator.credentials.get({
            publicKey: { rpId: id, challenge, allowCredentials: [{ type: 'public-key', id: rawId }], userVerification: 'required', timeout: 30_000 },
          }) as PublicKeyCredential;
          const response = credential.response as AuthenticatorAssertionResponse;
          const data = new Uint8Array(response.authenticatorData);
          const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)));
          return { ok: true as const, clientData: clientDataOf(response), flags: data[32], rpIdHashMatches: expected.every((byte, index) => data[index] === byte) };
        } catch (error) { return failure(error); }
      };
      const strip = (attempt: Awaited<ReturnType<typeof create>>) => (attempt.ok ? { ok: true as const, clientData: attempt.clientData } : attempt);
      const created = await create(rpId);
      const foreignCreate = await create('example.com');
      if (!created.ok) return { challenge: toBase64Url(challenge), created: strip(created), foreignCreate: strip(foreignCreate), asserted: null, foreignGet: null };
      return {
        challenge: toBase64Url(challenge),
        created: strip(created),
        foreignCreate: strip(foreignCreate),
        asserted: await get(rpId, created.rawId),
        foreignGet: await get('example.com', created.rawId),
      };
    }, PASSKEY_RP_ID) as { challenge: string; created: CeremonyAttempt; foreignCreate: CeremonyAttempt; asserted: CeremonyAttempt | null; foreignGet: CeremonyAttempt | null };

    const origin = `chrome-extension://${extensionId}`;
    // Registration for antara.tech succeeds; the client data names the extension origin.
    expect(result.created).toMatchObject({ ok: true, clientData: { type: 'webauthn.create', challenge: result.challenge, origin } });
    // A site without host permission cannot be claimed.
    expect(result.foreignCreate).toMatchObject({ ok: false, name: 'SecurityError' });
    // The assertion the guardian would verify: same RP ID hash, user present and verified.
    expect(result.asserted).toMatchObject({ ok: true, clientData: { type: 'webauthn.get', challenge: result.challenge, origin }, rpIdHashMatches: true });
    expect((result.asserted as { flags: number }).flags & 0x05).toBe(0x05);
    expect(result.foreignGet).toMatchObject({ ok: false, name: 'SecurityError' });
  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
  expect(problems).toEqual([]);
  await page.close();
});

type PositionAttempt = { ok: true; lat: number; lng: number; accuracy: number; timestamp: number } | { ok: false; code: number; message: string };

/**
 * One getCurrentPosition() with the collector's options (VAULT_LAYERS.md §12) under a
 * CDP location override. No context.grantPermissions() anywhere in this file, and
 * Playwright's headless Chromium answers any permission prompt with a denial, so a
 * position here was allowed without a prompt.
 */
async function readPosition(page: Page): Promise<PositionAttempt> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setGeolocationOverride', { latitude: 48.8566, longitude: 2.3522, accuracy: 35 });
  try {
    return await page.evaluate(() => new Promise<PositionAttempt>(resolve => navigator.geolocation.getCurrentPosition(
      p => resolve({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, timestamp: p.timestamp }),
      error => resolve({ ok: false, code: error.code, message: error.message }),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
    )));
  } finally {
    await cdp.send('Emulation.clearGeolocationOverride').catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
}

for (const [file, attr] of [['wallet.html', 'tab'], ['sidepanel.html', 'sidepanel']] as const) {
  test(`vault layers: ${attr === 'sidepanel' ? 'the sidepanel.html document (in a tab)' : 'the wallet tab'} reads navigator.geolocation with no prompt (manifest permission)`, async () => {
    const page = await context.newPage();
    const { problems } = watch(page);
    await page.goto(`chrome-extension://${extensionId}/${file}`);
    await expect(page.locator('html')).toHaveAttribute('data-surface', attr);
    // Chrome counts the manifest permission as granted. (navigator.permissions.query
    // still answers "prompt" in extension pages, so collectors must not gate on it.)
    const granted = await page.evaluate(() => (globalThis as unknown as {
      chrome: { permissions: { contains: (p: { permissions: string[] }) => Promise<boolean> } };
    }).chrome.permissions.contains({ permissions: ['geolocation'] }));
    expect(granted).toBe(true);
    const position = await readPosition(page);
    expect(position).toMatchObject({ ok: true, lat: 48.8566, lng: 2.3522, accuracy: 35 });
    expect(position.ok && Number.isFinite(position.timestamp) && position.timestamp > 0).toBe(true);
    expect(problems).toEqual([]);
    await page.close();
  });
}

test('vault layers: control: a web page in the same headless browser is denied location (so the extension result is the manifest permission)', async () => {
  const origin = 'https://geolocation-control.antara.test';
  // Served by Playwright, never resolved: a secure context that is not the extension.
  await context.route(`${origin}/**`, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>control</title>' }));
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/`);
    expect(await page.evaluate(() => isSecureContext)).toBe(true);
    expect(await readPosition(page)).toMatchObject({ ok: false, code: 1 });
  } finally {
    await page.close();
    await context.unroute(`${origin}/**`);
  }
});

test('vault layers: Web Bluetooth requestDevice exists in the wallet tab (the chooser itself is a manual check)', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/wallet.html`);
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'tab');
  const api = await page.evaluate(() => ({
    secure: isSecureContext,
    requestDevice: typeof (navigator as Navigator & { bluetooth?: { requestDevice?: unknown } }).bluetooth?.requestDevice,
  }));
  expect(api).toEqual({ secure: true, requestDevice: 'function' });
  await page.close();
});
