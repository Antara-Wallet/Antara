import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import {
  getSwapQuote,
  type PortfolioToken,
  type SwapChain,
  type SwapQuote,
} from "../lib/api";
import { executeSwap, type SwapPhase } from "../lib/swap";
import { executeVaultSwap, type VaultPhase } from "../lib/safe";
import { COMMON_TOKENS, NATIVE, sameToken, type SwapToken } from "../lib/tokens";
import { TokenLogo } from "./TokenLogo";
import { TokenPicker } from "./TokenPicker";
import { byKey } from "../solares/networks";

/**
 * Non-custodial swap. Pick either side from common tokens, your holdings, or any
 * pasted address. On the Wallet view it swaps from the EOA; on the Vault view it
 * routes the swap through the co-signer (Face ID + layers), output back to the
 * vault. The same `SwapForm` powers both the modal and the side rail.
 */

const EXPLORER: Record<SwapChain, string> = {
  ethereum: byKey("ethereum").explorer.tx,
  base: byKey("base").explorer.tx,
};

const GAS_RESERVE: Record<SwapChain, number> = {
  ethereum: 0.0006,
  base: 0.00006,
};

const PHASE_LABEL: Record<SwapPhase, string> = {
  quoting: "Getting quote…",
  approving: "Approving token (1/2)…",
  "signing-permit": "Authorizing…",
  swapping: "Signing & broadcasting…",
  confirming: "Confirming on-chain…",
  done: "Done",
  error: "Failed",
};

const VAULT_PHASE_LABEL: Record<VaultPhase, string> = {
  predicting: "Preparing…",
  deploying: "Deploying vault…",
  confirming: "Confirming on-chain…",
  building: "Building swap…",
  signing: "Signing in vault core…",
  executing: "Co-signer approving…",
  done: "Done",
  error: "Failed",
};

export interface SwapVault {
  owner: `0x${string}`;
  safeAddress: `0x${string}`;
}

export function SwapForm({
  chain,
  from,
  accountIndex,
  tokens,
  vault,
  initialReceive,
}: {
  chain: SwapChain;
  from: `0x${string}`;
  accountIndex: number;
  tokens: PortfolioToken[];
  vault?: SwapVault;
  initialReceive?: SwapToken;
}) {
  const usdc =
    (COMMON_TOKENS[chain] ?? []).find((t) => t.symbol === "USDC") ?? NATIVE[chain];
  const defaultReceive = initialReceive ?? usdc;
  const defaultPay = defaultReceive.address === "native" ? usdc : NATIVE[chain];

  const [pay, setPay] = useState<SwapToken>(defaultPay);
  const [receive, setReceive] = useState<SwapToken>(defaultReceive);
  const [amount, setAmount] = useState("");
  const [picker, setPicker] = useState<null | "pay" | "receive">(null);

  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState("");

  const [phase, setPhase] = useState<SwapPhase | null>(null);
  const [vphase, setVphase] = useState<VaultPhase | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [runErr, setRunErr] = useState("");

  const tokenIn = pay.address === "native" ? "native" : pay.address;
  const tokenOut = receive.address === "native" ? "native" : receive.address;
  const busy =
    (phase != null && phase !== "done" && phase !== "error") ||
    (vphase != null && vphase !== "done" && vphase !== "error");

  // Vault swaps pay with ETH for now (ERC-20 input needs a Permit2/approve flow
  // from the Safe). Block paying with a token from the vault, with a clear hint.
  const vaultTokenInBlocked = !!vault && pay.address !== "native";

  const payHeld = tokens.find(
    (t) => t.chain === chain && sameToken(t.tokenAddress ?? "native", pay.address)
  );
  const payBalance = payHeld ? Number(payHeld.balance) : 0;
  const amountNum = Number(amount || "0");
  const overBalance = amountNum > payBalance;

  function setPct(p: number) {
    if (payBalance <= 0) return;
    let v = payBalance * p;
    if (pay.address === "native") v = Math.max(0, payBalance * p - GAS_RESERVE[chain]);
    setAmount(v.toFixed(Math.min(pay.decimals, 8)).replace(/\.?0+$/, ""));
  }

  function flip() {
    setPay(receive);
    setReceive(pay);
    setAmount("");
    setQuote(null);
  }

  function reset() {
    setTxHash(null);
    setRunErr("");
    setAmount("");
    setQuote(null);
    setPhase(null);
    setVphase(null);
  }

  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshQuote = useCallback(() => {
    setQuoteErr("");
    if (sameToken(pay.address, receive.address)) {
      setQuote(null);
      return;
    }
    let raw: bigint;
    try {
      raw = parseUnits(amount || "0", pay.decimals);
    } catch {
      setQuote(null);
      return;
    }
    if (raw <= 0n) {
      setQuote(null);
      return;
    }
    setQuoting(true);
    getSwapQuote(chain, tokenIn, tokenOut, raw.toString())
      .then(setQuote)
      .catch((e) => {
        setQuote(null);
        setQuoteErr(humanizeQuoteError(String(e?.message ?? e)));
      })
      .finally(() => setQuoting(false));
  }, [amount, pay, receive, chain, tokenIn, tokenOut]);

  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(refreshQuote, 400);
    return () => clearTimeout(debounce.current);
  }, [refreshQuote]);

  const receiveAmount =
    quote != null ? formatUnits(BigInt(quote.amountOut), receive.decimals) : "";
  const minReceive =
    quote != null ? formatUnits(BigInt(quote.minOut), receive.decimals) : "";

  const canSwap = !!quote && !busy && !overBalance && !vaultTokenInBlocked;
  const busyLabel = vault
    ? vphase
      ? VAULT_PHASE_LABEL[vphase]
      : "Swap"
    : phase
      ? PHASE_LABEL[phase]
      : "Swap";

  async function run() {
    if (!canSwap) return;
    setRunErr("");
    setTxHash(null);
    try {
      const raw = parseUnits(amount, pay.decimals).toString();
      if (vault) {
        const res = await executeVaultSwap(
          {
            chain,
            accountIndex,
            owner: vault.owner,
            safeAddress: vault.safeAddress,
            tokenIn,
            tokenOut,
            amountIn: raw,
          },
          setVphase
        );
        setTxHash(res.hash);
        if (res.status !== "success") setRunErr("Transaction reverted on-chain.");
        return;
      }
      const res = await executeSwap(
        { chain, accountIndex, from, tokenIn, tokenOut, amountIn: raw },
        setPhase
      );
      setTxHash(res.hash);
      if (res.status !== "success") setRunErr("Transaction reverted on-chain.");
    } catch (e) {
      if (vault) setVphase("error");
      else setPhase("error");
      setRunErr(String((e as Error)?.message ?? e));
    }
  }

  if (txHash) {
    return (
      <div className="rounded-2xl border border-mint/30 bg-mint/10 p-4 text-sm">
        <p className="font-semibold text-mint">
          {runErr ? "Submitted (reverted)" : "Swap confirmed"}
        </p>
        <a
          href={`${EXPLORER[chain]}${txHash}`}
          target="_blank"
          rel="noreferrer"
          className="mt-1 block truncate text-xs text-muted underline"
        >
          {txHash}
        </a>
        {runErr && <p className="mt-1 text-xs text-pink">{runErr}</p>}
        <button
          onClick={reset}
          className="mt-3 w-full rounded-pill bg-surface-2 py-2.5 text-sm font-semibold"
        >
          Swap again
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Pay */}
      <div className="rounded-2xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">You pay</span>
          {payHeld && (
            <span className="text-xs text-muted">Balance {trimNum(payHeld.balance)}</span>
          )}
        </div>
        <div className="mt-2 flex items-center gap-3">
          <input
            inputMode="decimal"
            value={amount}
            disabled={busy}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.0"
            className="min-w-0 flex-1 bg-transparent text-3xl font-bold text-fg outline-none placeholder:text-muted"
          />
          <TokenButton t={pay} chain={chain} onClick={() => !busy && setPicker("pay")} />
        </div>
        {payBalance > 0 && (
          <div className="mt-3 flex gap-1.5">
            {[0.25, 0.5, 0.75, 1].map((p) => (
              <button
                key={p}
                onClick={() => setPct(p)}
                disabled={busy}
                className="flex-1 rounded-pill bg-surface-2 py-1 text-xs font-semibold text-muted transition-colors hover:text-fg"
              >
                {p === 1 ? "Max" : `${p * 100}%`}
              </button>
            ))}
          </div>
        )}
        {overBalance && <p className="mt-2 text-xs text-pink">Exceeds balance.</p>}
      </div>

      <div className="my-2 flex justify-center">
        <button
          onClick={flip}
          disabled={busy}
          title="Switch direction"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-base text-muted transition-colors hover:text-fg"
        >
          ↑↓
        </button>
      </div>

      {/* Receive */}
      <div className="rounded-2xl border border-border bg-surface p-4">
        <span className="text-xs text-muted">You receive (est.)</span>
        <div className="mt-2 flex items-center gap-3">
          <div className="min-w-0 flex-1 text-3xl font-bold">
            {quoting ? (
              <span className="text-muted">…</span>
            ) : receiveAmount ? (
              trimNum(receiveAmount)
            ) : (
              <span className="text-muted">0.0</span>
            )}
          </div>
          <TokenButton
            t={receive}
            chain={chain}
            onClick={() => !busy && setPicker("receive")}
          />
        </div>
      </div>

      {quote && (
        <div className="mt-4 space-y-1.5 rounded-2xl bg-surface px-4 py-3 text-xs text-muted">
          <Line label="Min received" value={`${trimNum(minReceive)} ${receive.symbol}`} />
          <Line label="Pool fee" value={`${quote.feeTier / 10000}%`} />
          <Line
            label="Price impact"
            value={quote.priceImpactBps != null ? `${(quote.priceImpactBps / 100).toFixed(2)}%` : "—"}
          />
        </div>
      )}

      {quoteErr && <p className="mt-3 text-xs text-pink">{quoteErr}</p>}
      {vaultTokenInBlocked && (
        <p className="mt-3 text-xs text-muted">
          Vault swaps pay with ETH for now. To swap a token from the vault,
          withdraw it to your wallet first.
        </p>
      )}
      {runErr && <p className="mt-3 text-xs text-pink">{runErr}</p>}

      <button
        onClick={run}
        disabled={!canSwap}
        className="mt-5 w-full rounded-pill bg-accent px-6 py-3.5 text-[15px] font-bold text-base transition-transform hover:scale-[1.01] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy
          ? busyLabel
          : overBalance
            ? "Insufficient balance"
            : quote
              ? `Swap ${pay.symbol} for ${receive.symbol}`
              : "Enter amount"}
      </button>
      <p className="mt-3 text-center text-[11px] text-muted">
        {vault
          ? "Signed in your vault core, then co-signed through your layers · self-custodial"
          : "Signed inside your vault · routed through Uniswap · self-custodial"}
      </p>

      {picker && (
        <TokenPicker
          chain={chain}
          held={tokens}
          excludeAddress={picker === "pay" ? receive.address : pay.address}
          onSelect={(t) => {
            if (picker === "pay") setPay(t);
            else setReceive(t);
            setAmount("");
            setQuote(null);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );
}

/** Centered modal wrapper for the "Swap" action. */
export function SwapModal({
  onClose,
  ...rest
}: {
  chain: SwapChain;
  from: `0x${string}`;
  accountIndex: number;
  tokens: PortfolioToken[];
  vault?: SwapVault;
  initialReceive?: SwapToken;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-border bg-base p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold">Swap</h2>
          <button onClick={onClose} className="text-muted transition-colors hover:text-fg">
            ✕
          </button>
        </div>
        <SwapForm {...rest} />
      </div>
    </div>
  );
}

function TokenButton({
  t,
  chain,
  onClick,
}: {
  t: SwapToken;
  chain: SwapChain;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex shrink-0 items-center gap-2 rounded-pill border border-border bg-base px-3 py-2 text-sm font-semibold transition-colors hover:bg-surface-2"
    >
      <TokenLogo symbol={t.symbol} logo={t.logo} chain={chain} address={t.address} size={22} />
      {t.symbol}
      <span className="text-muted">▾</span>
    </button>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span className="font-medium text-fg">{value}</span>
    </div>
  );
}

function humanizeQuoteError(msg: string): string {
  if (/no pool|no route|liquidity/i.test(msg))
    return "No liquidity pool for this pair. Try a different token or amount.";
  if (/backend 4|backend 5/i.test(msg)) return "Could not get a quote right now.";
  return msg;
}

function trimNum(s: string): string {
  const n = Number(s);
  if (!isFinite(n)) return s;
  if (n === 0) return "0";
  if (n < 0.000001) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
