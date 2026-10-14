/**
 * Activity model (docs/UI_ARGUS_PARITY.md 6.11, contract 8.4): what this device started,
 * merged from three device-local records: transfers (transfers/transfer.ts), Relay
 * routes (relay/history.ts) and paired-vault actions (vaults/vaultActivity.ts, 8.5).
 *
 * Pure, apart from `useActivityItems`. `mergeActivity` never throws: a malformed record
 * is dropped, a record on a removed network (Arbitrum, Polygon) stays readable and is
 * marked `legacy` (read-only, never refreshed against Relay), and records of another
 * Privy user or another wallet are never returned. It never invents a status: every
 * label comes from the stored record.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSolaresWallet } from '../wallet/context';
import { SOLANA_CLUSTER } from '../wallet/config';
import {
  LEGACY_NETWORKS, SOLANA_NETWORK, byKey, describeChainId, explorerAddressUrl, explorerTxUrl,
  isFundingToken, isLegacyNetworkKey, isNetworkKey,
} from '../networks';
import { formatAmount, isTerminal, sameAddress, type TradeRecord, type TradeStatus } from '../relay/model';
import { fillWindowNote } from '../relay/review';
import type { TransferRecord } from '../transfers/transfer';

export type ActivityKind = 'Sent' | 'Swap' | 'Vault';
export type ActivityTone = 'neutral' | 'ok' | 'warn' | 'danger';

/** A paired-vault action, as Area D's vaults/vaultActivity.ts stores it (contract 8.5). */
export interface VaultActivityRecord {
  id: string;
  kind: 'deposit' | 'release' | 'activation';
  multisig: string;
  asset?: 'SOL' | 'USDC';
  amount?: string;
  recipient?: string;
  index?: string;
  signature: string;
  status: 'confirmed' | 'submitted';
  createdAt: string;
}
/** Storage key of contract 8.5 (read directly only when vaults/vaultActivity.ts is not in this build). */
export const VAULT_ACTIVITY_STORAGE_KEY = (privyUserId: string) => `solares.vault.activity.v1:${privyUserId}`;

/**
 * One row (contract 8.4). The fields after `vault` are additive and optional, so readers
 * written against the contract keep compiling:
 * - `status`, `network`, `tone`: the row's status label, network label and chip tone;
 * - `legacy`: a record on a network ANTARA no longer supports (read-only);
 * - `trade`: every swap's saved route. `route` is set only when Relay status refresh is
 *   possible (both networks supported), as in the legacy panel;
 * - `fill`: Relay's fill-window line for a settling swap; `settlement`: its tracking label.
 */
export interface ActivityItem {
  key: string;
  kind: ActivityKind;
  title: string;
  description: string;
  amount: string;
  timestamp: number;
  chain?: string;
  hash?: string;
  explorer?: string;
  from?: string;
  to?: string;
  route?: TradeRecord;
  vault?: VaultActivityRecord;
  status?: string;
  network?: string;
  tone?: ActivityTone;
  legacy?: boolean;
  trade?: TradeRecord;
  fill?: { notFilled: boolean; detail: string } | null;
  settlement?: string;
  /** Explorer name for `explorer` ("Solscan", "Etherscan", …). */
  explorerName?: string;
  /** Receiving side of a swap: "<token> on <network>". */
  receive?: string;
}

export interface MergeInput {
  userId: string;
  addresses: { solana: string | null; ethereum: string | null };
  transfers: readonly TransferRecord[];
  routes: readonly TradeRecord[];
  vault: readonly VaultActivityRecord[];
  /** Clock for Relay fill windows. Default Date.now(). */
  now?: number;
}

/** Copy (6.11). Kept here so the screen, the detail sheet and tests share one source. */
export const ACTIVITY_COPY = Object.freeze({
  signedOutTitle: 'Your activity, in one place',
  signedOutText: 'Sign in to see transfers and routes initiated on this device.',
  emptyTitle: 'No activity yet',
  emptyText: 'Your transfers and swaps made here will appear on this device.',
  filterEmpty: Object.freeze({ Sent: 'No transfers on this device yet.', Swap: 'No swaps on this device yet.', Vault: 'No vault activity on this device yet.' }),
  storageError: 'Unable to load activity on this device.',
  refreshError: 'Unable to refresh route status.',
  footnote: 'Activity initiated on this device. Refresh route status or inspect the explorer before retrying an unknown outcome.',
  extensionNote: 'Activity started in the ANTARA extension. The desktop app keeps its own.',
  unknownOutcome: 'Wallet outcome unknown',
  unknownHint: 'Check wallet history before retrying',
  releaseApproval: 'Approved by your wallet and ANTARA',
});

const capitalize = (value: string) => value ? value[0].toUpperCase() + value.slice(1) : value;
const DECIMAL = /^\d{1,30}(\.\d{1,36})?$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const LABEL = /^[^\p{C}]{1,40}$/u;
const solanaAddress = (value: unknown): value is string => typeof value === 'string' && value.length >= 32 && value.length <= 44 && BASE58.test(value);

/** Network label of a supported or legacy network key; legacy networks say "(no longer supported)". */
function networkLabel(chain: string) {
  if (isNetworkKey(chain)) return chain === 'solana' && SOLANA_CLUSTER === 'devnet' ? `${byKey(chain).name} devnet` : byKey(chain).name;
  return LEGACY_NETWORKS.find(network => network.key === chain)?.label ?? 'Unknown network';
}
function explorerTarget(chain: string) {
  return isNetworkKey(chain) ? byKey(chain) : LEGACY_NETWORKS.find(network => network.key === chain);
}
const explorerOptions = { solanaCluster: SOLANA_CLUSTER } as const;

/** Relay tracking labels, matching the Swap screen's status list (relay/TradeWorkspace.tsx). */
export const SETTLEMENT_LABELS: Readonly<Record<TradeStatus, string>> = Object.freeze({
  waiting: 'Awaiting deposit', depositing: 'Deposit confirming', pending: 'Swapping', submitted: 'Destination submitted',
  delayed: 'Settlement delayed', success: 'Delivered', refund: 'Refunded', failure: 'Needs attention', unresolved: 'Status unresolved',
});
const ROUTE_TONES: Readonly<Record<TradeStatus, ActivityTone>> = Object.freeze({
  waiting: 'neutral', depositing: 'neutral', pending: 'neutral', submitted: 'neutral', delayed: 'warn',
  success: 'ok', refund: 'neutral', failure: 'danger', unresolved: 'warn',
});

// ---------- Transfers ----------

const TRANSFER_STATUS: Readonly<Record<TransferRecord['status'], { label: string; tone: ActivityTone }>> = Object.freeze({
  confirmed: { label: 'Confirmed', tone: 'ok' },
  submitted: { label: 'Submitted', tone: 'neutral' },
  reverted: { label: 'Reverted', tone: 'danger' },
  'submission-unknown': { label: ACTIVITY_COPY.unknownOutcome, tone: 'warn' },
});

function transferItem(record: TransferRecord, addresses: MergeInput['addresses']): ActivityItem | null {
  if (!record || typeof record !== 'object') return null;
  const { id, chain, symbol, amount, recipient, sender, hash, status, createdAt } = record;
  if (typeof id !== 'string' || !id || typeof chain !== 'string' || !(isNetworkKey(chain) || isLegacyNetworkKey(chain))) return null;
  if (typeof symbol !== 'string' || !LABEL.test(symbol) || typeof amount !== 'string' || !DECIMAL.test(amount)) return null;
  if (typeof recipient !== 'string' || typeof hash !== 'string' || typeof createdAt !== 'string' || !Object.prototype.hasOwnProperty.call(TRANSFER_STATUS, status)) return null;
  // Only the selected wallet's own transfers (the legacy panel's rule): no sender, no row.
  const vm = chain === 'solana' ? 'solana' : 'ethereum';
  const own = addresses[vm];
  if (typeof sender !== 'string' || !sender || !own || !sameAddress(sender, own, vm)) return null;
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return null;
  const network = networkLabel(chain);
  const target = explorerTarget(chain);
  const unknown = status === 'submission-unknown';
  // "<status> · <network>": the order the browser specs assert for transfer rows (wallet.spec.ts).
  const statusText = unknown ? ACTIVITY_COPY.unknownHint : TRANSFER_STATUS[status].label;
  return {
    key: `transfer:${id}`,
    kind: 'Sent',
    title: unknown ? ACTIVITY_COPY.unknownOutcome : `${status === 'reverted' ? 'Reverted' : 'Sent'} ${symbol}`,
    description: `${statusText} · ${network}`,
    amount: `${amount} ${symbol}`,
    timestamp,
    chain,
    hash: hash || undefined,
    // No hash yet (outcome unknown): the sender's account page, where the wallet's own history shows.
    explorer: target ? (hash ? explorerTxUrl(target, hash, explorerOptions) : explorerAddressUrl(target, sender, explorerOptions)) : undefined,
    explorerName: target?.explorer.name,
    from: sender,
    to: recipient || undefined,
    status: TRANSFER_STATUS[status].label,
    network,
    tone: TRANSFER_STATUS[status].tone,
    legacy: isLegacyNetworkKey(chain),
  };
}

// ---------- Relay routes ----------

/** Display-only summary of a saved route (moved from the legacy panel); never throws for removed or unknown networks. */
export function describeRoute(record: TradeRecord) {
  const source = describeChainId(record.intent.originChainId);
  const destination = describeChainId(record.intent.destinationChainId);
  // The amount is in base units of the source network's funding stablecoin (Circle USDC on removed networks).
  const funding = source.status === 'supported' ? source.network.funding : source.status === 'legacy' ? { label: source.legacy.usdc.symbol, decimals: source.legacy.usdc.decimals } : null;
  const token = record.intent.destinationToken;
  let received = 'Unknown token';
  if (token && typeof token === 'object') {
    if (destination.status !== 'supported' || token.chainId !== destination.chainId) received = typeof token.symbol === 'string' ? token.symbol : received;
    else if (destination.network.rejectedLookalikes.some(item => item.toLowerCase() === String(token.address).toLowerCase())) received = 'Unverified token';
    else if (isFundingToken(destination.network, String(token.address)) && token.decimals === destination.network.funding.decimals) received = destination.network.funding.label;
    // Any other token calling itself a supported stablecoin is not shown under that name.
    else if (typeof token.symbol === 'string') received = /^usd[cg]$/i.test(token.symbol.trim()) ? 'Unverified token' : token.symbol;
  } else if (token === 'native') {
    received = destination.status === 'supported' ? destination.network.native.symbol : destination.status === 'legacy' ? destination.legacy.native.symbol : received;
  } else if (token === 'USDC') {
    // The legacy selector meant Circle USDC; it never names another issuer's stablecoin.
    received = destination.status === 'legacy' || (destination.status === 'supported' && destination.network.funding.circleIssued) ? 'USDC' : received;
  }
  return {
    source,
    destination,
    spent: funding?.label ?? 'Unknown token',
    received,
    amount: funding ? `${formatAmount(record.intent.amount, funding.decimals)} ${funding.label}` : 'Unknown amount',
    sourceVm: source.status === 'supported' ? (source.network.vm === 'svm' ? 'solana' as const : 'ethereum' as const) : source.status === 'legacy' ? 'ethereum' as const : undefined,
    // Status refresh contacts Relay, which only serves supported networks.
    refreshable: source.status === 'supported' && destination.status === 'supported',
  };
}

function routeItem(record: TradeRecord, addresses: MergeInput['addresses'], now: number): ActivityItem | null {
  try {
    if (!record || typeof record !== 'object' || !record.intent || typeof record.requestId !== 'string' || !Number.isSafeInteger(record.createdAt)) return null;
    if (!Object.prototype.hasOwnProperty.call(SETTLEMENT_LABELS, record.status)) return null;
    const route = describeRoute(record);
    const own = route.sourceVm ? addresses[route.sourceVm] : null;
    // Only routes the selected wallet submitted (the legacy panel's rule).
    if (!route.sourceVm || !own || typeof record.intent.user !== 'string' || !sameAddress(record.intent.user, own, route.sourceVm)) return null;
    const legacy = !route.refreshable;
    // A saved order's fill window; never for removed networks (Swap screen rule).
    let fill: ActivityItem['fill'] = null;
    if (!legacy) { try { fill = fillWindowNote(record, now); } catch { fill = null; } }
    // Raw Relay status word, as the legacy panel and the browser specs show it ("success").
    const status = legacy && !isTerminal(record.status) ? 'Not tracked' : fill?.notFilled ? 'Not filled' : capitalize(String(record.status).replace(/_/g, ' '));
    const settlement = legacy && !isTerminal(record.status) ? 'Not tracked' : fill?.notFilled ? 'Not filled' : SETTLEMENT_LABELS[record.status];
    const tone: ActivityTone = legacy && !isTerminal(record.status) ? 'neutral' : fill?.notFilled ? 'warn' : ROUTE_TONES[record.status];
    const network = route.source.label;
    const target = route.source.status === 'supported' ? route.source.network : route.source.status === 'legacy' ? route.source.legacy : null;
    const hashes = Array.isArray(record.sourceTxHashes) ? record.sourceTxHashes.filter(hash => typeof hash === 'string' && hash) : [];
    const hash = hashes[0];
    const destinationLabel = route.destination.label;
    return {
      key: `route:${record.requestId}`,
      kind: 'Swap',
      title: `${route.spent} → ${route.received}`,
      // "<network> · <status>": the order the browser specs assert for route rows (wallet.spec.ts).
      description: `${network} · ${status}`,
      amount: route.amount,
      timestamp: record.createdAt,
      chain: target?.key,
      hash,
      explorer: hash && target ? explorerTxUrl(target, hash, explorerOptions) : undefined,
      explorerName: hash && target ? target.explorer.name : undefined,
      from: typeof record.intent.user === 'string' ? record.intent.user : undefined,
      to: typeof record.intent.recipient === 'string' ? record.intent.recipient : undefined,
      route: route.refreshable ? record : undefined,
      status,
      network,
      tone,
      legacy,
      trade: record,
      fill,
      settlement,
      receive: `${route.received} on ${destinationLabel}`,
    };
  } catch {
    return null;
  }
}

// ---------- Paired-vault actions ----------

/** Strict shape check for a stored vault record (contract 8.5); anything else is dropped. */
export function isVaultActivityRecord(value: unknown): value is VaultActivityRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 128 &&
    (record.kind === 'deposit' || record.kind === 'release' || record.kind === 'activation') &&
    solanaAddress(record.multisig) &&
    (record.asset === undefined || record.asset === 'SOL' || record.asset === 'USDC') &&
    (record.amount === undefined || (typeof record.amount === 'string' && DECIMAL.test(record.amount))) &&
    (record.recipient === undefined || solanaAddress(record.recipient)) &&
    (record.index === undefined || (typeof record.index === 'string' && /^\d{1,20}$/.test(record.index))) &&
    typeof record.signature === 'string' && record.signature.length >= 64 && record.signature.length <= 128 && BASE58.test(record.signature) &&
    (record.status === 'confirmed' || record.status === 'submitted') &&
    typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt));
}

/** Reads contract 8.5's storage directly: newest first, at most 100, malformed rows dropped. Never throws. */
export function readVaultActivity(storage: Pick<Storage, 'getItem'> | undefined, privyUserId: string): VaultActivityRecord[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(VAULT_ACTIVITY_STORAGE_KEY(privyUserId)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isVaultActivityRecord).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 100);
  } catch {
    return [];
  }
}

const VAULT_TITLES: Readonly<Record<VaultActivityRecord['kind'], string>> = Object.freeze({
  deposit: 'Vault deposit', release: 'Vault release', activation: 'Vault activation',
});

function vaultItem(record: VaultActivityRecord, addresses: MergeInput['addresses']): ActivityItem | null {
  // Per-user storage; the vault is paired with the account's Solana wallet, so no Solana wallet means no rows.
  if (!isVaultActivityRecord(record) || !addresses.solana) return null;
  const network = networkLabel('solana');
  const status = record.status === 'confirmed' ? 'Confirmed' : 'Submitted';
  return {
    key: `vault:${record.id}`,
    kind: 'Vault',
    title: record.kind === 'release' && record.index ? `Vault release #${record.index}` : VAULT_TITLES[record.kind],
    description: `${network} · ${status}`,
    amount: record.amount && record.asset ? `${record.amount} ${record.asset}` : '',
    timestamp: Date.parse(record.createdAt),
    chain: 'solana',
    hash: record.signature,
    explorer: explorerTxUrl(SOLANA_NETWORK, record.signature, explorerOptions),
    explorerName: SOLANA_NETWORK.explorer.name,
    to: record.kind === 'release' ? record.recipient : undefined,
    vault: record,
    status,
    network,
    tone: record.status === 'confirmed' ? 'ok' : 'neutral',
    legacy: false,
  };
}

/**
 * Merges the three sources into rows, newest first (ties by key, so the order is stable).
 * Only records of `userId`'s selected wallets are returned; malformed records are dropped.
 */
export function mergeActivity(input: MergeInput): ActivityItem[] {
  if (!input.userId) return [];
  const now = input.now ?? Date.now();
  const items: (ActivityItem | null)[] = [
    ...(Array.isArray(input.transfers) ? input.transfers : []).map(record => transferItem(record, input.addresses)),
    ...(Array.isArray(input.routes) ? input.routes : []).map(record => routeItem(record, input.addresses, now)),
    ...(Array.isArray(input.vault) ? input.vault : []).map(record => vaultItem(record, input.addresses)),
  ];
  const seen = new Set<string>();
  return items
    .filter((item): item is ActivityItem => !!item && Number.isFinite(item.timestamp) && !seen.has(item.key) && !!seen.add(item.key))
    .sort((a, b) => b.timestamp - a.timestamp || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Filter tabs (6.11): All · Sent · Swaps · Vault. */
export type ActivityFilter = 'All' | ActivityKind;
export const ACTIVITY_FILTERS: readonly { value: ActivityFilter; label: string }[] = Object.freeze([
  { value: 'All', label: 'All' }, { value: 'Sent', label: 'Sent' }, { value: 'Swap', label: 'Swaps' }, { value: 'Vault', label: 'Vault' },
]);
export function filterActivity(items: readonly ActivityItem[], filter: ActivityFilter): ActivityItem[] {
  return filter === 'All' ? [...items] : items.filter(item => item.kind === filter);
}

// ---------- Hook ----------

/** Area D's reader when it is in this build, else the contract's storage read above. */
async function vaultReader(): Promise<(privyUserId: string) => unknown[]> {
  const modules = import.meta.glob<{ vaultActivity?: (privyUserId: string) => unknown[] }>('../vaults/vaultActivity.ts');
  const load = Object.values(modules)[0];
  if (load) {
    const module = await load();
    if (typeof module.vaultActivity === 'function') return module.vaultActivity;
  }
  return privyUserId => readVaultActivity(globalThis.localStorage, privyUserId);
}

/** Same-page events that mean "a record changed" (8.4); `storage` covers other tabs. */
export const ACTIVITY_EVENTS = Object.freeze(['solares:transfers', 'solares:relay-activity', 'solares:vault-activity'] as const);

/**
 * The selected wallets' activity on this device (8.4). Re-reads on mount, when the page
 * becomes visible, on `storage` (other tabs) and on the three same-page events.
 * `loading` is additive: true until the first read finishes.
 */
export function useActivityItems(limit?: number): { items: ActivityItem[]; error: string; loading: boolean } {
  const wallet = useSolaresWallet();
  const { authenticated, userId } = wallet;
  const { solana, ethereum } = wallet.addresses;
  // Signed in: loading until the first read, so the screen never flashes "No activity yet".
  const [state, setState] = useState<{ items: ActivityItem[]; error: string; loading: boolean }>(() => ({ items: [], error: '', loading: authenticated && !!userId }));
  useEffect(() => {
    if (!authenticated || !userId) { setState({ items: [], error: '', loading: false }); return; }
    setState({ items: [], error: '', loading: true });
    let active = true;
    let sequence = 0;
    const read = async (run: number) => {
      const [{ loadTradeHistory }, { transferHistory }, readVault] = await Promise.all([
        import('../relay/history'),
        import('../transfers/transfer'),
        vaultReader(),
      ]);
      const items = mergeActivity({
        userId,
        addresses: { solana, ethereum },
        transfers: transferHistory(userId),
        routes: loadTradeHistory(),
        vault: readVault(userId) as VaultActivityRecord[],
      });
      // A slower earlier read never overwrites a newer one.
      if (active && run === sequence) setState({ items, error: '', loading: false });
    };
    const reload = () => {
      const run = ++sequence;
      void read(run).catch(() => {
        if (active && run === sequence) setState(previous => ({ items: previous.items, error: ACTIVITY_COPY.storageError, loading: false }));
      });
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') reload(); };
    reload();
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, reload);
    window.addEventListener('storage', reload);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, reload);
      window.removeEventListener('storage', reload);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [authenticated, userId, solana, ethereum]);
  return useMemo(() => (limit === undefined ? state : { ...state, items: state.items.slice(0, Math.max(0, limit)) }), [state, limit]);
}
