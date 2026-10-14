/**
 * Area C parity scenarios: Swap (docs/UI_ARGUS_PARITY.md 6.10, 10.3), on the Relay routes
 * of routes/relay.ts. The review and expiry scenarios run on swap-harness.html, which
 * signs in as the wallets a captured, solver-signed Relay order commits to, so the real
 * `verifyReviewedQuote` passes and the real disclosure renders (see that file).
 */
import { PARITY_EVM_WALLETS, PARITY_KEYS } from '../keys';
import { PARITY_TIME, type ParityScenario, type StepApi } from '../types';
import { TRADE_STORAGE_KEY } from '../routes/relay';

const ARGUS_SWAP = ['argus-ext-popup-19-swap.png', 'argus-ext-popup-19b-swap-quote.png', 'argus-pwa-desktop-view-swap.png'];
const REVIEW_PAGE = '/tests/parity/swap-harness.html';
const now = PARITY_TIME.getTime();
const SOLANA = 792703809;

/** A well-formed, fixed hex id (never a real Relay request). */
const requestId = (digit: string) => `0x${digit.repeat(64)}`;
/** A fixed signed-order shape as relay/history.ts stores it; display only (the fill window line). */
const order = (digit: string, deadline: number) => ({
  orderId: `0x${digit.repeat(64)}`,
  orderSignature: `0x${digit.repeat(130)}`,
  orderData: { version: 'v1', solverChainId: 'base', solver: '0xf70da97812cb96acdf810712aa562db8dfa3dbef', salt: '1', inputs: [], output: { chainId: 'solana', payments: [], calls: [], deadline, extraData: '0x' }, fees: [] },
});

/**
 * Device-local swap history of the fixture user: a Solana swap Relay reported as deposited
 * 10 minutes ago (still inside the 30-minute block, so "Start another swap" is offered), an
 * unresolved Ethereum swap, and a Base swap whose deposit was never submitted.
 */
const SEEDED_SWAPS = JSON.stringify([
  {
    requestId: requestId('a'), createdAt: now - 10 * 60_000, status: 'pending', settlementUpdatedAt: now - 8 * 60_000,
    sourceTxHashes: ['5'.repeat(88)], destinationTxHashes: [],
    intent: { originChainId: SOLANA, destinationChainId: SOLANA, user: PARITY_KEYS.user, recipient: PARITY_KEYS.user, amount: '10000000', destinationToken: 'native', slippageBps: 50 },
    order: order('a', Math.floor(now / 1000) + 7 * 86_400 - 600),
  },
  {
    requestId: requestId('b'), createdAt: now - 3 * 3_600_000, status: 'unresolved',
    sourceTxHashes: [`0x${'b'.repeat(64)}`], destinationTxHashes: [],
    detail: 'Deposit submitted, but notification could not be confirmed. Check status before another trade.',
    intent: { originChainId: 1, destinationChainId: 1, user: PARITY_EVM_WALLETS[0].address, recipient: PARITY_EVM_WALLETS[0].address, amount: '7500000', destinationToken: 'native', slippageBps: 100 },
  },
  {
    requestId: requestId('c'), createdAt: now - 26 * 3_600_000, status: 'failure',
    sourceTxHashes: [], destinationTxHashes: [],
    detail: 'Deposit was not submitted. The wallet request was rejected.',
    intent: { originChainId: 8453, destinationChainId: 8453, user: PARITY_EVM_WALLETS[0].address, recipient: PARITY_EVM_WALLETS[0].address, amount: '5000000', destinationToken: 'native', slippageBps: 50 },
  },
]);

/** Types an amount into the pay card ("<label> amount to spend"). */
const amount = (label: string, value: string) => async ({ page }: StepApi) => {
  await page.getByLabel(`${label} amount to spend`, { exact: true }).fill(value);
};

/** On swap-harness.html: 5 USDC to SOL on Solana at 0.5% is exactly the captured order, so Review shows its disclosure. */
async function reviewCapturedQuote(api: StepApi) {
  await amount('USDC', '5')(api);
  await api.click(['Review swap']);
  await api.expectPresent(api.page.getByRole('region', { name: 'Swap review' }), 'swap review', 20_000);
}

export const entries: readonly ParityScenario[] = [
  {
    id: 'swap-signed-out',
    area: 'C',
    screen: '6.10',
    title: 'Signed out: pay and receive cards, muted balance "0.00", output "0" with "No quote yet", "Sign in to swap"',
    argus: ARGUS_SWAP,
    state: 'signed-out',
    hash: 'swap',
  },
  {
    id: 'swap-config-500',
    area: 'C',
    screen: '6.10',
    title: 'Relay config unreachable (500): connection notice, "Swaps unavailable"',
    argus: ['argus-ext-popup-19-swap.png'],
    state: 'signed-in',
    hash: 'swap',
    profile: { relay: 'config-500' },
  },
  {
    id: 'swap-ready',
    area: 'C',
    screen: '6.10',
    title: 'Configured, signed in: 10 USDC on Solana, balance, 50% and Max chips, "Review swap"',
    argus: ARGUS_SWAP,
    state: 'signed-in',
    hash: 'swap',
    steps: amount('USDC', '10'),
  },
  {
    id: 'swap-insufficient',
    area: 'C',
    screen: '6.10',
    title: 'Amount above the known balance (50 of 42.5 USDC): "Not enough USDC", disabled',
    argus: ['argus-ext-popup-19b-swap-quote.png'],
    state: 'signed-in',
    hash: 'swap',
    steps: amount('USDC', '50'),
  },
  {
    id: 'swap-native-fee',
    area: 'C',
    screen: '6.10',
    title: 'Pay on Base with a known zero ETH balance: network-fee notice, Review still available',
    argus: ['argus-ext-popup-19-swap.png'],
    state: 'signed-in',
    hash: 'swap',
    steps: async ({ page }) => {
      await page.getByLabel('Pay network', { exact: true }).selectOption('8453');
      await page.getByLabel('USDC amount to spend', { exact: true }).fill('5');
    },
  },
  {
    id: 'swap-picker',
    area: 'C',
    screen: '6.10',
    title: 'Token picker on Solana: pinned SOL and USDC, then Relay results; identity only, no market data',
    argus: ['argus-ext-popup-19c-swap-token-picker.png'],
    state: 'signed-in',
    hash: 'swap',
    steps: async ({ page, click, expectPresent }) => {
      await click(['Select token, SOL on Solana']);
      const dialog = page.getByRole('dialog', { name: 'Select a token' });
      await expectPresent(dialog, 'token picker');
      await expectPresent(dialog.getByRole('button', { name: /^JUP Jupiter/ }), 'Relay token results', 10_000);
    },
  },
  {
    id: 'swap-settings',
    area: 'C',
    screen: '6.10',
    title: 'Swap settings sheet: slippage 0.5% / 1% only and the terms note; no swap cap, no speed or MEV tiers',
    argus: ['argus-ext-popup-19e-swap-settings.png', 'argus-ext-popup-19e-swap-settings-full.png'],
    state: 'signed-in',
    hash: 'swap',
    steps: async ({ page, click, expectPresent }) => {
      // Before the build the gear does not exist ("not present before").
      await click(['Swap settings']);
      await expectPresent(page.getByRole('dialog', { name: 'Swap settings' }), 'swap settings sheet');
    },
  },
  {
    id: 'swap-review-disclosure',
    area: 'C',
    screen: '6.10',
    title: 'Review of a captured, solver-signed Relay order: spending-wallet line, full disclosure, acknowledgement',
    argus: ['argus-ext-popup-35-simple-swap-confirm.png', 'argus-ext-popup-19b-swap-quote.png'],
    path: REVIEW_PAGE,
    hash: 'swap',
    steps: reviewCapturedQuote,
  },
  {
    id: 'swap-expired',
    area: 'C',
    screen: '6.10',
    title: 'The same review after its 90-second validity: "Expired · refresh to continue", "Refresh quote"',
    argus: ['argus-ext-popup-35-simple-swap-confirm.png'],
    path: REVIEW_PAGE,
    hash: 'swap',
    steps: async api => {
      await reviewCapturedQuote(api);
      await api.page.clock.fastForward(120_000);
      await api.expectPresent(api.page.getByRole('button', { name: 'Refresh quote', exact: true }), 'Refresh quote');
    },
  },
  {
    id: 'swap-status-list',
    area: 'C',
    screen: '6.10',
    title: 'Swap status: a settling Solana swap, an unresolved Ethereum swap and a Base swap never deposited',
    argus: ['argus-ext-popup-24b-activity-sim.png'],
    state: 'signed-in',
    hash: 'swap',
    storage: { [TRADE_STORAGE_KEY]: SEEDED_SWAPS },
    steps: async ({ page, expectPresent }) => {
      await expectPresent(page.getByLabel('Swap status', { exact: true }), 'swap status list');
    },
  },
];
