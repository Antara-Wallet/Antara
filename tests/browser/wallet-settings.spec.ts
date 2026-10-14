import { test, expect, type Locator, type Page } from '@playwright/test';

// The Wallets drawer and the per-wallet settings sheet (src/solares/shell/AccountSheet.tsx,
// WalletSettings.tsx) on the wallet fixture in its `?wallets=owner` mode: the embedded Solana
// wallet (Privy's standard wallet name "Privy"), a connected Phantom, and the embedded EVM
// wallet (client type "privy"). Export never reaches Privy here: the fixture records the call.
// WALLET_SHOTS_DIR saves the review screenshots elsewhere (default artifacts/).
const SHOTS = process.env.WALLET_SHOTS_DIR || 'artifacts';
const SOLANA_ANTARA = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const EVM_ANTARA = '0x7e6cb1a2c3d4e5f60718293a4b5c6d7e8f9f9805';
const OWNER = '/tests/fixtures/wallet.html?wallets=owner';

async function openDrawer(page: Page, width: number, url = OWNER) {
  await page.setViewportSize({ width, height: width <= 420 ? 820 : 900 });
  await page.goto(url);
  await page.getByRole('button', { name: 'Select wallet', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Wallets' });
  await expect(drawer).toBeVisible();
  // Let the drawer's entrance animation settle before measuring.
  await page.waitForTimeout(350);
  return drawer;
}

/** Every card and action inside the sheet body's content box, and no sideways scroll anywhere. */
async function overflow(drawer: Locator) {
  return drawer.evaluate(dialog => {
    const body = dialog.querySelector<HTMLElement>('.ui-sheet-body')!;
    const style = getComputedStyle(body);
    const rect = body.getBoundingClientRect();
    const left = rect.left + parseFloat(style.paddingLeft) - 0.5;
    const right = rect.right - parseFloat(style.paddingRight) + 0.5;
    const outside = [...body.querySelectorAll<HTMLElement>('.shell-account-card, .shell-vault-row, .shell-account-action, .shell-account-heading')]
      .filter(element => { const box = element.getBoundingClientRect(); return box.left < left || box.right > right; })
      .map(element => element.className);
    const scrolling = [dialog as HTMLElement, body, ...body.querySelectorAll<HTMLElement>('.shell-account-card, .shell-vault-row')]
      .filter(element => element.scrollWidth > element.clientWidth + 1)
      .map(element => element.className);
    return { outside, scrolling, padding: [style.paddingLeft, style.paddingRight], page: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  });
}

for (const width of [1440, 1024, 420, 360]) {
  test(`the Wallets drawer fits at ${width}px, names the ANTARA wallet and never scrolls sideways`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const drawer = await openDrawer(page, width);
    const solana = drawer.getByRole('region', { name: 'Solana' });
    const evm = drawer.getByRole('region', { name: /^EVM/ });
    // The embedded wallets are the ANTARA wallet; Phantom keeps its name with an External tag.
    await expect(solana.getByRole('button', { name: /^ANTARA wallet AKnL4N…aRSZ9/ })).toBeVisible();
    await expect(solana.getByRole('button', { name: /^Phantom External EMX22G…ny5tD/ })).toBeVisible();
    await expect(evm.getByRole('button', { name: /^ANTARA wallet 0x7e6c…f9805/ })).toBeVisible();
    await expect(drawer).not.toContainText(/privy/i);
    await expect(page.getByRole('button', { name: 'Select wallet', exact: true })).toContainText('ANTARA wallet');
    // One cog per wallet.
    await expect(drawer.getByRole('button', { name: /^Wallet settings for / })).toHaveCount(3);
    // The Vault row sits only under the ANTARA Solana wallet.
    await expect(drawer.locator('.shell-vault-row')).toHaveCount(1);
    await expect(solana.locator('.shell-account-item').first().locator('.shell-vault-row')).toHaveCount(1);
    await expect(evm.locator('.shell-vault-row')).toHaveCount(0);

    expect(await overflow(drawer)).toEqual({ outside: [], scrolling: [], padding: [expect.any(String), expect.any(String)], page: false });
    const { padding } = await overflow(drawer);
    expect(padding[0]).toBe(padding[1]);
    // The cog sits inset from the card's edge (its hover and focus ring stay inside the border),
    // and the Vault row's arrow is centred under it.
    const geometry = await drawer.evaluate(dialog => {
      const card = dialog.querySelector('.shell-account-card')!.getBoundingClientRect();
      const cog = dialog.querySelector('.shell-account-card > .shell-account-cog')!.getBoundingClientRect();
      const arrow = dialog.querySelector('.shell-vault-arrow')!.getBoundingClientRect();
      return { inset: card.right - cog.right, offset: Math.abs((arrow.left + arrow.right) / 2 - (cog.left + cog.right) / 2) };
    });
    expect(geometry.inset).toBeGreaterThanOrEqual(6);
    expect(geometry.offset).toBeLessThanOrEqual(2);
    if (width === 1440 || width === 420) await page.screenshot({ path: `${SHOTS}/wallets-drawer-${width}.png`, animations: 'disabled' });

    // The owner's worst case: a long wallet name and the longest vault status still fit (truncated / wrapped).
    await drawer.evaluate(dialog => {
      const names = dialog.querySelectorAll('.shell-account-name strong');
      names[1].textContent = 'Phantom Wallet with an unusually long connector name for testing';
      const chip = dialog.querySelector('.shell-vault-chip .ui-chip-label');
      if (chip) chip.textContent = 'Use your ANTARA wallet for the vault · releases paused';
    });
    expect((await overflow(drawer)).outside).toEqual([]);
    expect((await overflow(drawer)).scrolling).toEqual([]);
    expect(errors).toEqual([]);
  });
}

for (const width of [1440, 420]) {
  test(`at ${width}px the cog opens the wallet's settings and export warns before Privy's window opens`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const drawer = await openDrawer(page, width);
    const cog = drawer.getByRole('region', { name: 'Solana' }).getByRole('button', { name: /^Wallet settings for ANTARA wallet/ });
    await cog.click();
    const sheet = page.getByRole('dialog', { name: 'Wallet settings' });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.wset-name strong')).toHaveText('ANTARA wallet');
    // The full address with copy, and Solscan.
    await expect(sheet.locator('.ui-address-text')).toHaveText(SOLANA_ANTARA);
    await expect(sheet.getByRole('button', { name: 'Copy ANTARA wallet address' })).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'View on Solscan (Solana)' })).toHaveAttribute('href', `https://solscan.io/account/${SOLANA_ANTARA}`);
    await page.waitForTimeout(350);
    // The full address never leaves a short fragment alone on a second line.
    const lines = await sheet.locator('.wset-address .ui-address-text').evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const rows = new Map<number, number>();
      for (const rect of range.getClientRects()) rows.set(Math.round(rect.top), (rows.get(Math.round(rect.top)) ?? 0) + rect.width);
      return [...rows.values()];
    });
    expect(lines.length).toBeLessThanOrEqual(2);
    if (lines.length === 2) expect(Math.min(...lines) / Math.max(...lines)).toBeGreaterThan(0.5);
    if (width === 1440) await page.screenshot({ path: `${SHOTS}/wallet-settings-sheet-${width}.png`, animations: 'disabled' });

    // The ANTARA warning comes first; nothing reaches Privy until it is acknowledged.
    await sheet.getByRole('button', { name: 'Export private key' }).click();
    await expect(sheet.getByRole('heading', { name: 'Before you export' })).toBeVisible();
    await expect(sheet).toContainText('Anyone with this key controls this wallet’s funds.');
    await expect(sheet).toContainText('ANTARA never sees, stores or copies it.');
    await expect(sheet).toContainText('clear your clipboard afterwards');
    // This build has no vault (no guardian pinned), so the warning never promises one.
    await expect(sheet).not.toContainText('releases still need ANTARA’s guardian');
    // Only the EVM export offers a recovery phrase.
    await expect(sheet).not.toContainText('recovery phrase');
    const proceed = sheet.getByRole('button', { name: 'Continue to secure export' });
    await expect(proceed).toBeDisabled();
    expect(await page.evaluate(() => (window as unknown as { __fixtureExports: string[] }).__fixtureExports)).toEqual([]);
    await sheet.getByRole('checkbox', { name: /I understand/ }).check();
    await expect(proceed).toBeEnabled();
    await page.screenshot({ path: `${SHOTS}/wallet-export-warning-${width}.png`, animations: 'disabled' });
    const sheetOverflow = await sheet.evaluate(dialog => [...dialog.querySelectorAll<HTMLElement>('*')].filter(element => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== 'visible').map(element => element.className));
    expect(sheetOverflow).toEqual([]);
    await proceed.click();
    expect(await page.evaluate(() => (window as unknown as { __fixtureExports: string[] }).__fixtureExports)).toEqual([`solana:${SOLANA_ANTARA}`]);
    await expect(sheet.getByRole('status')).toHaveText('Privy’s export window closed. ANTARA never received your key.');
    await expect(sheet.getByRole('button', { name: 'Export private key' })).toBeFocused();

    // Escape closes only the settings sheet and returns focus to the cog.
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(cog).toBeFocused();

    // An external wallet is exported from its own app: guidance, no export button.
    await drawer.getByRole('button', { name: /^Wallet settings for Phantom/ }).click();
    await expect(sheet.getByRole('heading', { name: 'Export from Phantom' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Export private key' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The EVM ANTARA wallet: every supported EVM explorer, and its own export.
    await drawer.getByRole('region', { name: /^EVM/ }).getByRole('button', { name: /^Wallet settings for ANTARA wallet/ }).click();
    await expect(sheet.getByRole('link', { name: /^View on / })).toHaveText([/Etherscan/, /BscScan/, /Blockscout/, /Basescan/]);
    await expect(sheet.locator('.wset-name strong')).toHaveText('ANTARA wallet');
    await expect(sheet.locator('.ui-address-text')).toHaveText(EVM_ANTARA);
    if (width === 1440) { await page.waitForTimeout(350); await page.screenshot({ path: `${SHOTS}/wallet-settings-evm-${width}.png`, animations: 'disabled' }); }
    await sheet.getByRole('button', { name: 'Export private key' }).click();
    await expect(sheet).not.toContainText('releases still need ANTARA’s guardian');
    // Privy's EVM export also offers a recovery phrase, which can restore the ANTARA Solana wallet.
    await expect(sheet).toContainText('Privy may also show a recovery phrase.');
    await expect(sheet).toContainText('It can restore your ANTARA Solana wallet too. Treat exporting it as exporting both wallets.');
    await expect(sheet.getByRole('checkbox', { name: 'I understand that anyone with this key or recovery phrase controls this wallet’s funds.' })).toBeVisible();
    if (width === 1440) await page.screenshot({ path: `${SHOTS}/wallet-export-warning-evm-${width}.png`, animations: 'disabled' });
    await sheet.getByRole('checkbox', { name: /I understand/ }).check();
    await sheet.getByRole('button', { name: 'Continue to secure export' }).click();
    expect(await page.evaluate(() => (window as unknown as { __fixtureExports: string[] }).__fixtureExports)).toEqual([`solana:${SOLANA_ANTARA}`, `ethereum:${EVM_ANTARA}`]);
    expect(errors).toEqual([]);
  });
}

test('a failed export says why in plain words and never shows the provider’s raw error', async ({ page }) => {
  const drawer = await openDrawer(page, 1440, `${OWNER}&export=disabled`);
  await drawer.getByRole('region', { name: 'Solana' }).getByRole('button', { name: /^Wallet settings for ANTARA wallet/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Wallet settings' });
  await sheet.getByRole('button', { name: 'Export private key' }).click();
  await sheet.getByRole('checkbox', { name: /I understand/ }).check();
  await sheet.getByRole('button', { name: 'Continue to secure export' }).click();
  await expect(sheet.getByRole('alert')).toHaveText('Key export is turned off for ANTARA’s sign-in provider. Nothing was shown.');
  await expect(sheet).not.toContainText('disabled for this app');
  // Still on the warning step, ready to retry or go back.
  await expect(sheet.getByRole('button', { name: 'Continue to secure export' })).toBeEnabled();
  await sheet.getByRole('button', { name: 'Back to wallet settings' }).click();
  await expect(sheet.getByRole('button', { name: 'Export private key' })).toBeVisible();
});

test('the address book names your own wallets as everywhere else, with External on Phantom', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${OWNER}#addressbook`);
  const own = page.locator('.ab-section').filter({ has: page.getByRole('heading', { name: 'Your wallets' }) });
  await expect(own.locator('.ab-name')).toHaveText(['ANTARA wallet', 'Phantom', 'ANTARA wallet']);
  await expect(own.locator('.ab-row').nth(1)).toContainText('External');
  await expect(own.locator('.ab-row').nth(0)).not.toContainText('External');
  await expect(own).not.toContainText(/privy/i);
});

test('choosing the Vault row while Phantom is selected switches to the ANTARA wallet first', async ({ page }) => {
  const drawer = await openDrawer(page, 1440);
  await drawer.getByRole('button', { name: /^Phantom External/ }).click();
  await expect(page.getByRole('button', { name: 'Select wallet', exact: true })).toContainText('Phantom');
  await page.getByRole('button', { name: 'Select wallet', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: 'Wallets' });
  await expect(reopened.locator('.shell-vault-row')).toContainText('Select to view');
  await reopened.locator('.shell-vault-row').click();
  await expect(page.getByRole('button', { name: 'Select wallet', exact: true })).toContainText('ANTARA wallet');
  await expect(page.getByRole('tab', { name: 'Vault', exact: true })).toHaveAttribute('aria-selected', 'true');
});

for (const width of [1440, 420]) {
  test(`Settings › Wallets at ${width}px lists the same wallets with the same cog`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${OWNER}#settings`);
    const wallets = page.getByRole('region', { name: 'Wallets' });
    await expect(wallets.locator('.set-wallet-name')).toHaveText(['ANTARA wallet', 'Phantom', 'ANTARA wallet']);
    await expect(wallets.locator('.set-wallet-tag')).toHaveText(['External']);
    await expect(wallets).not.toContainText(/privy/i);
    const overflowing = await wallets.evaluate(section => [...section.querySelectorAll<HTMLElement>('.set-wallet')].filter(row => row.scrollWidth > row.clientWidth + 1).length);
    expect(overflowing).toBe(0);
    await wallets.getByRole('button', { name: /^Wallet settings for ANTARA wallet AKnL4N/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Wallet settings' });
    await expect(sheet.getByRole('button', { name: 'Export private key' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Export private key' }).click();
    await expect(sheet.getByRole('heading', { name: 'Before you export' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });
}
