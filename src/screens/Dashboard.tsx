import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Logo } from "../components/Logo";
import { WalletsDrawer } from "../components/WalletsDrawer";
import {
  CoinIcon,
  TokenIcon,
  ActivityIcon,
  ShieldIcon,
  SettingsIcon,
  FaceIdIcon,
  BluetoothIcon,
  UsbIcon,
  GeoIcon,
  VoiceIcon,
} from "../components/Icons";
import { initials, shortAddress, type DerivedWallet } from "../lib/wallet";
import { revealMnemonic, revealPrivateKey } from "../lib/vault";
import { getMeta, backgroundCss } from "../lib/walletMeta";
import { SwapModal, SwapForm, type SwapVault } from "../components/SwapModal";
import { ReceiveModal } from "../components/ReceiveModal";
import { StealthPanel } from "../components/StealthPanel";
import { AgentChatDock } from "../components/AgentChatDock";
import { Agents } from "./Agents";
import { SendModal } from "../components/SendModal";
import { TokenLogo } from "../components/TokenLogo";
import { byKey } from "../solares/networks";
import {
  getVaultCosigner,
  predictCosignedVault,
  createCosignedVault,
  configToLayers,
  getDefaultLayers,
  setDefaultLayers,
  updateVaultPolicy,
  isVaultDeployed,
  type VaultPhase,
  type VaultLayers,
} from "../lib/safe";
import { getVaultPolicy, type VaultPolicyConfig } from "../lib/api";
import { WEBAUTHN_NATIVE_READY } from "../lib/webauthn";
import { friendlyError } from "../lib/errors";
import { isEffectivelyHidden, hideToken, unhideToken } from "../lib/tokenMeta";
import { checkForUpdate, type UpdateInfo } from "../lib/updates";
import {
  browserOpen,
  browserActivate,
  browserNavigate,
  browserClose,
  browserHideAll,
  browserBack,
  browserForward,
  browserReload,
  onBrowserNavigated,
} from "../lib/browser";
import {
  listUsbDevices,
  listBluetoothDevices,
  getLocation,
  type UsbDevice,
  type BtDevice,
  type GeoPos,
} from "../lib/devices";
import {
  getPortfolio,
  getHistory,
  formatUsd,
  type Portfolio,
  type PortfolioToken,
  type Transfer,
  type SwapChain,
} from "../lib/api";

interface SwapReq {
  chain: SwapChain;
}

const NAV = [
  "Portfolio",
  "Tokens",
  "Activity",
  "Vaults",
  "Agents",
  "Browser",
  "Settings",
] as const;
type Tab = (typeof NAV)[number];

// Tabs that take the full pane (no swap rail, no scroll container).
const FULL_BLEED: Tab[] = ["Browser"];

const CHAIN_LABEL: Record<string, string> = {
  ethereum: "Ethereum",
  base: "Base",
};

export function Dashboard({
  wallets,
  activeIndex,
  onSwitch,
  onAddWallet,
  onImportWallet,
  onLock,
  onRename,
  onSetBackground,
  onRemove,
}: {
  wallets: DerivedWallet[];
  activeIndex: number;
  onSwitch: (i: number) => void;
  onAddWallet: () => void;
  onImportWallet: (secret: string, password: string) => Promise<void>;
  onLock: () => void;
  onRename: (index: number, name: string) => void;
  onSetBackground: (index: number, background: string) => void;
  onRemove: (index: number) => void;
}) {
  const [tab, setTab] = useState<Tab>("Portfolio");
  const [drawer, setDrawer] = useState(false);
  const [swap, setSwap] = useState<SwapReq | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [showSwapPanel, setShowSwapPanel] = useState(
    () => localStorage.getItem("ark.showSwapPanel") !== "0"
  );
  const toggleSwapPanel = () =>
    setShowSwapPanel((v) => {
      localStorage.setItem("ark.showSwapPanel", v ? "0" : "1");
      return !v;
    });
  const [navCollapsed, setNavCollapsed] = useState(
    () => localStorage.getItem("ark.navCollapsed") === "1"
  );
  const toggleNav = () =>
    setNavCollapsed((v) => {
      localStorage.setItem("ark.navCollapsed", v ? "0" : "1");
      return !v;
    });
  const [headerCollapsed, setHeaderCollapsed] = useState(
    () => localStorage.getItem("ark.headerCollapsed") === "1"
  );
  const toggleHeader = () =>
    setHeaderCollapsed((v) => {
      localStorage.setItem("ark.headerCollapsed", v ? "0" : "1");
      return !v;
    });
  const active = wallets.find((w) => w.index === activeIndex) ?? wallets[0];
  const activeBg = backgroundCss(getMeta(active.address).background);

  // Wallet <-> Vault: the Portfolio can show either this wallet (the EOA) or the
  // vault (the Safe) it owns — two separate addresses with separate balances.
  const [view, setView] = useState<"wallet" | "vault" | "private">("wallet");
  const [vaultAddr, setVaultAddr] = useState<`0x${string}` | null>(null);
  const [vaultDeployed, setVaultDeployed] = useState(false);
  // When the open SendModal should route through the vault (Safe + co-signer)
  // rather than the EOA. Used for vault "Send" and "Withdraw to wallet".
  const [sendVault, setSendVault] = useState(false);
  const [sendPrefill, setSendPrefill] = useState<`0x${string}` | "">("");

  // Re-derive the vault address + on-chain deployed status. Callable on demand so
  // a vault created after initial load (in the Vaults tab) is detected when the
  // user switches to the Vault view — not stuck on a stale "not created yet".
  async function resolveVault() {
    try {
      const cs = await getVaultCosigner();
      if (!cs) return;
      const addr = await predictCosignedVault(VAULT_CHAIN, active.address, cs);
      setVaultAddr(addr);
      setVaultDeployed(await isVaultDeployed(VAULT_CHAIN, addr));
    } catch {
      /* vault unavailable — switch just won't show */
    }
  }

  useEffect(() => {
    setView("wallet");
    setVaultAddr(null);
    setVaultDeployed(false);
    resolveVault();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.address]);

  const accountAddress: `0x${string}` =
    view === "vault" && vaultAddr ? vaultAddr : active.address;

  // When on the Vault view, swaps trade the vault's funds through the co-signer.
  const swapVault: SwapVault | undefined =
    view === "vault" && vaultAddr
      ? { owner: active.address as `0x${string}`, safeAddress: vaultAddr }
      : undefined;

  // Check for a newer app version (keys are safe across updates — app-data dir).
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const current = await getVersion();
        const info = await checkForUpdate(current);
        if (alive) setUpdate(info);
      } catch {
        /* not in Tauri / offline — no prompt */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const openSwap = () =>
    setSwap({ chain: "base" });

  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setPortfolio(null);
    getPortfolio(accountAddress)
      .then((p) => alive && setPortfolio(p))
      .catch(() => alive && setPortfolio(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [accountAddress]);

  const total = portfolio ? formatUsd(portfolio.totalUsd) : "$0.00";

  return (
    <div className="flex h-full w-full bg-base">
      {/* Sidebar */}
      {!navCollapsed && (
      <aside className="flex w-60 flex-col border-r border-border px-5 py-6">
        <Logo size={26} />
        <nav className="mt-10 flex flex-col gap-1">
          {NAV.map((item) => (
            <button
              key={item}
              onClick={() => setTab(item)}
              className={`rounded-xl px-4 py-2.5 text-left text-sm font-medium transition-colors ${
                tab === item
                  ? "bg-surface-2 text-fg"
                  : "text-muted hover:bg-surface hover:text-fg"
              }`}
            >
              {item}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-3">
          {update && (
            <button
              onClick={() => openExternal(update.url)}
              className="w-full rounded-xl border border-accent/50 bg-accent/10 px-4 py-2.5 text-left text-xs transition-colors hover:bg-accent/20"
            >
              <span className="block font-semibold text-accent">
                Update available · v{update.version}
              </span>
              <span className="text-muted">Download the newest version</span>
            </button>
          )}
          <button
            onClick={onLock}
            className="w-full rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            Lock wallet
          </button>
        </div>
      </aside>
      )}

      {/* Right side */}
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {headerCollapsed ? (
          <div className="flex h-8 items-center gap-2 border-b border-border px-4 text-muted">
            <button
              onClick={toggleNav}
              title={navCollapsed ? "Show menu" : "Hide menu"}
              className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg"
            >
              <span className="text-base leading-none">≡</span>
            </button>
            <span className="text-xs font-semibold">{tab}</span>
            <button
              onClick={() => setDrawer(true)}
              className="ml-auto flex items-center gap-1.5 rounded-pill border border-border bg-surface px-2 py-0.5 transition-colors hover:bg-surface-2"
            >
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-gradient-to-br from-lavender to-pink text-[8px] font-bold text-base">
                {initials(active.name)}
              </span>
              <span className="text-xs font-semibold text-fg">{active.name}</span>
              <span className="text-[10px] text-muted">{shortAddress(active.address)}</span>
            </button>
            <button
              onClick={toggleHeader}
              title="Show top bar"
              className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg"
            >
              <span className="text-xs leading-none">▾</span>
            </button>
          </div>
        ) : (
          <header className="flex items-center justify-between border-b border-border px-10 py-5">
            <div className="flex items-center gap-3">
              <button
                onClick={toggleNav}
                title={navCollapsed ? "Show menu" : "Hide menu"}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <span className="text-lg leading-none">≡</span>
              </button>
              <h1 className="text-xl font-bold">{tab}</h1>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setDrawer(true)}
                className="flex items-center gap-2.5 rounded-pill border border-border bg-surface px-3 py-1.5 transition-colors hover:bg-surface-2"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-lavender to-pink text-[11px] font-bold text-base">
                  {initials(active.name)}
                </span>
                <span className="text-left">
                  <span className="block text-sm font-semibold leading-tight">
                    {active.name}
                  </span>
                  <span className="block text-xs leading-tight text-muted">
                    {shortAddress(active.address)}
                  </span>
                </span>
                <span className="ml-1 text-muted">›</span>
              </button>
              <button
                onClick={toggleHeader}
                title="Hide top bar"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <span className="text-xs leading-none">▴</span>
              </button>
            </div>
          </header>
        )}

        <div className="flex flex-1 overflow-hidden">
          <main
            className={`flex-1 ${
              tab === "Browser"
                ? "overflow-hidden"
                : FULL_BLEED.includes(tab)
                  ? "overflow-hidden px-10 py-8"
                  : "overflow-y-auto px-10 py-8"
            }`}
          >
            {tab === "Portfolio" && (
              <Portfolio
                total={total}
                loading={loading}
                portfolio={portfolio}
                account={{ address: active.address as `0x${string}`, index: active.index }}
                onSwap={openSwap}
                onReceive={() => setReceiveOpen(true)}
                onSend={() => {
                  setSendVault(view === "vault" && vaultDeployed);
                  setSendOpen(true);
                }}
                background={activeBg}
                view={view}
                onToggleView={(v) => {
                  setView(v);
                  if (v === "vault") resolveVault();
                }}
                vaultAvailable={vaultAddr != null}
                vaultDeployed={vaultDeployed}
                onCreateVault={() => setTab("Vaults")}
                onManageVault={() => setTab("Vaults")}
                onMoveToVault={
                  vaultAddr
                    ? () => {
                        setSendVault(false);
                        setSendPrefill(vaultAddr);
                        setSendOpen(true);
                      }
                    : undefined
                }
                onWithdrawToWallet={() => {
                  setSendVault(true);
                  setSendPrefill(active.address as `0x${string}`);
                  setSendOpen(true);
                }}
              />
            )}
            {tab === "Tokens" && (
              <Tokens loading={loading} portfolio={portfolio} />
            )}
            {tab === "Activity" && <Activity address={active.address} />}
            {tab === "Vaults" && <Vaults wallet={active} />}
            {tab === "Agents" && <Agents wallet={active} />}
            {tab === "Browser" && <BrowserView />}
            {tab === "Settings" && <Settings wallet={active} />}
          </main>

          {!FULL_BLEED.includes(tab) && showSwapPanel && (
            <aside className="hidden w-80 shrink-0 flex-col border-l border-border px-6 py-8 xl:flex">
              <SwapRail
                onHide={toggleSwapPanel}
                chain="base"
                from={active.address as `0x${string}`}
                accountIndex={active.index}
                tokens={portfolio?.tokens ?? []}
                vault={swapVault}
              />
            </aside>
          )}
          {!FULL_BLEED.includes(tab) && !showSwapPanel && (
            <button
              onClick={toggleSwapPanel}
              title="Show swap panel"
              className="hidden shrink-0 items-start border-l border-border px-2 py-8 text-muted transition-colors hover:bg-surface hover:text-fg xl:flex"
            >
              <span className="[writing-mode:vertical-rl] rotate-180 text-xs font-semibold uppercase tracking-wide">
                Swap
              </span>
            </button>
          )}
        </div>

        {swap && (
          <SwapModal
            chain={swap.chain}
            from={active.address as `0x${string}`}
            accountIndex={active.index}
            tokens={portfolio?.tokens ?? []}
            vault={swapVault}
            onClose={() => setSwap(null)}
          />
        )}
        {receiveOpen && (
          <ReceiveModal
            address={accountAddress}
            name={view === "vault" ? `${active.name} · Vault` : active.name}
            onClose={() => setReceiveOpen(false)}
          />
        )}
        {sendOpen && (
          <SendModal
            from={active.address as `0x${string}`}
            accountIndex={active.index}
            tokens={portfolio?.tokens ?? []}
            to={sendPrefill || undefined}
            vault={
              sendVault && vaultAddr
                ? { owner: active.address as `0x${string}`, safeAddress: vaultAddr }
                : undefined
            }
            onClose={() => {
              setSendOpen(false);
              setSendPrefill("");
              setSendVault(false);
            }}
          />
        )}
      </div>

      <WalletsDrawer
        open={drawer}
        wallets={wallets}
        activeIndex={activeIndex}
        netWorth={total}
        onSwitch={onSwitch}
        onAddWallet={onAddWallet}
        onImportWallet={onImportWallet}
        onClose={() => setDrawer(false)}
        onRename={onRename}
        onSetBackground={onSetBackground}
        onRemove={onRemove}
      />

      <AgentChatDock wallet={active} />
    </div>
  );
}

/* ---------- Tabs ---------- */

function Portfolio({
  total,
  loading,
  portfolio,
  account,
  onSwap,
  onReceive,
  onSend,
  background,
  view,
  onToggleView,
  vaultAvailable,
  vaultDeployed,
  onCreateVault,
  onMoveToVault,
  onWithdrawToWallet,
  onManageVault,
}: {
  total: string;
  loading: boolean;
  portfolio: Portfolio | null;
  account: { address: `0x${string}`; index: number };
  onSwap?: () => void;
  onReceive?: () => void;
  onSend?: () => void;
  background?: string;
  view: "wallet" | "vault" | "private";
  onToggleView: (v: "wallet" | "vault" | "private") => void;
  vaultAvailable: boolean;
  vaultDeployed: boolean;
  onCreateVault: () => void;
  onMoveToVault?: () => void;
  onWithdrawToWallet?: () => void;
  onManageVault?: () => void;
}) {
  const assetCount = portfolio?.tokens.length ?? 0;
  const onVault = view === "vault";
  const needsCreate = onVault && !vaultDeployed;

  return (
    <>
      <div className="mb-4 inline-flex rounded-pill border border-border bg-surface p-1">
        {((vaultAvailable
          ? ["wallet", "vault", "private"]
          : ["wallet", "private"]) as ("wallet" | "vault" | "private")[]).map(
          (v) => (
            <button
              key={v}
              type="button"
              onClick={() => onToggleView(v)}
              className={`rounded-pill px-5 py-1.5 text-sm font-semibold transition-colors ${
                view === v ? "bg-accent text-base" : "text-muted hover:text-fg"
              }`}
            >
              {v === "wallet" ? "Wallet" : v === "vault" ? "Vault" : "Private"}
            </button>
          )
        )}
      </div>

      {view === "private" ? (
        <StealthPanel
          chain="base"
          account={account}
          tokens={portfolio?.tokens ?? []}
          background={background}
        />
      ) : (
        <>
          <section
            className="relative overflow-hidden rounded-3xl border border-border p-6 text-white"
            style={{ background }}
          >
        <div className="absolute inset-0 bg-black/10" />
        {onVault && onManageVault && (
          <button
            onClick={onManageVault}
            title="Vault settings"
            aria-label="Vault settings"
            className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/30 text-white/80 backdrop-blur transition-colors hover:bg-black/50 hover:text-white"
          >
            <SettingsIcon size={18} />
          </button>
        )}
        <div className="relative">
          <p className="text-sm text-white/70">{onVault ? "Vault balance" : "Balance"}</p>
          <h2 className="mt-1 text-4xl font-bold tracking-tight">
            {needsCreate ? "—" : loading ? <span className="text-white/70">Loading…</span> : total}
          </h2>
          <p className="mt-1 text-sm text-white/70">
            {needsCreate
              ? "Your secured vault — not created yet."
              : onVault
                ? `${assetCount} asset${assetCount === 1 ? "" : "s"} secured on Base`
                : `${assetCount} asset${assetCount === 1 ? "" : "s"} across Ethereum and Base`}
          </p>

          {needsCreate ? (
            <div className="mt-5">
              <ActionButton primary onClick={onCreateVault}>Create vault</ActionButton>
            </div>
          ) : (
            <div className="mt-5 flex flex-wrap gap-3">
              <ActionButton primary onClick={onReceive}>Deposit</ActionButton>
              <ActionButton onClick={onSend}>Send</ActionButton>
              {!onVault && <ActionButton onClick={onSwap}>Swap</ActionButton>}
              {!onVault && onMoveToVault && (
                <ActionButton onClick={onMoveToVault}>Move to vault</ActionButton>
              )}
              {onVault && onWithdrawToWallet && (
                <ActionButton onClick={onWithdrawToWallet}>Withdraw to wallet</ActionButton>
              )}
            </div>
          )}
          {portfolio && !portfolio.live && !needsCreate && <DataHint />}
        </div>
      </section>

      {!needsCreate && !loading && assetCount === 0 && (
        <EmptyState
          icon={<CoinIcon size={32} />}
          title={onVault ? "Fund your vault" : "Get started"}
          body={
            onVault
              ? "Move funds from your wallet into the vault to secure them behind your layers."
              : "Deposit crypto to start trading, swapping, and securing it inside a vault."
          }
          cta="Deposit"
        />
      )}
      {!needsCreate && assetCount > 0 && (
        <div className="mt-6">
          <TokenList tokens={portfolio!.tokens} />
        </div>
      )}
        </>
      )}
    </>
  );
}

function Tokens({
  loading,
  portfolio,
}: {
  loading: boolean;
  portfolio: Portfolio | null;
}) {
  const tokens = portfolio?.tokens ?? [];
  if (loading)
    return (
      <section className="rounded-3xl border border-border bg-surface p-6 text-sm text-muted">
        Loading tokens…
      </section>
    );
  if (tokens.length === 0)
    return (
      <section className="rounded-3xl border border-border bg-surface">
        <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-surface-2 text-muted">
            <TokenIcon size={32} />
          </div>
          <h3 className="mt-4 font-bold">No tokens yet</h3>
          <p className="mt-1 max-w-xs text-sm text-muted">
            Tokens you hold will appear here once this wallet has a balance.
          </p>
          {portfolio && !portfolio.live && <DataHint />}
        </div>
      </section>
    );
  return <TokenList tokens={tokens} />;
}

function TokenList({ tokens }: { tokens: PortfolioToken[] }) {
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const [showHidden, setShowHidden] = useState(false);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const keyOf = (t: PortfolioToken) => `${t.chain}:${t.tokenAddress ?? "native"}`;

  const visible = tokens.filter((t) => !isEffectivelyHidden(t));
  const hidden = tokens.filter((t) => isEffectivelyHidden(t));

  function hide(t: PortfolioToken) {
    hideToken(t.chain, t.tokenAddress);
    setMenuKey(null);
    bump();
  }
  function unhide(t: PortfolioToken) {
    unhideToken(t.chain, t.tokenAddress);
    bump();
  }

  return (
    <section className="overflow-hidden rounded-3xl border border-border bg-surface">
      {visible.map((t, i) => {
        const k = keyOf(t);
        return (
          <div
            key={k}
            className={`relative flex items-center gap-4 px-5 py-4 ${
              i !== visible.length - 1 ? "border-b border-border" : ""
            }`}
          >
            <TokenLogo symbol={t.symbol} logo={t.logo} size={40} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{t.name}</div>
              <div className="text-xs text-muted">
                {trim(t.balance)} {t.symbol} · {CHAIN_LABEL[t.chain]}
              </div>
            </div>
            <div className="text-right">
              <div className="font-semibold">
                {t.valueUsd != null ? formatUsd(t.valueUsd) : "—"}
              </div>
              <div className="text-xs text-muted">
                {t.priceUsd != null ? formatUsd(t.priceUsd) : "no price"}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setMenuKey(menuKey === k ? null : k)}
              className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
              aria-label="Token options"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="19" cy="12" r="1.6" />
              </svg>
            </button>
            {menuKey === k && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuKey(null)} />
                <div className="absolute right-4 top-12 z-20 overflow-hidden rounded-xl border border-border bg-surface-2 shadow-xl">
                  <button
                    type="button"
                    onClick={() => hide(t)}
                    className="block w-full px-4 py-2.5 text-left text-sm text-fg hover:bg-surface"
                  >
                    Hide token
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}

      {visible.length === 0 && (
        <div className="px-5 py-6 text-center text-sm text-muted">No tokens to show.</div>
      )}

      {hidden.length > 0 && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => setShowHidden((s) => !s)}
            className="w-full px-5 py-3 text-left text-xs font-medium text-muted hover:text-fg"
          >
            {showHidden ? "Hide" : "Show"} hidden &amp; spam ({hidden.length})
          </button>
          {showHidden &&
            hidden.map((t) => (
              <div key={keyOf(t)} className="flex items-center gap-4 px-5 py-3 opacity-60">
                <TokenLogo symbol={t.symbol} logo={t.logo} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{t.name}</div>
                  <div className="text-xs text-muted">
                    {trim(t.balance)} {t.symbol} · {CHAIN_LABEL[t.chain]}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => unhide(t)}
                  className="flex-none rounded-pill border border-border px-3 py-1.5 text-xs text-muted hover:text-fg"
                >
                  Unhide
                </button>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

function Activity({ address }: { address: string }) {
  const [transfers, setTransfers] = useState<Transfer[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getHistory(address)
      .then((h) => alive && setTransfers(h.transfers))
      .catch(() => alive && setTransfers([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [address]);

  if (loading)
    return (
      <section className="rounded-3xl border border-border bg-surface p-6 text-sm text-muted">
        Loading activity…
      </section>
    );
  if (!transfers || transfers.length === 0)
    return (
      <EmptyState
        icon={<ActivityIcon size={32} />}
        title="No activity yet"
        body="Your transactions — sends, swaps, and vault approvals — will show up here."
      />
    );

  return (
    <section className="overflow-hidden rounded-3xl border border-border bg-surface">
      {transfers.map((t, i) => (
        <div
          key={t.hash + i}
          className={`flex items-center gap-4 px-5 py-4 ${
            i !== transfers.length - 1 ? "border-b border-border" : ""
          }`}
        >
          <span
            className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold ${
              t.direction === "in"
                ? "bg-mint/20 text-mint"
                : "bg-pink/20 text-pink"
            }`}
          >
            {t.direction === "in" ? "↓" : "↑"}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">
              {t.direction === "in" ? "Received" : "Sent"} {t.asset ?? ""}
            </div>
            <div className="truncate text-xs text-muted">
              {CHAIN_LABEL[t.chain]} ·{" "}
              {t.direction === "in"
                ? `from ${shortAddress(t.from)}`
                : `to ${t.to ? shortAddress(t.to) : "—"}`}
            </div>
          </div>
          <div className="text-right text-sm font-semibold">
            {t.value != null ? trim(String(t.value)) : ""} {t.asset ?? ""}
          </div>
        </div>
      ))}
    </section>
  );
}

const VAULT_PHASE_LABEL: Record<VaultPhase, string> = {
  predicting: "Computing vault address…",
  deploying: "Deploying vault…",
  confirming: "Waiting for confirmation…",
  building: "Building transaction…",
  signing: "Signing in vault core…",
  executing: "Executing from vault…",
  done: "Done",
  error: "Error",
};

const VAULT_CHAIN: SwapChain = "base";

const LAYER_META: {
  key: keyof VaultLayers;
  label: string;
  desc: string;
  Icon: (p: { size?: number; className?: string }) => ReactNode;
}[] = [
  { key: "faceId", label: "Face ID", desc: "Windows Hello / Touch ID", Icon: FaceIdIcon },
  { key: "bluetooth", label: "Bluetooth device", desc: "Registered device nearby", Icon: BluetoothIcon },
  { key: "usb", label: "USB device", desc: "Hardware security key present", Icon: UsbIcon },
  { key: "geo", label: "Geo location", desc: "Approved location", Icon: GeoIcon },
];


/**
 * ARGUS-style vault: one wallet → one vault, a Safe 2-of-2 owned by
 * [your master wallet, the ANTARA co-signer]. Every transfer needs your signature
 * AND the co-signer (Member 2), which only signs once the policy engine passes.
 */
function Vaults({ wallet }: { wallet: DerivedWallet }) {
  const owner = wallet.address;
  const [cosigner, setCosigner] = useState<`0x${string}` | null>(null);
  const [cosignerEnabled, setCosignerEnabled] = useState<boolean | null>(null);
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [deployed, setDeployed] = useState<boolean | null>(null);
  const [layers, setLayers] = useState<VaultLayers>(getDefaultLayers);
  const [deployedConfig, setDeployedConfig] = useState<VaultPolicyConfig | null>(null);
  // Per-layer registration state (only used while configuring a new vault).
  const [usbList, setUsbList] = useState<UsbDevice[]>([]);
  const [usbId, setUsbId] = useState("");
  const [btList, setBtList] = useState<BtDevice[]>([]);
  const [btId, setBtId] = useState("");
  const [geoPos, setGeoPos] = useState<GeoPos | null>(null);
  const [geoRadius, setGeoRadius] = useState(500);
  const [layerBusy, setLayerBusy] = useState("");
  const [editing, setEditing] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<VaultPhase | null>(null);
  const busy = phase != null && phase !== "done" && phase !== "error";
  // Layers are editable while configuring a new vault, or while editing a deployed one.
  const editable = !deployed || editing;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    setAddress(null);
    setDeployed(null);
    setPhase(null);
    setLayers(getDefaultLayers());
    getVaultCosigner()
      .then(async (cs) => {
        if (!alive) return;
        setCosignerEnabled(cs != null);
        if (!cs) return;
        setCosigner(cs);
        const addr = await predictCosignedVault(VAULT_CHAIN, owner, cs);
        if (!alive) return;
        setAddress(addr);
        const d = await isVaultDeployed(VAULT_CHAIN, addr);
        if (!alive) return;
        setDeployed(d);
        if (d) {
          // Show the layers this vault was created with.
          const { config } = await getVaultPolicy(VAULT_CHAIN, addr);
          if (alive) {
            setDeployedConfig(config);
            setLayers(configToLayers(config));
          }
        }
      })
      .catch((e) => alive && setError(String(e instanceof Error ? e.message : e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [owner]);

  async function toggle(key: keyof VaultLayers) {
    const turningOn = !layers[key];
    setLayers((l) => ({ ...l, [key]: turningOn }));
    if (!turningOn) return;
    // Load what this layer needs to register the moment it's switched on.
    setError("");
    try {
      if (key === "usb") {
        setLayerBusy("usb");
        const list = await listUsbDevices();
        setUsbList(list);
        if (list[0]) setUsbId((cur) => cur || list[0].id);
      } else if (key === "bluetooth") {
        setLayerBusy("bluetooth");
        const list = await listBluetoothDevices();
        setBtList(list);
        const connected = list.find((d) => d.connected) ?? list[0];
        if (connected) setBtId((cur) => cur || connected.id);
      } else if (key === "geo") {
        setLayerBusy("geo");
        setGeoPos(await getLocation());
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setLayers((l) => ({ ...l, [key]: false })); // couldn't set it up; revert
    } finally {
      setLayerBusy("");
    }
  }

  function buildConfig(): VaultPolicyConfig | string {
    const cfg: VaultPolicyConfig = {};
    if (layers.faceId) cfg.requireWebauthn = true;
    if (layers.usb) {
      if (!usbId) return "Pick a USB device for the USB layer.";
      cfg.requireUsbKey = true;
      cfg.usbDeviceId = usbId;
    }
    if (layers.bluetooth) {
      if (!btId) return "Pick a Bluetooth device for the Bluetooth layer.";
      cfg.requireBluetooth = true;
      cfg.bluetoothId = btId;
    }
    if (layers.geo) {
      if (!geoPos) return "Capture a location for the Geo layer.";
      cfg.requireGeo = true;
      cfg.geofence = { lat: geoPos.lat, lng: geoPos.lng, radiusM: geoRadius };
    }
    return cfg;
  }

  async function deploy() {
    if (busy || !cosigner) return;
    const config = buildConfig();
    if (typeof config === "string") {
      setError(config);
      return;
    }
    setError("");
    try {
      const res = await createCosignedVault(
        { chain: VAULT_CHAIN, accountIndex: wallet.index, owner, cosigner, config },
        setPhase
      );
      setAddress(res.safeAddress);
      setDeployed(true);
      setDeployedConfig(config);
    } catch (e) {
      setError(friendlyError(e, { fundAddress: owner, network: CHAIN_LABEL[VAULT_CHAIN], gasSymbol: "ETH" }));
    }
  }

  async function enterEdit() {
    if (!deployedConfig) return;
    setError("");
    setEditing(true);
    if (deployedConfig.usbDeviceId) setUsbId(deployedConfig.usbDeviceId);
    if (deployedConfig.bluetoothId) setBtId(deployedConfig.bluetoothId);
    if (deployedConfig.geofence) {
      setGeoPos({
        lat: deployedConfig.geofence.lat,
        lng: deployedConfig.geofence.lng,
        accuracy_m: 0,
      });
      setGeoRadius(deployedConfig.geofence.radiusM);
    }
    // Load lists so the pickers show the current selection.
    try {
      setUsbList(await listUsbDevices());
    } catch {
      /* ignore */
    }
    try {
      setBtList(await listBluetoothDevices());
    } catch {
      /* ignore */
    }
  }

  function cancelEdit() {
    setEditing(false);
    setError("");
    if (deployedConfig) setLayers(configToLayers(deployedConfig));
  }

  async function saveEdit() {
    if (!address || !deployedConfig || savingPolicy) return;
    const cfg = buildConfig();
    if (typeof cfg === "string") {
      setError(cfg);
      return;
    }
    setSavingPolicy(true);
    setError("");
    try {
      await updateVaultPolicy(VAULT_CHAIN, address, cfg, deployedConfig);
      setDeployedConfig(cfg);
      setLayers(configToLayers(cfg));
      setEditing(false);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      setError(
        /403|security checks/i.test(msg)
          ? "Security checks failed. To change settings you must currently pass your enabled layers (USB plugged in, in your geo-fence, Face ID, etc.)."
          : msg
      );
    } finally {
      setSavingPolicy(false);
    }
  }

  if (loading) {
    return (
      <section className="mx-auto mt-6 w-full max-w-lg rounded-3xl border border-border bg-surface px-6 py-20 text-center text-sm text-muted">
        Loading vault…
      </section>
    );
  }

  if (cosignerEnabled === false) {
    return (
      <div className="mx-auto w-full max-w-lg">
        <div className="rounded-3xl border border-dashed border-border bg-surface p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-muted">
              <ShieldIcon size={24} />
            </div>
            <div>
              <h3 className="font-bold">Co-signer not configured</h3>
              <p className="text-xs text-muted">
                The vault needs the ANTARA co-signer (Member 2).
              </p>
            </div>
          </div>
          <p className="mt-4 text-sm text-muted">
            Set <span className="font-mono text-fg">COSIGNER_PRIVATE_KEY</span> in the
            backend <span className="font-mono text-fg">.env</span> and restart it.
            That key becomes the policy co-signer that must approve every transfer
            alongside your wallet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-4">
      <div className="rounded-3xl border border-border bg-surface p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-muted">
            <ShieldIcon size={24} />
          </div>
          <div>
            <h3 className="font-bold">Secure vault</h3>
            <p className="text-xs text-muted">
              A Safe on Base. Every transfer needs your key + the ANTARA co-signer.
            </p>
          </div>
          <span
            className={`ml-auto rounded-pill px-3 py-1 text-xs font-semibold ${
              deployed ? "bg-green-500/15 text-green-400" : "bg-surface-2 text-muted"
            }`}
          >
            {deployed ? "Deployed" : "Not deployed"}
          </span>
        </div>

        <div className="mt-5 space-y-2">
          <OwnerRow label="Your wallet" address={owner} tag="signs first" />
          <OwnerRow
            label="ANTARA co-signer"
            address={cosigner ?? "0x"}
            tag="signs if rules pass"
          />
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Security layers
            </p>
            {deployed && !editing && (
              <button
                onClick={enterEdit}
                className="rounded-pill border border-border px-3 py-1 text-xs font-semibold text-muted transition-colors hover:text-fg"
              >
                Edit
              </button>
            )}
            {deployed && editing && (
              <div className="flex items-center gap-2">
                <button
                  onClick={cancelEdit}
                  disabled={savingPolicy}
                  className="rounded-pill border border-border px-3 py-1 text-xs font-semibold text-muted hover:text-fg disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={saveEdit}
                  disabled={savingPolicy}
                  className="rounded-pill bg-accent px-3 py-1 text-xs font-semibold text-base disabled:opacity-50"
                >
                  {savingPolicy ? "Saving…" : "Save"}
                </button>
              </div>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">
            {editing
              ? "Changing settings requires passing your current layers right now (device connected, in your area, Face ID…)."
              : deployed
                ? "These factors must pass for the co-signer to approve a transfer."
                : "Choose what must pass before the co-signer approves a transfer."}
          </p>
          <div className="mt-3 space-y-2">
            {LAYER_META.map((m) => {
              const faceIdPending = m.key === "faceId" && !WEBAUTHN_NATIVE_READY;
              const on = layers[m.key];
              return (
                <div key={m.key}>
                  <LayerToggle
                    icon={<m.Icon size={18} />}
                    label={m.label}
                    desc={faceIdPending ? "Native module pending — see setup" : m.desc}
                    on={on}
                    locked={!editable || busy || savingPolicy || faceIdPending}
                    onToggle={() => toggle(m.key)}
                  />

                  {on && editable && (
                    <div className="ml-3 mt-1.5 rounded-2xl border border-border bg-base px-4 py-3">
                      {m.key === "faceId" && (
                        <p className="text-xs text-muted">
                          A passkey is registered when you create the vault — approve on
                          your device (or phone) at that step.
                        </p>
                      )}
                      {m.key === "usb" && (
                        <UsbPicker
                          loading={layerBusy === "usb"}
                          list={usbList}
                          value={usbId}
                          onChange={setUsbId}
                        />
                      )}
                      {m.key === "bluetooth" && (
                        <BtPicker
                          loading={layerBusy === "bluetooth"}
                          list={btList}
                          value={btId}
                          onChange={setBtId}
                        />
                      )}
                      {m.key === "geo" && (
                        <GeoPicker
                          loading={layerBusy === "geo"}
                          pos={geoPos}
                          radius={geoRadius}
                          onRadius={setGeoRadius}
                          onRecapture={async () => {
                            setLayerBusy("geo");
                            setError("");
                            try {
                              setGeoPos(await getLocation());
                            } catch (e) {
                              setError(String(e instanceof Error ? e.message : e));
                            } finally {
                              setLayerBusy("");
                            }
                          }}
                        />
                      )}
                    </div>
                  )}

                  {on && deployed && !editing && deployedConfig && (
                    <p className="ml-3 mt-1 text-xs text-muted">
                      {registeredCaption(m.key, deployedConfig)}
                    </p>
                  )}
                </div>
              );
            })}
            <div>
              <LayerToggle
                icon={<VoiceIcon size={18} />}
                label="Voice"
                desc="Voice recognition"
                on={false}
                locked
                onToggle={() => {}}
                comingSoon
              />
            </div>
          </div>
        </div>

        {address && (
          <div className="mt-4 rounded-2xl border border-border bg-base px-4 py-3">
            <p className="text-xs text-muted">Vault address</p>
            <p className="mt-0.5 break-all font-mono text-sm">{address}</p>
          </div>
        )}

        {!deployed && (
          <button
            onClick={deploy}
            disabled={busy}
            className="mt-5 w-full rounded-pill bg-accent px-6 py-3 text-sm font-semibold text-base transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-50"
          >
            {busy ? VAULT_PHASE_LABEL[phase!] : "Create vault"}
          </button>
        )}

        {busy && deployed === false && (
          <p className="mt-3 text-center text-xs text-muted">
            This deploys the Safe and is paid for from this wallet.
          </p>
        )}
      </div>

      {error && (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

function LayerToggle({
  icon,
  label,
  desc,
  on,
  locked,
  onToggle,
  comingSoon,
}: {
  icon: ReactNode;
  label: string;
  desc: string;
  on: boolean;
  locked: boolean;
  onToggle: () => void;
  comingSoon?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={locked || comingSoon ? undefined : onToggle}
      disabled={locked || comingSoon}
      className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors ${
        on ? "border-accent/50 bg-accent/5" : "border-border bg-base"
      } ${locked || comingSoon ? "cursor-default" : "hover:border-accent/40"} ${
        comingSoon ? "opacity-60" : ""
      }`}
    >
      <span className={`shrink-0 ${on ? "text-accent" : "text-muted"}`}>{icon}</span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        <p className="truncate text-xs text-muted">{desc}</p>
      </div>
      {comingSoon ? (
        <span className="ml-auto shrink-0 rounded-full border border-border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
          Soon
        </span>
      ) : (
        <span
          className={`ml-auto flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors ${
            on ? "bg-accent" : "bg-surface-2"
          }`}
        >
          <span
            className={`h-5 w-5 rounded-full bg-white transition-transform ${
              on ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </span>
      )}
    </button>
  );
}

function registeredCaption(key: keyof VaultLayers, cfg: VaultPolicyConfig): string {
  switch (key) {
    case "faceId":
      return "Passkey registered";
    case "usb":
      return `Registered USB · ${cfg.usbDeviceId ?? "—"}`;
    case "bluetooth":
      return `Registered device · ${cfg.bluetoothId ?? "—"}`;
    case "geo":
      return cfg.geofence ? `Geo-fence · ${cfg.geofence.radiusM} m radius` : "Location required";
  }
}

const pickerSelect =
  "mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent";

function UsbPicker({
  loading,
  list,
  value,
  onChange,
}: {
  loading: boolean;
  list: UsbDevice[];
  value: string;
  onChange: (v: string) => void;
}) {
  if (loading) return <p className="text-xs text-muted">Reading USB devices…</p>;
  if (list.length === 0)
    return <p className="text-xs text-muted">No USB devices detected. Plug one in and re-toggle.</p>;
  return (
    <>
      <label className="text-xs text-muted">Which USB device must be present?</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={pickerSelect}>
        {list.map((d) => (
          <option key={d.id} value={d.id}>
            {d.product} · {d.kind}
            {d.serial ? "" : " (no serial)"}
          </option>
        ))}
      </select>
    </>
  );
}

function BtPicker({
  loading,
  list,
  value,
  onChange,
}: {
  loading: boolean;
  list: BtDevice[];
  value: string;
  onChange: (v: string) => void;
}) {
  if (loading) return <p className="text-xs text-muted">Reading Bluetooth devices…</p>;
  if (list.length === 0)
    return (
      <p className="text-xs text-muted">
        No paired Bluetooth devices found. Pair one in Windows, then re-toggle.
      </p>
    );
  return (
    <>
      <label className="text-xs text-muted">Which Bluetooth device must be nearby?</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={pickerSelect}>
        {list.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
            {d.connected ? " · connected" : " · paired"}
          </option>
        ))}
      </select>
      <p className="mt-1.5 text-[11px] text-muted">
        Counted present only while the device is connected.
      </p>
    </>
  );
}

function GeoPicker({
  loading,
  pos,
  radius,
  onRadius,
  onRecapture,
}: {
  loading: boolean;
  pos: GeoPos | null;
  radius: number;
  onRadius: (n: number) => void;
  onRecapture: () => void;
}) {
  if (loading) return <p className="text-xs text-muted">Reading location…</p>;
  if (!pos)
    return (
      <div>
        <p className="text-xs text-muted">
          Couldn't read location. Enable location access for desktop apps in Windows
          Settings.
        </p>
        <button
          onClick={onRecapture}
          className="mt-2 rounded-pill border border-border px-3 py-1.5 text-xs font-semibold text-muted hover:text-fg"
        >
          Try again
        </button>
      </div>
    );
  return (
    <>
      <p className="text-xs text-muted">
        Approved location · {pos.lat.toFixed(4)}, {pos.lng.toFixed(4)}
        {pos.accuracy_m ? ` (±${Math.round(pos.accuracy_m)} m)` : ""}
      </p>
      <label className="mt-2 block text-xs text-muted">Allowed radius (meters)</label>
      <input
        value={radius}
        onChange={(e) => onRadius(Number(e.target.value.replace(/[^0-9]/g, "")) || 0)}
        className={pickerSelect}
      />
      <button
        onClick={onRecapture}
        className="mt-2 rounded-pill border border-border px-3 py-1.5 text-xs font-semibold text-muted hover:text-fg"
      >
        Re-capture here
      </button>
    </>
  );
}

function OwnerRow({
  label,
  address,
  tag,
}: {
  label: string;
  address: string;
  tag: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-base px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        <p className="truncate font-mono text-xs text-muted">{shortAddress(address)}</p>
      </div>
      <span className="ml-auto shrink-0 rounded-pill bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-muted">
        {tag}
      </span>
    </div>
  );
}

const BROWSER_HOME = "https://www.google.com";

function BrowserIconBtn({
  onClick,
  label,
  title,
}: {
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      {label}
    </button>
  );
}

interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url || "New tab";
  }
}

function faviconUrl(url: string): string | null {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`;
  } catch {
    return null;
  }
}

/**
 * Embedded Chrome-style multi-tab browser. Each tab is a native child webview
 * (managed in Rust) floated over the region below; this component is the chrome
 * (tab strip + compact address bar) and keeps the active tab's bounds in sync.
 */
const FIRST_TAB: BrowserTab = {
  id: "t1",
  url: BROWSER_HOME,
  title: hostLabel(BROWSER_HOME),
};

export function BrowserView({ visible = true }: { visible?: boolean } = {}) {
  const holder = useRef<HTMLDivElement>(null);
  const counter = useRef(1); // t1 is the initial tab
  const [tabs, setTabs] = useState<BrowserTab[]>([FIRST_TAB]);
  const [activeId, setActiveId] = useState(FIRST_TAB.id);
  const [addr, setAddr] = useState(FIRST_TAB.url);
  const [error, setError] = useState("");

  const activeRef = useRef("");
  activeRef.current = activeId;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const fail = (e: unknown) => setError(String(e instanceof Error ? e.message : e));
  const rect = () => holder.current?.getBoundingClientRect() ?? null;

  const showActive = useCallback(() => {
    if (!visibleRef.current) return;
    const r = rect();
    const id = activeRef.current;
    if (r && id) browserActivate(id, r.left, r.top, r.width, r.height).catch(() => {});
  }, []);

  const openTab = useCallback((url = BROWSER_HOME) => {
    const id = `t${++counter.current}`;
    const r = rect();
    setTabs((t) => [...t, { id, url, title: hostLabel(url) }]);
    setActiveId(id);
    setAddr(url);
    setError("");
    if (r) browserOpen(id, url, r.left, r.top, r.width, r.height).then(() => {
      if (!visibleRef.current) return browserHideAll();
    }).catch(fail);
  }, []);

  function selectTab(id: string) {
    const t = tabs.find((x) => x.id === id);
    setActiveId(id);
    if (t) setAddr(t.url);
  }

  function closeTab(id: string) {
    browserClose(id).catch(() => {});
    setTabs((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      const next = prev.filter((x) => x.id !== id);
      if (id === activeRef.current) {
        const neighbor = next[idx] ?? next[idx - 1];
        if (neighbor) {
          setActiveId(neighbor.id);
          setAddr(neighbor.url);
        } else {
          setActiveId("");
        }
      }
      return next;
    });
  }

  function go(url?: string) {
    const target = url ?? addr;
    setAddr(target);
    setError("");
    if (!activeId) {
      openTab(target);
      return;
    }
    browserNavigate(activeId, target).catch(fail);
    setTabs((t) => t.map((x) => (x.id === activeId ? { ...x, url: target } : x)));
  }

  // Mount: open the initial tab's webview (idempotent by id, so StrictMode's
  // double-invoke can't spawn a second tab) + listeners.
  useEffect(() => {
    const r = rect();
    if (r) browserOpen(FIRST_TAB.id, FIRST_TAB.url, r.left, r.top, r.width, r.height).then(() => {
      if (!visibleRef.current) return browserHideAll();
    }).catch(fail);
    const unlisten = onBrowserNavigated(({ id, url }) => {
      setTabs((t) => t.map((x) => (x.id === id ? { ...x, url, title: hostLabel(url) } : x)));
      if (id === activeRef.current) setAddr(url);
    });
    const ro = new ResizeObserver(showActive);
    if (holder.current) ro.observe(holder.current);
    window.addEventListener("resize", showActive);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", showActive);
      unlisten.then((f) => f());
      browserHideAll().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whenever the active tab changes, bring it to front.
  useEffect(() => {
    if (!visible) browserHideAll().catch(() => {});
    else if (activeId) showActive();
  }, [activeId, visible, showActive]);

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pt-2">
      {/* Tab strip */}
      <div className="flex items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <div
              key={t.id}
              onClick={() => selectTab(t.id)}
              className={`group flex h-8 max-w-44 shrink-0 cursor-pointer items-center gap-2 rounded-t-lg border-b-2 px-3 text-xs ${
                t.id === activeId
                  ? "border-accent bg-surface text-fg"
                  : "border-transparent text-muted hover:bg-surface/60 hover:text-fg"
              }`}
            >
              {faviconUrl(t.url) && (
                <img
                  src={faviconUrl(t.url)!}
                  alt=""
                  className="h-4 w-4 shrink-0 rounded-sm"
                  onError={(e) => {
                    e.currentTarget.style.visibility = "hidden";
                  }}
                />
              )}
              <span className="truncate">{t.title}</span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
                className="shrink-0 rounded-full px-1 text-muted opacity-0 hover:bg-surface-2 hover:text-fg group-hover:opacity-100"
              >
                ✕
              </span>
            </div>
          ))}
        </div>
        <BrowserIconBtn onClick={() => openTab()} label="+" title="New tab" />
      </div>

      {/* Compact toolbar */}
      <div className="mt-1 flex items-center gap-1">
        <BrowserIconBtn onClick={() => activeId && browserBack(activeId).catch(() => {})} label="‹" title="Back" />
        <BrowserIconBtn onClick={() => activeId && browserForward(activeId).catch(() => {})} label="›" title="Forward" />
        <BrowserIconBtn onClick={() => activeId && browserReload(activeId).catch(() => {})} label="⟳" title="Reload" />
        <input
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          spellCheck={false}
          placeholder="Search or enter address"
          className="min-w-0 flex-1 rounded-full border border-border bg-surface px-4 py-1.5 text-sm outline-none focus:border-accent"
        />
      </div>
      </div>

      {/* The native browser webview floats over this region. */}
      <div className="relative mt-1.5 flex-1 overflow-hidden border-t border-border bg-base" ref={holder}>
        {error && (
          <div className="absolute inset-x-0 top-0 z-10 m-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-400">
            Browser error: {error}
          </div>
        )}
      </div>
    </div>
  );
}

function Settings({ wallet }: { wallet: DerivedWallet }) {
  return (
    <div className="mx-auto w-full max-w-lg space-y-4">
      <Row label="Wallet name" value={wallet.name} />
      <AddressRow address={wallet.address} />
      <Row label="HD path" value={`m/44'/60'/0'/0/${wallet.index}`} mono />

      <LayerDefaults />

      <p className="px-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">
        Backups & keys
      </p>
      <RevealSecret
        title="Recovery phrase"
        desc="Backs up every wallet derived from this seed."
        onReveal={(pw) => revealMnemonic(pw)}
      />
      <RevealSecret
        title="Private key"
        desc={`This wallet only (m/44'/60'/0'/0/${wallet.index}). Never share it.`}
        danger
        onReveal={(pw) => revealPrivateKey(pw, wallet.index)}
      />
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-border bg-surface px-5 py-4">
      <span className="text-sm text-muted">{label}</span>
      <span className={`text-sm ${mono ? "font-mono" : "font-medium"}`}>
        {value}
      </span>
    </div>
  );
}

function AddressRow({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-5 py-4">
      <span className="shrink-0 text-sm text-muted">Address</span>
      <span className="min-w-0 truncate font-mono text-sm">{address}</span>
      <div className="flex shrink-0 items-center gap-1">
        <button
          title="Copy"
          onClick={() => {
            navigator.clipboard.writeText(address).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
          className="rounded-lg px-2 py-1 text-xs font-semibold text-muted hover:bg-surface-2 hover:text-fg"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          title="View on Explorer"
          onClick={() => openExternal(`${byKey("base").explorer.address}${address}`)}
          className="rounded-lg px-2 py-1 text-xs font-semibold text-muted hover:bg-surface-2 hover:text-fg"
        >
          Explorer
        </button>
      </div>
    </div>
  );
}

function openExternal(url: string) {
  import("@tauri-apps/plugin-opener")
    .then((m) => m.openUrl(url))
    .catch(() => {});
}

function LayerDefaults() {
  const [layers, setLayers] = useState<VaultLayers>(getDefaultLayers);
  function toggle(key: keyof VaultLayers) {
    setLayers((l) => {
      const next = { ...l, [key]: !l[key] };
      setDefaultLayers(next);
      return next;
    });
  }
  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <p className="font-semibold">Default security layers</p>
      <p className="text-xs text-muted">
        Pre-selected when you create a vault. The co-signer enforces these on every
        transfer.
      </p>
      <div className="mt-3 space-y-2">
        {LAYER_META.map((m) => (
          <button
            key={m.key}
            onClick={() => toggle(m.key)}
            className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
              layers[m.key] ? "border-accent/50 bg-accent/5" : "border-border bg-base hover:border-muted"
            }`}
          >
            <span className={`shrink-0 ${layers[m.key] ? "text-accent" : "text-muted"}`}>
              <m.Icon size={18} />
            </span>
            <span className="flex-1 text-sm font-medium">{m.label}</span>
            <span
              className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
                layers[m.key] ? "bg-accent" : "bg-surface-2"
              }`}
            >
              <span
                className={`h-4 w-4 rounded-full bg-white transition-transform ${
                  layers[m.key] ? "translate-x-4" : ""
                }`}
              />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Password-gated reveal for sensitive secrets (phrase / private key). */
function RevealSecret({
  title,
  desc,
  danger,
  onReveal,
}: {
  title: string;
  desc: string;
  danger?: boolean;
  onReveal: (password: string) => Promise<string>;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [prompting, setPrompting] = useState(false);
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function reveal() {
    if (!pw || busy) return;
    setBusy(true);
    setError("");
    try {
      setValue(await onReveal(pw));
      setPrompting(false);
      setPw("");
    } catch (e) {
      setError(String(e).includes("invalid password") ? "Wrong password." : String(e));
    } finally {
      setBusy(false);
    }
  }

  function hide() {
    setValue(null);
    setPrompting(false);
    setPw("");
    setError("");
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{title}</p>
          <p className="text-xs text-muted">{desc}</p>
        </div>
        <button
          onClick={() => (value || prompting ? hide() : setPrompting(true))}
          className="shrink-0 rounded-pill border border-border bg-surface-2 px-4 py-2 text-sm font-semibold transition-colors hover:brightness-110"
        >
          {value || prompting ? "Hide" : "Reveal"}
        </button>
      </div>

      {prompting && !value && (
        <div className="mt-4">
          <p className="mb-2 text-xs text-muted">Confirm your password to reveal.</p>
          <div className="flex gap-2">
            <input
              type="password"
              autoFocus
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && reveal()}
              placeholder="Password"
              className="flex-1 rounded-xl border border-border bg-base px-4 py-2.5 text-sm text-fg outline-none focus:border-accent"
            />
            <button
              disabled={!pw || busy}
              onClick={reveal}
              className="rounded-pill bg-accent px-4 py-2.5 text-sm font-semibold text-base disabled:opacity-40"
            >
              {busy ? "…" : "Confirm"}
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-pink">{error}</p>}
        </div>
      )}

      {value && (
        <div className={`mt-4 rounded-xl border bg-base px-4 py-3 ${danger ? "border-pink/40" : "border-border"}`}>
          {danger && (
            <p className="mb-2 text-xs font-semibold text-pink">
              Anyone with this can drain this wallet. Never paste it anywhere.
            </p>
          )}
          <p className="break-all font-mono text-sm leading-relaxed">{value}</p>
          <button
            onClick={() => {
              navigator.clipboard.writeText(value).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
            className="mt-3 rounded-pill border border-border px-3 py-1.5 text-xs font-semibold text-muted hover:text-fg"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- Shared ---------- */

function DataHint() {
  return (
    <p className="mt-4 rounded-xl border border-border bg-surface-2 px-4 py-2.5 text-xs text-muted">
      Live balances are off — add an Alchemy key to the backend to load them.
      Prices are live.
    </p>
  );
}

function EmptyState({
  icon,
  title,
  body,
  cta,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  cta?: string;
}) {
  return (
    <section className="mt-6 flex flex-col items-center justify-center rounded-3xl border border-border bg-surface px-6 py-20 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-surface-2 text-muted">
        {icon}
      </div>
      <h3 className="mt-5 text-lg font-bold">{title}</h3>
      <p className="mt-2 max-w-sm text-sm text-muted">{body}</p>
      {cta && (
        <button className="mt-6 rounded-pill bg-accent px-7 py-3 text-sm font-semibold text-base transition-transform hover:scale-[1.02] active:scale-95">
          {cta}
        </button>
      )}
    </section>
  );
}

function ActionButton({
  children,
  primary,
  onClick,
}: {
  children: ReactNode;
  primary?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-pill px-5 py-3 text-sm font-semibold backdrop-blur transition-transform hover:scale-[1.02] active:scale-95 ${
        primary
          ? "bg-white text-black hover:brightness-95"
          : "bg-white/15 text-white hover:bg-white/25"
      }`}
    >
      {children}
    </button>
  );
}

function SwapRail({
  onHide,
  chain,
  from,
  accountIndex,
  tokens,
  vault,
}: {
  onHide: () => void;
  chain: SwapChain;
  from: `0x${string}`;
  accountIndex: number;
  tokens: PortfolioToken[];
  vault?: SwapVault;
}) {
  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">{vault ? "Swap (vault)" : "Swap"}</h2>
        <button
          onClick={onHide}
          title="Hide swap panel"
          className="flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          ✕
        </button>
      </div>
      <div className="mt-5">
        <SwapForm
          chain={chain}
          from={from}
          accountIndex={accountIndex}
          tokens={tokens}
          vault={vault}
        />
      </div>
    </>
  );
}

function trim(s: string): string {
  const n = Number(s);
  if (!isFinite(n)) return s;
  if (n === 0) return "0";
  if (n < 0.0001) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
