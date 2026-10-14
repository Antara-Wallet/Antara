/**
 * Receive model (docs/UI_ARGUS_PARITY.md 6.7). Pure: the ten receivable assets in
 * registry order, search, the address each one uses, and the exact copy around them.
 * Send's asset step lists the same ten rows (6.8).
 */
import { SUPPORTED_NETWORKS, byKey, type NetworkKey, type SolanaCluster } from '../networks';
import { SOLANA_CLUSTER } from '../wallet/config';
import { familyOf, type AddressFamily } from '../addressbook/family';

export type AssetKind = 'native' | 'stablecoin';

export interface AssetRow {
  /** `<network>:<native|stablecoin>`, e.g. "bsc:stablecoin". */
  key: string;
  chain: NetworkKey;
  asset: AssetKind;
  /** Exact display label: "SOL", "USDC", "USDC (Binance-Peg)", "USDG", "ETH". Never generalised to "USDC". */
  label: string;
  /** Full name: "Solana", "USD Coin", "Binance-Peg USD Coin", "Paxos Global Dollar", "Ether". */
  name: string;
  /** Network display name, "Solana devnet" on devnet. */
  network: string;
  /** TokenLogo symbol. Only Circle USDC uses the USDC mark; other stablecoins get the neutral mark. */
  mark: string;
  family: AddressFamily;
  decimals: number;
  /** Contract or mint; null for the native coin. */
  tokenAddress: string | null;
  /** Issuer note for a stablecoin Circle does not issue (Binance-Peg USDC, USDG); '' otherwise. */
  issuerNote: string;
  /** Why the row cannot be used here (e.g. "Mainnet only"); '' when usable. */
  unavailable: string;
}

export const networkDisplayName = (chain: NetworkKey, cluster: SolanaCluster = SOLANA_CLUSTER) =>
  chain === 'solana' && cluster === 'devnet' ? 'Solana devnet' : byKey(chain).name;

/** The ten rows in registry order: each network's native coin, then its funding stablecoin. */
export function assetRows(cluster: SolanaCluster = SOLANA_CLUSTER): AssetRow[] {
  return SUPPORTED_NETWORKS.flatMap(network => {
    const networkName = networkDisplayName(network.key, cluster);
    const native: AssetRow = {
      key: `${network.key}:native`, chain: network.key, asset: 'native', label: network.native.symbol, name: network.native.name,
      network: networkName, mark: network.native.symbol, family: familyOf(network.key), decimals: network.native.decimals,
      tokenAddress: null, issuerNote: '', unavailable: '',
    };
    const stablecoin: AssetRow = {
      key: `${network.key}:stablecoin`, chain: network.key, asset: 'stablecoin', label: network.funding.label, name: network.funding.name,
      network: networkName, mark: network.funding.circleIssued ? network.funding.symbol : 'stablecoin', family: familyOf(network.key),
      decimals: network.funding.decimals, tokenAddress: network.funding.address,
      issuerNote: network.funding.circleIssued ? '' : network.funding.issuerNote,
      // Circle USDC on Solana exists on mainnet only.
      unavailable: network.key === 'solana' && cluster === 'devnet' ? 'Mainnet only' : '',
    };
    return [native, stablecoin];
  });
}

/** Rows matching every word of `query` in label, name, network or symbol. Order is kept. */
export function filterRows<T extends Pick<AssetRow, 'label' | 'name' | 'network' | 'chain'>>(rows: readonly T[], query: string): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter(row => {
    const haystack = `${row.label} ${row.name} ${row.network} ${byKey(row.chain).shortName}`.toLowerCase();
    return words.every(word => haystack.includes(word));
  });
}

/** The spending-wallet address a row receives on: the Solana wallet, or the one EVM wallet for every EVM network. */
export function walletAddressFor(family: AddressFamily, addresses: { solana: string | null; ethereum: string | null }): string | null {
  return family === 'solana' ? addresses.solana : addresses.ethereum;
}

/** "Receive <label> on <network>" (step-2 heading). */
export const receiveHeading = (row: Pick<AssetRow, 'label' | 'network'>) => `Receive ${row.label} on ${row.network}`;

/** Label above the address in step 2. */
export const addressHeading = (row: Pick<AssetRow, 'network'>, side: 'wallet' | 'vault') =>
  side === 'vault' ? 'Your vault’s deposit address' : `Your ${row.network} address`;

/** Toast after a copy, e.g. "Solana address copied." */
export const copiedMessage = (row: Pick<AssetRow, 'network'>, side: 'wallet' | 'vault') =>
  side === 'vault' ? 'Vault deposit address copied.' : `${row.network} address copied.`;

/** The existing network warning (legacy Receive dialog, kept verbatim). */
export function networkNote(chain: NetworkKey, cluster: SolanaCluster = SOLANA_CLUSTER): string {
  const devnet = chain === 'solana' && cluster === 'devnet';
  return `Only send ${devnet ? 'devnet assets' : 'assets'} on ${networkDisplayName(chain, cluster)} to this address. Verify the network in the sending wallet.`;
}

/**
 * The existing stablecoin identity line with its issuer note, e.g.
 * "Stablecoin on Robinhood Chain: USDG (Paxos Global Dollar). USDG (Global Dollar) is issued by Paxos…".
 * None on Solana devnet, which has no mainnet USDC.
 */
export function stablecoinLine(chain: NetworkKey, cluster: SolanaCluster = SOLANA_CLUSTER): string {
  if (chain === 'solana' && cluster === 'devnet') return '';
  const funding = byKey(chain).funding;
  return `Stablecoin on ${networkDisplayName(chain, cluster)}: ${funding.label} (${funding.name}).${funding.circleIssued ? '' : ` ${funding.issuerNote}`}`;
}

/** The vault takes SOL and Circle USDC on Solana only (USDC on mainnet only). */
export function vaultRows(cluster: SolanaCluster = SOLANA_CLUSTER): AssetRow[] {
  return assetRows(cluster).filter(row => row.chain === 'solana' && !row.unavailable);
}

/** Existing vault copy (6.6 Tokens tab). */
export const VAULT_DEPOSIT_NOTE = 'Only send SOL or Circle USDC on Solana to this address.';

/** Signed-out and EVM-only copy (6.7). */
export const RECEIVE_COPY = Object.freeze({
  signedOutTitle: 'Sign in to receive funds',
  signedOutText: 'Sign in to view your receiving address.',
  noSolana: 'Connect or create a Solana wallet to receive on Solana.',
  noEvm: 'Connect or create an EVM wallet to receive on this network.',
  toWallet: 'To your wallet',
  toVault: 'To your Solana vault',
  search: 'Search assets or networks',
  noMatch: 'No assets match your search.',
});
