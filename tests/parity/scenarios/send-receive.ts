/**
 * Area B parity scenarios: Receive (6.7) and Send (6.8), docs/UI_ARGUS_PARITY.md 10.3.
 *
 * - Before run: today's shell (harness.html) and its legacy dialogs, opened by clicking
 *   "Deposit" / "Send" on Wallet home. Screens that do not exist yet are "not present".
 * - After run: tests/parity/send-receive.html, which mounts ReceiveSheet and SendFlow
 *   directly (the shell keeps the legacy dialogs until the integration pass switches
 *   shell/screens.ts). Each after scenario also asserts the strings that
 *   tests/browser/{wallet,mobile}.spec.ts rely on, so the integration cannot break them
 *   silently.
 */
import { expect, type Page } from '@playwright/test';
import { PARITY_KEYS, PARITY_USER_ID } from '../keys';
import { PARITY_RUN, type ParityScenario, type StepApi, type SurfaceId } from '../types';

const AFTER = PARITY_RUN === 'after';
const PAGE = '/tests/parity/send-receive.html';
/** Send and Receive also run in the 420px panel (10.3). */
const SURFACES: readonly SurfaceId[] = ['desktop', 'mobile', 'panel-360', 'panel-420'];
const NETWORKS = ['Solana', 'Ethereum', 'BNB Smart Chain', 'Robinhood Chain', 'Base'];

/** A saved "Treasury" entry for the fixture user, as addressbook/store.ts writes it. */
export const SEEDED_BOOK = JSON.stringify({
  version: 1,
  entries: [{ id: 'parity-treasury', label: 'Treasury', family: 'solana', address: PARITY_KEYS.recipient, createdAt: '2026-10-12T09:00:00.000Z', updatedAt: '2026-10-12T09:00:00.000Z' }],
});
/** Same first 4 and last 4 characters as PARITY_KEYS.recipient, one middle character different (a valid key). */
export const LOOKALIKE = '9hSR6S7WPtxmTojgo6GG3k4yDPecgJZ292j7xrsUGWBu';

type Variant = Partial<Pick<ParityScenario, 'path' | 'state' | 'params' | 'steps' | 'storage' | 'hash' | 'truth' | 'allowConsole'>>;
interface Definition extends Omit<ParityScenario, 'path' | 'state' | 'params' | 'steps' | 'storage' | 'hash'> {
  /** null: the screen does not exist before the build ("not present before"). */
  before: Variant | null;
  after: Variant;
}

const notPresentBefore = (selector: string): Variant => ({
  steps: async ({ page, expectPresent }) => expectPresent(page.locator(selector), 'new screen', 1_500),
});
function define({ before, after, ...common }: Definition): ParityScenario {
  const variant = AFTER ? after : before ?? notPresentBefore('[data-screen="receive"], [data-screen="send"], [data-screen="address-book"]');
  const steps = variant.steps;
  // Leave nothing hovered after the steps, so the capture and the colour checks see resting states.
  return { surfaces: SURFACES, ...common, ...variant, steps: steps && (async api => { await steps(api); await api.page.mouse.move(0, 0); }) };
}

const dialog = (page: Page) => page.getByRole('dialog');
async function openLegacy({ page, click, expectPresent }: StepApi, names: string[]) {
  await click(names);
  await expectPresent(dialog(page), 'dialog');
}
async function pickSendRow(page: Page, chain: string, index = 0) {
  await page.locator(`[data-asset-row="send"][data-chain="${chain}"] button`).nth(index).click();
  await expect(page.getByLabel('Recipient', { exact: true })).toBeVisible();
}

export const entries: readonly ParityScenario[] = [
  define({
    id: 'receive-step1',
    area: 'B',
    screen: '6.7',
    title: 'Receive step 1: ten assets in registry order with QR and Copy, Network select on Solana',
    argus: ['argus-ext-popup-14-receive.png', 'argus-pwa-desktop-modal-receive.png', 'argus-pwa-mobile-modal-receive.png'],
    before: { state: 'signed-in', steps: api => openLegacy(api, ['Receive', 'Deposit']) },
    after: {
      path: PAGE, state: 'signed-in', params: { screen: 'receive' },
      steps: async ({ page }) => {
        await expect(dialog(page).getByRole('combobox')).toHaveValue('solana');
        await expect(dialog(page).getByRole('combobox').locator('option')).toHaveText(NETWORKS);
        await expect(page.locator('[data-asset-row="receive"]')).toHaveCount(10);
        await expect(page.locator('[data-asset-row="receive"]').first()).toHaveAttribute('data-chain', 'solana');
      },
    },
  }),
  define({
    id: 'receive-qr-solana-usdc',
    area: 'B',
    screen: '6.7',
    title: 'Receive step 2: USDC on Solana QR with the token mark, full address and notes',
    argus: ['argus-ext-popup-15-receive-qr-full.png', 'argus-ext-popup-15-receive-qr.png'],
    before: { state: 'signed-in', steps: api => openLegacy(api, ['Receive', 'Deposit']) },
    after: {
      path: PAGE, state: 'signed-in', params: { screen: 'receive' },
      steps: async ({ page, click }) => {
        await click('Show QR code for USDC on Solana');
        await expect(dialog(page).getByRole('heading', { name: 'Receive USDC on Solana' })).toBeVisible();
        // The QR encodes exactly the address shown, in full.
        await expect(page.locator('.rcv-qr')).toHaveAttribute('data-value', PARITY_KEYS.user);
        await expect(page.locator('.rcv-address-box')).toHaveText(PARITY_KEYS.user);
        await expect(dialog(page)).toContainText('Stablecoin on Solana: USDC (USD Coin).');
      },
    },
  }),
  define({
    id: 'receive-signed-out',
    area: 'B',
    screen: '6.7',
    title: 'Receive while signed out: Network select, sign-in prompt, no QR',
    argus: ['argus-ext-popup-14-receive.png'],
    before: { state: 'signed-out', steps: api => openLegacy(api, ['Receive', 'Deposit']) },
    after: {
      path: PAGE, state: 'signed-out', params: { screen: 'receive' },
      steps: async ({ page }) => {
        // tests/browser/wallet.spec.ts: these hold for the legacy dialog and must hold here.
        await expect(dialog(page)).toContainText('Sign in to view your receiving address.');
        await expect(dialog(page).getByRole('combobox')).toHaveValue('solana');
        await expect(dialog(page).getByRole('combobox').locator('option')).toHaveText(NETWORKS);
        await expect(dialog(page).locator('.desktop-qr, .rcv-qr')).toHaveCount(0);
      },
    },
  }),
  define({
    id: 'receive-vault',
    area: 'B',
    screen: '6.7',
    title: 'Receive, vault side (active vault): only the verified deposit address, SOL QR',
    argus: ['argus-ext-popup-15-receive-qr-full.png', 'argus-ext-popup-42-vault-sim-vault-mode.png'],
    before: null,
    after: {
      path: PAGE, state: 'signed-in', params: { screen: 'receive-vault', vault: 'active' },
      steps: async ({ page, click }) => {
        await expect(page.locator('[data-asset-row="receive"]')).toHaveCount(2);
        await click('Show QR code for SOL on Solana');
        await expect(dialog(page)).toContainText('Your vault’s deposit address');
        await expect(dialog(page)).toContainText('To your Solana vault');
        // The vault side never shows the spending wallet's address.
        await expect(dialog(page)).not.toContainText(PARITY_KEYS.user);
      },
    },
  }),
  define({
    id: 'receive-vault-blocked',
    area: 'B',
    screen: '6.7',
    title: 'Receive, vault side, passkey missing: the block reason, no address and no QR',
    argus: ['argus-ext-popup-42-vault-sim-vault-mode.png'],
    before: null,
    after: {
      path: PAGE, state: 'signed-in', params: { screen: 'receive-vault', vault: 'passkey-needed' },
      steps: async ({ page }) => {
        await expect(dialog(page)).toContainText('Add a passkey to finish activating this vault before depositing.');
        await expect(page.locator('[data-asset-row="receive"], .rcv-qr')).toHaveCount(0);
      },
    },
  }),
  define({
    id: 'send-asset',
    area: 'B',
    screen: '6.8',
    title: 'Send step 1: Network and Asset, then the ten assets with exact balances',
    argus: ['argus-ext-popup-16-send-select.png', 'argus-ext-popup-16-send.png', 'argus-pwa-desktop-modal-send.png'],
    before: { state: 'signed-in', steps: api => openLegacy(api, ['Send']) },
    after: {
      path: PAGE, state: 'signed-in', params: { screen: 'send', chain: 'robinhood' },
      steps: async ({ page }) => {
        // tests/browser/wallet.spec.ts (Robinhood Chain and BNB Smart Chain comboboxes).
        const boxes = dialog(page).getByRole('combobox');
        await expect(boxes.first()).toHaveValue('robinhood');
        await expect(boxes.nth(1).locator('option')).toHaveText(['ETH', 'USDG']);
        await boxes.first().selectOption('bsc');
        await expect(boxes.nth(1).locator('option')).toHaveText(['BNB', 'USDC (Binance-Peg)']);
        await expect(boxes.first().locator('option')).toHaveText(NETWORKS);
        await boxes.first().selectOption('solana');
        await expect(page.locator('[data-asset-row="send"]').first()).toHaveAttribute('data-chain', 'solana');
        // Base ETH is a known zero: listed, not selectable.
        await expect(page.locator('[data-asset-row="send"][data-chain="base"] button').first()).toBeDisabled();
      },
    },
  }),
  define({
    id: 'send-asset-empty',
    area: 'B',
    screen: '6.8',
    title: 'Send step 1 with every balance a known zero: "Nothing to send yet" and Receive',
    argus: ['argus-ext-popup-16-send.png'],
    before: { state: 'signed-in', params: { balances: 'empty' }, steps: api => openLegacy(api, ['Send']) },
    after: {
      path: PAGE, state: 'signed-in', params: { screen: 'send', balances: 'empty' },
      steps: async ({ page }) => {
        await expect(dialog(page)).toContainText('Nothing to send yet');
        await expect(dialog(page).getByRole('button', { name: 'Receive' })).toBeVisible();
      },
    },
  }),
  define({
    id: 'send-details-empty',
    area: 'B',
    screen: '6.8',
    title: 'Send step 2: SOL on Solana, recipient with the address book, amount and notes',
    argus: ['argus-ext-popup-17-send-details.png', 'argus-pwa-desktop-modal-send.png'],
    before: { state: 'signed-in', steps: api => openLegacy(api, ['Send']) },
    after: {
      path: PAGE, state: 'signed-in', params: { screen: 'send' },
      steps: async ({ page }) => {
        await pickSendRow(page, 'solana');
        await expect(dialog(page).getByRole('heading', { name: 'Send SOL on Solana' })).toBeVisible();
        await expect(dialog(page).getByRole('button', { name: 'Review transfer' })).toBeDisabled();
      },
    },
  }),
  define({
    id: 'send-details-insufficient',
    area: 'B',
    screen: '6.8',
    title: 'Send step 2: amount above the known balance, "Not enough SOL." and Review disabled',
    argus: ['argus-ext-popup-17-send-details-filled.png'],
    before: {
      state: 'signed-in',
      steps: async api => {
        await openLegacy(api, ['Send']);
        await api.page.getByLabel('Recipient address').fill(PARITY_KEYS.recipient);
        await api.page.getByLabel('Amount').fill('5');
      },
    },
    after: {
      path: PAGE, state: 'signed-in', params: { screen: 'send' },
      steps: async ({ page }) => {
        await pickSendRow(page, 'solana');
        await page.getByLabel('Recipient', { exact: true }).fill(PARITY_KEYS.recipient);
        await page.getByLabel('Amount', { exact: true }).fill('5');
        await expect(dialog(page)).toContainText('Not enough SOL.');
        await expect(dialog(page).getByRole('button', { name: 'Review transfer' })).toBeDisabled();
      },
    },
  }),
  define({
    id: 'send-details-lookalike',
    area: 'B',
    screen: '6.8',
    title: 'Send step 2: a recipient that looks like the saved "Treasury" gets the poisoning warning',
    argus: ['argus-ext-popup-17-send-details-filled.png'],
    before: {
      state: 'signed-in',
      steps: async api => {
        await openLegacy(api, ['Send']);
        await api.page.getByLabel('Recipient address').fill(LOOKALIKE);
        await api.expectPresent(api.page.getByText(/looks like Treasury/), 'lookalike warning', 1_500);
      },
    },
    after: {
      path: PAGE, state: 'signed-in', params: { screen: 'send' },
      storage: { [`solares.address-book.v1:${PARITY_USER_ID}`]: SEEDED_BOOK },
      steps: async ({ page }) => {
        await pickSendRow(page, 'solana');
        await page.getByLabel('Recipient', { exact: true }).fill(LOOKALIKE);
        await page.getByLabel('Amount', { exact: true }).fill('0.1');
        await expect(dialog(page)).toContainText('This address looks like Treasury but is different. Check every character.');
      },
    },
  }),
  define({
    id: 'send-review',
    area: 'B',
    screen: '6.8',
    title: 'Send step 3: review from the RPC fake (blockhash, fee), full addresses, Visibility row',
    argus: ['argus-ext-popup-18-send-confirm.png', 'argus-ext-popup-32-simple-send-confirm.png'],
    before: {
      state: 'signed-in',
      steps: async api => {
        await openLegacy(api, ['Send']);
        await api.page.getByLabel('Recipient address').fill(PARITY_KEYS.recipient);
        await api.page.getByLabel('Amount').fill('0.1');
        await api.click('Review transfer');
        await api.expectPresent(api.page.getByRole('heading', { name: 'Review your transfer.' }), 'legacy review', 15_000);
      },
    },
    after: {
      path: PAGE, state: 'signed-in', params: { screen: 'send' },
      storage: { [`solares.address-book.v1:${PARITY_USER_ID}`]: SEEDED_BOOK },
      steps: async ({ page, click }) => {
        await pickSendRow(page, 'solana');
        await page.getByLabel('Recipient', { exact: true }).fill(PARITY_KEYS.recipient);
        await page.getByLabel('Amount', { exact: true }).fill('0.1');
        await click('Review transfer');
        await expect(dialog(page).getByRole('heading', { name: 'Review your transfer.' })).toBeVisible({ timeout: 15_000 });
        await expect(dialog(page)).toContainText('Public on-chain transaction');
        await expect(dialog(page)).toContainText('0.000005 SOL');
        await expect(dialog(page)).toContainText(PARITY_KEYS.recipient);
        await expect(dialog(page)).toContainText('Saved as Treasury');
      },
    },
  }),
  define({
    id: 'send-signed-out',
    area: 'B',
    screen: '6.8',
    title: 'Send while signed out: "Sign in to send assets." and the Close transfer button',
    argus: ['argus-ext-popup-16-send.png'],
    before: { state: 'signed-out', steps: api => openLegacy(api, ['Send']) },
    after: {
      path: PAGE, state: 'signed-out', params: { screen: 'send' },
      steps: async ({ page }) => {
        await expect(dialog(page)).toContainText('Sign in to send assets.');
        await expect(dialog(page).getByRole('heading', { name: 'Send assets' })).toBeVisible();
        await expect(dialog(page).getByRole('button', { name: 'Close transfer' })).toBeVisible();
      },
    },
  }),
];
