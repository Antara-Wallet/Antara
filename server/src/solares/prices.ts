import { Router } from 'express';
import { SUPPORTED_NETWORKS, type Network, type NetworkKey } from '../../../src/solares/networks';
import { USD_PRICE_BOUNDS } from '../../../src/solares/wallet/prices';
import { rateLimit } from './rateLimit';
import { solanaCluster } from '../config.js';

/**
 * USD prices for each supported network's native coin and funding stablecoin, read from Relay's
 * public price endpoint (GET https://api.relay.link/currencies/token/price?address=&chainId=, which
 * answers {"price": <number>} or 400 {"error":"Could not get price"}; captured read-only in
 * fixtures/relay-prices). Prices are public market data, so the route is public and read-only,
 * limited per client IP, and served from a 60-second in-memory cache: concurrent callers share one
 * upstream read, so the upstream load is at most one read per asset per minute however many clients ask.
 *
 * Nothing is invented. A price Relay does not return, or returns outside sane bounds, is omitted,
 * and the client shows that asset without a USD value. Every price is labelled with its source
 * and the time it was read. The server's RELAY_API_KEY, when set, is sent to Relay only and never returned.
 */
export const RELAY_PRICE_URL = 'https://api.relay.link/currencies/token/price';
/** How long a complete snapshot is served from memory. */
export const PRICE_TTL_MS = 60_000;
/** A snapshot with any missing price is kept only this long, so a transient Relay failure clears quickly. */
export const PARTIAL_PRICE_TTL_MS = 15_000;
/** Each upstream read is abandoned after this long. */
export const PRICE_TIMEOUT_MS = 5_000;
/**
 * Sanity bounds, in USD, shared with the client (src/solares/wallet/prices.ts USD_PRICE_BOUNDS).
 * Outside them the value is treated as bad data and omitted, never clamped: a native coin between
 * a millionth of a dollar and ten million dollars, a dollar stablecoin between 50 cents and 1.50.
 */
export const PRICE_BOUNDS = Object.freeze({ native: USD_PRICE_BOUNDS.native, funding: USD_PRICE_BOUNDS.stablecoin });

export type PriceKind = keyof typeof PRICE_BOUNDS;
export interface PriceQuote { readonly usd: number; readonly symbol: string }
export type NetworkPrices = Partial<Record<PriceKind, PriceQuote>>;
export interface PriceSnapshot {
  readonly prices: Partial<Record<NetworkKey, NetworkPrices>>;
  /** When these prices were read from Relay (ISO 8601). */
  readonly observedAt: string;
  readonly source: 'Relay';
}

type FetchLike = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;
export interface PriceSourceOptions {
  /** Defaults to the global fetch, resolved at call time. */
  fetch?: FetchLike;
  now?: () => number;
  /** Defaults to RELAY_API_KEY. Sent upstream only. */
  apiKey?: () => string | undefined;
  /** Solana devnet tokens have no market value: when 'devnet', Solana is never priced. */
  cluster?: () => 'mainnet-beta' | 'devnet';
  ttlMs?: number;
  partialTtlMs?: number;
  timeoutMs?: number;
}

/** The asset Relay is asked about: the pinned native currency address or the pinned stablecoin. */
export function priceRequest(network: Network, kind: PriceKind): { chainId: number; address: string; symbol: string } {
  return kind === 'native'
    ? { chainId: network.relay.chainId, address: network.native.relayAddress, symbol: network.native.symbol }
    : { chainId: network.relay.chainId, address: network.funding.address, symbol: network.funding.symbol };
}

/** The price in Relay's answer when it is a finite number inside the bounds for `kind`; null otherwise. */
export function parseRelayPrice(body: unknown, kind: PriceKind): number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const price = (body as { price?: unknown }).price;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  const bounds = PRICE_BOUNDS[kind];
  return price >= bounds.min && price <= bounds.max ? price : null;
}

/** Reads one price; any failure (status, timeout, size, shape, bounds) is null. */
async function readPrice(fetchImpl: FetchLike, network: Network, kind: PriceKind, apiKey: string | undefined, timeoutMs: number): Promise<PriceQuote | null> {
  const asset = priceRequest(network, kind);
  // Fixed origin and path; only pinned registry values reach the query string.
  const url = `${RELAY_PRICE_URL}?${new URLSearchParams({ address: asset.address, chainId: String(asset.chainId) })}`;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 4_096) return null;
    const usd = parseRelayPrice(JSON.parse(text), kind);
    return usd === null ? null : { usd, symbol: asset.symbol };
  } catch {
    return null;
  }
}

/** A cached, coalescing reader of every supported network's two prices. */
export function createPriceSource(options: PriceSourceOptions = {}): () => Promise<PriceSnapshot> {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const apiKey = options.apiKey ?? (() => process.env.RELAY_API_KEY?.trim() || undefined);
  const cluster = options.cluster ?? solanaCluster;
  const ttlMs = options.ttlMs ?? PRICE_TTL_MS;
  const partialTtlMs = options.partialTtlMs ?? PARTIAL_PRICE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? PRICE_TIMEOUT_MS;
  let cached: { snapshot: PriceSnapshot; expires: number } | null = null;
  let inflight: Promise<PriceSnapshot> | null = null;

  async function refresh(): Promise<PriceSnapshot> {
    const key = apiKey();
    const networks = SUPPORTED_NETWORKS.filter(network => network.key !== 'solana' || cluster() !== 'devnet');
    const reads = networks.flatMap(network => (['native', 'funding'] as const).map(async kind => ({ network: network.key, kind, quote: await readPrice(fetchImpl, network, kind, key, timeoutMs) })));
    const results = await Promise.all(reads);
    const prices: Partial<Record<NetworkKey, NetworkPrices>> = {};
    for (const { network, kind, quote } of results) if (quote) (prices[network] ??= {})[kind] = quote;
    const snapshot: PriceSnapshot = { prices, observedAt: new Date(now()).toISOString(), source: 'Relay' };
    // A devnet build leaves Solana out deliberately; only a price Relay failed to give shortens the cache.
    const complete = results.every(result => result.quote);
    cached = { snapshot, expires: now() + (complete ? ttlMs : partialTtlMs) };
    return snapshot;
  }

  return async () => {
    if (cached && cached.expires > now()) return cached.snapshot;
    inflight ??= refresh().finally(() => { inflight = null; });
    return inflight;
  };
}

export interface PricesRouterOptions extends PriceSourceOptions {
  /** Requests per client IP per minute. Clients refresh about once a minute. */
  perIpPerMinute?: number;
  read?: () => Promise<PriceSnapshot>;
}

/** GET / : the current snapshot, or 503 when Relay priced nothing. Public; no session or wallet involved. */
export function pricesRouter(options: PricesRouterOptions = {}) {
  const read = options.read ?? createPriceSource(options);
  const router = Router();
  router.get('/',
    rateLimit({ max: options.perIpPerMinute ?? 60, scope: () => 'prices', message: 'Please wait before refreshing prices again.' }),
    async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const snapshot = await read();
        if (!Object.keys(snapshot.prices).length) { res.status(503).json({ error: 'Prices are unavailable right now.', source: 'Relay' }); return; }
        res.json(snapshot);
      } catch {
        res.status(503).json({ error: 'Prices are unavailable right now.', source: 'Relay' });
      }
    });
  return router;
}
