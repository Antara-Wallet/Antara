import type { SwapChain, PortfolioToken } from "./api";
import { byKey } from "../solares/networks";

/** A token as the swap UI handles it. `address` is "native" for the gas coin. */
export interface SwapToken {
  address: string; // "native" | 0x...
  symbol: string;
  name: string;
  decimals: number;
  logo?: string | null;
}

export const NATIVE: Record<SwapChain, SwapToken> = {
  ethereum: { address: "native", symbol: "ETH", name: "Ethereum", decimals: 18 },
  base: { address: "native", symbol: "ETH", name: "Ethereum", decimals: 18 },
};

// Curated, high-confidence tokens shown by default in the picker. Anything else
// (memes, brand-new launches) is added by pasting its address (resolved on-chain).
export const COMMON_TOKENS: Record<SwapChain, SwapToken[]> = {
  base: [
    NATIVE.base,
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
    // Circle USDC, pinned in the network registry.
    { address: byKey("base").funding.address, symbol: "USDC", name: "USD Coin", decimals: byKey("base").funding.decimals },
    { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", name: "Dai", decimals: 18 },
    { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", name: "Coinbase Wrapped BTC", decimals: 8 },
    { address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", symbol: "DEGEN", name: "Degen", decimals: 18 },
  ],
  ethereum: [
    NATIVE.ethereum,
    { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
    { address: byKey("ethereum").funding.address, symbol: "USDC", name: "USD Coin", decimals: byKey("ethereum").funding.decimals },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", name: "Tether USD", decimals: 6 },
    { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", name: "Dai", decimals: 18 },
    { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", name: "Wrapped BTC", decimals: 8 },
  ],
};

export function heldToSwapToken(t: PortfolioToken): SwapToken {
  return {
    address: t.tokenAddress ?? "native",
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    logo: t.logo ?? null,
  };
}

export const sameToken = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();
