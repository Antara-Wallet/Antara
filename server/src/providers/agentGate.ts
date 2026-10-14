import { erc20Abi, formatUnits, isAddress, type Address } from "viem";
import { getRpcClient } from "./uniswap.js";
import { cache } from "../cache.js";

/**
 * $ARK holder gate for the hosted agent. To use ARK's hosted LLM the caller's
 * wallet must hold at least AGENT_GATE_USD worth of $ARK. We price $ARK from
 * DexScreener (it isn't on Uniswap v3, so the v3 quoter can't price it) using
 * the deepest-liquidity pair, and read the on-chain balance directly.
 */

const ARK_TOKEN = (process.env.ARK_TOKEN_ADDRESS ??
  "0x4bbb622433e594efc554124d3db896b1a5aefba3") as Address;
const GATE_USD = Number(process.env.AGENT_GATE_USD ?? 50);
const ARK_DECIMALS = 18;

interface DexPair {
  priceUsd?: string;
  liquidity?: { usd?: number };
}

/** $ARK price in USD from the deepest-liquidity pair on DexScreener. */
async function arkPriceUsd(): Promise<number> {
  return cache.wrap("ark:price", 60_000, async () => {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ARK_TOKEN}`);
    if (!res.ok) throw new Error("price source unavailable");
    const data = (await res.json()) as { pairs?: DexPair[] };
    const pairs = (data.pairs ?? []).filter((p) => p.priceUsd);
    if (!pairs.length) throw new Error("no market price for token");
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    return Number(pairs[0].priceUsd);
  });
}

export interface GateResult {
  address: string;
  token: string;
  balance: string; // human-readable $ARK
  priceUsd: number;
  usd: number;
  requiredUsd: number;
  ok: boolean;
}

export async function checkArkGate(address: string): Promise<GateResult> {
  if (!isAddress(address)) throw new Error("invalid address");
  const client = getRpcClient("base");
  const [raw, price] = await Promise.all([
    client.readContract({
      address: ARK_TOKEN,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address as Address],
    }) as Promise<bigint>,
    arkPriceUsd(),
  ]);
  const balance = Number(formatUnits(raw, ARK_DECIMALS));
  const usd = balance * price;
  return {
    address,
    token: ARK_TOKEN,
    balance: balance.toString(),
    priceUsd: price,
    usd,
    requiredUsd: GATE_USD,
    ok: usd >= GATE_USD,
  };
}
