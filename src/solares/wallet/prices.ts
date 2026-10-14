/**
 * USD values of wallet and vault balances. Owner decision 2026-10-13: the balance on top of the
 * wallet and of the vault is the total of what it holds, in US dollars, not a single stablecoin.
 * Prices come from ANTARA's API (GET /api/solares/wallet/prices, server/src/solares/prices.ts),
 * which reads Relay's public price endpoint. Pure: no React, no DOM, unit-tested (prices.test.ts).
 *
 * - Exact math: amounts are raw bigint units, prices exact decimals (units / 10^scale). A value
 *   keeps 18 decimal places of a dollar and is rounded only for display (to the cent, half up).
 * - Nothing is invented: an asset without a price has no USD value and is named as excluded; when
 *   no held asset has a price the headline is a token amount, never "$0"; Solana devnet is never priced.
 * - A total is labelled as an estimate ("≈") with its source and the time the prices were read.
 */
import { NETWORK_KEYS, SUPPORTED_NETWORKS, byKey, type SolanaCluster } from '../networks';
import type { WalletChain } from './types';

export type ValuedKind = 'native' | 'stablecoin';
/** An exact USD price: units / 10^scale dollars. */
export interface UsdPrice { readonly units: bigint; readonly scale: number; readonly symbol: string }
export type PriceTable = Partial<Record<WalletChain, Partial<Record<ValuedKind, UsdPrice>>>>;
export interface PriceSnapshot { readonly table: PriceTable; readonly observedAt: string; readonly source: 'Relay' }
/** What the wallet knows about prices: still reading, a snapshot, or none. */
export type PricesState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly snapshot: PriceSnapshot }
  | { readonly status: 'unavailable' };

export const PRICE_SOURCE = 'Relay';
/** Decimal places of a dollar a value keeps before display rounding. */
export const USD_DECIMALS = 18;
const USD_UNIT = 10n ** BigInt(USD_DECIMALS);
const CENT = USD_UNIT / 100n;
/**
 * Sanity bounds of a USD price, shared with the API server (server/src/solares/prices.ts), which
 * omits a price outside them; the client checks again. A native coin between a millionth of a
 * dollar and ten million dollars, a dollar stablecoin between 50 cents and 1.50. Outside them a
 * price is bad data and is dropped, never clamped.
 */
export const USD_PRICE_BOUNDS: Readonly<Record<ValuedKind, Readonly<{ min: number; max: number }>>> = Object.freeze({
  native: Object.freeze({ min: 1e-6, max: 1e7 }),
  stablecoin: Object.freeze({ min: 0.5, max: 1.5 }),
});

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A JavaScript number as an exact decimal (its shortest round-trip spelling, exponents included); null for anything else. */
export function decimalPrice(value: unknown): { units: bigint; scale: number } | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/i.exec(String(value));
  if (!match) return null;
  const fraction = match[2] ?? '';
  let scale = fraction.length - Number(match[3] ?? 0);
  let units = BigInt(`${match[1]}${fraction}`);
  if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
  if (units === 0n || scale > 40) return null;
  return { units, scale };
}

/** A price entry for `kind` on `chain` when it is the registry's asset and inside the bounds; null otherwise. */
function parseQuote(quote: unknown, chain: WalletChain, kind: ValuedKind): UsdPrice | null {
  if (!object(quote)) return null;
  const network = byKey(chain);
  const symbol = kind === 'native' ? network.native.symbol : network.funding.symbol;
  const bounds = USD_PRICE_BOUNDS[kind];
  if (quote.symbol !== symbol || typeof quote.usd !== 'number' || quote.usd < bounds.min || quote.usd > bounds.max) return null;
  const exact = decimalPrice(quote.usd);
  return exact ? { ...exact, symbol } : null;
}

/**
 * The API's snapshot ({ prices: { [network]: { native?, funding? } }, observedAt, source: 'Relay' }).
 * The envelope must be exact; an entry that is malformed, out of bounds or names another symbol is dropped.
 */
export function parsePriceSnapshot(value: unknown): PriceSnapshot {
  if (!object(value) || value.source !== PRICE_SOURCE || !object(value.prices) || typeof value.observedAt !== 'string'
    || value.observedAt.length > 40 || !Number.isFinite(Date.parse(value.observedAt))) {
    throw new Error('The price service returned an invalid answer.');
  }
  const table: PriceTable = {};
  for (const chain of NETWORK_KEYS) {
    const entry = value.prices[chain];
    if (!object(entry)) continue;
    const native = parseQuote(entry.native, chain, 'native');
    const stablecoin = parseQuote(entry.funding, chain, 'stablecoin');
    if (native || stablecoin) table[chain] = { ...(native ? { native } : {}), ...(stablecoin ? { stablecoin } : {}) };
  }
  return { table, observedAt: value.observedAt, source: PRICE_SOURCE };
}

/** The price of an asset, or null (not read, not returned, or Solana on a devnet build). */
export function priceFor(prices: PricesState, chain: WalletChain, kind: ValuedKind, cluster: SolanaCluster = 'mainnet-beta'): UsdPrice | null {
  if (prices.status !== 'ready' || (chain === 'solana' && cluster === 'devnet')) return null;
  return prices.snapshot.table[chain]?.[kind] ?? null;
}

/** USD value of `raw` units with `decimals`, in 10^-18 dollars. Exact up to the 18th decimal place. */
export function usdValue(raw: bigint, decimals: number, price: Pick<UsdPrice, 'units' | 'scale'>): bigint {
  if (raw <= 0n) return 0n;
  return (raw * price.units * USD_UNIT) / 10n ** BigInt(decimals + price.scale);
}

const grouped = (value: bigint) => value.toLocaleString('en-US');

/** "$1,234.56", "$0.00" for an exact zero, "< $0.01" for a positive value under half a cent. Rounds half up to the cent. */
export function formatUsd(value: bigint): string {
  if (value <= 0n) return '$0.00';
  const cents = (value + CENT / 2n) / CENT;
  if (cents === 0n) return '< $0.01';
  return `$${grouped(cents / 100n)}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** A total for display: the rounded amount, and whether it needs "≈" ("< $0.01" already says it is approximate). */
export function usdDisplay(value: bigint): { amount: string; approx: boolean } {
  const amount = formatUsd(value);
  return { amount, approx: !amount.startsWith('<') };
}

/** "≈ $8.43", or "< $0.01". */
export function approxUsd(value: bigint): string {
  const { amount, approx } = usdDisplay(value);
  return approx ? `≈ ${amount}` : amount;
}

/** A unit price: cents from one dollar up ("$107.83"), four significant digits below it ("$0.9999"). */
export function formatPrice(price: Pick<UsdPrice, 'units' | 'scale'>): string {
  const value = usdValue(1n, 0, price);
  if (value >= USD_UNIT) return formatUsd(value);
  const fraction = value.toString().padStart(USD_DECIMALS, '0');
  const keep = Math.min(USD_DECIMALS, fraction.search(/[1-9]/) + 4);
  const step = 10n ** BigInt(USD_DECIMALS - keep);
  const rounded = (value + step / 2n) / step;
  if (rounded >= 10n ** BigInt(keep)) return '$1.00';
  const digits = rounded.toString().padStart(keep, '0').replace(/0+$/, '');
  return `$0.${digits.padEnd(2, '0')}`;
}

/**
 * A token amount for a headline or a caption, never rounded up: up to four decimals, and at least
 * three significant digits below one ("0.0983" for 0.09833392). The exact amount stays in the token rows.
 */
export function compactAmount(raw: bigint, decimals: number): string {
  if (raw <= 0n) return '0';
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, '0');
  const keep = whole > 0n ? 4 : Math.max(4, fraction.search(/[1-9]/) + 3);
  const shown = fraction.slice(0, keep).replace(/0+$/, '');
  return `${grouped(whole)}${shown ? `.${shown}` : ''}`;
}

/** "12:41": the local time a snapshot was read (24-hour, so it reads the same everywhere). */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** "prices from Relay, 12:41". */
export function priceStamp(snapshot: Pick<PriceSnapshot, 'observedAt' | 'source'>): string {
  const clock = formatClock(snapshot.observedAt);
  return clock ? `prices from ${snapshot.source}, ${clock}` : `prices from ${snapshot.source}`;
}

/** One asset an account or a vault holds. `raw` is exact, in units of `decimals`. */
export interface Holding { readonly chain: WalletChain; readonly kind: ValuedKind; readonly raw: bigint; readonly decimals: number; readonly label: string }

export type Valuation =
  /** Nothing held: an exact $0.00, which needs no price. */
  | { readonly kind: 'empty' }
  /** Something is held and prices are still being read. */
  | { readonly kind: 'pending' }
  /** The priced holdings' total; `excluded` are held assets without a price, one per label. */
  | { readonly kind: 'usd'; readonly value: bigint; readonly excluded: readonly Holding[]; readonly snapshot: PriceSnapshot }
  /**
   * No held asset has a price: the largest holding leads, the rest follow, one per label (the same
   * token on several networks, such as Circle USDC or ETH, is added up exactly). Never a dollar figure.
   */
  | { readonly kind: 'unpriced'; readonly lead: Holding; readonly others: readonly Holding[] };

const NETWORK_ORDER = new Map(SUPPORTED_NETWORKS.map((network, index) => [network.key, index]));
const registryOrder = (a: Holding, b: Holding) => ((NETWORK_ORDER.get(a.chain) ?? 99) - (NETWORK_ORDER.get(b.chain) ?? 99)) || ((a.kind === 'native' ? 0 : 1) - (b.kind === 'native' ? 0 : 1));

/** Holdings by token amount, largest first (amounts scaled to a common precision, exactly); ties keep registry order. */
export function byAmount(holdings: readonly Holding[]): Holding[] {
  const precision = Math.max(0, ...holdings.map(holding => holding.decimals));
  const scaled = (holding: Holding) => holding.raw * 10n ** BigInt(precision - holding.decimals);
  return [...holdings].sort((a, b) => {
    const difference = scaled(b) - scaled(a);
    return difference > 0n ? 1 : difference < 0n ? -1 : registryOrder(a, b);
  });
}

/** One holding per label and precision, amounts added exactly, first network kept; registry order. */
export function byLabel(holdings: readonly Holding[]): Holding[] {
  const merged = new Map<string, Holding>();
  for (const holding of [...holdings].sort(registryOrder)) {
    const key = `${holding.label}:${holding.decimals}`;
    const previous = merged.get(key);
    merged.set(key, previous ? { ...previous, raw: previous.raw + holding.raw } : holding);
  }
  return [...merged.values()];
}

/** The USD total of `holdings` at `prices`; see Valuation. Zero balances never need a price. */
export function valuate(holdings: readonly Holding[], prices: PricesState, cluster: SolanaCluster = 'mainnet-beta'): Valuation {
  const held = [...holdings].filter(holding => holding.raw > 0n).sort(registryOrder);
  if (!held.length) return { kind: 'empty' };
  if (prices.status === 'loading') return { kind: 'pending' };
  const priced = held.map(holding => ({ holding, price: priceFor(prices, holding.chain, holding.kind, cluster) }));
  if (prices.status !== 'ready' || priced.every(item => !item.price)) {
    const [lead, ...others] = byAmount(byLabel(held));
    return { kind: 'unpriced', lead, others };
  }
  let value = 0n;
  for (const item of priced) if (item.price) value += usdValue(item.holding.raw, item.holding.decimals, item.price);
  return { kind: 'usd', value, excluded: byLabel(priced.filter(item => !item.price).map(item => item.holding)), snapshot: prices.snapshot };
}

/** "0.0983 SOL". */
export function holdingText(holding: Holding): string {
  return `${compactAmount(holding.raw, holding.decimals)} ${holding.label}`;
}

/** "≈ $8.43" for a valued total, "$0.00" for an empty one. */
export function usdHeadline(valuation: Extract<Valuation, { kind: 'usd' | 'empty' }>): string {
  return valuation.kind === 'empty' ? '$0.00' : approxUsd(valuation.value);
}

/** "Excludes 2.5 USDG (no price)"; amounts left out while balances are hidden. Empty when nothing is excluded. */
export function excludedNote(excluded: readonly Holding[], privacy: boolean): string {
  if (!excluded.length) return '';
  return `Excludes ${excluded.map(holding => privacy ? holding.label : holdingText(holding)).join(', ')} (no price)`;
}

/** The tooltip of a valued total: what it is and where its prices came from. */
export function valuationTitle(valuation: Valuation): string | undefined {
  if (valuation.kind !== 'usd') return undefined;
  const clock = formatClock(valuation.snapshot.observedAt);
  return `Estimated value in US dollars, using ${valuation.snapshot.source} prices${clock ? ` read at ${clock}` : ''}. Not a quote.`;
}
