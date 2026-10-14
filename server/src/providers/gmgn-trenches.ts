import { randomUUID } from "node:crypto";
import { GMGN_API_KEY, hasGmgn } from "../config.js";
import { cache } from "../cache.js";

/**
 * GMGN trenches — the "new launches" terminal feed (New / Almost-bonded /
 * Migrated). READ-ONLY + FAIL-SOFT: intel/discovery layer, never on the
 * critical path. Any error returns empty arrays.
 *
 * Verified against the official GMGN OpenAPI client (gmgn-cli) on 2026-05-28:
 *   POST https://openapi.gmgn.ai/v1/trenches?chain=&timestamp=&client_id=
 *   header: X-APIKEY: <key>            (no private key / signature for reads)
 *   body:   { version: "v2", <type>: { filters, launchpad_platform,
 *             quote_address_type, launchpad_platform_v2: true, limit } }
 *   response: { code: 0, data: { new_creation: [], pump: [], completed: [] } }
 *   NOTE: near_completion data is returned under the "pump" key.
 *
 * EVM coverage is Base + BSC. Ethereum mainnet is NOT supported (returns []).
 */

const HOST = "https://openapi.gmgn.ai";
const TTL = 2_000; // one upstream poll shared across all users via the cache.

export type TrenchChain = "base" | "bsc";
export type TrenchType = "new_creation" | "near_completion" | "completed";

// Response array keys, per stage (GMGN serves near_completion under "pump").
const STAGE_KEY: Record<TrenchType, string> = {
  new_creation: "new_creation",
  near_completion: "pump",
  completed: "completed",
};

const LAUNCHPADS: Record<TrenchChain, string[]> = {
  base: [
    "clanker",
    "bankr",
    "flaunch",
    "zora",
    "zora_creator",
    "baseapp",
    "basememe",
    "virtuals_v2",
    "klik",
  ],
  bsc: [
    "fourmeme",
    "fourmeme_agent",
    "bn_fourmeme",
    "four_xmode_agent",
    "flap",
    "clanker",
    "lunafun",
  ],
};

const QUOTE_TYPES: Record<TrenchChain, number[]> = {
  base: [11, 3, 12, 13, 0],
  bsc: [6, 7, 1, 16, 8, 3, 9, 10, 2, 17, 18, 0],
};

export interface TrenchToken {
  chain: string;
  address: string;
  symbol: string;
  name: string;
  logo: string | null;
  launchpad: string | null;
  ageSeconds: number | null;
  marketCap: number | null;
  volume: number | null;
  liquidity: number | null;
  holderCount: number | null;
  progress: number | null; // bonding-curve fraction (0..1)
  top10HolderRate: number | null;
  devHoldRate: number | null;
  sniperCount: number | null;
  sniperHoldRate: number | null;
  insiderRate: number | null;
  isHoneypot: boolean | null;
  buyTax: number | null;
  sellTax: number | null;
  isRenounced: boolean | null;
  smartDegenCount: number | null;
  twitter: string | null;
  website: string | null;
  telegram: string | null;
}

export type Trenches = Record<TrenchType, TrenchToken[]>;

type Raw = Record<string, unknown>;

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && isFinite(n) ? n : null;
};
const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
// GMGN encodes these flags as strings: "yes" / "no" / "unknown" / "".
const yesNo = (v: unknown): boolean | null => {
  if (typeof v === "boolean") return v;
  if (v === "yes") return true;
  if (v === "no") return false;
  return null;
};

function ageFrom(r: Raw): number | null {
  const ts = num(r.created_timestamp ?? r.open_timestamp);
  if (ts == null || ts <= 0) return null;
  const secs = ts > 1e12 ? ts / 1000 : ts;
  return Math.max(0, Math.floor(Date.now() / 1000 - secs));
}

function normalize(r: Raw): TrenchToken {
  return {
    chain: str(r.chain) ?? "",
    address: str(r.address) ?? "",
    symbol: str(r.symbol) ?? "",
    name: str(r.name) ?? str(r.symbol) ?? "",
    logo: str(r.logo),
    launchpad: str(r.launchpad_platform ?? r.launchpad),
    ageSeconds: ageFrom(r),
    marketCap: num(r.usd_market_cap ?? r.market_cap),
    volume: num(r.volume_24h),
    liquidity: num(r.liquidity),
    holderCount: num(r.holder_count),
    progress: num(r.progress),
    top10HolderRate: num(r.top_10_holder_rate),
    devHoldRate: num(r.dev_team_hold_rate ?? r.creator_balance_rate),
    sniperCount: num(r.sniper_count),
    sniperHoldRate: num(r.top70_sniper_hold_rate),
    insiderRate: num(r.suspected_insider_hold_rate),
    isHoneypot: yesNo(r.is_honeypot),
    buyTax: num(r.buy_tax),
    sellTax: num(r.sell_tax),
    isRenounced: yesNo(r.owner_renounced),
    smartDegenCount: num(r.smart_degen_count),
    twitter: str(r.twitter ?? r.twitter_handle),
    website: str(r.website),
    telegram: str(r.telegram),
  };
}

function emptyTrenches(): Trenches {
  return { new_creation: [], near_completion: [], completed: [] };
}

function buildBody(chain: TrenchChain, limit: number): Raw {
  const section = {
    filters: ["offchain", "onchain"],
    launchpad_platform: LAUNCHPADS[chain],
    quote_address_type: QUOTE_TYPES[chain],
    launchpad_platform_v2: true,
    limit,
  };
  const body: Raw = { version: "v2" };
  for (const t of Object.keys(STAGE_KEY) as TrenchType[]) {
    body[t] = { ...section };
  }
  return body;
}

async function fetchAll(chain: TrenchChain, limit: number): Promise<Trenches> {
  if (!hasGmgn()) return emptyTrenches();
  try {
    const qs = new URLSearchParams({
      chain,
      timestamp: String(Math.floor(Date.now() / 1000)),
      client_id: randomUUID(),
    });
    const res = await fetch(`${HOST}/v1/trenches?${qs.toString()}`, {
      method: "POST",
      headers: { "X-APIKEY": GMGN_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(chain, limit)),
    });
    if (!res.ok) return emptyTrenches();
    const json = (await res.json()) as { code?: number; data?: Raw };
    if (json.code !== 0 || !json.data) return emptyTrenches();
    const data = json.data;
    const out = emptyTrenches();
    for (const t of Object.keys(STAGE_KEY) as TrenchType[]) {
      const arr = data[STAGE_KEY[t]];
      if (Array.isArray(arr)) {
        out[t] = arr
          .map((r) => normalize(r as Raw))
          .filter((x) => x.address.length > 0);
      }
    }
    return out;
  } catch {
    return emptyTrenches();
  }
}

export function getTrenchesAll(
  chain: TrenchChain,
  limit = 60
): Promise<Trenches> {
  return cache.wrap(`gmgn:trenches:${chain}:${limit}`, TTL, () =>
    fetchAll(chain, limit)
  );
}

export async function getTrenches(
  chain: TrenchChain,
  type: TrenchType,
  limit = 60
): Promise<TrenchToken[]> {
  const all = await getTrenchesAll(chain, limit);
  return all[type];
}
