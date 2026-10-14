import { formatUnits } from "viem";
import { ALCHEMY_API_KEY, CHAINS, hasAlchemy, type Chain } from "../config.js";
import { cache } from "../cache.js";
import { getPrices, type LlamaPrice } from "./defillama.js";

const PORTFOLIO_TTL = 30_000;
const HISTORY_TTL = 30_000;

export interface PortfolioToken {
  chain: Chain["id"];
  /** null = native gas token */
  tokenAddress: string | null;
  symbol: string;
  name: string;
  decimals: number;
  logo?: string;
  balance: string; // human-readable
  raw: string; // wei / smallest unit
  priceUsd: number | null;
  valueUsd: number | null;
}

export interface Portfolio {
  address: string;
  tokens: PortfolioToken[];
  totalUsd: number;
  /** false when ALCHEMY_API_KEY is not set yet — UI can show a "connect data" hint. */
  live: boolean;
}

function rpcUrl(network: string) {
  return `https://${network}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
}

async function rpc<T>(network: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl(network), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  if (!res.ok) throw new Error(`Alchemy ${method} ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`Alchemy ${method}: ${json.error.message}`);
  return json.result as T;
}

export async function getPortfolio(address: string): Promise<Portfolio> {
  if (!hasAlchemy()) {
    return { address, tokens: [], totalUsd: 0, live: false };
  }
  return cache.wrap(`portfolio:${address.toLowerCase()}`, PORTFOLIO_TTL, () =>
    buildPortfolio(address)
  );
}

async function buildPortfolio(address: string): Promise<Portfolio> {
  const perChain = await Promise.all(
    CHAINS.map((chain) => chainTokens(address, chain).catch(() => []))
  );
  const tokens = perChain.flat();

  // Price everything via DefiLlama in one batched call.
  const ids = new Set<string>();
  for (const t of tokens) {
    ids.add(priceId(t));
  }
  let prices: Record<string, LlamaPrice> = {};
  try {
    prices = await getPrices([...ids]);
  } catch {
    prices = {};
  }

  let totalUsd = 0;
  for (const t of tokens) {
    const p = prices[priceId(t)]?.price ?? null;
    t.priceUsd = p;
    t.valueUsd = p != null ? Number(t.balance) * p : null;
    if (t.valueUsd) totalUsd += t.valueUsd;
  }

  tokens.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  return { address, tokens, totalUsd, live: true };
}

function priceId(t: PortfolioToken): string {
  if (t.tokenAddress === null) {
    const chain = CHAINS.find((c) => c.id === t.chain)!;
    return `coingecko:${chain.nativeCoingeckoId}`;
  }
  const chain = CHAINS.find((c) => c.id === t.chain)!;
  return `${chain.llamaChain}:${t.tokenAddress.toLowerCase()}`;
}

async function chainTokens(address: string, chain: Chain): Promise<PortfolioToken[]> {
  const out: PortfolioToken[] = [];

  // Native balance.
  const nativeHex = await rpc<string>(chain.alchemyNetwork, "eth_getBalance", [
    address,
    "latest",
  ]);
  const nativeRaw = BigInt(nativeHex);
  if (nativeRaw > 0n) {
    out.push({
      chain: chain.id,
      tokenAddress: null,
      symbol: chain.nativeSymbol,
      name: chain.nativeName,
      decimals: chain.nativeDecimals,
      balance: formatUnits(nativeRaw, chain.nativeDecimals),
      raw: nativeRaw.toString(),
      priceUsd: null,
      valueUsd: null,
    });
  }

  // ERC-20 balances (non-zero only).
  const balances = await rpc<{
    tokenBalances: { contractAddress: string; tokenBalance: string }[];
  }>(chain.alchemyNetwork, "alchemy_getTokenBalances", [address, "erc20"]);

  const nonZero = (balances.tokenBalances ?? []).filter(
    (b) => b.tokenBalance && BigInt(b.tokenBalance) > 0n
  );

  // Metadata per token, cached long (symbol/decimals don't change).
  const metas = await Promise.all(
    nonZero.map((b) =>
      tokenMetadata(chain, b.contractAddress).catch(() => null)
    )
  );

  nonZero.forEach((b, i) => {
    const meta = metas[i];
    if (!meta || meta.decimals == null) return;
    const raw = BigInt(b.tokenBalance);
    out.push({
      chain: chain.id,
      tokenAddress: b.contractAddress,
      symbol: meta.symbol ?? "?",
      name: meta.name ?? "Unknown token",
      decimals: meta.decimals,
      logo: meta.logo ?? undefined,
      balance: formatUnits(raw, meta.decimals),
      raw: raw.toString(),
      priceUsd: null,
      valueUsd: null,
    });
  });

  return out;
}

interface TokenMeta {
  symbol?: string;
  name?: string;
  decimals?: number;
  logo?: string;
}

function tokenMetadata(chain: Chain, contract: string): Promise<TokenMeta> {
  return cache.wrap(
    `meta:${chain.id}:${contract.toLowerCase()}`,
    24 * 60 * 60 * 1000,
    () =>
      rpc<TokenMeta>(chain.alchemyNetwork, "alchemy_getTokenMetadata", [contract])
  );
}

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logo: string | null;
}

/**
 * Resolve any ERC-20 by address (symbol / decimals / logo) so the swap UI can
 * add an arbitrary or brand-new token. Throws if it isn't a readable ERC-20.
 */
export async function getTokenInfo(
  chainId: Chain["id"],
  address: string
): Promise<TokenInfo> {
  const chain = CHAINS.find((c) => c.id === chainId);
  if (!chain) throw new Error("unknown chain");
  const meta = await tokenMetadata(chain, address);
  if (meta.decimals == null) throw new Error("not an ERC-20 token");
  return {
    address,
    symbol: meta.symbol || "?",
    name: meta.name || "Unknown token",
    decimals: meta.decimals,
    logo: meta.logo ?? null,
  };
}

/* ---------- History ---------- */

export interface Transfer {
  chain: Chain["id"];
  hash: string;
  from: string;
  to: string | null;
  direction: "in" | "out";
  asset: string | null;
  value: number | null;
  blockNum: string;
}

export async function getHistory(address: string): Promise<Transfer[]> {
  if (!hasAlchemy()) return [];
  return cache.wrap(`history:${address.toLowerCase()}`, HISTORY_TTL, () =>
    buildHistory(address)
  );
}

async function buildHistory(address: string): Promise<Transfer[]> {
  const perChain = await Promise.all(
    CHAINS.map((chain) => chainHistory(address, chain).catch(() => []))
  );
  return perChain
    .flat()
    .sort((a, b) => Number(BigInt(b.blockNum) - BigInt(a.blockNum)))
    .slice(0, 50);
}

async function chainHistory(address: string, chain: Chain): Promise<Transfer[]> {
  const category = ["external", "erc20"];
  const common = {
    withMetadata: false,
    excludeZeroValue: true,
    maxCount: "0x19", // 25
    category,
  };

  const [sent, received] = await Promise.all([
    rpc<{ transfers: RawTransfer[] }>(chain.alchemyNetwork, "alchemy_getAssetTransfers", [
      { ...common, fromAddress: address },
    ]),
    rpc<{ transfers: RawTransfer[] }>(chain.alchemyNetwork, "alchemy_getAssetTransfers", [
      { ...common, toAddress: address },
    ]),
  ]);

  const map = (t: RawTransfer, direction: "in" | "out"): Transfer => ({
    chain: chain.id,
    hash: t.hash,
    from: t.from,
    to: t.to,
    direction,
    asset: t.asset,
    value: t.value,
    blockNum: t.blockNum,
  });

  return [
    ...(sent.transfers ?? []).map((t) => map(t, "out")),
    ...(received.transfers ?? []).map((t) => map(t, "in")),
  ];
}

interface RawTransfer {
  hash: string;
  from: string;
  to: string | null;
  asset: string | null;
  value: number | null;
  blockNum: string;
}
