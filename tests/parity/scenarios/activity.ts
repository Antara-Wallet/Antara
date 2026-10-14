/**
 * Area E parity scenarios: Activity and its detail sheet (docs/UI_ARGUS_PARITY.md 6.11, 10.3).
 *
 * Before the integration pass the shell still renders the legacy Activity panel, so the
 * "after" run captures Area E's ActivityScreen on its own preview page
 * (tests/parity/settings-activity.html, the same fixture wallet inside a static copy of
 * the shell frame). Once shell/screens.ts points at activity/ActivityScreen, every run
 * uses the real shell harness again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PARITY_EVM_WALLETS, PARITY_KEYS, PARITY_USER_ID } from '../keys';
import { PARITY_RUN, PARITY_TIME, type ParityScenario } from '../types';

/** True once shell/screens.ts wires the named Area E screen (integration pass). */
export function wiredInShell(screen: 'activity/ActivityScreen' | 'settings/SettingsScreen') {
  try {
    return fs.readFileSync(path.resolve('src/solares/shell/screens.ts'), 'utf8').includes(screen);
  } catch {
    return false;
  }
}
/** Area E's own preview page, used only for the after run until the integration pass. */
export const AREA_E_PREVIEW = '/tests/parity/settings-activity.html';
const PATH = PARITY_RUN === 'after' && !wiredInShell('activity/ActivityScreen') ? AREA_E_PREVIEW : undefined;

const EVM = PARITY_EVM_WALLETS[0].address;
const OTHER_EVM = PARITY_EVM_WALLETS[1].address;
/** Fixture-only multisig address: a fixed fixture key, never a real vault. */
const FIXTURE_MULTISIG = PARITY_KEYS.createKey;
/** Fixed, well-formed signature and hash strings. None is a real transaction. */
const sig = (digit: string) => digit.repeat(88);
const evmHash = (pair: string) => `0x${pair.repeat(32)}`;
const iso = (value: string) => new Date(value).toISOString();
const seconds = (offsetMs: number) => Math.floor((PARITY_TIME.getTime() + offsetMs) / 1000);

/** transfers/transfer.ts records (solares:transfers:<user>), as SendFlow / TransferDialog store them. */
export const SEEDED_TRANSFERS = [
  { id: 'parity-sol-usdc', chain: 'solana', symbol: 'USDC', amount: '5', recipient: PARITY_KEYS.recipient, sender: PARITY_KEYS.user, hash: sig('5'), status: 'confirmed', createdAt: iso('2026-10-12T09:30:00Z') },
  { id: 'parity-eth', chain: 'ethereum', symbol: 'ETH', amount: '0.01', recipient: '0x3333333333333333333333333333333333333333', sender: EVM, hash: evmHash('ab'), status: 'submitted', createdAt: iso('2026-10-11T15:05:00Z') },
  { id: 'parity-base-unknown', chain: 'base', symbol: 'USDC', amount: '12.5', recipient: '0x4444444444444444444444444444444444444444', sender: EVM, hash: '', status: 'submission-unknown', createdAt: iso('2026-10-10T08:00:00Z') },
  { id: 'parity-bsc-reverted', chain: 'bsc', symbol: 'USDC (Binance-Peg)', amount: '3', recipient: '0x5555555555555555555555555555555555555555', sender: EVM, hash: evmHash('cd'), status: 'reverted', createdAt: iso('2026-10-09T18:45:00Z') },
  { id: 'parity-legacy-arbitrum', chain: 'arbitrum', symbol: 'USDC', amount: '3', recipient: '0x3333333333333333333333333333333333333333', sender: EVM, hash: evmHash('ef'), status: 'confirmed', createdAt: iso('2026-06-01T00:00:00Z') },
  // Sent from the account's second EVM wallet, which is not selected: never shown.
  { id: 'parity-other-wallet', chain: 'ethereum', symbol: 'ETH', amount: '9', recipient: EVM, sender: OTHER_EVM, hash: evmHash('99'), status: 'confirmed', createdAt: iso('2026-10-12T20:00:00Z') },
];

const route = (id: string, createdAt: string, status: string, intent: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  requestId: `0x${id.repeat(32)}`, createdAt: Date.parse(createdAt), status, sourceTxHashes: [], destinationTxHashes: [], intent: { slippageBps: 50, ...intent }, ...extra,
});
/** relay/history.ts records (solares.relay.activity.v1, shared by every user on the device). */
export const SEEDED_ROUTES = [
  route('a1', '2026-10-12T12:00:00Z', 'success', { originChainId: 792703809, destinationChainId: 792703809, user: PARITY_KEYS.user, recipient: PARITY_KEYS.user, amount: '25000000', destinationToken: 'native' }, { sourceTxHashes: [sig('4')], destinationTxHashes: [sig('6')] }),
  // Still settling, with its signed order: the detail sheet shows the fill window.
  route('b2', '2026-10-13T09:40:00Z', 'pending', { originChainId: 8453, destinationChainId: 8453, user: EVM, recipient: EVM, amount: '10000000', destinationToken: 'native', slippageBps: 100 }, {
    sourceTxHashes: [evmHash('12')],
    settlementUpdatedAt: Date.parse('2026-10-13T09:45:00Z'),
    order: { orderId: evmHash('cd'), orderSignature: `0x${'ef'.repeat(65)}`, orderData: { version: 'v1', output: { deadline: seconds(6 * 3_600_000) } } },
  }),
  // Robinhood Chain spends USDG, never USDC.
  route('c3', '2026-10-08T07:15:00Z', 'success', { originChainId: 4663, destinationChainId: 4663, user: EVM, recipient: EVM, amount: '2500000', destinationToken: 'native' }),
  // A route on a removed network: read-only, no status refresh.
  route('d4', '2026-04-01T00:00:00Z', 'success', { originChainId: 42161, destinationChainId: 8453, user: EVM, recipient: EVM, amount: '7000000', destinationToken: 'USDC' }),
];

/** vaults/vaultActivity.ts records (solares.vault.activity.v1:<user>, contract 8.5). */
export const SEEDED_VAULT = [
  { id: 'parity-vault-release', kind: 'release', multisig: FIXTURE_MULTISIG, asset: 'USDC', amount: '5', recipient: PARITY_KEYS.user, index: '2', signature: sig('7'), status: 'confirmed', createdAt: iso('2026-10-12T16:20:00Z') },
  { id: 'parity-vault-deposit', kind: 'deposit', multisig: FIXTURE_MULTISIG, asset: 'USDC', amount: '20', signature: sig('3'), status: 'confirmed', createdAt: iso('2026-10-06T10:00:00Z') },
  { id: 'parity-vault-activation', kind: 'activation', multisig: FIXTURE_MULTISIG, signature: sig('2'), status: 'confirmed', createdAt: iso('2026-10-05T10:00:00Z') },
];

/** Device storage for the filled scenarios: transfers, swaps and vault actions, plus another user's records. */
export const ACTIVITY_STORAGE: Readonly<Record<string, string>> = {
  [`solares:transfers:${PARITY_USER_ID}`]: JSON.stringify(SEEDED_TRANSFERS),
  'solares.relay.activity.v1': JSON.stringify(SEEDED_ROUTES),
  [`solares.vault.activity.v1:${PARITY_USER_ID}`]: JSON.stringify(SEEDED_VAULT),
  // Another Privy user on the same device: never shown.
  'solares:transfers:another-user': JSON.stringify([{ ...SEEDED_TRANSFERS[0], id: 'another-user-transfer', amount: '777' }]),
};

const ACTIVITY_ARGUS = ['argus-ext-popup-24b-activity-sim.png', 'argus-ext-popup-24-activity.png', 'argus-pwa-desktop-view-history.png'];

export const entries: readonly ParityScenario[] = [
  {
    id: 'activity-signed-out',
    area: 'E',
    screen: '6.11',
    title: 'Activity, signed out: "Your activity, in one place" and Sign in',
    argus: ['argus-ext-popup-24-activity.png', 'argus-pwa-desktop-view-history.png'],
    path: PATH,
    state: 'signed-out',
    hash: 'activity',
  },
  {
    id: 'activity-empty',
    area: 'E',
    screen: '6.11',
    title: 'Activity, signed in with nothing on this device: "No activity yet"',
    argus: ['argus-ext-popup-24-activity.png', 'argus-pwa-desktop-view-history.png'],
    path: PATH,
    state: 'signed-in',
    hash: 'activity',
  },
  {
    id: 'activity-filled',
    area: 'E',
    screen: '6.11',
    title: 'Activity with transfers, swaps and vault actions (legacy rows read-only; other wallet and user hidden)',
    argus: ACTIVITY_ARGUS,
    path: PATH,
    state: 'signed-in',
    hash: 'activity',
    storage: ACTIVITY_STORAGE,
  },
  {
    id: 'activity-detail-swap',
    area: 'E',
    screen: '6.11',
    title: 'Transaction details for a settling swap: fill window and settlement, no layer chips',
    argus: ['argus-ext-popup-24b-activity-sim.png'],
    path: PATH,
    state: 'signed-in',
    hash: 'activity',
    storage: ACTIVITY_STORAGE,
    steps: async ({ page, click, expectPresent }) => {
      // Rows open the detail sheet; the legacy panel has no detail sheet ("not present before").
      await click(['USDC → ETH'], { exact: false });
      await expectPresent(page.getByRole('dialog', { name: 'Transaction details' }), 'Transaction details sheet');
    },
  },
  {
    id: 'activity-filter-vault',
    area: 'E',
    screen: '6.11',
    title: 'Activity filtered to Vault: deposit, release and activation records only',
    argus: ACTIVITY_ARGUS,
    path: PATH,
    state: 'signed-in',
    hash: 'activity',
    storage: ACTIVITY_STORAGE,
    steps: async ({ page, click }) => {
      // The legacy panel filters All · Sent · Swap only ("not present before").
      await click(['Vault'], { within: page.getByRole('group', { name: 'Filter activity' }) });
    },
  },
];
