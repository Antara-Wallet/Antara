/**
 * The headline of a vault balance card (owner decision 2026-10-13): the vault's total in US dollars,
 * "≈ $8.43", over a line with what it holds, "0.005 SOL · 0 USDC". Shared by the Wallet home's
 * "Your vault" card (home/VaultCard.tsx) and the Vault screen (PairedSolanaVault, WalletVault).
 * Pure; the same valuation rules as the wallet total (wallet/prices.ts): an asset without a price
 * is excluded by name, and with no price at all the headline is the largest holding, never "$0".
 */
import { byKey, type SolanaCluster } from '../networks';
import type { WalletChain } from '../wallet/types';
import { compactAmount, excludedNote, priceStamp, usdDisplay, valuate, valuationTitle, type Holding, type PricesState } from '../wallet/prices';

export const VAULT_TOTAL_LABEL = 'Vault · total';
export const MASKED = '••••••';

export interface VaultValueInput {
  chain: WalletChain;
  /** Raw native balance (lamports or wei). */
  native: bigint;
  /** Raw stablecoin balance; null where the vault cannot hold it (Solana devnet has no mainnet USDC). */
  stablecoin: bigint | null;
  prices: PricesState;
  privacy: boolean;
  cluster?: SolanaCluster;
}

export type VaultHeadline =
  | { kind: 'masked' }
  /** Prices are still being read: a muted stand-in, with `reason`. */
  | { kind: 'pending'; reason: string }
  | { kind: 'usd'; amount: string; approx: boolean }
  | { kind: 'amount'; amount: string; unit: string };

export interface VaultValueModel {
  label: string;
  headline: VaultHeadline;
  /** "0.005 SOL · 0 USDC", or the mask. */
  holdings: string;
  /** The same, one entry per asset: ["0.005 SOL", "0 USDC"]; empty while masked. */
  holdingList: string[];
  /** "prices from Relay, 12:41", "USD value unavailable" or "Reading prices"; empty for an empty vault. */
  source: string;
  /** "Excludes 2.5 USDG (no price)", or empty. */
  excluded: string;
  /** Tooltip of an estimated total. */
  title?: string;
}

export function vaultHoldings(chain: WalletChain, native: bigint, stablecoin: bigint | null): Holding[] {
  const network = byKey(chain);
  const list: Holding[] = [{ chain, kind: 'native', raw: native, decimals: network.native.decimals, label: network.native.symbol }];
  if (stablecoin !== null) list.push({ chain, kind: 'stablecoin', raw: stablecoin, decimals: network.funding.decimals, label: network.funding.label });
  return list;
}

export function vaultValue(input: VaultValueInput): VaultValueModel {
  const holdings = vaultHoldings(input.chain, input.native, input.stablecoin);
  const valuation = valuate(holdings, input.prices, input.cluster);
  const list = holdings.map(holding => `${compactAmount(holding.raw, holding.decimals)} ${holding.label}`);
  const source = valuation.kind === 'usd' ? priceStamp(valuation.snapshot)
    : valuation.kind === 'pending' ? 'Reading prices'
    : valuation.kind === 'unpriced' ? 'USD value unavailable'
    : '';
  const headline: VaultHeadline = input.privacy ? { kind: 'masked' }
    : valuation.kind === 'empty' ? { kind: 'usd', amount: '$0.00', approx: false }
    : valuation.kind === 'pending' ? { kind: 'pending', reason: 'Reading prices' }
    : valuation.kind === 'usd' ? { kind: 'usd', ...usdDisplay(valuation.value) }
    : { kind: 'amount', amount: compactAmount(valuation.lead.raw, valuation.lead.decimals), unit: valuation.lead.label };
  return {
    label: VAULT_TOTAL_LABEL,
    headline,
    holdings: input.privacy ? MASKED : list.join(' · '),
    holdingList: input.privacy ? [] : list,
    source,
    excluded: valuation.kind === 'usd' ? excludedNote(valuation.excluded, input.privacy) : '',
    title: input.privacy ? undefined : valuationTitle(valuation),
  };
}
