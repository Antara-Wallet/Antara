import { useEffect, useState } from "react";
import { initials, shortAddress, type DerivedWallet } from "../lib/wallet";
import { revealPrivateKey } from "../lib/vault";
import { BACKGROUNDS, backgroundCss, getMeta } from "../lib/walletMeta";

type Sub = "menu" | "rename" | "background" | "reveal";

export function WalletsDrawer({
  open,
  wallets,
  activeIndex,
  netWorth,
  onSwitch,
  onAddWallet,
  onImportWallet,
  onClose,
  onRename,
  onSetBackground,
  onRemove,
}: {
  open: boolean;
  wallets: DerivedWallet[];
  activeIndex: number;
  netWorth: string;
  onSwitch: (i: number) => void;
  onAddWallet: () => void;
  onImportWallet: (secret: string, password: string) => Promise<void>;
  onClose: () => void;
  onRename: (index: number, name: string) => void;
  onSetBackground: (index: number, background: string) => void;
  onRemove: (index: number) => void;
}) {
  // When set, the drawer shows the per-wallet detail view instead of the list.
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const detail = wallets.find((w) => w.index === detailIndex) ?? null;

  // Reset to the list whenever the drawer closes.
  useEffect(() => {
    if (!open) setDetailIndex(null);
  }, [open]);

  return (
    <>
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        className={`fixed right-0 top-0 z-50 flex h-full w-[400px] flex-col border-l border-border bg-base px-6 py-7 shadow-2xl transition-transform ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {detail ? (
          <WalletDetail
            wallet={detail}
            canRemove={wallets.length > 1}
            onBack={() => setDetailIndex(null)}
            onClose={onClose}
            onRename={(name) => onRename(detail.index, name)}
            onSetBackground={(bg) => onSetBackground(detail.index, bg)}
            onRemove={() => {
              onRemove(detail.index);
              setDetailIndex(null);
            }}
          />
        ) : (
          <WalletList
            wallets={wallets}
            activeIndex={activeIndex}
            netWorth={netWorth}
            onClose={onClose}
            onSwitch={(i) => {
              onSwitch(i);
              onClose();
            }}
            onOpenDetail={setDetailIndex}
            onAddWallet={onAddWallet}
            onImportWallet={onImportWallet}
          />
        )}
      </aside>
    </>
  );
}

/* ---------- List view ---------- */

function WalletList({
  wallets,
  activeIndex,
  netWorth,
  onClose,
  onSwitch,
  onOpenDetail,
  onAddWallet,
  onImportWallet,
}: {
  wallets: DerivedWallet[];
  activeIndex: number;
  netWorth: string;
  onClose: () => void;
  onSwitch: (i: number) => void;
  onOpenDetail: (i: number) => void;
  onAddWallet: () => void;
  onImportWallet: (secret: string, password: string) => Promise<void>;
}) {
  const [importing, setImporting] = useState(false);

  if (importing) {
    return (
      <ImportPanel
        onImport={onImportWallet}
        onCancel={() => setImporting(false)}
        onClose={onClose}
      />
    );
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">My wallets</h2>
        <button
          onClick={onClose}
          className="text-muted transition-colors hover:text-fg"
        >
          ✕
        </button>
      </div>

      <div className="mt-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          Net worth
        </p>
        <p className="mt-1 text-2xl font-bold">{netWorth}</p>
      </div>

      <p className="mt-7 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted">
        Recovery phrase <span>›</span>
      </p>

      <div className="mt-2 flex-1 space-y-2 overflow-y-auto">
        {wallets.map((w) => (
          <div
            key={w.index}
            className={`flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${
              w.index === activeIndex
                ? "border-accent bg-surface-2"
                : "border-border bg-surface hover:bg-surface-2"
            }`}
          >
            <button
              onClick={() => onSwitch(w.index)}
              className="flex flex-1 items-center gap-3 text-left"
            >
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                style={{ background: backgroundCss(getMeta(w.address).background) }}
              >
                {initials(w.name)}
              </span>
              <span className="flex-1">
                <span className="block font-semibold">{w.name}</span>
                <span className="block text-xs text-muted">
                  {shortAddress(w.address)}
                </span>
              </span>
            </button>
            <button
              onClick={() => onOpenDetail(w.index)}
              title="Manage wallet"
              className="shrink-0 rounded-lg px-2 py-1 text-muted transition-colors hover:bg-surface hover:text-fg"
            >
              ›
            </button>
          </div>
        ))}
      </div>

      <div className="mt-4 space-y-2">
        <button
          onClick={onAddWallet}
          className="w-full rounded-pill bg-accent px-6 py-3.5 text-[15px] font-semibold text-base transition-transform hover:scale-[1.02] active:scale-95"
        >
          + Add wallet
        </button>
        <button
          onClick={() => setImporting(true)}
          className="w-full rounded-pill border border-border bg-surface px-6 py-3 text-sm font-semibold text-fg transition-colors hover:bg-surface-2"
        >
          Import wallet
        </button>
      </div>
    </>
  );
}

/* ---------- Import view ---------- */

function ImportPanel({
  onImport,
  onCancel,
  onClose,
}: {
  onImport: (secret: string, password: string) => Promise<void>;
  onCancel: () => void;
  onClose: () => void;
}) {
  const [secret, setSecret] = useState("");
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!secret.trim() || !pw || busy) return;
    setBusy(true);
    setError("");
    try {
      await onImport(secret.trim(), pw);
      setSecret("");
      setPw("");
      onClose();
    } catch (e) {
      const msg = String(e);
      setError(
        /invalid password/i.test(msg)
          ? "Wrong password."
          : /already in your vault/i.test(msg)
            ? "This wallet is already in your vault."
            : /invalid private key|invalid recovery/i.test(msg)
              ? "That doesn't look like a valid recovery phrase or private key."
              : msg
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <button onClick={onCancel} className="text-muted transition-colors hover:text-fg">
          ←
        </button>
        <h2 className="text-lg font-bold">Import wallet</h2>
        <button onClick={onClose} className="text-muted transition-colors hover:text-fg">
          ✕
        </button>
      </div>

      <div className="mt-6">
        <label className="text-xs font-semibold uppercase tracking-wide text-muted">
          Recovery phrase or private key
        </label>
        <textarea
          autoFocus
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder="word1 word2 word3 …  or  0x-prefixed private key"
          className="mt-2 w-full resize-none rounded-xl border border-border bg-surface px-4 py-3 font-mono text-sm text-fg outline-none focus:border-accent"
        />
        <p className="mt-1.5 text-xs text-muted">
          Imported as a standalone wallet, encrypted on this device. It is not
          derived from your recovery phrase, so back it up separately.
        </p>

        <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-muted">
          Vault password
        </label>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Confirm to seal the imported key"
          className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-fg outline-none focus:border-accent"
        />
        {error && <p className="mt-2 text-xs text-pink">{error}</p>}

        <div className="mt-4 flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded-pill border border-border bg-surface px-4 py-2.5 text-sm font-semibold"
          >
            Cancel
          </button>
          <button
            disabled={!secret.trim() || !pw || busy}
            onClick={submit}
            className="flex-1 rounded-pill bg-accent px-4 py-2.5 text-sm font-semibold text-base disabled:opacity-40"
          >
            {busy ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </>
  );
}

/* ---------- Detail view ---------- */

function WalletDetail({
  wallet,
  canRemove,
  onBack,
  onClose,
  onRename,
  onSetBackground,
  onRemove,
}: {
  wallet: DerivedWallet;
  canRemove: boolean;
  onBack: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
  onSetBackground: (bg: string) => void;
  onRemove: () => void;
}) {
  const [sub, setSub] = useState<Sub>("menu");
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <button
          onClick={sub === "menu" ? onBack : () => setSub("menu")}
          className="text-muted transition-colors hover:text-fg"
        >
          ←
        </button>
        <h2 className="truncate px-3 text-lg font-bold">{wallet.name}</h2>
        <button
          onClick={onClose}
          className="text-muted transition-colors hover:text-fg"
        >
          ✕
        </button>
      </div>

      {sub === "menu" && (
        <div className="mt-6 space-y-2">
          <ActionRow
            icon="⧉"
            title={copied ? "Copied!" : "Copy address"}
            subtitle="Share your public key to receive assets"
            onClick={copy}
          />
          <ActionRow
            icon="✎"
            title="Rename wallet"
            subtitle="Give your wallet a recognizable name"
            onClick={() => setSub("rename")}
          />
          <ActionRow
            icon="🖌"
            title="Edit background"
            subtitle="Personalize your wallet's appearance"
            onClick={() => setSub("background")}
          />
          <ActionRow
            icon="◉"
            title="Reveal private key"
            subtitle="For safe backup, it's best to simply write it down"
            onClick={() => setSub("reveal")}
          />
          <ActionRow
            icon="🗑"
            title="Remove wallet"
            subtitle={
              canRemove
                ? "This device will lose access to this wallet"
                : "You can't remove your only wallet"
            }
            danger
            disabled={!canRemove}
            onClick={() => canRemove && setConfirmRemove(true)}
          />

          {confirmRemove && (
            <div className="mt-3 rounded-2xl border border-pink/40 bg-pink/10 p-4">
              <p className="text-sm font-semibold text-pink">Remove this wallet?</p>
              <p className="mt-1 text-xs text-muted">
                It will be hidden from this device. Your funds stay on-chain and
                you can restore it any time from your recovery phrase.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => setConfirmRemove(false)}
                  className="flex-1 rounded-pill border border-border bg-surface px-4 py-2.5 text-sm font-semibold"
                >
                  Cancel
                </button>
                <button
                  onClick={onRemove}
                  className="flex-1 rounded-pill bg-pink px-4 py-2.5 text-sm font-semibold text-base"
                >
                  Remove
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {sub === "rename" && (
        <RenamePanel
          current={wallet.name}
          onCancel={() => setSub("menu")}
          onSave={(name) => {
            onRename(name);
            setSub("menu");
          }}
        />
      )}

      {sub === "background" && (
        <BackgroundPanel
          current={getMeta(wallet.address).background}
          onCancel={() => setSub("menu")}
          onApply={(bg) => {
            onSetBackground(bg);
            setSub("menu");
          }}
        />
      )}

      {sub === "reveal" && (
        <RevealKeyPanel index={wallet.index} onClose={() => setSub("menu")} />
      )}
    </>
  );
}

function ActionRow({
  icon,
  title,
  subtitle,
  onClick,
  danger,
  disabled,
}: {
  icon: string;
  title: string;
  subtitle: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5 text-left transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm ${
          danger ? "bg-pink/15 text-pink" : "bg-surface-2 text-muted"
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span
          className={`block text-sm font-semibold ${danger ? "text-pink" : ""}`}
        >
          {title}
        </span>
        <span className="block truncate text-xs text-muted">{subtitle}</span>
      </span>
    </button>
  );
}

function RenamePanel({
  current,
  onCancel,
  onSave,
}: {
  current: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(current);
  return (
    <div className="mt-6">
      <label className="text-xs font-semibold uppercase tracking-wide text-muted">
        Wallet name
      </label>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && name.trim() && onSave(name)}
        maxLength={32}
        className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-fg outline-none focus:border-accent"
      />
      <div className="mt-4 flex gap-2">
        <button
          onClick={onCancel}
          className="flex-1 rounded-pill border border-border bg-surface px-4 py-2.5 text-sm font-semibold"
        >
          Cancel
        </button>
        <button
          disabled={!name.trim()}
          onClick={() => onSave(name)}
          className="flex-1 rounded-pill bg-accent px-4 py-2.5 text-sm font-semibold text-base disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function BackgroundPanel({
  current,
  onCancel,
  onApply,
}: {
  current?: string;
  onCancel: () => void;
  onApply: (bg: string) => void;
}) {
  const [picked, setPicked] = useState(current ?? BACKGROUNDS[0].id);
  return (
    <div className="mt-6 flex min-h-0 flex-1 flex-col">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
        Backgrounds
      </p>
      <div className="mt-3 grid flex-1 grid-cols-2 gap-3 overflow-y-auto">
        {BACKGROUNDS.map((b) => (
          <button
            key={b.id}
            onClick={() => setPicked(b.id)}
            style={{ background: b.css }}
            className={`flex h-24 items-end rounded-2xl p-3 text-left text-xs font-semibold text-white ring-2 transition-all ${
              picked === b.id ? "ring-accent" : "ring-transparent"
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button
          onClick={onCancel}
          className="flex-1 rounded-pill border border-border bg-surface px-4 py-2.5 text-sm font-semibold"
        >
          Cancel
        </button>
        <button
          onClick={() => onApply(picked)}
          className="flex-1 rounded-pill bg-accent px-4 py-2.5 text-sm font-semibold text-base"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

function RevealKeyPanel({
  index,
  onClose,
}: {
  index: number;
  onClose: () => void;
}) {
  const [pw, setPw] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function reveal() {
    if (!pw || busy) return;
    setBusy(true);
    setError("");
    try {
      setKey(await revealPrivateKey(pw, index));
      setPw("");
    } catch (e) {
      setError(
        String(e).includes("invalid password") ? "Wrong password." : String(e)
      );
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="mt-6">
      <div className="rounded-2xl border border-pink/40 bg-pink/10 p-4">
        <p className="text-sm font-semibold text-pink">Never share your private key</p>
        <p className="mt-1 text-xs text-muted">
          Anyone with this key controls this wallet's funds. Prefer writing it
          down offline over pasting it anywhere.
        </p>
      </div>

      {!key ? (
        <div className="mt-4">
          <p className="mb-2 text-xs text-muted">
            Confirm your password to reveal the key.
          </p>
          <input
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && reveal()}
            placeholder="Password"
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-fg outline-none focus:border-accent"
          />
          {error && <p className="mt-2 text-xs text-pink">{error}</p>}
          <div className="mt-4 flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 rounded-pill border border-border bg-surface px-4 py-2.5 text-sm font-semibold"
            >
              Cancel
            </button>
            <button
              disabled={!pw || busy}
              onClick={reveal}
              className="flex-1 rounded-pill bg-accent px-4 py-2.5 text-sm font-semibold text-base disabled:opacity-40"
            >
              {busy ? "…" : "Reveal"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <p className="break-all rounded-xl bg-surface px-4 py-3 font-mono text-xs leading-relaxed">
            {key}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              onClick={copy}
              className="flex-1 rounded-pill border border-border bg-surface px-4 py-2.5 text-sm font-semibold"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              onClick={onClose}
              className="flex-1 rounded-pill bg-accent px-4 py-2.5 text-sm font-semibold text-base"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
