// The wallet shell (docs/UI_ARGUS_PARITY.md 5, 6.1-6.5): sidebar and topbar on desktop,
// topbar and bottom tabs when narrow, the account pill and sheet, and the page slots.
// Screens come from shell/screens.ts, the one wiring module; this file owns layout,
// navigation, preferences and the sheets the Wallet screen opens.
// Legacy shell styles first, so the shell's and the screens' own styles (imported by the
// modules below) follow them; tokens and shared components come in through ./ui.
import "./desktop.css";
import "./cinematic.css";
import "./observatory.css";
import "./wallet-ui.css";
import "./mobile.css";
import "./shell/shell.css";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSolaresWallet } from "./wallet";
import type { WalletChain } from "./wallet/types";
import { CelestialScene } from "./CelestialScene";
import {
  ActivityScreen,
  PairedVaultSummaryProvider,
  ProtectionScreen,
  ReceiveScreen,
  SendScreen,
  SettingsScreen,
  SwapScreen,
  VaultScreen,
  usePairedVaultSummary,
} from "./shell/screens";
import { pageHash, parseRoute, settledHash, viewHash, type AccountView, type Page, type Route } from "./shell/routes";
import { Sidebar, desktopLabel } from "./shell/Sidebar";
import { Topbar } from "./shell/Topbar";
import { BottomTabs, narrowLabel } from "./shell/BottomTabs";
import { AccountPill } from "./shell/AccountPill";
import { AccountSheet } from "./shell/AccountSheet";
import { networkAfterSelect, pillModel, signerLabel } from "./shell/accountModel";
import { AccountBar, WalletHome } from "./home/WalletHome";
import { defaultScope, type AssetKind, type NetworkScope, type TokenDetailModel } from "./home/homeModel";
import { ToastProvider, useToast } from "./ui";

const NARROW_QUERY = "(max-width: 640px), (max-height: 500px) and (pointer: coarse)";

function readPreference(key: string, fallback: boolean) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

export default function DesktopWallet() {
  return (
    <ToastProvider>
      <PairedVaultSummaryProvider>
        <WalletShell />
      </PairedVaultSummaryProvider>
    </ToastProvider>
  );
}

type SendRequest = { chain: WalletChain; asset?: AssetKind; trigger: HTMLElement | null };
type ReceiveRequest = { chain: WalletChain; asset?: AssetKind; side?: "wallet" | "vault"; trigger?: HTMLElement | null };

function WalletShell() {
  const wallet = useSolaresWallet();
  const toast = useToast();
  const vaultSummary = usePairedVaultSummary();
  const initialRoute = useRef<Route>(parseRoute(window.location.hash));
  const [page, setPage] = useState<Page>(initialRoute.current.page);
  const [accountView, setAccountView] = useState<AccountView>(initialRoute.current.view);
  const [settingsSection, setSettingsSection] = useState<"address-book" | undefined>(initialRoute.current.panel === "addressbook" ? "address-book" : undefined);
  // null until a network is chosen: Solana by default, or every network for an account with only an EVM wallet.
  const [networkChoice, setNetwork] = useState<NetworkScope | null>(null);
  const evmOnlyAccount = wallet.ready && wallet.authenticated && !wallet.addresses.solana && !!wallet.addresses.ethereum;
  const network: NetworkScope = networkChoice ?? defaultScope(evmOnlyAccount);
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  const [navExpanded, setNavExpanded] = useState(() => window.matchMedia(NARROW_QUERY).matches ? false : readPreference("solares.desktop.nav", true));
  const [privacy, setPrivacy] = useState(() => readPreference("solares-balance-privacy", false));
  const [motion, setMotion] = useState(() => readPreference("aethra.motion", true));
  const [windowVisible, setWindowVisible] = useState(() => !document.hidden);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [receive, setReceive] = useState<ReceiveRequest | null>(null);
  const [send, setSend] = useState<SendRequest | null>(null);
  const [swapPrefill, setSwapPrefill] = useState<TokenDetailModel["swap"]>({});
  const contentRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const closeReceive = useCallback(() => setReceive(null), []);
  const closeAccounts = useCallback(() => setAccountsOpen(false), []);
  const closeSend = useCallback(() => setSend(null), []);
  // Solana is the primary wallet: "All networks" shows it unless the account has only an EVM wallet.
  const solanaView = network === "solana" || (network === "all" && !(wallet.authenticated && !wallet.addresses.solana && wallet.addresses.ethereum));
  const currentAddress = wallet.authenticated ? (solanaView ? wallet.addresses.solana : wallet.addresses.ethereum) : null;
  const selectedNetwork: WalletChain = network === "all" ? "solana" : network;
  // Receive and Send are Sheets, which make the rest of <body> inert; the shell also marks
  // itself inert while one is open (6.1 "a modal open"), as it always has.
  const modalOpen = !!receive || !!send;

  // Opens what a route asks for: its page and side, and the one-shot Receive or Send sheet.
  const applyRoute = useCallback((route: Route) => {
    setPage(route.page);
    if (route.page === "Portfolio") setAccountView(route.view);
    setSettingsSection(route.panel === "addressbook" ? "address-book" : undefined);
    if (route.panel === "receive") setReceive({ chain: "solana" });
    if (route.panel === "send") setSend({ chain: "solana", trigger: null });
    const settled = settledHash(route);
    if (settled) history.replaceState(history.state, "", settled);
  }, []);
  useEffect(() => { applyRoute(initialRoute.current); }, [applyRoute]);
  useEffect(() => {
    const handler = () => applyRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, [applyRoute]);
  useEffect(() => {
    // Follow the visible screen when a mobile keyboard opens. Do not fight pinch zoom.
    const viewport = window.visualViewport;
    const update = () => {
      if (viewport && viewport.scale !== 1) return;
      const height = viewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--wallet-viewport-height", `${height}px`);
      document.documentElement.dataset.walletKeyboard = window.innerHeight - height > 150 ? "open" : "closed";
    };
    update();
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      document.documentElement.style.removeProperty("--wallet-viewport-height");
      delete document.documentElement.dataset.walletKeyboard;
    };
  }, []);
  useEffect(() => {
    const update = () => setWindowVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const update = () => {
      setNarrow(media.matches);
      setNavExpanded(media.matches ? false : readPreference("solares.desktop.nav", true));
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  // Sheets and toasts render outside the shell: mirror the in-app motion switch onto <html> (4.3).
  useEffect(() => {
    document.documentElement.dataset.motion = motion ? "on" : "off";
    return () => { delete document.documentElement.dataset.motion; };
  }, [motion]);
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [page]);
  useEffect(() => {
    try {
      if (!narrow) localStorage.setItem("solares.desktop.nav", String(navExpanded));
      localStorage.setItem("solares-balance-privacy", String(privacy));
      localStorage.setItem("aethra.motion", String(motion));
    } catch {
      /* Preferences remain active for this session. */
    }
  }, [navExpanded, privacy, narrow, motion]);

  function navigate(next: Page) {
    setPage(next);
    if (next === "Portfolio") setAccountView("wallet");
    setSettingsSection(undefined);
    setSwapPrefill({});
    window.location.hash = pageHash(next);
    if (narrow) setNavExpanded(false);
  }
  function openView(view: AccountView, focus = false) {
    setPage("Portfolio");
    setAccountView(view);
    window.location.hash = viewHash(view).slice(1);
    if (focus) requestAnimationFrame(() => document.getElementById(`account-tab-${view}`)?.focus());
  }
  /** The Vault side with one of its panels focused (5.4: `#vaultdeposit`, `#vaultlayers`, …). */
  function openVaultPanel(hash: "vaultdeposit" | "vaultlayers") {
    setPage("Portfolio");
    setAccountView("vault");
    window.location.hash = hash;
  }
  function openSwap(prefill: TokenDetailModel["swap"] = {}) {
    navigate("Swap");
    setSwapPrefill(prefill);
  }
  function signIn() {
    setAccountsOpen(false);
    if (!wallet.configured) {
      navigate("Settings");
      toast.show(wallet.configError || "Sign-in is being set up. Please try again later.");
    } else wallet.login();
  }
  async function logout() {
    try {
      await wallet.logout();
      setAccountsOpen(false);
    } catch {
      toast.show("Unable to sign out. Please try again.");
    }
  }

  const pill = pillModel({
    authenticated: wallet.authenticated,
    configured: wallet.configured,
    address: currentAddress,
    name: signerLabel(solanaView ? wallet.solanaSigners : wallet.evmSigners, currentAddress, solanaView ? "solana" : "evm"),
    solanaView,
  });
  const mainPage = page === "Portfolio";
  const vaultSide = mainPage && accountView === "vault";
  // "Vault" is a primary destination (the Vault side of the Wallet screen), so it titles the page too.
  const title = vaultSide ? "Vault" : narrow ? narrowLabel(page) : desktopLabel(page);

  function walletScreen() {
    return (
      <>
        <AccountBar
          view={accountView}
          onView={openView}
          address={currentAddress}
          vaultNetwork={selectedNetwork}
          onVaultNetwork={setNetwork}
        />
        <div id="wallet-account-panel" role="tabpanel" aria-labelledby={`account-tab-${accountView}`}>
          {accountView === "vault" ? (
            <VaultScreen
              key={`${wallet.userId}:${currentAddress}:${network}`}
              chain={selectedNetwork}
              privacy={privacy}
              onPrivacy={() => setPrivacy(!privacy)}
              onSignIn={signIn}
              onWallet={() => navigate("Portfolio")}
              onSettings={() => navigate("Protection")}
              onReceive={() => setReceive({ chain: "solana", side: "vault" })}
              onFundWallet={() => setReceive({ chain: "solana", asset: "native", side: "wallet" })}
            />
          ) : (
            <WalletHome
              scope={network}
              onScope={setNetwork}
              currentAddress={currentAddress}
              solanaView={solanaView}
              privacy={privacy}
              onPrivacy={() => setPrivacy(!privacy)}
              narrow={narrow}
              onReceive={(chain, asset, trigger) => setReceive({ chain, asset, trigger: trigger ?? null })}
              onSend={(chain, asset, trigger) => setSend({ chain, asset, trigger: trigger ?? null })}
              onSwap={openSwap}
              onVault={() => openView("vault")}
              onPairedVault={() => {
                // "Your vault" is the paired Solana vault: an EVM scope switches back to Solana first.
                if (network !== "solana" && network !== "all") setNetwork("solana");
                openView("vault");
              }}
              onSignIn={signIn}
              onSeeActivity={() => navigate("Activity")}
              onOpenProtection={() => navigate("Protection")}
            />
          )}
        </div>
      </>
    );
  }

  return (
    <div className={`desktop-app shell-app ${navExpanded ? "desktop-nav-expanded" : ""}`} data-motion={motion ? "on" : "off"} data-window-hidden={!windowVisible} data-narrow={narrow || undefined}>
      <CelestialScene active={motion && windowVisible} />
      {!narrow && (
        <Sidebar
          page={page}
          vaultActive={vaultSide}
          onOpenVault={() => openView("vault")}
          expanded={navExpanded}
          inert={modalOpen}
          authenticated={wallet.authenticated}
          onNavigate={navigate}
          onSignIn={signIn}
          onSignOut={() => void logout()}
        />
      )}
      <div className="desktop-main shell-main" inert={modalOpen}>
        <Topbar
          title={title}
          narrow={narrow}
          navExpanded={navExpanded}
          onToggleNav={() => setNavExpanded(!navExpanded)}
          onSettingsGear={() => navigate(page === "Settings" ? "Portfolio" : "Settings")}
          onSettingsPage={page === "Settings"}
          pill={<AccountPill ref={pillRef} model={pill} authenticated={wallet.authenticated} vaultSide={vaultSide} onOpen={() => setAccountsOpen(true)} />}
        />
        <div className="desktop-body">
          <main
            key={page}
            ref={contentRef}
            className={`desktop-content shell-content ${mainPage ? "desktop-portfolio-content" : "desktop-secondary-content"}`}
            data-side={mainPage ? accountView : undefined}
          >
            <Suspense fallback={<Loading />}>
              {page === "Portfolio" ? (
                walletScreen()
              ) : page === "Protection" ? (
                <ProtectionScreen
                  configured={wallet.configured}
                  ready={wallet.ready}
                  authenticated={wallet.authenticated}
                  onConnect={signIn}
                  onVaults={() => openView("vault")}
                  onLayers={() => openVaultPanel("vaultlayers")}
                />
              ) : page === "Swap" ? (
                <div className="desktop-workspace desktop-swap-workspace">
                  <SwapScreen {...swapPrefill} />
                </div>
              ) : page === "Activity" ? (
                <ActivityScreen privacy={privacy} onConnect={signIn} onSwap={() => navigate("Swap")} />
              ) : (
                <SettingsScreen
                  isMobile={narrow}
                  privacy={privacy}
                  onPrivacy={setPrivacy}
                  motion={motion}
                  onMotion={setMotion}
                  navExpanded={navExpanded}
                  onNavExpanded={setNavExpanded}
                  section={settingsSection}
                  onNavigate={hash => { window.location.hash = hash; }}
                  onSignIn={signIn}
                  onOpenAccounts={() => setAccountsOpen(true)}
                />
              )}
            </Suspense>
          </main>
        </div>
        {narrow && <BottomTabs page={page} vaultActive={vaultSide} onNavigate={navigate} onOpenVault={() => openView("vault")} />}
      </div>
      {accountsOpen && (
        <AccountSheet
          onClose={closeAccounts}
          returnFocusTo={pillRef.current}
          onSelect={family => setNetwork(networkAfterSelect(family, network))}
          onOpenVault={() => openView("vault")}
          onSignIn={signIn}
          onSignOut={() => void logout()}
          onSettings={() => navigate("Settings")}
          onAddressBook={() => { window.location.hash = "addressbook"; }}
        />
      )}
      {receive && (
        <ReceiveScreen
          initialChain={receive.chain}
          initialAsset={receive.asset}
          side={receive.side}
          returnFocusTo={receive.trigger}
          vaultSummary={vaultSummary}
          onClose={closeReceive}
          onSignIn={signIn}
        />
      )}
      {send && (
        <Suspense fallback={<div className="desktop-modal-backdrop"><Loading /></div>}>
          <SendScreen
            initialChain={send.chain}
            initialAsset={send.asset}
            returnFocusTo={send.trigger}
            vaultSummary={vaultSummary}
            onClose={closeSend}
            onReceive={chain => { setSend(null); setReceive({ chain }); }}
            onOpenVaultDeposit={() => {
              // 8.6: close Send and open the vault's Deposit (#vaultdeposit, read by the Vault side).
              setSend(null);
              openVaultPanel("vaultdeposit");
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="desktop-loading shell-loading" role="status">
      <p>Loading workspace…</p>
    </div>
  );
}
