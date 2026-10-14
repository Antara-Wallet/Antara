/**
 * Pure model of the Settings screen (docs/UI_ARGUS_PARITY.md 6.16): the Networks rows and
 * the About facts. Nothing here reads the DOM, storage or the network, so every label is
 * unit-tested (settingsModel.test.ts). A row says only what the wallet state shows:
 * loading is never "unavailable", and a network with no rows is never "loaded".
 */
import { SUPPORTED_NETWORKS, type NetworkKey } from '../networks';
import type { WalletBalance } from '../wallet/types';
import { shortAddress } from '../ui/address';
import type { ChipTone } from '../ui/StatusChip';
import type { ExtensionSurface, Runtime } from '../../platform';

export const SETTINGS_SECTIONS = Object.freeze(['Account', 'Wallets', 'Address book', 'Security', 'Preferences', 'Networks', 'About'] as const);

export interface NetworkRowInput {
  authenticated: boolean;
  ready: boolean;
  balances: readonly Pick<WalletBalance, 'chain'>[];
  balancesLoading: boolean;
  balancesError: string | null;
  addresses: { solana: string | null; ethereum: string | null };
  cluster: 'mainnet-beta' | 'devnet';
}
export interface NetworkRow {
  key: NetworkKey;
  name: string;
  /** Solana only: "mainnet-beta" or "devnet". */
  cluster: string | null;
  explorer: string;
  status: { tone: ChipTone; label: string };
}

/** Five rows in registry order (Solana first), each with its balance status and explorer. No RPC URL is shown. */
export function networkRows(input: NetworkRowInput): NetworkRow[] {
  const anyRows = input.balances.length > 0;
  return SUPPORTED_NETWORKS.map(network => {
    const family = network.vm === 'svm' ? 'solana' : 'ethereum';
    let status: NetworkRow['status'];
    if (!input.authenticated) status = { tone: 'neutral', label: 'Sign in to load balances' };
    else if (!input.addresses[family]) status = { tone: 'neutral', label: family === 'solana' ? 'No Solana wallet' : 'No EVM wallet' };
    else if (input.balances.some(balance => balance.chain === network.key)) status = { tone: 'ok', label: 'Balances loaded' };
    // Still loading (or not read yet, with no error and no rows at all): never "unavailable".
    else if (!input.ready || input.balancesLoading || (!anyRows && !input.balancesError)) status = { tone: 'neutral', label: 'Loading…' };
    else status = { tone: 'warn', label: 'Balances unavailable' };
    return {
      key: network.key,
      name: network.name,
      cluster: network.key === 'solana' ? input.cluster : null,
      explorer: network.explorer.name,
      status,
    };
  });
}

const SURFACES: Readonly<Record<ExtensionSurface, string>> = Object.freeze({ sidepanel: 'side panel', tab: 'tab', popup: 'popup' });
/** "Desktop app", "Chrome extension · side panel" (· tab, · popup) or "Web". */
export function surfaceLabel(runtime: Runtime, surface: ExtensionSurface | null): string {
  if (runtime === 'tauri') return 'Desktop app';
  if (runtime === 'extension') return surface ? `Chrome extension · ${SURFACES[surface]}` : 'Chrome extension';
  return 'Web';
}

/** The API host this build talks to, or "This site" for same-origin `/api`. */
export function apiHostLabel(apiUrl: string): string {
  const value = apiUrl.trim();
  if (!value) return 'This site';
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

/** The vault guardian pinned into this build (a public key), shortened; never implies the guardian is switched on. */
export function guardianLabel(pin: string): string {
  return pin.trim() ? shortAddress(pin) : 'Not set in this build';
}
