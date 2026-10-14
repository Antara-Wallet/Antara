/**
 * Send model (docs/UI_ARGUS_PARITY.md 6.8). Pure helpers behind SendFlow's four steps:
 * which assets can be picked, what the wallet's balance is known to be, amount checks,
 * recognised recipients and the exact copy. No wallet calls, no storage, no network.
 *
 * Unknown is never zero: a balance is `known` only when the wallet's balance list holds
 * exactly one entry for that network and asset and nothing is still loading.
 */
import { parseAmount } from '../../vaults/validation';
import { byKey, type NetworkKey } from '../../networks';
import type { WalletBalance } from '../../wallet/types';
import type { AssetKind, AssetRow } from '../../receive/receiveModel';
import { sameAddress, type AddressFamily } from '../../addressbook/family';
import type { TransferRecord } from '../transfer';

export type KnownBalance = { status: 'known'; raw: bigint; formatted: string } | { status: 'unknown' };
const UNKNOWN: KnownBalance = Object.freeze({ status: 'unknown' });

export function balanceFor(wallet: { authenticated: boolean; balancesLoading: boolean; balances: readonly WalletBalance[] }, chain: NetworkKey, asset: AssetKind): KnownBalance {
  if (!wallet.authenticated || wallet.balancesLoading) return UNKNOWN;
  const found = wallet.balances.filter(balance => balance.chain === chain && balance.isNative === (asset === 'native'));
  if (found.length !== 1 || !/^\d+$/.test(found[0].raw)) return UNKNOWN;
  return { status: 'known', raw: BigInt(found[0].raw), formatted: found[0].formatted };
}

export const isKnownZero = (balance: KnownBalance) => balance.status === 'known' && balance.raw === 0n;

export interface SendRowState {
  selectable: boolean;
  /** Right-hand text: the exact balance with its label, or why it cannot be picked. */
  note: string;
  balance: KnownBalance;
}

export function sendRowState(row: Pick<AssetRow, 'family' | 'label' | 'unavailable'>, hasWallet: boolean, balance: KnownBalance): SendRowState {
  if (row.unavailable) return { selectable: false, note: row.unavailable, balance };
  if (!hasWallet) return { selectable: false, note: row.family === 'solana' ? SEND_COPY.noSolanaWallet : SEND_COPY.noEvmWallet, balance };
  if (balance.status === 'unknown') return { selectable: true, note: SEND_COPY.unknownBalance, balance };
  if (balance.raw === 0n) return { selectable: false, note: SEND_COPY.noBalance, balance };
  return { selectable: true, note: `${balance.formatted} ${row.label}`, balance };
}

/** Every asset the wallet could send is known to be zero: "Nothing to send yet" (ARGUS showed an empty list). */
export function nothingToSend(states: readonly SendRowState[]): boolean {
  const usable = states.filter(state => state.selectable || state.note === SEND_COPY.noBalance);
  return usable.length > 0 && usable.every(state => isKnownZero(state.balance));
}

export type AmountCheck = 'empty' | 'invalid' | 'over' | 'ok';
/** Only a *known* balance can make an amount too large here; with an unknown balance the wallet and network decide. */
export function amountCheck(amount: string, decimals: number, balance: KnownBalance): AmountCheck {
  if (!amount.trim()) return 'empty';
  let raw: bigint;
  try { raw = parseAmount(amount.trim(), decimals); } catch { return 'invalid'; }
  return balance.status === 'known' && raw > balance.raw ? 'over' : 'ok';
}

/** Max is offered for stablecoins only, and only with a known, nonzero balance: the exact balance. */
export function maxAmount(asset: AssetKind, balance: KnownBalance): string | null {
  return asset === 'stablecoin' && balance.status === 'known' && balance.raw > 0n ? balance.formatted : null;
}

export const secondsLeft = (expires: number, now: number) => Math.max(0, Math.ceil((expires - now) / 1000));

export type RecipientChip = { kind: 'saved' | 'own' | 'vault' | 'vault-config'; text: string };

/**
 * What ANTARA knows about a typed recipient: a saved entry, one of your own wallets, or
 * your Solana vault (its deposit address, or its configuration account, which must never
 * receive a plain transfer).
 */
export function recognise(recipient: string, family: AddressFamily, known: {
  saved: readonly { label: string; family: AddressFamily; address: string }[];
  own: readonly { name: string; address: string }[];
  vault: { depositAddress: string; multisig: string } | null;
}): RecipientChip[] {
  const value = recipient.trim();
  if (!value) return [];
  const chips: RecipientChip[] = [];
  const saved = known.saved.find(entry => entry.family === family && sameAddress(family, entry.address, value));
  if (saved) chips.push({ kind: 'saved', text: `Saved as ${saved.label}` });
  if (known.own.some(wallet => sameAddress(family, wallet.address, value))) chips.push({ kind: 'own', text: 'Your wallet' });
  if (family === 'solana' && known.vault) {
    if (sameAddress('solana', known.vault.depositAddress, value)) chips.push({ kind: 'vault', text: 'Your Solana vault' });
    else if (sameAddress('solana', known.vault.multisig, value)) chips.push({ kind: 'vault-config', text: 'Your vault’s configuration account' });
  }
  return chips;
}

/** A plain transfer to the vault is never built: deposits go through Deposit (8.6). */
export const blocksTransfer = (chips: readonly RecipientChip[]) => chips.some(chip => chip.kind === 'vault' || chip.kind === 'vault-config');

export const detailsTitle = (row: Pick<AssetRow, 'label' | 'network'>) => `Send ${row.label} on ${row.network}`;
export const nativeSymbol = (chain: NetworkKey) => byKey(chain).native.symbol;

/** Existing result titles and texts (TransferDialog), verbatim. */
export function resultCopy(status: TransferRecord['status']): { title: string; text: string } {
  switch (status) {
    case 'confirmed': return { title: 'Transfer confirmed.', text: 'Confirmed by the network.' };
    case 'reverted': return { title: 'Transfer reverted.', text: 'The network rejected the transaction. Network fees may still apply.' };
    case 'submission-unknown': return { title: 'Awaiting wallet outcome.', text: 'A wallet request started. Its outcome has not been confirmed; do not repeat this payment.' };
    default: return { title: 'Transfer submitted.', text: 'Waiting for network confirmation. This payment has already been submitted.' };
  }
}

export const SEND_STEPS = ['Asset', 'Details', 'Review', 'Result'] as const;

/** Exact copy (6.8). Existing TransferDialog strings are kept verbatim. */
export const SEND_COPY = Object.freeze({
  title: 'Send assets',
  closeLabel: 'Close transfer',
  signedOut: 'Sign in to send assets.',
  signIn: 'Sign in',
  setupRequired: 'Sign-in setup required',
  network: 'Network',
  asset: 'Asset',
  search: 'Search assets or networks',
  yourAssets: 'Your assets',
  noMatch: 'No assets match your search.',
  noBalance: 'No balance',
  unknownBalance: 'Balance unavailable',
  noSolanaWallet: 'No Solana wallet',
  noEvmWallet: 'No EVM wallet',
  nothingTitle: 'Nothing to send yet',
  nothingText: 'Receive assets into your wallet first.',
  receive: 'Receive',
  continue: 'Continue',
  cancel: 'Cancel',
  back: 'Back',
  recipient: 'Recipient',
  addressBook: 'Choose from address book',
  amount: 'Amount',
  max: 'Max',
  available: 'Available',
  spendNote: 'Spend from your selected wallet. Vault balances remain protected by their own approval policy.',
  vaultHandoff: 'Deposits use your vault’s Deposit, which checks the vault first.',
  vaultConfig: 'This is your vault’s configuration account. It does not receive funds; use Deposit on the Vault side.',
  continueToVault: 'Continue to vault deposit',
  review: 'Review transfer',
  reviewBusy: 'Simulating and estimating fees…',
  reviewTitle: 'Review your transfer.',
  verify: 'Verify the complete recipient address. The wallet will request your signature for this exact transfer.',
  approvalScope: 'One transfer. No token allowance.',
  visibility: 'Public on-chain transaction',
  banner: 'Spending wallet · funds here are not protected by your vault.',
  expired: 'Review expired. Go back and refresh the network fee.',
  confirm: 'Confirm in wallet',
  confirmBusy: 'Waiting for your wallet…',
  backToDetails: 'Back to details',
  saveAddress: 'Save this address',
  done: 'Done',
  doneBusy: 'Waiting for wallet…',
  reviewValid: (seconds: number) => `Review valid for ${seconds}s`,
  notEnough: (label: string) => `Not enough ${label}.`,
  keepFees: (symbol: string) => `Keep some ${symbol} for network fees.`,
  needFee: (symbol: string, network: string) => `You need some ${symbol} on ${network} to pay the network fee.`,
  nativeCoin: (network: string) => `Native coin of ${network}`,
});
