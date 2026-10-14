import { useState } from "react";
import { getAddress } from "viem";
import arkLogo from "../assets/ark-logo.png";
import { byKey } from "../solares/networks";

/**
 * Token logo with a graceful, multi-source fallback. Tries, in order: an explicit
 * `logo` URL (e.g. from the backend), the Trust Wallet asset for this chain+address,
 * a known-symbol logo, and finally the symbol's initials. Each failed image
 * advances to the next candidate, so a broken URL never leaves a hole.
 */

const TW = "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains";

const TW_CHAIN: Record<string, string> = {
  ethereum: "ethereum",
  base: "base",
};

const KNOWN: Record<string, string> = {
  ANTARA: '/antara/emblem.png',
  AETHRA: arkLogo, // Existing asset-symbol lookup remains compatible.
  ETH: `${TW}/ethereum/info/logo.png`,
  WETH: `${TW}/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png`,
  USDC: `${TW}/ethereum/assets/${byKey("ethereum").funding.address}/logo.png`,
  USDT: `${TW}/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png`,
  DAI: `${TW}/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png`,
  WBTC: `${TW}/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png`,
  POL: `${TW}/polygon/info/logo.png`,
  MATIC: `${TW}/polygon/info/logo.png`,
};

function twByAddress(chain?: string, address?: string | null): string | null {
  if (!chain || !address || address === "native") return null;
  const folder = TW_CHAIN[chain];
  if (!folder) return null;
  try {
    return `${TW}/${folder}/assets/${getAddress(address)}/logo.png`;
  } catch {
    return null;
  }
}

export function TokenLogo({
  symbol,
  logo,
  chain,
  address,
  size = 20,
}: {
  symbol: string;
  logo?: string | null;
  chain?: string;
  address?: string | null;
  size?: number;
}) {
  const candidates = [
    logo,
    twByAddress(chain, address),
    KNOWN[symbol.toUpperCase()],
  ].filter(Boolean) as string[];

  const [i, setI] = useState(0);
  const src = candidates[i];

  if (src) {
    return (
      <img
        src={src}
        alt={symbol}
        onError={() => setI((n) => n + 1)}
        className="shrink-0 rounded-full bg-surface-2 object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-surface-2 text-[9px] font-bold text-muted"
      style={{ width: size, height: size }}
    >
      {symbol.slice(0, 3).toUpperCase()}
    </span>
  );
}
