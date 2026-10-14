import { useState } from "react";
import { isAddress, parseUnits, encodeFunctionData, type Hex } from "viem";
import type { PortfolioToken, SwapChain } from "../lib/api";
import { sendAsset, type SendPhase } from "../lib/send";
import { sendFromCosignedVault, type VaultPhase } from "../lib/safe";
import { sendPrivately, isMetaAddress, type StealthPhase } from "../lib/stealth";
import { friendlyError } from "../lib/errors";
import { TokenLogo } from "./TokenLogo";
import { isEffectivelyHidden } from "../lib/tokenMeta";
import { NATIVE } from "../lib/tokens";
import { byKey } from "../solares/networks";

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const EXPLORER: Record<SwapChain, string> = {
  ethereum: byKey("ethereum").explorer.tx,
  base: byKey("base").explorer.tx,
};

const CHAIN_LABEL: Record<SwapChain, string> = {
  ethereum: "Ethereum",
  base: "Base",
};

const PHASE_LABEL: Record<SendPhase, string> = {
  signing: "Signing in vault core…",
  confirming: "Confirming on-chain…",
  done: "Sent",
  error: "Failed",
};

const VAULT_PHASE_LABEL: Record<VaultPhase, string> = {
  predicting: "Preparing…",
  deploying: "Deploying vault…",
  confirming: "Confirming on-chain…",
  building: "Building transaction…",
  signing: "Signing in vault core…",
  executing: "Co-signer approving…",
  done: "Sent",
  error: "Failed",
};

const STEALTH_PHASE_LABEL: Record<StealthPhase, string> = {
  computing: "Deriving address…",
  preparing: "Preparing…",
  signing: "Signing in vault core…",
  broadcasting: "Broadcasting…",
  confirming: "Confirming on-chain…",
  announcing: "Publishing…",
  done: "Sent",
};

// Native gas to keep aside for the Max button (conservative over-estimate so a
// "send max" never fails for lack of gas). Base is pennies; mainnet more.
const NATIVE_GAS_RESERVE: Record<SwapChain, number> = {
  ethereum: 0.0006,
  base: 0.00006,
};

const fmtUsd = (n: number | null | undefined) =>
  (n ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

const fmtBal = (s: string) => {
  const n = Number(s);
  if (!n) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
};

export function SendModal({
  from,
  accountIndex,
  tokens,
  to: initialTo,
  vault,
  stealth,
  onClose,
}: {
  from: `0x${string}`;
  accountIndex: number;
  tokens: PortfolioToken[];
  to?: string;
  // When set, the send goes out of the co-signed vault (Safe) instead of the
  // EOA: the user signs, the ANTARA co-signer checks the layers + co-signs, and the
  // owner EOA pays gas. Same UI, different rail.
  vault?: { owner: `0x${string}`; safeAddress: `0x${string}` };
  // When set, the recipient is an ERC-5564 stealth meta-address: the funds land
  // at a fresh one-time address and are announced. Same UI, private rail.
  stealth?: boolean;
  onClose: () => void;
}) {
  // Only assets on supported chains, with a positive balance, minus spam/hidden.
  const sendable = tokens.filter(
    (t) => t.chain in EXPLORER && Number(t.balance) > 0 && !isEffectivelyHidden(t)
  );

  const [selected, setSelected] = useState<PortfolioToken | null>(null);
  const [query, setQuery] = useState("");
  const [to, setTo] = useState(initialTo ?? "");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<SendPhase | null>(null);
  const [vphase, setVphase] = useState<VaultPhase | null>(null);
  const [sphase, setSphase] = useState<StealthPhase | null>(null);
  const [error, setError] = useState("");
  const [hash, setHash] = useState<`0x${string}` | null>(null);

  const token = selected;
  const busy =
    phase === "signing" ||
    phase === "confirming" ||
    (vphase != null && vphase !== "done" && vphase !== "error") ||
    (sphase != null && sphase !== "done");
  const busyLabel = stealth
    ? sphase
      ? STEALTH_PHASE_LABEL[sphase]
      : "Send privately"
    : vault
      ? vphase
        ? VAULT_PHASE_LABEL[vphase]
        : "Send"
      : phase
        ? PHASE_LABEL[phase]
        : "Send";
  const amountNum = Number(amount);
  const overBalance = token ? amountNum > Number(token.balance) : false;
  const validTo = stealth ? isMetaAddress(to) : isAddress(to);
  const canSend = !!token && validTo && amount !== "" && amountNum > 0 && !overBalance && !busy;
  const usdValue = token && token.priceUsd != null ? amountNum * token.priceUsd : 0;

  function maxAmount(t: PortfolioToken): string {
    const bal = Number(t.balance);
    if (t.tokenAddress === null) {
      const reserve = NATIVE_GAS_RESERVE[t.chain as SwapChain] ?? 0;
      const v = Math.max(0, bal - reserve);
      return v.toFixed(Math.min(t.decimals, 8)).replace(/\.?0+$/, "");
    }
    return t.balance;
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? sendable.filter(
        (t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)
      )
    : sendable;

  async function submit() {
    if (!canSend || !token) return;
    setError("");
    setHash(null);
    try {
      if (stealth) {
        // Private rail: derive a one-time stealth address, send to it, announce.
        const res = await sendPrivately(
          {
            chain: token.chain as SwapChain,
            accountIndex,
            from,
            meta: to,
            tokenAddress: token.tokenAddress,
            amount,
            decimals: token.decimals,
          },
          setSphase
        );
        setHash(res.hash);
        return;
      }

      if (vault) {
        // Vault rail: encode a native or ERC-20 transfer, then push it through the
        // co-signer (which runs the Face ID / device / geo layers before signing).
        const raw = parseUnits(amount, token.decimals).toString();
        const isNative = token.tokenAddress === null;
        const res = await sendFromCosignedVault(
          {
            chain: token.chain as SwapChain,
            accountIndex,
            owner: vault.owner,
            safeAddress: vault.safeAddress,
            to: isNative ? (to as Hex) : (token.tokenAddress as Hex),
            value: isNative ? raw : "0",
            data: isNative
              ? "0x"
              : encodeFunctionData({
                  abi: ERC20_TRANSFER_ABI,
                  functionName: "transfer",
                  args: [to as Hex, BigInt(raw)],
                }),
          },
          setVphase
        );
        setHash(res.hash);
        if (res.status !== "success") setError("Transaction reverted on-chain.");
        return;
      }

      const res = await sendAsset(
        {
          chain: token.chain as SwapChain,
          accountIndex,
          from,
          to,
          tokenAddress: token.tokenAddress,
          amount,
          decimals: token.decimals,
        },
        setPhase
      );
      setHash(res.hash);
      if (res.status !== "success") setError("Transaction reverted on-chain.");
    } catch (e) {
      if (stealth) setSphase(null);
      else if (vault) setVphase("error");
      else setPhase("error");
      const chain = token.chain as SwapChain;
      setError(
        vault || stealth
          ? friendlyError(e, { network: CHAIN_LABEL[chain], gasSymbol: NATIVE[chain]?.symbol })
          : String(e instanceof Error ? e.message : e)
      );
    }
  }

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-sm flex-col rounded-3xl border border-border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 pt-5">
          {token && !hash ? (
            <button
              onClick={() => setSelected(null)}
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
              aria-label="Back"
            >
              ‹
            </button>
          ) : (
            <span className="h-8 w-8" />
          )}
          <h2 className="flex-1 text-center text-lg font-bold">
            {stealth ? "Send privately" : "Send"}
          </h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {sendable.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-muted">
            No assets to send yet. Deposit some crypto first.
          </p>
        ) : hash && !error ? (
          <div className="px-6 py-8 text-center">
            <p className="text-sm font-semibold text-green-400">Sent</p>
            <a
              href={`${EXPLORER[token!.chain as SwapChain]}${hash}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 block break-all font-mono text-xs text-accent underline"
            >
              {hash}
            </a>
            <button
              onClick={onClose}
              className="mt-5 w-full rounded-pill bg-accent px-6 py-3 text-sm font-semibold text-base"
            >
              Done
            </button>
          </div>
        ) : !token ? (
          /* STEP 1 — pick an asset from what the user holds */
          <div className="flex min-h-0 flex-col px-5 pb-5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search an asset to send"
              className="mt-4 w-full rounded-pill border border-border bg-base px-4 py-2.5 text-sm outline-none focus:border-accent"
            />
            <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
              {filtered.map((t) => (
                <button
                  key={`${t.chain}:${t.tokenAddress ?? "native"}`}
                  onClick={() => {
                    setSelected(t);
                    setAmount("");
                  }}
                  className="flex w-full items-center gap-3 rounded-2xl px-2 py-3 text-left hover:bg-surface-2"
                >
                  <TokenLogo symbol={t.symbol} logo={t.logo} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{t.name}</div>
                    <div className="text-xs text-muted">
                      {t.symbol} · {CHAIN_LABEL[t.chain as SwapChain]}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold">{fmtUsd(t.valueUsd)}</div>
                    <div className="text-xs text-muted">
                      {fmtBal(t.balance)} {t.symbol}
                    </div>
                  </div>
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="py-6 text-center text-sm text-muted">No assets match.</p>
              )}
            </div>
          </div>
        ) : (
          /* STEP 2 — recipient + amount + gas-aware max */
          <div className="overflow-y-auto px-6 pb-6">
            <div className="mt-5 flex flex-col items-center">
              <TokenLogo symbol={token.symbol} logo={token.logo} size={52} />
              <p className="mt-2 font-bold">{token.symbol}</p>
              <p className="text-xs text-muted">{CHAIN_LABEL[token.chain as SwapChain]}</p>
            </div>

            <label className="mt-6 block text-xs font-medium text-muted">To</label>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              disabled={busy}
              spellCheck={false}
              placeholder={stealth ? "Paste a stealth address (st:…)" : "Enter or paste an address"}
              className="mt-1 w-full rounded-xl border border-border bg-base px-4 py-3 font-mono text-sm outline-none focus:border-accent"
            />
            {to !== "" && !validTo && (
              <p className="mt-1 text-xs text-pink">
                {stealth ? "Not a valid stealth address." : "Not a valid address."}
              </p>
            )}

            <div className="mt-4 flex items-center justify-between">
              <label className="text-xs font-medium text-muted">Amount</label>
              <button
                onClick={() => setAmount(maxAmount(token))}
                className="text-xs font-semibold text-accent hover:underline"
              >
                Max
              </button>
            </div>
            <div className="relative mt-1">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                disabled={busy}
                inputMode="decimal"
                placeholder="0.0"
                className="w-full rounded-xl border border-border bg-base px-4 py-3 pr-16 text-lg outline-none focus:border-accent"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted">
                {token.symbol}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-xs text-muted">
              <span>{fmtUsd(usdValue)}</span>
              <span>
                {fmtBal(token.balance)} {token.symbol} available
              </span>
            </div>
            {overBalance && <p className="mt-1 text-xs text-pink">Exceeds balance.</p>}

            {error && (
              <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {error}
              </p>
            )}

            <button
              onClick={submit}
              disabled={!canSend}
              className="mt-5 w-full rounded-pill bg-accent px-6 py-3 text-sm font-semibold text-base transition-transform enabled:hover:scale-[1.01] enabled:active:scale-95 disabled:bg-surface-2 disabled:text-muted"
            >
              {busy ? busyLabel : vault ? "Approve & send" : stealth ? "Send privately" : "Send"}
            </button>
            <p className="mt-3 text-center text-xs text-muted">
              {stealth
                ? "The funds land at a fresh, unlinkable address only the recipient can find. Fees are paid from this wallet."
                : vault
                  ? "Your key signs, then the ANTARA co-signer checks your layers. Network fees are paid from your wallet."
                  : "Network fees are paid from this wallet."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
