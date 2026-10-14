/**
 * Area A parity scenarios: sign-in welcome, Wallet home (Wallet side) and token detail
 * (docs/UI_ARGUS_PARITY.md 6.2, 6.4, 6.5, 10.3). Also the worked example for other areas:
 * a state, optional params/storage/hash, steps that click by accessible name with
 * alternatives, and `expectPresent` for screens that do not exist before the build.
 */
import { PARITY_KEYS, PARITY_USER_ID } from '../keys';
import type { ParityScenario, StepApi, SurfaceId } from '../types';

/** Wallet, Vault and Verification also run at 1440×900; shell and home also run in the 420px panel (10.3). */
const HOME_SURFACES: readonly SurfaceId[] = ['desktop', 'desktop-wide', 'mobile', 'panel-360', 'panel-420'];

/** One confirmed Solana USDC transfer by the fixture user, as transfers/transfer.ts stores it. */
const SEEDED_TRANSFERS = JSON.stringify([{
  id: 'parity-transfer-1',
  chain: 'solana',
  symbol: 'USDC',
  amount: '5',
  recipient: PARITY_KEYS.recipient,
  sender: PARITY_KEYS.user,
  // A fixed, well-formed base58 signature string; never a real transaction.
  hash: '5'.repeat(88),
  status: 'confirmed',
  createdAt: '2026-10-12T09:30:00.000Z',
}]);

/**
 * Opens token detail for one row. Token rows are buttons named "<label> on <network>"
 * and the detail carries data-screen="token-detail" (Area A's phase-1 contract).
 */
function openTokenDetail(network: string | null, row: string) {
  return async ({ page, click, expectPresent }: StepApi) => {
    if (network) await page.getByLabel('Filter assets by network').selectOption(network);
    await click([row]);
    await expectPresent(page.locator('[data-screen="token-detail"]'), 'token detail');
  };
}

export const entries: readonly ParityScenario[] = [
  {
    id: 'signin-welcome',
    area: 'A',
    screen: '6.2',
    title: 'Signed out: sign-in welcome, muted balance "0.00", no token rows',
    argus: ['argus-ext-onboard-01-welcome.png', 'argus-ext-popup-50-unlock.png', 'argus-pwa-desktop-onboarding.png'],
    surfaces: HOME_SURFACES,
    state: 'signed-out',
  },
  {
    id: 'signin-unconfigured',
    area: 'A',
    screen: '6.2',
    title: 'Sign-in not configured (no Privy app id): "Open setup" path',
    argus: ['argus-ext-popup-51-unlock-error.png'],
    surfaces: HOME_SURFACES,
    state: 'unconfigured',
  },
  {
    id: 'home-signed-in',
    area: 'A',
    screen: '6.4',
    title: 'Wallet home, signed in: balance hero, four actions, tokens on Solana',
    argus: ['argus-ext-popup-01b-main-simbalance.png', 'argus-ext-popup-01c-main-simtokens.png', 'argus-pwa-desktop-view-home.png'],
    surfaces: HOME_SURFACES,
    state: 'signed-in',
  },
  {
    id: 'home-create-vault',
    area: 'A',
    screen: '6.4',
    title: 'Wallet home, no vault yet: "Your vault" → Create your vault opens the Vault side’s create sequence',
    argus: ['argus-pwa-desktop-view-home.png'],
    surfaces: ['desktop-wide', 'panel-360'],
    state: 'signed-in',
    profile: { vault: 'activate' },
    steps: async ({ page, click, expectPresent }) => {
      await click(['Create your vault'], { timeout: 20_000 });
      await expectPresent(page.getByRole('dialog', { name: 'Create your vault' }), 'create sequence', 20_000);
    },
  },
  {
    id: 'home-privacy',
    area: 'A',
    screen: '6.4',
    title: 'Wallet home with Hide balances on: every amount masked',
    argus: ['argus-ext-popup-01b-main-simbalance.png'],
    surfaces: HOME_SURFACES,
    state: 'signed-in',
    storage: { 'solares-balance-privacy': 'true' },
  },
  {
    id: 'home-failed-base',
    area: 'A',
    screen: '6.4',
    title: 'One network failed (Base): notice, the total of the networks that loaded with "Excludes Base (couldn’t load)" and "Couldn’t load · Retry" on All networks',
    argus: ['argus-ext-popup-01-main.png'],
    surfaces: HOME_SURFACES,
    state: 'signed-in',
    params: { failed: 'base' },
    steps: async ({ page }) => {
      await page.getByLabel('Filter assets by network').selectOption('all');
    },
  },
  {
    id: 'home-evm-only',
    area: 'A',
    screen: '6.4',
    title: 'EVM-only account: "All networks" default, no Solana rows',
    argus: ['argus-pwa-desktop-view-home.png'],
    surfaces: HOME_SURFACES,
    state: 'evm-only',
  },
  {
    id: 'home-activity-tab',
    area: 'A',
    screen: '6.4',
    title: 'Wallet home, Activity tab: latest items and "See all activity"',
    argus: ['argus-ext-popup-24-activity.png', 'argus-ext-popup-24b-activity-sim.png'],
    surfaces: HOME_SURFACES,
    state: 'signed-in',
    storage: { [`solares:transfers:${PARITY_USER_ID}`]: SEEDED_TRANSFERS },
    steps: async ({ page, click, expectPresent }) => {
      // Before the build there is no Tokens/Activity tablist on the home screen ("not present before").
      await click(['Activity'], { role: 'tab' });
      // The seeded transfer is read from device storage after the tab opens.
      await expectPresent(page.locator('[data-activity-row]'), 'seeded activity row');
    },
  },
  {
    id: 'token-detail-sol',
    area: 'A',
    screen: '6.5',
    title: 'Token detail: SOL on Solana (native coin), its USD value and Relay price, no other market data',
    argus: ['argus-ext-popup-25-token-detail.png', 'argus-ext-popup-25-token-detail-full.png'],
    surfaces: HOME_SURFACES,
    state: 'signed-in',
    steps: openTokenDetail(null, 'SOL on Solana'),
  },
  {
    id: 'token-detail-bsc-usdc',
    area: 'A',
    screen: '6.5',
    title: 'Token detail: USDC (Binance-Peg) on BNB Smart Chain with its issuer note',
    argus: ['argus-ext-popup-25-token-detail-full.png'],
    surfaces: HOME_SURFACES,
    state: 'signed-in',
    steps: openTokenDetail('bsc', 'USDC (Binance-Peg) on BNB Smart Chain'),
  },
  {
    id: 'token-detail-usdg',
    area: 'A',
    screen: '6.5',
    title: 'Token detail: USDG on Robinhood Chain, never called USDC',
    argus: ['argus-ext-popup-25-token-detail-full.png'],
    surfaces: HOME_SURFACES,
    state: 'signed-in',
    steps: openTokenDetail('robinhood', 'USDG on Robinhood Chain'),
  },
];
