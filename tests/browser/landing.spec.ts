import { test, expect } from '@playwright/test';

const layers = ['Bluetooth', 'Wi-Fi', 'Biometrics', 'Safe Zones', 'MFA', 'Limits'];

test('public entry points load the landing without account providers', async ({ page }) => {
  const errors: string[] = [];
  const accountRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (/privy\.io$/.test(url.hostname) || /\/(WalletApp|LiveWalletProvider)\.tsx$/.test(url.pathname)) accountRequests.push(url.pathname);
  });
  for (const route of ['/', '/landing']) {
    await page.goto(route);
    await expect(page.locator('.antara-landing')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/one vault\./i);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/six shields\./i);
    await expect(page.getByRole('link', { name: 'Read the docs', exact: true })).toHaveAttribute('href', '/docs');
    await expect(page.getByRole('link', { name: 'Open wallet', exact: true }).first()).toHaveAttribute('href', '/app');
    await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveCount(2);
    for (const link of await page.getByRole('link', { name: 'Download', exact: true }).all()) await expect(link).toHaveAttribute('href', '/download');
    await expect(page.getByRole('complementary', { name: 'App navigation' })).toHaveCount(0);
  }
  expect(accountRequests).toEqual([]);
  expect(errors).toEqual([]);
  await page.getByRole('link', { name: 'Open wallet', exact: true }).first().click();
  await expect(page).toHaveURL(/\/app$/);
  // The first /app load compiles the wallet chunk on the dev server; allow for a cold start.
  await expect(page.getByRole('heading', { name: 'Wallet', exact: true })).toBeVisible({ timeout: 30_000 });
});

for (const { width, height } of [
  { width: 1440, height: 900 }, { width: 1366, height: 768 },
  { width: 900, height: 640 }, { width: 390, height: 844 },
  { width: 390, height: 640 }, { width: 844, height: 390 },
  { width: 320, height: 568 }, { width: 500, height: 400 },
]) {
  test(`landing controls and layer details remain reachable at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const name of ['Overview', 'Protection', 'Networks']) {
      const tab = page.getByRole('tab', { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      // Normal desktop, laptop and phone sizes keep the landing to one viewport.
      if (height >= 760 || (width >= 1280 && height >= 700) || (width === 844 && height === 390)) expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
    }
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expect(page.getByRole('tabpanel').getByRole('link', { name: 'Download', exact: true })).toBeVisible();
    // Header links (Docs, Download, Open wallet) never sit on top of the chapter tabs.
    expect(await page.evaluate(() => {
      const tabs = document.querySelector('.landing-nav [role=tablist]')!.getBoundingClientRect();
      return [...document.querySelectorAll('.landing-header-links a')].some(link => {
        const box = link.getBoundingClientRect();
        return box.width > 0 && box.left < tabs.right && box.right > tabs.left && box.top < tabs.bottom && box.bottom > tabs.top;
      });
    })).toBe(false);
    for (const name of layers) {
      const button = page.getByRole('button', { name, exact: true });
      await button.click();
      await expect(page.locator('.landing-layer-detail')).toBeVisible();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: 'Close layer details', exact: true }).click();
      await expect(page.locator('.landing-layer-detail')).toHaveCount(0);
      await expect(button).toBeFocused();
    }
    await expect(page.getByRole('link', { name: 'Open wallet', exact: true }).first()).toBeVisible();
    await page.screenshot({ path: `artifacts/antara-landing-${width}x${height}.png`, fullPage: true, animations: 'disabled' });
  });
}

test('landing tabs support keyboard navigation and reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/landing');
  const overview = page.getByRole('tab', { name: 'Overview', exact: true });
  await overview.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Protection', exact: true })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Protection', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Networks', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(overview).toBeFocused();
  await expect(overview).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.antara-landing')).toHaveAttribute('data-motion', 'still');
  const sustainedAnimations = await page.locator('.antara-landing').evaluate(element =>
    element.getAnimations({ subtree: true }).filter(animation => {
      const timing = animation.effect?.getComputedTiming();
      return animation.playState === 'running' && timing && (timing.iterations === Infinity || Number(timing.duration) > 100);
    }).length,
  );
  expect(sustainedAnimations).toBe(0);
});

test('ambient motion preference persists across reloads', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/landing');
  const landing = page.locator('.antara-landing');
  await expect(landing).toHaveAttribute('data-motion', 'running');
  await page.getByRole('button', { name: 'Pause ambient motion', exact: true }).click();
  await expect(landing).toHaveAttribute('data-motion', 'still');
  await expect(page.getByRole('button', { name: 'Enable ambient motion', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(landing).toHaveAttribute('data-motion', 'still');
  await page.getByRole('button', { name: 'Enable ambient motion', exact: true }).click();
  await expect(landing).toHaveAttribute('data-motion', 'running');
  await page.reload();
  await expect(landing).toHaveAttribute('data-motion', 'running');
});

test('each protection node explains its role and current availability, with no vault node', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/landing');
  await expect(page.locator('.landing-layer-button')).toHaveCount(6);
  await expect(page.getByRole('button', { name: /vault/i })).toHaveCount(0);
  for (const name of layers) {
    const button = page.getByRole('button', { name, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    // The selected layer takes over the headline.
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`${name}.`);
    const detail = page.locator('.landing-layer-detail');
    await expect(detail.getByRole('heading')).toBeVisible();
    await expect(detail.locator('p').first()).not.toBeEmpty();
    // Section 14.3 of docs/VAULT_LAYERS.md: every vault layer says it is not live yet. MFA is the vault's own optional authenticator (2026-10-13).
    await expect(page.locator('.landing-layer-status')).toContainText(/not live yet/i);
    // Every layer says who supplies its evidence; device-reported layers say so.
    await expect(detail.locator('.landing-detail-facts')).toContainText(name === 'Safe Zones' || name === 'Bluetooth' ? /Device-reported/ : name === 'Wi-Fi' ? /Server-observed/ : /Cryptographic|Server-enforced/);
    if (name === 'MFA') await expect(page.locator('.landing-layer-status')).toHaveText('Paired-vault layer · optional vault authenticator code · not live yet');
    // Owner decision 2026-10-13: Limits is optional caps the user sets; no default caps or 24-hour windows are claimed.
    if (name === 'Limits') {
      await expect(page.locator('.landing-layer-status')).toHaveText('Paired-vault layer · optional caps you set, enforced by the guardian · not live yet');
      await expect(detail).toContainText('Optional');
      await expect(page.locator('.antara-landing')).not.toContainText(/always on|24-hour|24 hours/i);
    }
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }
  await page.getByRole('tab', { name: 'Protection', exact: true }).click();
  await expect(page.locator('.landing-layer-detail')).toBeVisible();
});

test('all five networks are preserved and unsupported security claims stay absent', async ({ page }) => {
  await page.goto('/landing');
  for (const name of ['Overview', 'Protection', 'Networks']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(page.locator('.antara-landing')).not.toContainText(/geolocation (?:is )?(?:active|enforced)|geofence (?:is )?(?:active|enforced)|free gas on every chain|gas[- ]free|zero gas fees|guaranteed returns|unhackable|audited|quantum[- ]proof|\btvl\b|\d[\d,.]*\s*(?:users|wallets|vaults) protected/i);
  }
  for (const network of ['Solana', 'Ethereum', 'BNB Smart Chain', 'Robinhood Chain', 'Base']) await expect(page.getByRole('tabpanel')).toContainText(network);
  for (const removed of ['Arbitrum', 'Polygon']) await expect(page.getByRole('tabpanel')).not.toContainText(removed);
  await expect(page.getByRole('link', { name: 'Explore trading', exact: true })).toHaveAttribute('href', '/app#swap');
});

test('legacy public fallback uses the current landing', async ({ page }) => {
  await page.goto('/legacy');
  await expect(page.locator('.antara-landing')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open wallet', exact: true }).first()).toHaveAttribute('href', '/app');
  await expect(page.locator('.ark-landing-shell')).toHaveCount(0);
});

test('legacy wallet hashes and native root bypass the public landing', async ({ page }) => {
  for (const [hash, heading] of [['vault', 'Vault'], ['vaults', 'Vault'], ['swap', 'Swap'], ['protection', 'Protection']]) {
    await page.goto(`/#${hash}`);
    await expect(page.locator('.antara-landing')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    if (hash.startsWith('vault')) await expect(page.getByRole('tab', { name: 'Vault', exact: true })).toHaveAttribute('aria-selected', 'true');
  }
  await page.addInitScript(() => Object.defineProperty(globalThis, 'isTauri', { value: true, configurable: true }));
  await page.goto('/');
  await expect(page.locator('.antara-landing')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Wallet', exact: true })).toBeVisible();
});

test('the dotted Earth is live 3D, rotates with keyboard input, and respects motion pause', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/landing');
  const canvas = page.locator('.landing-globe[data-renderer=ready] canvas');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-geometry', 'dotted-earth');
  // Land dots come from the land mask, so a working scene has thousands of them.
  expect(Number(await canvas.getAttribute('data-dots'))).toBeGreaterThan(8000);
  expect(await canvas.evaluate((element: HTMLCanvasElement) => !!element.getContext('webgl2'))).toBe(true);
  await canvas.focus();
  const first = await canvas.screenshot();
  await page.keyboard.press('ArrowRight');
  await expect(canvas).toHaveAttribute('data-pose', '0.00,0.25');
  await expect.poll(async () => (await canvas.screenshot()).equals(first)).toBe(false);
  await page.keyboard.press('Home');
  await expect(canvas).toHaveAttribute('data-pose', '0.00,0.00');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const moving = await canvas.screenshot();
  await expect.poll(async () => (await canvas.screenshot()).equals(moving)).toBe(false);
  await page.getByRole('button', { name: 'Pause ambient motion', exact: true }).click();
  await expect(page.locator('.antara-landing')).toHaveAttribute('data-motion', 'still');
  // Let the final static frame land before comparing.
  await page.waitForTimeout(300);
  const paused = await canvas.screenshot();
  // Screenshot calls wait through animation frames; a paused scene must stay identical.
  expect((await canvas.screenshot()).equals(paused)).toBe(true);
});

test('protection controls stay usable after context loss and without WebGL', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/landing');
  const globe = page.locator('.landing-globe[data-renderer]');
  await expect(globe).toHaveAttribute('data-renderer', 'ready');
  await globe.locator('canvas').dispatchEvent('webglcontextlost');
  await expect(globe).toHaveAttribute('data-renderer', 'fallback');
  await expect(globe.locator('canvas')).toHaveCount(0);
  const still = page.getByRole('img', { name: 'ANTARA globe with six protection layers around one vault', exact: true });
  await expect(still).toBeVisible();
  expect(await still.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.getByRole('button', { name: 'MFA', exact: true }).click();
  await expect(page.locator('.landing-layer-detail')).toBeVisible();
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') return null;
      return original.apply(this, [type, ...args] as Parameters<typeof original>);
    } as typeof original;
  });
  await page.reload();
  await expect(globe).toHaveAttribute('data-renderer', 'fallback');
  await expect(still).toBeVisible();
  await expect(page.locator('.landing-layer-button')).toHaveCount(6);
  await page.getByRole('button', { name: 'Safe Zones', exact: true }).click();
  await expect(page.locator('.landing-layer-status')).toContainText(/not live yet/i);
  await page.getByRole('button', { name: 'Close layer details', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open wallet', exact: true }).first()).toBeVisible();
});


test('clicking a layer node on the globe selects that layer', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/landing');
  const canvas = page.locator('.landing-globe[data-renderer=ready] canvas');
  await expect(canvas).toBeVisible();
  const tags = page.locator('.landing-tag');
  await expect(tags).toHaveCount(6);
  await expect.poll(async () => (await tags.evaluateAll(list => list.filter(tag => (tag as HTMLElement).dataset.visible === 'true').length))).toBeGreaterThan(0);
  const index = await tags.evaluateAll(list => list.findIndex(tag => (tag as HTMLElement).dataset.visible === 'true'));
  const tag = tags.nth(index);
  const position = { x: Number(await tag.getAttribute('data-x')), y: Number(await tag.getAttribute('data-y')) };
  const name = (await tag.locator('.landing-tag-label > span').textContent())?.trim() ?? '';
  await canvas.click({ position });
  await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`${name}.`);
  await expect(page.getByRole('tab', { name: 'Protection', exact: true })).toHaveAttribute('aria-selected', 'true');
});
