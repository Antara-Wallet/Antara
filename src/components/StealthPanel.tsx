import { useEffect, useState } from "react";
import { isAddress } from "viem";
import { shortAddress } from "../lib/wallet";
import { formatUsd, type PortfolioToken, type SwapChain } from "../lib/api";
import {
  getMyMeta,
  scanInbox,
  sweepNative,
  type InboxItem,
  type StealthPhase,
} from "../lib/stealth";
import { ReceiveModal } from "./ReceiveModal";
import { SendModal } from "./SendModal";
import { byKey } from "../solares/networks";

const EXPLORER: Record<SwapChain, string> = {
  ethereum: byKey("ethereum").explorer.tx,
  base: byKey("base").explorer.tx,
};

const WITHDRAW_PHASE: Record<StealthPhase, string> = {
  computing: "Preparing…",
  preparing: "Preparing…",
  signing: "Signing in vault core…",
  broadcasting: "Broadcasting…",
  confirming: "Confirming on-chain…",
  announcing: "Finishing…",
  done: "Done",
};

/**
 * Private payments (ERC-5564 stealth addresses) — the third mode alongside
 * Wallet and Vault, built to match: the same hero card with action buttons that
 * open the same polished Receive / Send modals, and a list of received payments
 * below (the way the token list sits under the Wallet hero).
 */
export function StealthPanel({
  chain,
  account,
  tokens,
  background,
}: {
  chain: SwapChain;
  account: { address: `0x${string}`; index: number };
  tokens: PortfolioToken[];
  background?: string;
}) {
  const [modal, setModal] = useState<null | "receive" | "send">(null);
  const [meta, setMeta] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    getMyMeta(account.index, chain)
      .then((m) => on && setMeta(m.meta))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [account.index, chain]);

  return (
    <>
      <section
        className="relative overflow-hidden rounded-3xl border border-border p-6 text-white"
        style={{ background }}
      >
        <div className="absolute inset-0 bg-black/10" />
        <div className="relative">
          <p className="text-sm text-white/70">Private payments</p>
          <h2 className="mt-1 text-4xl font-bold tracking-tight">Off the public ledger</h2>
          <p className="mt-1 max-w-xl text-sm text-white/70">
            Send and receive at fresh, unlinkable addresses that only the owner
            can find and spend.
          </p>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              onClick={() => setModal("receive")}
              className="flex-1 rounded-pill bg-white px-5 py-3 text-sm font-semibold text-black backdrop-blur transition-transform hover:scale-[1.02] hover:brightness-95 active:scale-95"
            >
              Receive
            </button>
            <button
              onClick={() => setModal("send")}
              className="flex-1 rounded-pill bg-white/15 px-5 py-3 text-sm font-semibold text-white backdrop-blur transition-transform hover:scale-[1.02] hover:bg-white/25 active:scale-95"
            >
              Send
            </button>
          </div>
        </div>
      </section>

      <div className="mt-6">
        <Inbox chain={chain} account={account} />
      </div>

      {modal === "receive" && meta && (
        <ReceiveModal stealth address={meta} name="" onClose={() => setModal(null)} />
      )}
      {modal === "send" && (
        <SendModal
          stealth
          from={account.address}
          accountIndex={account.index}
          tokens={tokens}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}

/* ---------------- Received list (sits under the hero like the token list) -------- */

function Inbox({
  chain,
  account,
}: {
  chain: SwapChain;
  account: { address: `0x${string}`; index: number };
}) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState<InboxItem | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});

  async function scan() {
    setBusy(true);
    setError("");
    try {
      setItems(await scanInbox(chain, account.index));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.index]);

  return (
    <section className="rounded-3xl border border-border bg-surface p-6">
      <div className="flex items-center justify-between">
        <h3 className="font-bold">Received privately</h3>
        <button
          onClick={scan}
          disabled={busy}
          className="rounded-lg px-2 py-1 text-xs font-semibold text-accent disabled:opacity-50"
        >
          {busy ? "Scanning…" : "Refresh"}
        </button>
      </div>

      {error && <p className="mt-3 text-xs text-pink">{error}</p>}

      {items && items.length === 0 && !busy && (
        <div className="mt-4 flex flex-col items-center justify-center rounded-2xl border border-border bg-base px-6 py-12 text-center">
          <p className="text-sm font-semibold">No private payments yet</p>
          <p className="mt-1 max-w-xs text-xs text-muted">
            Tap Receive, share your stealth address, and incoming payments show
            up here.
          </p>
        </div>
      )}

      <div className="mt-4 space-y-2">
        {items?.map((it) => {
          const hash = done[it.stealthAddress];
          return (
            <div
              key={it.stealthAddress}
              className="flex items-center justify-between rounded-2xl border border-border bg-base px-4 py-3"
            >
              <div>
                <p className="font-semibold">
                  {it.nativeFormatted} {it.symbol}
                </p>
                <p className="text-xs text-muted">
                  {formatUsd(it.valueUsd)} · {shortAddress(it.stealthAddress)}
                </p>
              </div>
              {hash ? (
                <a
                  href={`${EXPLORER[chain]}${hash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-semibold text-emerald-400 underline"
                >
                  Withdrawn
                </a>
              ) : (
                <button
                  onClick={() => setWithdrawing(it)}
                  className="rounded-pill bg-accent px-4 py-2 text-xs font-semibold text-base"
                >
                  Withdraw
                </button>
              )}
            </div>
          );
        })}
      </div>

      {items && items.length > 0 && (
        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          Withdrawing moves a payment out using its one-time key. Send it to a
          fresh wallet to stay private, or your main wallet to consolidate.
        </p>
      )}

      {withdrawing && (
        <WithdrawModal
          item={withdrawing}
          chain={chain}
          accountIndex={account.index}
          defaultTo={account.address}
          onClose={() => setWithdrawing(null)}
          onDone={(hash) => {
            setDone((d) => ({ ...d, [withdrawing.stealthAddress]: hash }));
            setWithdrawing(null);
          }}
        />
      )}
    </section>
  );
}

/* ---------------- Withdraw a received payment to a chosen destination -------- */

function WithdrawModal({
  item,
  chain,
  accountIndex,
  defaultTo,
  onClose,
  onDone,
}: {
  item: InboxItem;
  chain: SwapChain;
  accountIndex: number;
  defaultTo: `0x${string}`;
  onClose: () => void;
  onDone: (hash: string) => void;
}) {
  const [to, setTo] = useState<string>(defaultTo);
  const [phase, setPhase] = useState<StealthPhase | null>(null);
  const [error, setError] = useState("");

  const valid = isAddress(to);
  const busy = phase != null && phase !== "done";

  async function withdraw() {
    if (!valid || busy) return;
    setError("");
    try {
      const hash = await sweepNative(
        {
          chain,
          accountIndex,
          ephemeralPub: item.ephemeralPub,
          stealthAddress: item.stealthAddress,
          to: to as `0x${string}`,
        },
        setPhase
      );
      onDone(hash);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setPhase(null);
    }
  }

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-3xl border border-border bg-surface p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Withdraw</h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
          >
            ✕
          </button>
        </div>

        <div className="mt-5 rounded-2xl border border-border bg-base px-4 py-4 text-center">
          <p className="text-2xl font-bold">
            {item.nativeFormatted} {item.symbol}
          </p>
          <p className="mt-1 text-xs text-muted">
            {formatUsd(item.valueUsd)} · from {shortAddress(item.stealthAddress)}
          </p>
        </div>

        <label className="mt-5 block text-xs font-medium text-muted">
          Withdraw to
        </label>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          disabled={busy}
          spellCheck={false}
          placeholder="0x… destination address"
          className="mt-1 w-full rounded-xl border border-border bg-base px-4 py-3 font-mono text-sm outline-none focus:border-accent"
        />
        {to !== "" && !valid && (
          <p className="mt-1 text-xs text-pink">Not a valid address.</p>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          Defaults to your active wallet. To stay private, withdraw to a fresh
          wallet instead — sending to a public wallet links this payment to it.
        </p>

        {error && (
          <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </p>
        )}

        <button
          onClick={withdraw}
          disabled={!valid || busy}
          className="mt-5 w-full rounded-pill bg-accent px-6 py-3 text-sm font-semibold text-base transition-transform enabled:hover:scale-[1.01] enabled:active:scale-95 disabled:bg-surface-2 disabled:text-muted"
        >
          {busy ? WITHDRAW_PHASE[phase!] : "Withdraw"}
        </button>
      </div>
    </div>
  );
}
