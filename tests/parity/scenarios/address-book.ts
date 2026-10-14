/**
 * Area B parity scenarios: the address book (6.9), docs/UI_ARGUS_PARITY.md 10.3.
 * The screen is new, so every id is "not present" in the before run. The after run
 * mounts AddressBookScreen on tests/parity/send-receive.html (Settings embeds it in the
 * integration pass).
 */
import { expect } from '@playwright/test';
import { PARITY_EVM_WALLETS, PARITY_KEYS, PARITY_USER_ID } from '../keys';
import { PARITY_RUN, type ParityScenario } from '../types';

const AFTER = PARITY_RUN === 'after';
const BOOK_KEY = `solares.address-book.v1:${PARITY_USER_ID}`;
const at = '2026-10-12T09:00:00.000Z';

/** Saved entries as addressbook/store.ts writes them (canonical addresses, newest first). */
const FILLED_BOOK = JSON.stringify({
  version: 1,
  entries: [
    { id: 'parity-exchange', label: 'Exchange deposit', family: 'evm', address: '0x52908400098527886E0F7030069857D2E4169EE7', createdAt: at, updatedAt: at },
    { id: 'parity-treasury', label: 'Treasury', family: 'solana', address: PARITY_KEYS.recipient, createdAt: at, updatedAt: at },
  ],
});
/** Two confirmed transfers: one to the saved Treasury, one to an unsaved address (a recent). */
const TRANSFERS = JSON.stringify([
  { id: 'parity-t1', chain: 'solana', symbol: 'USDC', amount: '5', recipient: PARITY_KEYS.createKey, sender: PARITY_KEYS.user, hash: '5'.repeat(88), status: 'confirmed', createdAt: '2026-10-12T09:30:00.000Z' },
  { id: 'parity-t2', chain: 'solana', symbol: 'SOL', amount: '0.1', recipient: PARITY_KEYS.recipient, sender: PARITY_KEYS.user, hash: '4'.repeat(88), status: 'confirmed', createdAt: '2026-10-11T09:30:00.000Z' },
  { id: 'parity-t3', chain: 'base', symbol: 'USDC', amount: '2', recipient: '0x3333333333333333333333333333333333333333', sender: PARITY_EVM_WALLETS[0].address, hash: `0x${'ab'.repeat(32)}`, status: 'submitted', createdAt: '2026-10-10T09:30:00.000Z' },
]);

const PAGE = { path: '/tests/parity/send-receive.html', params: { screen: 'addressbook' } } as const;
const notPresent: Pick<ParityScenario, 'steps'> = {
  steps: async ({ page, expectPresent }) => expectPresent(page.locator('[data-screen="address-book"]'), 'address book', 1_500),
};
const heading = (page: import('@playwright/test').Page) => page.getByRole('heading', { name: 'Address book', exact: true });

export const entries: readonly ParityScenario[] = [
  {
    id: 'address-book-empty',
    area: 'B',
    screen: '6.9',
    title: 'Address book, nothing saved: your wallets, empty Recent and Saved, footer note',
    argus: ['argus-ext-popup-12-address-book.png'],
    state: 'signed-in',
    hash: AFTER ? undefined : 'settings',
    ...(AFTER ? { ...PAGE, steps: async ({ page }) => {
      await expect(heading(page)).toBeVisible();
      await expect(page.getByText('No saved addresses yet. Addresses you save stay on this device for this account.')).toBeVisible();
      await expect(page.getByText('Saved on this device only. Not synced to your other devices or the ANTARA extension.')).toBeVisible();
    } } : notPresent),
  },
  {
    id: 'address-book-filled',
    area: 'B',
    screen: '6.9',
    title: 'Address book with saved entries and recent recipients derived from transfers',
    argus: ['argus-ext-popup-12-address-book.png'],
    state: 'signed-in',
    hash: AFTER ? undefined : 'settings',
    storage: { [BOOK_KEY]: FILLED_BOOK, [`solares:transfers:${PARITY_USER_ID}`]: TRANSFERS },
    ...(AFTER ? { ...PAGE, steps: async ({ page }) => {
      await expect(page.getByRole('button', { name: 'Edit Treasury' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Remove Exchange deposit' })).toBeVisible();
      await expect(page.getByRole('button', { name: `Save recent address ${PARITY_KEYS.createKey}` })).toBeVisible();
    } } : notPresent),
  },
  {
    id: 'address-book-unreadable',
    area: 'B',
    screen: '6.9',
    title: 'Address book whose stored value is corrupted: never overwritten, explicit clear only',
    argus: ['argus-ext-popup-12-address-book.png'],
    state: 'signed-in',
    hash: AFTER ? undefined : 'settings',
    storage: { [BOOK_KEY]: '{"version":1,"entries":[{"id":"broken"' },
    ...(AFTER ? { ...PAGE, steps: async ({ page }) => {
      await expect(page.getByText('Saved addresses on this device could not be read. Nothing was changed.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add address' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Clear and start again' })).toBeVisible();
    } } : notPresent),
  },
  {
    id: 'address-form-error',
    area: 'B',
    screen: '6.9',
    title: 'Add address with an invalid Solana address: the exact error, nothing saved',
    argus: ['argus-ext-popup-13-address-book-add.png'],
    state: 'signed-in',
    hash: AFTER ? undefined : 'settings',
    ...(AFTER ? { ...PAGE, steps: async ({ page, click }) => {
      await click('Add address');
      const form = page.getByRole('dialog', { name: 'Add address' });
      await form.getByLabel('Name', { exact: true }).fill('Savings', { timeout: 10_000 });
      await form.getByLabel('Address', { exact: true }).fill('not-a-solana-address', { timeout: 10_000 });
      await click('Save', { within: form });
      await expect(form.getByRole('alert')).toHaveText('Enter a valid Solana address.');
      expect(await page.evaluate(key => localStorage.getItem(key), BOOK_KEY)).toBeNull();
      // Leave nothing hovered, so the capture and the colour checks see resting states.
      await page.mouse.move(0, 0);
    } } : notPresent),
  },
];
