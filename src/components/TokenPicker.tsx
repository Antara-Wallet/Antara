import { useEffect, useMemo, useState } from "react";
import { isAddress } from "viem";
import {
  getTokenInfo,
  type PortfolioToken,
  type SwapChain,
} from "../lib/api";
import {
  COMMON_TOKENS,
  heldToSwapToken,
  sameToken,
  type SwapToken,
} from "../lib/tokens";
import { TokenLogo } from "./TokenLogo";

/**
 * Pick a token to swap: curated common tokens + whatever this wallet holds, or
 * paste any address to add it (resolved on-chain, even a brand-new token).
 */
export function TokenPicker({
  chain,
  held,
  excludeAddress,
  onSelect,
  onClose,
}: {
  chain: SwapChain;
  held: PortfolioToken[];
  excludeAddress?: string;
  onSelect: (t: SwapToken) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [resolved, setResolved] = useState<SwapToken | null>(null);
  const [resolving, setResolving] = useState(false);
  const [err, setErr] = useState("");

  // Common tokens for this chain, with any held tokens not already in the list
  // appended; held balances are looked up by address for display.
  const heldOnChain = useMemo(
    () => held.filter((t) => t.chain === chain),
    [held, chain]
  );
  const balanceOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of heldOnChain) m.set((t.tokenAddress ?? "native").toLowerCase(), t.balance);
    return m;
  }, [heldOnChain]);

  const list = useMemo<SwapToken[]>(() => {
    const common = COMMON_TOKENS[chain] ?? [];
    const seen = new Set(common.map((t) => t.address.toLowerCase()));
    const extra = heldOnChain
      .map(heldToSwapToken)
      .filter((t) => !seen.has(t.address.toLowerCase()));
    return [...common, ...extra];
  }, [chain, heldOnChain]);

  // Resolve a pasted address that isn't already in the list.
  useEffect(() => {
    const query = q.trim();
    setErr("");
    setResolved(null);
    if (!isAddress(query)) return;
    if (list.some((t) => sameToken(t.address, query))) return;
    setResolving(true);
    getTokenInfo(chain, query)
      .then((t) => setResolved({ ...t }))
      .catch((e) => setErr(e instanceof Error ? e.message : "Token not found"))
      .finally(() => setResolving(false));
  }, [q, chain, list]);

  const query = q.trim().toLowerCase();
  const filtered = query
    ? list.filter(
        (t) =>
          t.symbol.toLowerCase().includes(query) ||
          t.name.toLowerCase().includes(query) ||
          t.address.toLowerCase() === query
      )
    : list;

  function Row({ t }: { t: SwapToken }) {
    const disabled = excludeAddress && sameToken(t.address, excludeAddress);
    const bal = balanceOf.get(t.address.toLowerCase());
    return (
      <button
        disabled={!!disabled}
        onClick={() => onSelect(t)}
        className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <TokenLogo symbol={t.symbol} logo={t.logo} chain={chain} address={t.address} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{t.symbol}</div>
          <div className="truncate text-xs text-muted">{t.name}</div>
        </div>
        {bal != null && (
          <div className="text-right text-xs text-muted">{trim(bal)}</div>
        )}
      </button>
    );
  }

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-sm flex-col rounded-3xl border border-border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-lg font-bold">Select a token</h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
          >
            ✕
          </button>
        </div>

        <div className="px-5 pt-4">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            spellCheck={false}
            placeholder="Search name or paste an address"
            className="w-full rounded-pill border border-border bg-base px-4 py-2.5 text-sm outline-none focus:border-accent"
          />
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {resolving && (
            <p className="px-2 py-3 text-sm text-muted">Looking up token…</p>
          )}
          {err && <p className="px-2 py-3 text-sm text-pink">{err}</p>}
          {resolved && <Row t={resolved} />}
          {filtered.map((t) => (
            <Row key={t.address} t={t} />
          ))}
          {!resolving && !resolved && filtered.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted">
              No tokens match. Paste a token address to add it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function trim(s: string): string {
  const n = Number(s);
  if (!isFinite(n) || n === 0) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
