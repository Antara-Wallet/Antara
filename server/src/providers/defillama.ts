import { cache } from "../cache.js";

const BASE = "https://coins.llama.fi/prices/current";
const PRICE_TTL = 60_000;

export interface LlamaPrice {
  price: number;
  symbol?: string;
  decimals?: number;
}

/**
 * Fetch USD prices for DefiLlama coin ids, e.g.
 *   "coingecko:ethereum", "ethereum:0xA0b8...", "base:0x833..."
 * Per-id cached for 60s, so 100 users polling the same assets = 1 upstream call.
 */
export async function getPrices(
  ids: string[]
): Promise<Record<string, LlamaPrice>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const result: Record<string, LlamaPrice> = {};
  const missing: string[] = [];

  for (const id of unique) {
    const cached = priceMemory.get(id);
    if (cached && cached.expires > Date.now()) result[id] = cached.value;
    else missing.push(id);
  }

  if (missing.length === 0) return result;

  // De-dupe the upstream call across concurrent requests.
  const fetched = await cache.wrap(
    `llama:${missing.slice().sort().join(",")}`,
    PRICE_TTL,
    () => fetchPrices(missing)
  );

  for (const [id, price] of Object.entries(fetched)) {
    rememberPrice(id, price);
    result[id] = price;
  }
  return result;
}

const priceMemory = new Map<string, { value: LlamaPrice; expires: number }>();
const PRICE_MEMORY_MAX = 5_000;

// Ids are caller-supplied on a public route, so memory is bounded. With one TTL,
// insertion order is expiry order: drop expired (or, at capacity, oldest) first.
function rememberPrice(id: string, value: LlamaPrice) {
  const now = Date.now();
  priceMemory.delete(id);
  for (const [key, entry] of priceMemory) {
    if (entry.expires > now && priceMemory.size < PRICE_MEMORY_MAX) break;
    priceMemory.delete(key);
  }
  priceMemory.set(id, { value, expires: now + PRICE_TTL });
}

async function fetchPrices(ids: string[]): Promise<Record<string, LlamaPrice>> {
  const url = `${BASE}/${encodeURIComponent(ids.join(","))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DefiLlama ${res.status}`);
  const json = (await res.json()) as {
    coins: Record<
      string,
      { price: number; symbol?: string; decimals?: number }
    >;
  };
  const out: Record<string, LlamaPrice> = {};
  for (const [id, data] of Object.entries(json.coins ?? {})) {
    out[id] = {
      price: data.price,
      symbol: data.symbol,
      decimals: data.decimals,
    };
  }
  return out;
}
