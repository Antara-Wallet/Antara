import { test, expect, type Page } from '@playwright/test';
import {
  FIXTURE_MULTISIG, FIXTURE_RECIPIENT, FIXTURE_WEBAUTHN_CREATE, FIXTURE_WEBAUTHN_GET, LABELS_THAT_LOOK_UNMASKED, emptyLayersFixture, enrollChallengeFixture, layersFixture,
  recoveryPendingFixture, releaseChallengeFixture,
} from '../../src/solares/layers/testFixtures';

// The public /relay/config shape the server returns (docs/RELAY.md endpoint table). Owner decision 2026-10-13: no swap cap,
// so the per-swap bound is the 100,000-unit protocol sanity ceiling and there is no daily value.
const RELAY_CONFIG = { configured: true, mode: 'verified-funding-origin', maxTradeUnits: '100000', maxDailyUnits: null, maxFundingUnits: '100000', fillWindowDays: 7, refundGuaranteed: false, swapLimitsError: null };

// The public GET /api/solares/wallet/prices shape (server/src/solares/prices.ts) with the prices Relay returned
// on 2026-10-14 (server/src/solares/fixtures/relay-prices). Owner decision 2026-10-13: the balance on top is the
// wallet's total in US dollars.
const PRICES = {
  prices: {
    solana: { native: { usd: 107.831068, symbol: 'SOL' }, funding: { usd: 0.999898, symbol: 'USDC' } },
    ethereum: { native: { usd: 2511.149244, symbol: 'ETH' }, funding: { usd: 0.999859, symbol: 'USDC' } },
    bsc: { native: { usd: 744.462048, symbol: 'BNB' }, funding: { usd: 0.999859, symbol: 'USDC' } },
    robinhood: { native: { usd: 2511.149244, symbol: 'ETH' }, funding: { usd: 0.999881, symbol: 'USDG' } },
    base: { native: { usd: 2511.149244, symbol: 'ETH' }, funding: { usd: 0.999859, symbol: 'USDC' } },
  },
  observedAt: '2026-10-14T05:00:52.000Z',
  source: 'Relay',
};
const PRICE_CLOCK = (() => { const date = new Date(PRICES.observedAt); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; })();

// Every page gets these prices unless a test answers the route itself (a later route wins).
test.beforeEach(async ({ page }) => {
  await page.route('**/api/solares/wallet/prices', route => route.fulfill({ json: PRICES }));
});

test('ANTARA opens an honest disconnected Solana-first wallet without fictional holdings', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('ark.demo', '1'));
  await page.goto('/app?demo=1');
  await expect(page).toHaveTitle(/ANTARA/);
  await expect(page.getByRole('heading', { name: 'Wallet', exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'App navigation' })).toHaveClass(/is-expanded/);
  // Signed out: a muted "0.00" stand-in (never "—"), with the reason as its accessible name.
  await expect(page.locator('.desktop-balance-number')).toHaveText('0.00');
  await expect(page.locator('.desktop-balance-number [data-placeholder]')).toHaveText('0.00');
  await expect(page.locator('.desktop-balance-number')).toHaveAttribute('aria-label', 'Sign in to load balances');
  await expect(page.locator('.desktop-token-table tbody tr')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/preview|sample data|128,640|24,384|SOLARES/i);
  // Registry order with Solana first; Arbitrum and Polygon are gone.
  await expect(page.getByLabel('Filter assets by network').locator('option')).toHaveText(['All networks', 'Solana', 'Ethereum', 'BNB Smart Chain', 'Robinhood Chain', 'Base']);
  await expect(page.getByLabel('Filter assets by network')).toHaveValue('solana');
  await expect(page.getByLabel('Supported networks')).toHaveText(/Solana.*Ethereum.*BNB Smart Chain.*Robinhood Chain.*Base/);
  await expect(page.locator('body')).not.toContainText(/Arbitrum|Polygon/);
  await expect(page.getByRole('complementary', { name: 'Swap panel' })).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/antara-desktop.png', fullPage: true, animations: 'disabled' });

  await page.getByRole('button', { name: 'Hide balances', exact: true }).click();
  await expect(page.locator('.desktop-balance-number')).toHaveText('••••••');
  await page.getByRole('button', { name: 'Show balances', exact: true }).click();
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Sign in to view your receiving address.');
  await expect(page.getByRole('dialog').getByRole('combobox')).toHaveValue('solana');
  await expect(page.getByRole('dialog').getByRole('combobox').locator('option')).toHaveText(['Solana', 'Ethereum', 'BNB Smart Chain', 'Robinhood Chain', 'Base']);
  await expect(page.getByRole('dialog').locator('.desktop-qr')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Receive', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Sign in to send assets.');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Sign-in setup required' })).toBeDisabled();
  await page.getByRole('button', { name: 'Close transfer' }).click();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your activity, in one place' })).toBeVisible();
  await expect(page.locator('.desktop-activity-row')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Solana-first swap and vault defaults keep every supported network and require real wallet configuration', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/app#swap');
  await expect(page.getByRole('heading', { name: 'Swap', exact: true })).toBeVisible();
  await expect(page.locator('#sol-relay-source')).toHaveValue('792703809');
  await expect(page.locator('#sol-relay-destination')).toHaveValue('792703809');
  await expect(page.locator('#sol-relay-source option')).toHaveText(['Solana', 'Ethereum', 'BNB Smart Chain', 'Robinhood Chain', 'Base']);
  await page.getByLabel('USDC amount to spend').fill('25');
  await expect(page.getByRole('button', { name: 'Sign-in setup required', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Confirm .*trade/ })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/preview|sample/i);
  await page.screenshot({ path: 'artifacts/antara-crosschain.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Wallet', exact: true }).click();
  await page.getByRole('tab', { name: 'Vault', exact: true }).click();
  // Vault is a primary destination (sidebar, bottom tabs), so the Vault side titles the page "Vault".
  await expect(page.getByRole('heading', { name: 'Vault', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Vault balance', exact: true })).toBeVisible();
  await expect(page.getByLabel('Vault network')).toHaveValue('solana');
  await expect(page.getByLabel('Vault network').locator('option')).toHaveText(['Solana', 'Ethereum', 'BNB Smart Chain', 'Robinhood Chain', 'Base']);
  await expect(page.getByRole('region', { name: 'Vault balance', exact: true })).toContainText('Solana');
  await expect(page.getByText(/Choose your owners|Additional owner addresses|Signing owner/)).toHaveCount(0);
  await expect(page.locator('.desktop-balance-number')).toHaveText('0.00');
  await page.screenshot({ path: 'artifacts/antara-vaults.png', fullPage: true, animations: 'disabled' });
  await page.getByLabel('Vault network').selectOption('ethereum');
  await expect(page.getByRole('region', { name: 'Vault balance', exact: true })).toContainText('Ethereum');
  await page.getByLabel('Vault network').selectOption('robinhood');
  // The vault card's headline is the vault's total; Robinhood Chain has no Circle USDC, so nothing there says USDC.
  await expect(page.getByRole('region', { name: 'Vault balance', exact: true })).toContainText('Vault · total');
  await expect(page.getByRole('region', { name: 'Vault balance', exact: true })).not.toContainText('USDC');
  await page.getByLabel('Vault network').selectOption('bsc');
  await expect(page.getByRole('region', { name: 'Vault balance', exact: true })).toContainText('Vault · total');
  await expect(page.locator('.desktop-balance-number')).toHaveText('0.00');
  await expect(page.getByRole('button', { name: /Create .*signature vault/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('navigation contains only wallet, trading and security screens; retired links recover to Wallet', async ({ page }) => {
  for (const hash of ['trenches', 'agents', 'browser', 'tokens']) {
    await page.goto('/app#' + hash);
    await expect(page.getByRole('heading', { name: 'Wallet', exact: true })).toBeVisible();
  }
  const nav = page.getByRole('complementary', { name: 'App navigation' });
  for (const label of ['Trenches', 'Agents', 'Browser', 'Tokens', 'Vaults']) await expect(nav.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  for (const label of ['Wallet', 'Vault', 'Swap', 'Activity', 'Protection', 'Settings']) await expect(nav.getByRole('button', { name: label, exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Private', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('link', { name: /Privy dashboard|Existing wallet workspace/ })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Show swap panel' })).toHaveCount(0);
});

test('small windows use thumb navigation and retain the disconnected wallet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app');
  await expect(page.getByRole('heading', { name: 'Wallet', exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'App navigation' })).toBeHidden();
  const navigation = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(navigation).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/antara-mobile.png', fullPage: true, animations: 'disabled' });
  await navigation.getByRole('button', { name: 'Protection', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Protect your vault', exact: true })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Protection', exact: true })).toHaveAttribute('aria-current', 'page');
  await navigation.getByRole('button', { name: 'Swap', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Swap', exact: true })).toBeVisible();
  await expect(page.getByLabel('USDC amount to spend')).toHaveCount(1);
  await navigation.getByRole('button', { name: 'Wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to wallet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Wallet', exact: true })).toBeVisible();
});

test('celestial motion respects reduced motion and the saved appearance preference', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/app');
  await expect(page.locator('.antara-celestial-scene')).toHaveAttribute('data-motion', 'still');
  await expect(page.locator('.desktop-hero-art')).toHaveCSS('animation-name', 'none');
  await expect(page.getByRole('region', { name: 'Wallet balance' })).toBeVisible();

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.antara-celestial-scene')).toHaveAttribute('data-motion', 'running');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('switch', { name: 'Celestial motion' }).click();
  await expect(page.getByRole('switch', { name: 'Celestial motion' })).not.toBeChecked();
  await expect(page.locator('.antara-celestial-scene')).toHaveAttribute('data-motion', 'still');
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Celestial motion' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Wallet', exact: true }).click();
  await expect(page.locator('.desktop-hero-art')).toHaveCSS('animation-name', 'none');
  await page.getByRole('button', { name: /Open your vault/ }).click();
  await expect(page.getByRole('region', { name: 'Vault balance', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Wallet', exact: true }).click();
  await page.getByRole('button', { name: /Open protection/ }).click();
  await expect(page.getByRole('heading', { name: 'Protection', exact: true })).toBeVisible();
  await page.getByRole('complementary', { name: 'App navigation' }).getByRole('button', { name: 'Swap', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Trade from your wallet' })).toBeVisible();
});

test('protection shows actionable layers and explains the vault boundary', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/app');
  await page.getByRole('button', { name: /Open protection/ }).click();
  await expect(page).toHaveURL(/#protection$/);
  await expect(page.getByRole('heading', { name: 'Protection', exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Swap panel' })).toHaveCount(0);
  const layers = page.getByRole('region', { name: 'Protection layers', exact: true });
  await expect(layers).toBeVisible();
  // Without a vault the six rows only describe the layers: no status, no badge and no dead button.
  await expect(layers.locator('.vl-row')).toHaveCount(6);
  expect(await layers.locator('.vl-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-layer')))).toEqual(['biometrics', 'geolocation', 'wifi', 'bluetooth', 'mfa', 'limits']);
  await expect(layers.locator('.vl-pill')).toHaveCount(0);
  await expect(layers.getByRole('button')).toHaveCount(0);
  await expect(layers).toContainText('Device location in places you pick');
  await expect(page.getByText(/Not enforced|Not implemented|Location rules|Voice verification|Device-reported|Server-observed|Cryptographic/)).toHaveCount(0);
  await expect(page.getByText('Protection applies to funds in your vault. Your spending wallet has no layers and never asks for a code.')).toBeVisible();
  await expect(layers.getByRole('switch')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/antara-protection.png', fullPage: true, animations: 'disabled' });
  await page.reload();
  await expect(layers).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/antara-protection-mobile.png', fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('navigation controls remain reachable in short windows', async ({ page }) => {
  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 640 });
    await page.goto('/app');
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeInViewport();
    if (width === 390) {
      await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: 'Sign in to ANTARA', exact: true })).toBeInViewport();
    } else await expect(page.getByRole('complementary', { name: 'App navigation' }).getByRole('button', { name: 'Sign in', exact: true })).toBeInViewport();
  }
});

test('swap searches real token identities on any supported network and has no decorative review panels', async ({ page }) => {
  const token = { chainId: 8453, address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8 };
  const queries: URL[] = [];
  await page.route('**/api/solares/relay/config', route => route.fulfill({ json: RELAY_CONFIG }));
  await page.route('**/api/solares/relay/currencies?*', route => {
    const url = new URL(route.request().url()); queries.push(url);
    return route.fulfill({ json: { tokens: url.searchParams.get('chainId') === '8453' ? [token] : [] } });
  });
  await page.goto('/app#swap');
  await expect(page.getByRole('heading', { name: 'Trade from your wallet' })).toBeVisible();
  await expect(page.getByLabel('Pay network')).toHaveValue('792703809');
  await expect(page.getByLabel('Receive network')).toHaveValue('792703809');
  await expect(page.getByText(/Flight check|Set your course|Route review|No routes yet/i)).toHaveCount(0);
  await page.getByLabel('USDC amount to spend').fill('25');
  await page.getByLabel('Pay network').selectOption('8453');
  await expect(page.getByLabel('Receive network')).toHaveValue('8453');
  const pickerButton = page.getByRole('button', { name: 'Select token, ETH on Base' });
  await pickerButton.click();
  const dialog = page.getByRole('dialog', { name: 'Select a token' });
  await expect(dialog).toBeVisible();
  await page.getByLabel('Search tokens').fill('cbBTC');
  await expect(dialog.getByRole('button', { name: /cbBTC Coinbase Wrapped BTC/ })).toBeVisible();
  await dialog.getByRole('button', { name: /cbBTC Coinbase Wrapped BTC/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select token, cbBTC on Base' })).toBeFocused();
  await expect(page.getByLabel('USDC amount to spend')).toHaveValue('25');
  await expect(page.getByLabel('Receive network')).toHaveValue('8453');
  expect(queries.some(url => url.searchParams.get('term') === 'cbBTC')).toBe(true);
  await page.screenshot({ path: 'artifacts/antara-swap.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Select token, cbBTC on Base' }).click();
  await page.getByLabel('Token network').selectOption('792703809');
  await dialog.getByRole('button', { name: /SOL SOL Native token/ }).click();
  await expect(page.getByLabel('Receive network')).toHaveValue('792703809');
  await expect(page.getByLabel('Pay network')).toHaveValue('8453');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/antara-swap-mobile.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Select token, SOL on Solana' }).click();
  await expect(dialog).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('Max uses the whole balance with no swap cap, and missing or invalid swap terms keep swaps unavailable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let config: Record<string, unknown> = RELAY_CONFIG;
  await page.route('**/api/solares/relay/config', route => route.fulfill({ json: config }));
  await page.goto('/tests/fixtures/wallet.html#swap');
  const card = page.locator('.trade-card');
  // Binance-Peg USDC balance 1.5 and USDG balance 2.5: Max fills the whole balance (owner decision 2026-10-13: no swap cap).
  await page.getByLabel('Pay network').selectOption('56');
  await expect(card.getByText('Balance: 1.5 USDC (Binance-Peg)', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Max', exact: true }).click();
  await expect(page.getByLabel('USDC (Binance-Peg) amount to spend')).toHaveValue('1.5');
  await page.getByLabel('Pay network').selectOption('4663');
  await card.getByRole('button', { name: 'Max', exact: true }).click();
  await expect(page.getByLabel('USDG amount to spend')).toHaveValue('2.5');
  await expect(page.getByRole('button', { name: 'Review swap', exact: true })).toBeVisible();
  await expect(card).not.toContainText(/per swap|per 24 hours|Swap limit/i);
  // The settings sheet has slippage and the terms note only: no swap limits row.
  await page.getByRole('button', { name: 'Swap settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Swap settings' });
  await expect(settings).toBeVisible();
  await expect(settings).not.toContainText(/Swap limits|per swap|per 24 hours/i);
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  // A server that reports unavailable swap terms, or omits them, keeps swaps unavailable.
  config = { ...RELAY_CONFIG, maxTradeUnits: null, maxFundingUnits: null, swapLimitsError: 'Swap terms are unavailable on the server.' };
  await page.reload();
  await expect(page.getByRole('button', { name: 'Swaps unavailable', exact: true })).toBeDisabled();
  await expect(page.locator('.trade-notice')).toHaveText('Swap terms are unavailable on the server.');
  config = { configured: true };
  await page.reload();
  await expect(page.getByRole('button', { name: 'Swaps unavailable', exact: true })).toBeDisabled();
  // Routes from another network into BNB Smart Chain or Robinhood Chain are not offered yet.
  await expect(page.getByLabel('Receive network').locator('option[value="56"]')).toBeDisabled();
  await expect(page.getByLabel('Receive network').locator('option[value="4663"]')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('token search errors can retry and stale results cannot cross networks', async ({ page }) => {
  let first = true;
  await page.route('**/api/solares/relay/config', route => route.fulfill({ json: { configured: false } }));
  await page.route('**/api/solares/relay/currencies?*', route => {
    if (first) { first = false; return route.fulfill({ status: 503, json: { error: 'Unavailable' } }); }
    return route.fulfill({ json: { tokens: [] } });
  });
  await page.goto('/app#swap');
  await page.getByRole('button', { name: 'Select token, SOL on Solana' }).click();
  await expect(page.getByText('Token search is unavailable. Try again.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Token search is unavailable. Try again.')).toHaveCount(0);
  await page.getByLabel('Search tokens').fill('NoSuchToken');
  await expect(page.getByText('No tokens found on Solana. Try the contract address.')).toBeVisible();
  await page.getByLabel('Token network').selectOption('1');
  await expect(page.getByRole('dialog').getByRole('button', { name: /SOL/ })).toHaveCount(0);
  await expect(page.getByRole('dialog').getByRole('button', { name: /ETH ETH Native token/ })).toBeVisible();
});

test('old vault links open the wallet’s Vault tab, with keyboard navigation and local settings', async ({ page }) => {
  await page.goto('/app#VAULT');
  await expect(page.getByRole('tab', { name: 'Vault', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => { location.hash = 'Wallet'; });
  await expect(page.getByRole('tab', { name: 'Wallet', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => { location.hash = 'Vaults'; });
  await expect(page.getByRole('tab', { name: 'Vault', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goto('/app#vaults');
  await expect(page.getByRole('heading', { name: 'Vault', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Vault', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Vaults', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Vault settings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Vault settings', exact: true })).toBeVisible();
  await expect(page.getByText(/Choose your owners|Additional owner addresses|Connect external owner/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('tab', { name: 'Vault', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Wallet', exact: true })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Wallet balance', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('region', { name: 'Vault balance', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Vault', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/antara-wallet-vault-mobile.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Manage existing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Open an existing vault', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Create .*vault/ })).toHaveCount(0);
});

test('the vault starts on the Solana wallet without EVM discovery, then follows the selected EVM wallet, ignores old requests, and never enables deposits when unavailable', async ({ page }) => {
  const first = '0x1111111111111111111111111111111111111111';
  const second = '0x2222222222222222222222222222222222222222';
  const requests: URL[] = [];
  let releaseFirst: (() => void) | undefined;
  await page.route('**/api/solares/paired-vault?*', async route => {
    const url = new URL(route.request().url()); requests.push(url);
    const owner = url.searchParams.get('owner'); const chain = url.searchParams.get('chain');
    if (owner === first) await new Promise<void>(resolve => { releaseFirst = resolve; });
    await route.fulfill({ json: { owner, chain, status: owner === first || chain === 'solana' ? 'unsupported' : 'unavailable', creationEnabled: false, transfersEnabled: false } }).catch(() => {});
  });
  await page.goto('/tests/fixtures/wallet.html#vault');
  // The primary Solana wallet opens on the paired Solana (Squads) vault. This build has no pinned guardian,
  // so it reads nothing and never falls back to EVM Safe discovery for Solana.
  await expect(page.getByLabel('Vault network')).toHaveValue('solana');
  await expect(page.getByRole('heading', { name: 'Vault protection isn’t available in this build', exact: true })).toBeVisible();
  expect(requests).toEqual([]);
  await page.getByLabel('Vault network').selectOption('ethereum');
  await expect(page.getByText('Finding your vault', { exact: true })).toBeVisible();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByRole('button', { name: 'Select wallet', exact: true }).click();
  await page.getByRole('button', { name: /^Wallet two/ }).click();
  await expect(page.getByLabel('Vault network')).toHaveValue('ethereum');
  await expect(page.getByText('Vault activation is not available yet.', { exact: false })).toBeVisible();
  releaseFirst?.();
  await expect(page.getByRole('region', { name: 'Vault balance', exact: true })).toContainText('0x2222');
  await expect(page.getByText('Paired vaults are not available on Ethereum yet.', { exact: false })).toHaveCount(0);
  expect(requests.some(url => url.searchParams.get('owner') === second)).toBe(true);
  for (const chain of ['bsc', 'robinhood', 'base']) {
    await page.getByLabel('Vault network').selectOption(chain);
    await expect.poll(() => requests.some(url => url.searchParams.get('owner') === second && url.searchParams.get('chain') === chain)).toBe(true);
  }
  expect(requests.some(url => ['solana', 'arbitrum', 'polygon'].includes(url.searchParams.get('chain') || ''))).toBe(false);
  await expect(page.getByRole('button', { name: /Deposit|Withdraw|Create vault|Activate vault/ })).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/antara-wallet-vault-signed-in.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByText('Your wallet. Its own vault.', { exact: true })).toBeVisible();
  await expect(page.locator('.desktop-balance-number')).toHaveText('0.00');
});

test('the wallet opens on Solana; the total covers every asset in scope in US dollars and a loaded zero stays zero', async ({ page }) => {
  await page.goto('/tests/fixtures/wallet.html');
  const balance = page.locator('.desktop-balance-number');
  const summary = page.getByRole('region', { name: 'Wallet balance', exact: true });
  const filter = page.getByLabel('Filter assets by network');
  const rows = page.locator('.desktop-token-table tbody tr');
  // Solana is the default network and the account's Solana wallet is primary.
  await expect(filter).toHaveValue('solana');
  await expect(page.getByRole('button', { name: 'Select wallet', exact: true })).toContainText('Solana wallet');
  await expect(summary.locator('.desktop-balance-top')).toHaveText('Total balance');
  // 9 USDC at $0.999898.
  await expect(balance).toHaveText('≈ $9.00');
  await expect(page.locator('.desktop-balance-meta')).toHaveText(`1 asset · Solana · prices from Relay, ${PRICE_CLOCK}`);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Solana');
  await expect(rows.first().locator('.home-token-usd')).toHaveText('≈ $9.00');
  // Circle USDC keeps the USDC mark.
  await expect(rows.first().locator('.desktop-token-mark')).toHaveClass(/desktop-token-usdc/);
  // "All networks" adds up every network the account holds, native coins included.
  await filter.selectOption('all');
  await expect(summary.locator('.desktop-balance-top')).toHaveText('Total balance');
  await expect(balance).toHaveText('≈ $224.11');
  await expect(page.locator('.desktop-balance-meta')).toHaveText(`6 assets · 5 networks · prices from Relay, ${PRICE_CLOCK}`);
  await expect(page.getByLabel('Other holdings')).toHaveCount(0);
  await expect(rows.first()).toContainText('Solana');
  // Every network loaded, so a loaded zero is shown as an exact zero.
  await filter.selectOption('base');
  await expect(balance).toHaveText('$0.00');
  await filter.selectOption('solana');
  await expect(balance).toHaveText('≈ $9.00');
  await filter.selectOption('all');
  await expect(balance).toHaveText('≈ $224.11');
  await page.getByRole('button', { name: 'Hide balances', exact: true }).click();
  await expect(balance).toHaveText('••••••');
  for (const value of await page.locator('.home-token-usd').allTextContents()) expect(value).toBe('••••••');
  await page.getByRole('button', { name: 'Show balances', exact: true }).click();
  await page.getByRole('button', { name: 'Select wallet', exact: true }).click();
  await expect(page.getByRole('dialog').locator('h3')).toHaveText(['Solana', /^EVM/]);
  await page.getByRole('dialog').getByRole('button', { name: /^Solana wallet/ }).click();
  await expect(balance).toHaveText('≈ $9.00');
  await page.getByRole('tab', { name: 'Vault', exact: true }).click();
  await expect(page.getByLabel('Vault network')).toHaveValue('solana');
});

test('BNB Smart Chain shows Binance-Peg USDC at 18 decimals and Robinhood Chain shows USDG, never USDC', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/tests/fixtures/wallet.html');
  const balance = page.locator('.desktop-balance-number');
  const summary = page.getByRole('region', { name: 'Wallet balance', exact: true });
  const rows = page.locator('.desktop-token-table tbody tr');
  await page.getByLabel('Filter assets by network').selectOption('bsc');
  await expect(summary.locator('.desktop-balance-top')).toHaveText('Total balance');
  // 0.25 BNB at $744.462048 and 1.5 Binance-Peg USDC (18 decimals) at $0.999859.
  await expect(balance).toHaveText('≈ $187.62');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.home-token-usd')).toHaveText('≈ $186.12');
  await expect(rows.nth(1).locator('.home-token-usd')).toHaveText('≈ $1.50');
  await expect(rows.nth(0)).toContainText('BNB');
  await expect(rows.nth(0)).toContainText('0.25');
  await expect(rows.nth(1)).toContainText('Binance-Peg USD Coin');
  await expect(rows.nth(1)).toContainText('USDC (Binance-Peg)');
  await expect(rows.nth(1)).toContainText('BNB Smart Chain');
  await expect(rows.nth(1)).toContainText('1.5');
  // Binance-Peg USDC never borrows Circle USDC's mark.
  await expect(rows.nth(1).locator('.desktop-token-mark')).toHaveClass(/desktop-token-stablecoin/);
  await expect(rows.nth(1).locator('.desktop-token-mark')).not.toHaveClass(/desktop-token-usdc/);
  await page.getByLabel('Filter assets by network').selectOption('robinhood');
  await expect(summary.locator('.desktop-balance-top')).toHaveText('Total balance');
  await expect(balance).toHaveText('≈ $2.50');
  await expect(summary).not.toContainText('USDC');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Paxos Global Dollar');
  await expect(rows.first()).toContainText('Robinhood Chain');
  await expect(rows.first()).not.toContainText('USDC');
  await expect(rows.first().locator('.desktop-token-mark')).toHaveClass(/desktop-token-stablecoin/);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('combobox')).toHaveValue('robinhood');
  await expect(page.getByRole('dialog')).toContainText('Stablecoin on Robinhood Chain: USDG (Paxos Global Dollar).');
  await page.getByRole('dialog').getByRole('combobox').selectOption('bsc');
  await expect(page.getByRole('dialog')).toContainText('not by Circle');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const send = page.getByRole('dialog');
  await expect(send.getByRole('combobox').first()).toHaveValue('robinhood');
  await expect(send.getByRole('combobox').nth(1).locator('option')).toHaveText(['ETH', 'USDG']);
  await send.getByRole('combobox').first().selectOption('bsc');
  await expect(send.getByRole('combobox').nth(1).locator('option')).toHaveText(['BNB', 'USDC (Binance-Peg)']);
  await expect(send.getByRole('combobox').first().locator('option')).toHaveText(['Solana', 'Ethereum', 'BNB Smart Chain', 'Robinhood Chain', 'Base']);
  expect(errors).toEqual([]);
});

test('a failed network is unknown, never zero: its own view is a muted 0.00 and the all-networks total names it as left out', async ({ page }) => {
  await page.goto('/tests/fixtures/wallet.html?failed=base');
  const balance = page.locator('.desktop-balance-number');
  const hero = page.getByRole('region', { name: 'Wallet balance' });
  await expect(page.getByRole('alert')).toContainText('Live balances unavailable on Base');
  // The default Solana view loaded, so it stays known while another network failed.
  await expect(page.getByLabel('Filter assets by network')).toHaveValue('solana');
  await expect(balance).toHaveText('≈ $9.00');
  await expect(hero.locator('.home-notes')).toHaveCount(0);
  await page.getByLabel('Filter assets by network').selectOption('all');
  // Everything that loaded still counts, and the total says what it leaves out, with a retry.
  await expect(balance).toHaveText('≈ $224.11');
  await expect(hero.locator('.home-notes')).toHaveText("Excludes Base (couldn't load)");
  await expect(hero.getByText("Couldn't load", { exact: true })).toBeVisible();
  await hero.getByRole('button', { name: 'Retry loading balances' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fixtureRefetches?: number }).__fixtureRefetches ?? 0)).toBe(1);
  await expect(page.getByLabel('Other holdings')).toHaveCount(0);
  await page.getByLabel('Filter assets by network').selectOption('base');
  // Unknown is a muted "0.00" stand-in (never "—", never "$0.00"), with the reason as its name.
  await expect(balance).toHaveText('0.00');
  await expect(balance.locator('[data-placeholder]')).toHaveText('0.00');
  await expect(balance).toHaveAttribute('aria-label', 'Balance unavailable on Base');
  await page.getByLabel('Filter assets by network').selectOption('ethereum');
  await expect(balance).toHaveText('≈ $25.00');
  await page.getByLabel('Filter assets by network').selectOption('robinhood');
  await expect(balance).toHaveText('≈ $2.50');
});

test('the owner case: SOL held and 0 USDC shows the dollar total on top, never "0 USDC"', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/tests/fixtures/wallet.html?balances=owner');
  const balance = page.locator('.desktop-balance-number');
  const summary = page.getByRole('region', { name: 'Wallet balance', exact: true });
  const rows = page.locator('.desktop-token-table tbody tr');
  await expect(summary.locator('.desktop-balance-top')).toHaveText('Total balance');
  // 0.09833392 SOL at $107.831068 is $10.6034…; the 0 USDC adds nothing.
  await expect(balance).toHaveText('≈ $10.60');
  await expect(balance.locator('[data-placeholder]')).toHaveCount(0);
  await expect(summary).not.toContainText(/\b0 USDC|USDC balance/i);
  await expect(page.locator('.desktop-balance-meta')).toHaveText(`2 assets · Solana · prices from Relay, ${PRICE_CLOCK}`);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('0.09833392');
  await expect(rows.nth(0).locator('.home-token-usd')).toHaveText('≈ $10.60');
  await expect(rows.nth(1).locator('.home-token-usd')).toHaveText('$0.00');
  // Token detail: the balance's dollar value and the price with its source and time; no "ANTARA does not show token prices".
  await page.getByRole('button', { name: 'SOL on Solana', exact: true }).click();
  const detail = page.locator('[data-screen="token-detail"]');
  await expect(detail.locator('.home-detail-usd')).toHaveText('≈ $10.60');
  await expect(detail.locator('.home-detail-foot')).toHaveText(`Price ≈ $107.83 · Relay, ${PRICE_CLOCK}`);
  await expect(detail).not.toContainText('does not show token prices');
  expect(errors).toEqual([]);
});

test('without prices the top shows the largest holding as a token amount, never $0', async ({ page }) => {
  await page.route('**/api/solares/wallet/prices', route => route.fulfill({ status: 503, json: { error: 'Prices are unavailable right now.', source: 'Relay' } }));
  await page.goto('/tests/fixtures/wallet.html?balances=owner');
  const balance = page.locator('.desktop-balance-number');
  await expect(balance).toHaveText('0.0983SOL');
  await expect(page.locator('.desktop-balance-meta')).toHaveText('2 assets · Solana · USD value unavailable');
  await expect(page.locator('.home-token-usd')).toHaveCount(1);
  await expect(page.locator('.home-token-usd')).toHaveText('$0.00');
  await page.getByRole('button', { name: 'SOL on Solana', exact: true }).click();
  await expect(page.locator('[data-screen="token-detail"] .home-detail-foot')).toHaveText('No price from Relay right now.');
});

test('device-local records on removed networks render read-only, labelled as no longer supported', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const first = '0x1111111111111111111111111111111111111111';
  const hash = `0x${'ab'.repeat(32)}`;
  await page.addInitScript(([sender, tx]) => {
    localStorage.setItem('solares:transfers:fixture-user', JSON.stringify([
      { id: 'legacy-arbitrum', chain: 'arbitrum', symbol: 'USDC', amount: '3', recipient: '0x3333333333333333333333333333333333333333', sender, hash: tx, status: 'confirmed', createdAt: '2026-06-01T00:00:00.000Z' },
      { id: 'legacy-polygon', chain: 'polygon', symbol: 'POL', amount: '4', recipient: '0x3333333333333333333333333333333333333333', sender, hash: '', status: 'submission-unknown', createdAt: '2026-05-01T00:00:00.000Z' },
    ]));
    localStorage.setItem('solares.vault-references.v1:fixture-user', JSON.stringify([{ address: '0x4444444444444444444444444444444444444444', network: '42161' }]));
    // Saved Relay routes: one from a removed network, and two funded with stablecoins Circle does not issue.
    const route = (id: string, day: string, originChainId: number, destinationChainId: number, amount: string, destinationToken: unknown) => ({
      requestId: `0x${id.repeat(64)}`, createdAt: Date.parse(day), status: 'success', sourceTxHashes: [], destinationTxHashes: [],
      intent: { originChainId, destinationChainId, user: sender, recipient: sender, amount, destinationToken, slippageBps: 50 },
    });
    localStorage.setItem('solares.relay.activity.v1', JSON.stringify([
      route('a', '2026-04-03T00:00:00.000Z', 4663, 8453, '2500000', 'native'),
      route('b', '2026-04-02T00:00:00.000Z', 56, 4663, '1500000000000000000', { chainId: 4663, address: '0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8', symbol: 'USDC', name: 'USD Coin', decimals: 6 }),
      route('c', '2026-04-01T00:00:00.000Z', 42161, 8453, '7000000', 'USDC'),
    ]));
  }, [first, hash] as const);
  await page.goto('/tests/fixtures/wallet.html');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const rows = page.locator('.desktop-activity-row');
  await expect(rows).toHaveCount(5);
  const arbitrumTransfer = rows.filter({ hasText: 'confirmed · Arbitrum (no longer supported)' });
  await expect(arbitrumTransfer.getByRole('link')).toHaveAttribute('href', `https://arbiscan.io/tx/${hash}`);
  const unknownTransfer = rows.filter({ hasText: 'Wallet outcome unknown' });
  await expect(unknownTransfer.getByRole('link')).toHaveAttribute('href', `https://polygonscan.com/address/${first}`);
  // A route from a removed network is labelled and read-only: Relay status refresh is not offered.
  const legacyRoute = rows.filter({ hasText: 'Arbitrum (no longer supported) · success' });
  await expect(legacyRoute).toContainText('USDC → USDC');
  await expect(legacyRoute).toContainText('7 USDC');
  await expect(legacyRoute.getByRole('button', { name: 'Refresh route status' })).toHaveCount(0);
  await expect(legacyRoute.getByRole('link')).toHaveCount(0);
  // Binance-Peg USDC keeps its issuer label at 18 decimals; a token imitating USDC is never named USDC.
  const bscRoute = rows.filter({ hasText: 'BNB Smart Chain · success' });
  await expect(bscRoute).toContainText('USDC (Binance-Peg) → Unverified token');
  await expect(bscRoute).toContainText('1.5 USDC (Binance-Peg)');
  await expect(bscRoute.getByRole('button', { name: 'Refresh route status' })).toHaveCount(1);
  // Robinhood Chain routes spend USDG, never USDC.
  const robinhoodRoute = rows.filter({ hasText: 'Robinhood Chain · success' });
  await expect(robinhoodRoute).toContainText('USDG → ETH');
  await expect(robinhoodRoute).toContainText('2.5 USDG');
  await expect(robinhoodRoute).not.toContainText('USDC');
  await expect(robinhoodRoute.getByRole('button', { name: 'Refresh route status' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Manage existing', exact: true }).click();
  const workspace = page.getByRole('region', { name: 'Multisig vault workspace', exact: true });
  await expect(workspace.locator('select').first().locator('option')).toHaveText(['Solana · Squads', 'Ethereum · Safe', 'BNB Smart Chain · Safe', 'Robinhood Chain · Safe', 'Base · Safe']);
  await expect(workspace.locator('select').first()).toHaveValue('solana');
  const legacy = page.getByLabel('Saved references on networks no longer supported');
  await expect(legacy).toContainText('Arbitrum (no longer supported)');
  await expect(legacy.getByRole('button')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('swap pays from each network’s pinned stablecoin, and saved swaps on removed networks stay read-only and unpolled', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const sender = '0x1111111111111111111111111111111111111111';
  const hash = `0x${'cd'.repeat(32)}`;
  const statusRequests: string[] = [];
  await page.route('**/api/solares/relay/config', route => route.fulfill({ json: RELAY_CONFIG }));
  await page.route('**/api/solares/relay/status/**', route => { statusRequests.push(route.request().url()); return route.fulfill({ status: 500, json: { error: 'Unexpected status request' } }); });
  await page.addInitScript(([user, tx]) => {
    const route = (id: string, originChainId: number, status: string, sourceTxHashes: string[]) => ({
      requestId: `0x${id.repeat(64)}`, createdAt: Date.parse('2026-04-01T00:00:00.000Z'), status, sourceTxHashes, destinationTxHashes: [],
      intent: { originChainId, destinationChainId: 8453, user, recipient: user, amount: '7000000', destinationToken: 'native', slippageBps: 50 },
    });
    localStorage.setItem('solares.relay.activity.v1', JSON.stringify([route('d', 42161, 'waiting', []), route('e', 137, 'pending', [tx])]));
  }, [sender, hash] as const);
  await page.goto('/tests/fixtures/wallet.html#swap');
  await expect(page.getByLabel('Pay network')).toHaveValue('792703809');
  await expect(page.getByLabel('USDC amount to spend')).toBeVisible();
  // Saved swaps on removed networks render read-only: no refresh, no polling, and an explorer link either way.
  const tracking = page.getByLabel('Swap status', { exact: true }).locator('article');
  await expect(tracking).toHaveCount(2);
  const arbitrum = tracking.filter({ hasText: 'Arbitrum (no longer supported)' });
  await expect(arbitrum).toContainText('7 USDC → ETH');
  await expect(arbitrum).toContainText('Not tracked');
  await expect(arbitrum.getByRole('link', { name: 'View wallet on Arbiscan ↗' })).toHaveAttribute('href', `https://arbiscan.io/address/${sender}`);
  const polygon = tracking.filter({ hasText: 'Polygon (no longer supported)' });
  await expect(polygon.getByRole('link', { name: 'Transaction 1 ↗' })).toHaveAttribute('href', `https://polygonscan.com/tx/${hash}`);
  await expect(polygon.getByRole('link', { name: /View wallet/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh status' })).toHaveCount(0);
  // BNB Smart Chain pays from Binance-Peg USDC at 18 decimals, without Circle USDC's mark.
  const card = page.locator('.trade-card');
  await page.getByLabel('Pay network').selectOption('56');
  await expect(card.getByText('Balance: 1.5 USDC (Binance-Peg)', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Max', exact: true }).click();
  await expect(page.getByLabel('USDC (Binance-Peg) amount to spend')).toHaveValue('1.5');
  await expect(card.locator('span.trade-asset .trade-coin')).not.toHaveClass(/trade-coin-usdc/);
  // Robinhood Chain pays from USDG and never shows USDC.
  await page.getByLabel('Pay network').selectOption('4663');
  await expect(card.getByText('Balance: 2.5 USDG', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Max', exact: true }).click();
  await expect(page.getByLabel('USDG amount to spend')).toHaveValue('2.5');
  await expect(card).not.toContainText('USDC');
  await page.getByLabel('Pay network').selectOption('8453');
  await expect(card.locator('span.trade-asset .trade-coin')).toHaveClass(/trade-coin-usdc/);
  expect(statusRequests).toEqual([]);
  expect(errors).toEqual([]);
});

// ---- Vault protection layers (docs/VAULT_LAYERS.md section 13.2), on the layer fixture with mocked routes ----

type LayerAnswer = { status: number; json: unknown; headers?: Record<string, string> };
const PAIRED_API = '/api/solares/paired-vault';
/** Mocks the paired-vault API by path; anything unmocked answers 404. Returns every request seen. */
async function mockPairedApi(page: Page, handlers: Record<string, (body: Record<string, unknown>) => LayerAnswer>) {
  const seen: { path: string; body: Record<string, unknown> | undefined }[] = [];
  await page.route(url => url.pathname.startsWith(PAIRED_API), async route => {
    const path = new URL(route.request().url()).pathname.slice(PAIRED_API.length);
    const data = route.request().postData();
    const body = data ? JSON.parse(data) as Record<string, unknown> : undefined;
    seen.push({ path, body });
    const answer = handlers[path]?.(body ?? {}) ?? { status: 404, json: { error: 'Not found.' } };
    await route.fulfill({ status: answer.status, json: answer.json, headers: answer.headers });
  });
  return seen;
}
/** Words that claim protection. None may appear unless GET /solana/layers answered 200. */
const layerCalls = (page: Page) => page.evaluate(() => (window as unknown as { __layerCalls: string[] }).__layerCalls);
const STATUS_WORDS = /Enrolled|enforced|Checked on every release|In force|verified|\bactive\b|Cryptographic|Device-reported|Server-observed/i;
const NEVER_CLAIMS = /GPS verified|verified location|proximity verified|Wi-Fi verified|cannot be spoofed|hardware-backed|\bTPM\b|per-transaction MFA|fingerprint is required/i;

test('vault protection layers show no status unless the server answers 200 with a valid view', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let answer: LayerAnswer = { status: 503, json: { error: 'Paired vaults are not switched on.', code: 'not-provisioned' } };
  await mockPairedApi(page, { '/solana/layers': () => answer });
  await page.goto('/tests/fixtures/layers.html');
  const panel = page.getByRole('region', { name: 'Protection layers', exact: true });
  await expect(panel).toContainText('ANTARA’s vault guardian is not switched on for this server');
  await expect(panel).toContainText('No layer status is shown.');
  await expect(page.getByTestId('gate-stage')).toHaveText('unavailable');
  await expect(page.getByTestId('release-block')).toContainText('deposits and releases are paused here');
  await expect(panel.locator('[data-layer]')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(STATUS_WORDS);

  answer = { status: 500, json: { error: 'Internal error.' } };
  await panel.getByRole('button', { name: 'Try again' }).click();
  await expect(panel).toContainText('Protection layers cannot be shown right now. Internal error.');
  await expect(page.locator('main')).not.toContainText(STATUS_WORDS);

  // A 200 that leaks an unmasked address, or overstates a badge, is refused like a failure.
  const leaky = layersFixture();
  (leaky.layers[1].items as Record<string, unknown>[])[0].detail = 'IPv4 203.0.113.7/32';
  answer = { status: 200, json: leaky };
  await panel.getByRole('button', { name: 'Try again' }).click();
  await expect(panel).toContainText('unexpected layer response');
  await expect(page.locator('main')).not.toContainText(STATUS_WORDS);
  const overstated = layersFixture();
  overstated.layers[3].kinds = ['cryptographic'];
  answer = { status: 200, json: overstated };
  await panel.getByRole('button', { name: 'Try again' }).click();
  await expect(panel).toContainText('unexpected layer response');
  await expect(page.locator('main')).not.toContainText(STATUS_WORDS);
  expect(errors).toEqual([]);
});

test('vault protection layers render every state from the server in simple rows, with the honest detail in each sheet, and cancel a pending change', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let view = layersFixture();
  const seen = await mockPairedApi(page, {
    '/solana/layers': () => ({ status: 200, json: view }),
    '/solana/layers/change/cancel': body => {
      view = { ...view, configVersion: 8, pending: view.pending.filter(item => item.id !== body.changeId),
        layers: view.layers.map(layer => layer.id !== 'geolocation' ? layer : { id: layer.id, kinds: layer.kinds, status: 'enrolled', enforced: true, items: layer.items }) };
      return { status: 200, json: { status: 'cancelled', configVersion: 8 } };
    },
  });
  await page.goto('/tests/fixtures/layers.html');
  const panel = page.getByRole('region', { name: 'Protection layers', exact: true });
  await expect(page.getByTestId('gate-stage')).toHaveText('ready');
  const row = (id: string) => panel.locator(`.vl-row[data-layer="${id}"]`);
  await expect(panel.locator('.vl-row')).toHaveCount(6);
  expect(await panel.locator('.vl-row').evaluateAll(items => items.map(item => item.getAttribute('data-layer')))).toEqual(['biometrics', 'geolocation', 'wifi', 'bluetooth', 'mfa', 'limits']);
  await expect(panel).toContainText('5 of 6 layers on.');
  // The list carries no badge or internal term; the honest detail is inside each sheet.
  await expect(panel.locator('.vl-list')).not.toContainText(/Device-reported|Server-observed|Cryptographic|Enrolled|Checked on every release/);

  await expect(row('bluetooth').locator('.vl-pill')).toHaveText('Off');
  await expect(row('bluetooth').getByRole('button')).toHaveText('Turn on');
  await expect(row('wifi').locator('.vl-pill')).toHaveText('On');
  await expect(row('wifi')).toContainText('Home');
  await expect(row('biometrics').locator('.vl-pill')).toHaveText('On · Required');
  await expect(row('biometrics')).toContainText('Windows Hello · 1 waiting');
  await expect(row('geolocation').locator('.vl-pill')).toHaveText('Turning off');
  await expect(row('geolocation')).toContainText('Turns off');
  await expect(row('geolocation')).not.toContainText(/48\.|2\.35/);
  await expect(row('mfa')).toContainText('Phone app');
  // Owner decision 2026-10-13: Limits is optional, with caps the user set (here: SOL both ways, USDC per day only).
  await expect(row('limits')).toContainText('0.5 SOL per release · 2 SOL per day · 200 USDC per day');

  await row('wifi').getByRole('button', { name: 'Manage: Wi-Fi' }).click();
  let sheet = page.getByRole('dialog', { name: 'Wi-Fi' });
  // The list shows the name and when it was added; the raw address range is one tap away, under "How ANTARA checks this".
  await expect(sheet.getByRole('list', { name: 'Wi-Fi settings' })).not.toContainText('IPv4');
  await expect(sheet).toContainText('You’re not on one of these networks now.');
  await sheet.getByText('How ANTARA checks this').click();
  await expect(sheet).toContainText('Anyone on the same network, or a VPN that exits there, shares that address.');
  await expect(sheet.locator('.vl-how')).toContainText('Home: IPv4 203.0.x.x/32');
  await sheet.getByRole('button', { name: 'Close' }).click();

  await row('biometrics').getByRole('button', { name: 'Manage: Biometrics' }).click();
  sheet = page.getByRole('dialog', { name: 'Biometrics' });
  await expect(sheet.locator('li[data-state="pending-addition"]')).toContainText('Phone');
  await expect(sheet.locator('li[data-state="pending-addition"]')).toContainText('Takes effect');
  // Only one passkey is in force, and a passkey is required: it cannot be removed, and Biometrics cannot be turned off.
  await expect(sheet.getByRole('button', { name: 'Remove Windows Hello' })).toHaveCount(0);
  await expect(sheet).toContainText('A vault always needs a passkey. Add another one before removing this one.');
  await expect(sheet.getByRole('button', { name: /Turn off/ })).toHaveCount(0);
  await sheet.getByText('How ANTARA checks this').click();
  await expect(sheet).toContainText('ANTARA never receives biometric data.');
  await sheet.getByRole('button', { name: 'Close' }).click();

  await row('limits').getByRole('button', { name: 'Manage: Limits' }).click();
  sheet = page.getByRole('dialog', { name: 'Limits' });
  await expect(sheet.getByLabel('SOL per release')).toHaveValue('0.5');
  await expect(sheet.getByLabel('USDC per day')).toHaveValue('200');
  await expect(sheet.getByRole('button', { name: 'Save limits', exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Turn off Limits', exact: true })).toBeVisible();
  await expect(sheet).not.toContainText(/per 24 hours|ANTARA’s limits|Always on/i);
  await sheet.getByRole('button', { name: 'Close' }).click();

  await panel.getByText('Your devices · 1').click();
  await expect(panel.getByRole('region', { name: 'Your devices' })).toContainText('ANTARA Desktop');
  await expect(panel.getByRole('region', { name: 'Your devices' })).toContainText('not in secure hardware');
  // No standalone "trust" button: the flows that read from this device set it up themselves.
  await expect(panel.getByRole('button', { name: /Trust this device|Set up this/ })).toHaveCount(0);
  await expect(panel).toContainText('ANTARA does not send notifications about pending changes. Check this screen.');
  await expect(page.locator('main')).not.toContainText(NEVER_CLAIMS);
  await expect(page.locator('main')).not.toContainText('—');

  const pending = panel.getByLabel('Pending changes list').locator('li');
  await expect(pending).toHaveCount(2);
  await panel.getByRole('button', { name: 'Cancel: Turn off Safe Zones' }).click();
  await expect(pending).toHaveCount(1);
  await expect(row('geolocation').locator('.vl-pill')).toHaveText('On');
  await expect(panel).toContainText('Cancelled: Turn off Safe Zones.');
  expect(seen.filter(item => item.path === '/solana/layers/change/cancel').map(item => item.body)).toEqual([{ multisig: FIXTURE_MULTISIG, changeId: 'chg_b2' }]);
  await page.screenshot({ path: 'artifacts/antara-vault-layers.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/antara-vault-layers-mobile.png', fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('a vault without a passkey pauses releases and asks for one before anything else', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const tighten = { ...enrollChallengeFixture(), class: 'tighten', effectiveAt: null, required: [{ id: 'mfa', evidence: 'server' }, { id: 'limits', evidence: 'server' }],
    webauthn: { get: null, create: enrollChallengeFixture().webauthn.create } };
  const seen = await mockPairedApi(page, {
    '/solana/layers': () => ({ status: 200, json: emptyLayersFixture() }),
    '/solana/layers/enroll/begin': () => ({ status: 200, json: tighten }),
  });
  await page.goto('/tests/fixtures/layers.html');
  const panel = page.getByRole('region', { name: 'Protection layers', exact: true });
  await expect(page.getByTestId('gate-stage')).toHaveText('activate-passkey');
  await expect(page.getByTestId('release-block')).toContainText('add a passkey to finish activating this vault');
  const biometrics = panel.locator('.vl-row[data-layer="biometrics"]');
  await expect(biometrics.locator('.vl-pill')).toHaveText('Required');
  await biometrics.getByRole('button', { name: 'Add a passkey: Biometrics' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a passkey' });
  // The first passkey, then this device is trusted in the same flow.
  await expect(sheet.getByRole('list', { name: 'What happens next' }).locator('li')).toHaveText([/Create your passkey/, /Set up this browser/]);
  await sheet.getByRole('button', { name: 'Add a passkey', exact: true }).click();
  // The fake authenticator cancels: nothing is sent to finish, and the calm card offers Try again.
  await expect(sheet.locator('.vl-problem')).toContainText('The passkey prompt was cancelled or timed out. Nothing was approved.');
  await expect(sheet.getByRole('button', { name: 'Try again' })).toBeVisible();
  // The registration ran over the challenge derived from this nonce and digest (section 6.2), not just any server value.
  expect(await layerCalls(page)).toEqual([`register:${FIXTURE_WEBAUTHN_CREATE}`]);
  expect(seen.map(item => item.path)).toEqual(['/solana/layers', '/solana/layers/enroll/begin']);
  expect(seen[1].body).toEqual({ multisig: FIXTURE_MULTISIG, op: { type: 'passkey.add', label: 'Passkey' } });
  expect(errors).toEqual([]);
});

test('layers-required opens the approval panel, sends bound evidence, and shows each failed layer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const challenge = { ...releaseChallengeFixture(), required: [{ id: 'biometrics', evidence: 'passkey' }, { id: 'mfa', evidence: 'server' }, { id: 'limits', evidence: 'server' }], devices: [] };
  let approvals = 0;
  const seen = await mockPairedApi(page, {
    '/solana/layers': () => ({ status: 200, json: layersFixture() }),
    '/solana/layers/approval/begin': () => ({ status: 200, json: challenge }),
    '/solana/approve': body => {
      approvals += 1;
      if (!body.layers) return { status: 403, json: { error: 'Verify your protection layers to approve this release.', code: 'layers-required', required: challenge.required } };
      if (approvals === 2) return { status: 403, json: { error: 'A protection layer did not pass. Nothing was approved.', code: 'layer-failed', layers: [{ id: 'biometrics', ok: false, reason: 'The passkey check did not pass.' }, { id: 'mfa', ok: true }] } };
      return { status: 200, json: { status: 'approved', signature: '5'.repeat(88), asset: 'SOL', amountRaw: '250000000', recipient: FIXTURE_RECIPIENT } };
    },
  });
  await page.goto('/tests/fixtures/layers.html');
  await page.getByRole('button', { name: 'Continue release', exact: true }).click();
  const approval = page.getByRole('region', { name: 'Verify this release' });
  await expect(approval).toContainText('Release #12 · 0.25 SOL to');
  await expect(approval.getByRole('list', { name: 'Required protection layers' }).locator('li')).toHaveCount(3);
  await expect(approval).toContainText('Layers are checked by ANTARA\'s server; a compromised ANTARA server could skip them.');
  // This vault has pending loosening changes: the release check says so before the user verifies.
  await expect(approval.getByRole('alert', { name: 'Pending protection change' })).toContainText('A change that weakens this vault’s protection takes effect on');
  // The release was read on this device after begin, and no prompt ran before the click.
  expect(await layerCalls(page)).toEqual(['read-proposal']);
  await approval.getByRole('button', { name: 'Verify and approve' }).click();
  await expect(approval.locator('li[data-layer="biometrics"]')).toContainText('The passkey check did not pass.');
  await expect(approval.getByRole('alert').filter({ hasText: 'did not pass' })).toContainText('A protection layer did not pass. Nothing was approved.');
  await page.screenshot({ path: 'artifacts/antara-vault-layer-approval.png', fullPage: true, animations: 'disabled' });
  expect(await layerCalls(page)).toEqual(['read-proposal', `passkey:${FIXTURE_WEBAUTHN_GET}`]);
  const sent = seen.filter(item => item.path === '/solana/approve').map(item => item.body);
  expect(sent[0]).toEqual({ multisig: FIXTURE_MULTISIG, transactionIndex: '12' });
  expect(Object.keys(sent[1]!)).toEqual(['multisig', 'transactionIndex', 'layers']);
  expect(Object.keys(sent[1]!.layers as object)).toEqual(['challengeId', 'passkey']);
  // The challenge is spent: the next attempt begins again (as PairedSolanaVault does, re-reading the release on this device), then approves.
  await approval.getByRole('button', { name: 'Start again' }).click();
  await approval.getByRole('button', { name: 'Verify and approve' }).click();
  await expect(page.getByTestId('release-status')).toHaveText('Approved: approved');
  expect(seen.filter(item => item.path === '/solana/layers/approval/begin')).toHaveLength(2);
  expect(seen.filter(item => item.path === '/solana/approve').map(item => 'layers' in (item.body ?? {}))).toEqual([false, true, true]);
  expect(await layerCalls(page)).toEqual(['read-proposal', `passkey:${FIXTURE_WEBAUTHN_GET}`, 'read-proposal', `passkey:${FIXTURE_WEBAUTHN_GET}`]);
  expect(errors).toEqual([]);
});

test('a stale check restarts once through begin, re-reading the release, without a bare approval', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const challenge = { ...releaseChallengeFixture(), required: [{ id: 'biometrics', evidence: 'passkey' }, { id: 'mfa', evidence: 'server' }, { id: 'limits', evidence: 'server' }], devices: [] };
  let approvals = 0;
  const seen = await mockPairedApi(page, {
    '/solana/layers': () => ({ status: 200, json: emptyLayersFixture(false) }),
    '/solana/layers/approval/begin': () => ({ status: 200, json: challenge }),
    '/solana/approve': body => {
      approvals += 1;
      if (!body.layers) return { status: 403, json: { error: 'Verify your protection layers.', code: 'layers-required', required: challenge.required } };
      if (approvals === 2) return { status: 409, json: { error: 'The vault or its protection layers changed after verification started. Start again.', code: 'challenge-stale' } };
      return { status: 200, json: { status: 'approved', signature: '5'.repeat(88), asset: 'SOL', amountRaw: '250000000', recipient: FIXTURE_RECIPIENT } };
    },
  });
  await page.goto('/tests/fixtures/layers.html');
  await page.getByRole('button', { name: 'Continue release', exact: true }).click();
  const approval = page.getByRole('region', { name: 'Verify this release' });
  await approval.getByRole('button', { name: 'Verify and approve' }).click();
  await expect(approval).toContainText('Something changed since this check started');
  await expect(approval.getByRole('button', { name: 'Verify and approve' })).toBeEnabled();
  expect(await layerCalls(page)).toEqual(['read-proposal', `passkey:${FIXTURE_WEBAUTHN_GET}`, 'read-proposal']);
  await approval.getByRole('button', { name: 'Verify and approve' }).click();
  await expect(page.getByTestId('release-status')).toHaveText('Approved: approved');
  expect(seen.filter(item => item.path === '/solana/approve').map(item => 'layers' in (item.body ?? {}))).toEqual([false, true, true]);
  expect(seen.filter(item => item.path === '/solana/layers/approval/begin')).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('a pending recovery change stays visible and cancelable whatever its label looks like, on the vault and in settings', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let label: string = LABELS_THAT_LOOK_UNMASKED[0];
  let cancelled = false;
  const seen = await mockPairedApi(page, {
    '/solana/layers': () => {
      const view = recoveryPendingFixture(label);
      if (cancelled) {
        view.pending = view.pending.filter(item => item.id !== 'chg_r7');
        view.layers[2].items = (view.layers[2].items as Record<string, unknown>[]).filter(item => item.changeId !== 'chg_r7');
      }
      return { status: 200, json: view };
    },
    '/solana/layers/change/cancel': () => { cancelled = true; return { status: 200, json: { status: 'cancelled', configVersion: 8 } }; },
  });
  const panel = page.getByRole('region', { name: 'Protection layers', exact: true });
  const warning = page.getByRole('region', { name: 'Vault summary' }).getByRole('alert', { name: 'Pending protection change' });
  for (const next of LABELS_THAT_LOOK_UNMASKED) {
    label = next;
    await page.goto('/tests/fixtures/layers.html');
    await expect(page.getByTestId('gate-stage')).toHaveText('ready');
    const change = panel.getByLabel('Pending changes list').locator('li').filter({ hasText: `Add passkey "${label}"` });
    await expect(change).toContainText('Recovery · waives Biometrics');
    await expect(change.getByRole('button', { name: `Cancel: Add passkey "${label}"` })).toBeEnabled();
    // Outside settings, the vault itself warns, in fixed text that never repeats the label.
    await expect(warning).toContainText('(recovery: waives Biometrics)');
    await expect(warning).not.toContainText(label);
  }
  await warning.getByRole('button', { name: 'Review or cancel' }).click();
  await expect(page.locator('#vl-pending')).toBeFocused();
  await panel.getByRole('button', { name: `Cancel: Add passkey "${label}"` }).click();
  await expect(panel.getByLabel('Pending changes list').locator('li')).toHaveCount(1);
  await expect(warning).not.toContainText('recovery');
  expect(seen.filter(item => item.path === '/solana/layers/change/cancel').map(item => item.body)).toEqual([{ multisig: FIXTURE_MULTISIG, changeId: 'chg_r7' }]);
  await page.screenshot({ path: 'artifacts/antara-vault-layers-pending.png', fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('a layer view the wallet refuses still shows its pending changes, with Cancel and without any layer status', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let view = recoveryPendingFixture('Phone');
  (view.layers[1].items as Record<string, unknown>[])[0].detail = 'IPv4 203.0.113.7/32';
  const seen = await mockPairedApi(page, {
    '/solana/layers': () => ({ status: 200, json: view }),
    '/solana/layers/change/cancel': body => { view = { ...view, pending: view.pending.filter(item => item.id !== body.changeId) }; return { status: 200, json: { status: 'cancelled', configVersion: 8 } }; },
  });
  await page.goto('/tests/fixtures/layers.html');
  const panel = page.getByRole('region', { name: 'Protection layers', exact: true });
  await expect(panel).toContainText('unexpected layer response');
  await expect(page.getByTestId('gate-stage')).toHaveText('unavailable');
  await expect(panel.locator('[data-layer]')).toHaveCount(0);
  const pending = panel.getByLabel('Pending changes list').locator('li');
  await expect(pending).toHaveCount(2);
  await expect(pending.nth(1)).toContainText('A protection change is pending');
  await expect(pending.nth(1)).toContainText('Recovery · waives Biometrics');
  await expect(page.getByRole('region', { name: 'Vault summary' }).getByRole('alert', { name: 'Pending protection change' })).toContainText('(recovery: waives Biometrics)');
  await expect(page.locator('main')).not.toContainText(STATUS_WORDS);
  await pending.nth(1).getByRole('button', { name: /^Cancel the protection change/ }).click();
  await expect(pending).toHaveCount(1);
  expect(seen.filter(item => item.path === '/solana/layers/change/cancel').map(item => item.body)).toEqual([{ multisig: FIXTURE_MULTISIG, changeId: 'chg_r7' }]);
  await expect(page.locator('main')).not.toContainText(STATUS_WORDS);
  expect(errors).toEqual([]);
});

test('cancelling a new passkey never offers to waive the passkey already on the vault', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const seen = await mockPairedApi(page, {
    '/solana/layers': () => ({ status: 200, json: layersFixture() }),
    '/solana/layers/enroll/begin': () => ({ status: 200, json: enrollChallengeFixture() }),
  });
  await page.goto('/tests/fixtures/layers.html');
  const panel = page.getByRole('region', { name: 'Protection layers', exact: true });
  await panel.locator('.vl-row[data-layer="biometrics"]').getByRole('button', { name: 'Manage: Biometrics' }).click();
  await page.getByRole('dialog', { name: 'Biometrics' }).getByRole('button', { name: 'Add another passkey' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add another passkey' });
  await sheet.getByRole('button', { name: 'Add another passkey', exact: true }).click();
  // This server still delays the change, so its time is shown and nothing is asked before Confirm.
  await expect(sheet).toContainText('Takes effect');
  expect(await layerCalls(page)).toEqual([]);
  await sheet.getByRole('button', { name: 'Confirm' }).click();
  await expect(sheet.locator('.vl-problem')).toContainText('The passkey prompt was cancelled or timed out.');
  // The enrolled passkey verified; only the creation of the new one was cancelled.
  expect(await layerCalls(page)).toEqual([`passkey:${FIXTURE_WEBAUTHN_GET}`, `register:${FIXTURE_WEBAUTHN_CREATE}`]);
  await expect(sheet.getByRole('button', { name: /use recovery|Waive/ })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
  expect(seen.map(item => item.path)).toEqual(['/solana/layers', '/solana/layers/enroll/begin']);
  expect(errors).toEqual([]);
});

test('before a passkey only a passkey can be added, and the server’s “passkey first” refusal offers one', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let view: Record<string, unknown> = emptyLayersFixture();
  const seen = await mockPairedApi(page, {
    '/solana/layers': () => ({ status: 200, json: view }),
    '/solana/layers/enroll/begin': () => ({ status: 409, json: { error: 'Add a passkey to this vault first. Other protection changes are possible once it has one.', code: 'conflict' } }),
  });
  await page.goto('/tests/fixtures/layers.html?key=1');
  const panel = page.getByRole('region', { name: 'Protection layers', exact: true });
  // No dead buttons: each other layer says in one line why it is not offered yet.
  for (const layer of ['wifi', 'geolocation', 'bluetooth', 'mfa', 'limits']) {
    const row = panel.locator(`.vl-row[data-layer="${layer}"]`);
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(row).toContainText('Add a passkey first');
  }
  await expect(panel.getByRole('button', { name: /Trust this device|Set up this/ })).toHaveCount(0);
  await expect(panel.locator('.vl-row[data-layer="biometrics"]').getByRole('button', { name: 'Add a passkey: Biometrics' })).toBeEnabled();

  // A view that is already stale (the server has no passkey in force): the 409 turns into an "Add a passkey" action.
  view = layersFixture();
  await page.reload();
  await panel.locator('.vl-row[data-layer="wifi"]').getByRole('button', { name: 'Manage: Wi-Fi' }).click();
  await page.getByRole('dialog', { name: 'Wi-Fi' }).getByRole('button', { name: 'Trust another network' }).click();
  const sheet = page.getByRole('dialog', { name: 'Trust another network' });
  await sheet.getByRole('button', { name: 'Trust another network', exact: true }).click();
  const problem = sheet.locator('.vl-problem');
  await expect(problem).toContainText('Add a passkey to this vault first.');
  await sheet.getByRole('button', { name: 'Add a passkey', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('form', { name: /passkey/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /use recovery|Waive/ })).toHaveCount(0);
  expect(seen.filter(item => item.path === '/solana/layers/enroll/begin')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('trusting a new app while Bluetooth is on offers only the Bluetooth recovery waiver the server names', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const view = layersFixture();
  view.layers[0] = { id: 'bluetooth', kinds: ['device-reported'], status: 'enrolled', enforced: true,
    items: [{ id: 'bt_AAAAAAAAAAAAAAAA', type: 'bluetooth', label: 'Phone', detail: 'Desktop · ID …7113', state: 'active', since: '2026-10-09T08:00:00.000Z' }] };
  const refusal = 'Bluetooth is on, and no trusted Bluetooth device is set up for Web, so this app cannot pass it. Bluetooth devices are trusted per app: add this app as a recovery change that waives Bluetooth (7 days).';
  const seen = await mockPairedApi(page, {
    '/solana/layers': () => ({ status: 200, json: view }),
    '/solana/layers/enroll/begin': () => ({ status: 409, json: { error: refusal, code: 'conflict' } }),
  });
  await page.goto('/tests/fixtures/layers.html?key=1');
  const panel = page.getByRole('region', { name: 'Protection layers', exact: true });
  // Adding a safe zone reads from this browser, so the flow sets it up first; the server refuses that before any ceremony.
  await panel.locator('.vl-row[data-layer="geolocation"]').getByRole('button', { name: 'Manage: Safe Zones' }).click();
  await page.getByRole('dialog', { name: 'Safe Zones' }).getByRole('button', { name: 'Add a safe zone' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a safe zone' });
  await expect(sheet.getByRole('list', { name: 'What happens next' }).locator('li').first()).toContainText('Set up this browser');
  await sheet.getByRole('button', { name: 'Add a safe zone', exact: true }).click();
  await expect(sheet.locator('.vl-problem')).toContainText('Bluetooth devices are trusted per app');
  // Refused before any ceremony: no passkey, chooser or location prompt ran.
  expect(await layerCalls(page)).toEqual([]);
  // The waiver names the change it belongs to: setting this browser up, not the safe zone.
  const waive = sheet.getByRole('button', { name: 'Waive Bluetooth to set up this browser (7 days)' });
  await expect(waive).toBeVisible();
  await waive.click();
  await expect.poll(() => seen.filter(item => item.path === '/solana/layers/enroll/begin').length).toBe(2);
  const begins = seen.filter(item => item.path === '/solana/layers/enroll/begin');
  expect(begins[0].body).not.toHaveProperty('waive');
  expect(begins[1].body).toMatchObject({ op: { type: 'device.add', surface: 'web' }, waive: ['bluetooth'] });
  expect(errors).toEqual([]);
});

test('adding a Bluetooth device while Bluetooth is on finds the trusted device first, then signs both in one reading', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let keyId = '';
  const view = layersFixture();
  view.layers[0] = { id: 'bluetooth', kinds: ['device-reported'], status: 'enrolled', enforced: true,
    items: [{ id: 'bt_phone', type: 'bluetooth', label: 'My phone', detail: 'Web · ID …YmFy', state: 'active', since: '2026-10-09T08:00:00.000Z' }] };
  const seen = await mockPairedApi(page, {
    '/solana/layers': () => ({ status: 200, json: keyId ? { ...view, devices: [...view.devices, { keyId, label: 'Web browser', surface: 'web', state: 'active', since: '2026-10-09T08:00:00.000Z' }] } : view }),
    // This page's key is trusted already (a view read before the key was known says otherwise; the server's answer wins).
    '/solana/layers/enroll/begin': body => (body.op as { type: string }).type === 'device.add' ? { status: 409, json: { error: 'This device is already trusted for this vault.', code: 'conflict' } } : ({ status: 200, json: {
      ...enrollChallengeFixture(), devices: [{ keyId, surface: 'web' }], webauthn: { get: null, create: null }, capture: { bluetooth: 'choose' },
      required: [{ id: 'bluetooth', evidence: 'device', reading: 'bluetooth', match: [{ surface: 'web', source: 'web-bluetooth', identifier: 'Zm9vYmFy', name: 'Pixel 9' }] },
        { id: 'mfa', evidence: 'server' }, { id: 'limits', evidence: 'server' }],
    } }),
    '/solana/layers/enroll/finish': () => ({ status: 200, json: { status: 'pending', change: { id: 'chg_c3', class: 'loosen', effectiveAt: '2026-10-14T11:00:00.000Z' } } }),
  });
  await page.goto('/tests/fixtures/layers.html?key=1');
  keyId = await (await page.waitForFunction(() => (window as unknown as { __layerKeyId?: string }).__layerKeyId)).jsonValue() as string;
  const panel = page.getByRole('region', { name: 'Protection layers', exact: true });
  await panel.locator('.vl-row[data-layer="bluetooth"]').getByRole('button', { name: 'Manage: Bluetooth' }).click();
  await page.getByRole('dialog', { name: 'Bluetooth' }).getByRole('button', { name: 'Add a Bluetooth device' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a Bluetooth device' });
  await sheet.getByRole('button', { name: 'Add a Bluetooth device', exact: true }).click();
  // This server still delays the change: its time is shown first, and confirming it does not skip the Bluetooth clicks.
  await expect(sheet).toContainText('Takes effect');
  await sheet.getByRole('button', { name: 'Confirm' }).click();
  // Chrome opens a chooser only from a click: first find a trusted device, then choose the new one.
  await expect(sheet).toContainText('Chrome needs two steps');
  expect(await layerCalls(page)).toEqual([]);
  await sheet.getByRole('button', { name: 'Find your trusted device' }).click();
  await expect(sheet).toContainText('Trusted device found');
  expect(await layerCalls(page)).toEqual(['bluetooth:Pixel 9']);
  await sheet.getByRole('button', { name: 'Choose your device' }).click();
  await expect(sheet).toContainText('Add a Bluetooth device takes effect');
  expect(await layerCalls(page)).toEqual(['bluetooth:Pixel 9', 'bluetooth:any']);
  const finish = seen.find(item => item.path === '/solana/layers/enroll/finish')!.body as { device: { keyId: string; payload: string } };
  expect(finish.device.keyId).toBe(keyId);
  const payload = JSON.parse(Buffer.from(finish.device.payload, 'base64url').toString('utf8'));
  expect(payload.bluetooth.source).toBe('web-bluetooth');
  expect(payload.bluetooth.devices).toEqual([{ identifier: 'Zm9vYmFy', name: 'Pixel 9' }, { identifier: 'bmV3LWRldmljZQ', name: 'Headphones' }]);
  expect(errors).toEqual([]);
});

test('a server release that differs from the proposal on this device aborts before any prompt', async ({ page }) => {
  await mockPairedApi(page, {
    '/solana/layers': () => ({ status: 200, json: layersFixture() }),
    '/solana/layers/approval/begin': () => ({ status: 200, json: releaseChallengeFixture({ amountRaw: '2500000000' }) }),
    '/solana/approve': () => ({ status: 403, json: { error: 'Verify your protection layers.', code: 'layers-required' } }),
  });
  await page.goto('/tests/fixtures/layers.html');
  await page.getByRole('button', { name: 'Continue release', exact: true }).click();
  await expect(page.getByTestId('release-status')).toHaveText('The server described a different release. Nothing was approved.');
  await expect(page.getByRole('region', { name: 'Verify this release' })).toHaveCount(0);
  expect(await layerCalls(page)).toEqual(['read-proposal']);
});

test('the extension side panel hands layer ceremonies to the full tab without starting them', async ({ page }) => {
  const seen = await mockPairedApi(page, {
    '/solana/layers': () => ({ status: 200, json: layersFixture() }),
    '/solana/approve': () => ({ status: 403, json: { error: 'Verify your protection layers.', code: 'layers-required' } }),
  });
  await page.goto('/tests/fixtures/layers.html?panel=1');
  const panel = page.getByRole('region', { name: 'Protection layers', exact: true });
  await expect(panel).toContainText('Changes to protection continue in a full tab.');
  await expect(panel.getByRole('button', { name: 'Open in a full tab' })).toBeVisible();
  // Rows show the server's status but carry no action here: never a disabled button.
  await expect(panel.locator('.vl-row')).toHaveCount(6);
  await expect(panel.locator('.vl-list').getByRole('button')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue release', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Verify this release' }).getByRole('button', { name: 'Approve in a full tab' })).toBeVisible();
  expect(seen.map(item => item.path)).not.toContain('/solana/layers/approval/begin');
  expect(await layerCalls(page)).toEqual([]);
});

test('unknown balances are a muted 0.00 with a retry, never a dash, in swap and send', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/solares/relay/config', route => route.fulfill({ json: RELAY_CONFIG }));
  const refetches = () => page.evaluate(() => (window as unknown as { __fixtureRefetches?: number }).__fixtureRefetches ?? 0);
  await page.goto('/tests/fixtures/wallet.html?failed=base#swap');
  const card = page.locator('.trade-card');
  // Base failed to load: its USDC balance is a muted "0.00 USDC" stand-in with "Couldn't load · Retry".
  await page.getByLabel('Pay network').selectOption('8453');
  await expect(card.locator('.swap-balance')).toHaveText(/^Balance: 0\.00 USDC/);
  await expect(card.locator('.swap-balance [data-placeholder]')).toContainText('0.00 USDC');
  await expect(card.getByText("Couldn't load", { exact: true })).toBeVisible();
  // An unknown balance never enables 50% / Max.
  await expect(card.getByRole('button', { name: 'Max', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: 'Retry loading USDC balance' }).click();
  await expect.poll(refetches).toBe(1);
  // Before a quote the output is a muted "0" captioned "No quote yet".
  await expect(card.locator('.swap-estimate')).toHaveText('0');
  await expect(card.locator('.swap-quote-caption')).toHaveText('No quote yet');
  await expect(card).not.toContainText('—');
  // Solana loaded, so its balance is known and shown exactly.
  await page.getByLabel('Pay network').selectOption('792703809');
  await expect(card.getByText("Couldn't load", { exact: true })).toHaveCount(0);

  await page.goto('/tests/fixtures/wallet.html?failed=base');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const send = page.getByRole('dialog');
  await send.getByRole('combobox').first().selectOption('base');
  const baseRows = send.locator('[data-asset-row="send"][data-chain="base"]');
  await expect(baseRows).toHaveCount(2);
  for (const row of await baseRows.all()) {
    await expect(row.locator('.send-balance [data-placeholder]')).toHaveText('0.00');
    await expect(row.locator('.send-balance-caption')).toHaveText("Couldn't load");
  }
  await expect(send.locator('.send-available [data-placeholder]')).toContainText('0.00 ETH');
  await send.locator('.send-available').getByRole('button', { name: 'Retry loading balances' }).click();
  await expect.poll(refetches).toBe(1);
  await expect(send).not.toContainText('—');
  expect(errors).toEqual([]);
});
