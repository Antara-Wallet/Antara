import { GMGN_API_KEY, hasGmgn } from "../config.js";
import { cache } from "../cache.js";

/**
 * GMGN read-only intel layer — trending tokens + token safety/rug checks.
 *
 * DELIBERATELY ISOLATED + FAIL-SOFT: GMGN has no documented stable REST URL and
 * changes fields often, so every call is wrapped to return null/[] on any error.
 * GMGN must NEVER be on the critical path (balances/swaps). This is a bonus.
 *
 * NOTE: exact endpoint paths/headers below are best-effort and must be verified
 * against a live key. If they 404, the functions degrade silently to empty.
 */

const BASE = "https://gmgn.ai/api/v1";
const TTL = 60_000;

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${GMGN_API_KEY}`, accept: "application/json" };
}

async function safeGet<T>(path: string): Promise<T | null> {
  if (!hasGmgn()) return null;
  try {
    const res = await fetch(`${BASE}${path}`, { headers: headers() });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface TrendingToken {
  address: string;
  symbol: string;
  name: string;
  priceUsd?: number;
  change1h?: number;
  change24h?: number;
  volume24h?: number;
}

export async function getTrending(
  chain: "eth" | "base"
): Promise<TrendingToken[]> {
  const data = await cache.wrap(`gmgn:trending:${chain}`, TTL, () =>
    safeGet<{ data?: { tokens?: TrendingToken[] } }>(
      `/market/trending?chain=${chain}`
    )
  );
  return data?.data?.tokens ?? [];
}

export interface TokenSafety {
  address: string;
  isHoneypot?: boolean;
  buyTax?: number;
  sellTax?: number;
  renounced?: boolean;
  rugScore?: number;
  raw?: unknown;
}

export async function getTokenSafety(
  chain: "eth" | "base",
  address: string
): Promise<TokenSafety | null> {
  const data = await cache.wrap(
    `gmgn:safety:${chain}:${address.toLowerCase()}`,
    TTL,
    () =>
      safeGet<{ data?: TokenSafety }>(
        `/token/security?chain=${chain}&address=${address}`
      )
  );
  if (!data?.data) return null;
  return { ...data.data, address };
}
