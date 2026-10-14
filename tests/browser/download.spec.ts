import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const MANIFEST = '**/downloads/manifest.json';
const sha = (char: string) => char.repeat(64);
const desktop = { id: 'desktop-windows', name: 'ANTARA for Windows (64-bit installer)', file: '/downloads/ANTARA-Setup-1.0.0-x64.exe', size: 12_939_264, sha256: sha('d') };
const extension = { id: 'chrome-extension', name: 'ANTARA Chrome extension (zip, load unpacked)', file: '/downloads/ANTARA-Chrome-Extension-1.0.0.zip', size: 17_749_333, sha256: sha('e') };

async function serveManifest(page: Page, body: unknown, status = 200) {
  await page.route(MANIFEST, route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
}

test('the download page loads without account providers and offers both installs from the list', async ({ page }) => {
  const errors: string[] = [];
  const accountRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (/privy\.io$/.test(url.hostname) || /\/(WalletApp|LiveWalletProvider)\.tsx$/.test(url.pathname)) accountRequests.push(url.pathname);
  });
  await serveManifest(page, { version: '1.0.0', files: [desktop, extension] });
  await page.goto('/download');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/download antara/i);
  await expect(page).toHaveTitle('Download · ANTARA');

  const windows = page.getByRole('region', { name: 'Desktop app' });
  const installer = windows.getByRole('link', { name: 'Download for Windows' });
  await expect(installer).toHaveAttribute('href', '/downloads/ANTARA-Setup-1.0.0-x64.exe');
  await expect(installer).toHaveAttribute('download', 'ANTARA-Setup-1.0.0-x64.exe');
  await expect(windows).toContainText('12.3 MB');
  await expect(windows).toContainText(sha('d'));
  await expect(windows).toContainText('Windows protected your PC');
  await expect(windows).toContainText('More info');
  await expect(windows).toContainText('Run anyway');
  await expect(windows).toContainText('not code-signed yet');
  await expect(windows).toContainText('WebView2');

  const chrome = page.getByRole('region', { name: 'Chrome extension' });
  const zip = chrome.getByRole('link', { name: 'Download extension (.zip)' });
  await expect(zip).toHaveAttribute('href', '/downloads/ANTARA-Chrome-Extension-1.0.0.zip');
  await expect(chrome).toContainText('16.9 MB');
  await expect(chrome).toContainText(sha('e'));
  for (const step of ['chrome://extensions', 'Developer mode', 'Load unpacked', 'side panel', 'Chrome Web Store listing coming soon', 'ckfkljfbjkmkjkkjkpbnmoehfipdcoin']) await expect(chrome).toContainText(step);

  await expect(page.getByRole('region', { name: 'Use in your browser' }).getByRole('link', { name: 'Open web wallet' })).toHaveAttribute('href', '/app');
  // No fake claims: nothing here says the build is signed, audited or listed.
  await expect(page.locator('.adl')).not.toContainText(/\bis (?:code-)?signed\b|audited|available on the chrome web store|unhackable/i);
  expect(accountRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('the list decides availability: unpublished, incomplete or unreachable files show no download link', async ({ page }) => {
  await serveManifest(page, { version: '1.0.0', files: [{ id: 'desktop-windows', name: desktop.name, file: desktop.file, available: false }, extension] });
  await page.goto('/download');
  const windows = page.getByRole('region', { name: 'Desktop app' });
  await expect(windows.getByRole('button', { name: 'Coming soon' })).toBeDisabled();
  await expect(windows.getByRole('link', { name: /download/i })).toHaveCount(0);
  await expect(windows).toContainText('not published yet');
  await expect(page.getByRole('region', { name: 'Chrome extension' }).getByRole('link', { name: 'Download extension (.zip)' })).toBeVisible();

  await page.unroute(MANIFEST);
  await serveManifest(page, { version: '1.0.0', files: [{ ...desktop, sha256: 'not-a-hash' }, { ...extension, file: 'https://example.com/antara.zip' }] });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Coming soon' })).toHaveCount(2);
  await expect(page.locator('a[href*="downloads/"], a[href*="example.com"]')).toHaveCount(0);

  await page.unroute(MANIFEST);
  await serveManifest(page, { error: 'missing' }, 404);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('could not be loaded');
  await expect(page.getByRole('button', { name: 'Unavailable' })).toHaveCount(2);
  await page.unroute(MANIFEST);
  await serveManifest(page, { version: '1.0.0', files: [desktop, extension] });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('link', { name: 'Download for Windows' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the published list matches the files the site serves, and /downloads is an alias', async ({ page, request }) => {
  const manifest = JSON.parse(readFileSync('public/downloads/manifest.json', 'utf8')) as { files: Array<{ id: string; file: string; size?: number; sha256?: string; available?: boolean }> };
  await page.goto('/downloads');
  await expect(page).toHaveURL(/\/download$/);
  for (const entry of manifest.files) {
    const region = page.getByRole('region', { name: entry.id === 'desktop-windows' ? 'Desktop app' : 'Chrome extension' });
    if (entry.available === false) {
      await expect(region.getByRole('button', { name: 'Coming soon' })).toBeDisabled();
      continue;
    }
    await expect(region.locator(`a[href="${entry.file}"]`)).toBeVisible();
    await expect(region).toContainText(entry.sha256!);
    const response = await request.get(entry.file);
    expect(response.status()).toBe(200);
    const body = await response.body();
    expect(body.length).toBe(entry.size);
    expect(createHash('sha256').update(body).digest('hex')).toBe(entry.sha256);
  }
  const zip = manifest.files.find(entry => entry.id === 'chrome-extension');
  expect(zip?.available).not.toBe(false);
});

test('the download page fits phones without horizontal scrolling', async ({ page }) => {
  await serveManifest(page, { version: '1.0.0', files: [desktop, extension] });
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/download');
    await expect(page.getByRole('link', { name: 'Download for Windows' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(await page.locator('.adl').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `artifacts/antara-download-${viewport.width}x${viewport.height}.png`, animations: 'disabled' });
  }
});

test('the landing links to the download page from the header and the overview', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.landing-header').getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('href', '/download');
  const cta = page.getByRole('tabpanel').getByRole('link', { name: 'Download', exact: true });
  await expect(cta).toHaveAttribute('href', '/download');
  await cta.click();
  await expect(page).toHaveURL(/\/download$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/download antara/i);
  await page.goBack();
  await expect(page.locator('.antara-landing')).toBeVisible();
});
