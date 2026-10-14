import { test, expect } from '@playwright/test';

test.use({ hasTouch: true });
for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }]) {
  test(`mobile wallet shell and navigation fit ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/app');
    const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
    await expect(nav).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('complementary', { name: 'App navigation' })).toBeHidden();
    for (const name of ['Wallet', 'Vault', 'Swap', 'Activity', 'Protection']) {
      await nav.getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
      await expect(nav.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
      const button = await nav.getByRole('button', { name, exact: true }).boundingBox();
      expect(button!.height).toBeGreaterThanOrEqual(44);
      if (name === 'Swap') await expect(page.getByLabel('USDC amount to spend')).toBeVisible();
      if (name === 'Activity') await expect(page.getByRole('heading', { name: 'Your activity, in one place' })).toBeVisible();
      await page.screenshot({ path: `artifacts/mobile-${name.toLowerCase()}-${size.width}x${size.height}.png`, fullPage: true, animations: 'disabled' });
    }
    await nav.getByRole('button', { name: 'Wallet', exact: true }).click();
    await page.getByRole('tab', { name: 'Vault', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Vault balance', exact: true })).toBeVisible();
    await expect(nav).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/mobile-vault-${size.width}x${size.height}.png`, fullPage: true, animations: 'disabled' });
    expect(errors).toEqual([]);
  });
}

test('receive and send open as accessible mobile sheets with focus returning to the action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app');
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  let sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.desktop-main')).toHaveAttribute('inert', '');
  await expect.poll(async () => { const bounds = await sheet.boundingBox(); return Math.round(bounds!.y + bounds!.height); }).toBe(844);
  await page.screenshot({ path: 'artifacts/mobile-receive-sheet.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Receive', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  sheet = page.getByRole('dialog');
  await expect(sheet).toBeInViewport({ ratio: 1 });
  await expect(sheet.getByRole('heading', { name: 'Send assets' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeFocused();
});

test('mobile landing renders the 3D scene and chapter tabs work without moving the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/landing');
  await expect(page.locator('.landing-globe[data-renderer=ready] canvas')).toBeVisible();
  await page.getByRole('tab', { name: 'Protection', exact: true }).tap();
  await expect(page.getByRole('tab', { name: 'Protection', exact: true })).toHaveAttribute('aria-selected', 'true');
  // Protection opens the first layer, which takes over the headline.
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/biometrics\./i);
  await expect(page.locator('.landing-layer-button')).toHaveCount(6);
  for (const button of await page.locator('.landing-layer-button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
});

test('home screen metadata opens directly into the wallet', async ({ request }) => {
  const response = await request.get('/manifest.webmanifest');
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest.start_url).toBe('/app');
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true);
});

test('token search stays usable when the available mobile height shrinks', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/solares/relay/currencies?*', route => route.fulfill({ json: { tokens: [] } }));
  await page.goto('/app#swap');
  await page.getByRole('button', { name: 'Select token, SOL on Solana' }).click();
  await page.getByLabel('Search tokens').fill('Test token');
  await page.setViewportSize({ width: 390, height: 480 });
  await expect(page.getByRole('dialog', { name: 'Select a token' })).toBeInViewport({ ratio: 1 });
  await expect(page.getByLabel('Search tokens')).toBeInViewport({ ratio: 1 });
  await expect(page.getByLabel('Search tokens')).toHaveValue('Test token');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Select token, SOL on Solana' })).toBeFocused();
});
