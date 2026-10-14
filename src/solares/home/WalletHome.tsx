// The Wallet screen, Wallet side (docs/UI_ARGUS_PARITY.md 6.2, 6.4, 6.5), laid out after the
// owner's Solflare reference (2026-10-13):
//   main column   the balance card with Receive / Send / Swap / Vault inside it, then the
//                 Assets card (Tokens | Activity)
//   right column  "Your vault" (create, progress, balance) and the Swap entry, when the
//                 content is wide enough (a container query in home.css)
// Narrow and medium widths are one column: balance card, Your vault, Assets.
// Also the account bar shared with the Vault side.
import { useEffect, useRef, useState } from 'react';
import { EmptyState, Icon, shortAddress, type IconName } from '../ui';
import { useSolaresWallet } from '../wallet';
import { usePrices } from '../wallet/usePrices';
import { byKey } from '../networks';
import { ExternalLink } from '../../platform/ExternalLink';
import type { WalletChain } from '../wallet/types';
import { useActivityItems } from '../shell/screens';
import { BalanceHero } from './BalanceHero';
import { ActionRow } from './ActionRow';
import { HomeTabs, useHomeTab } from './HomeTabs';
import { TokenList, TokenSkeleton } from './TokenList';
import { SignInWelcome } from './SignInWelcome';
import { TokenDetail } from './TokenDetail';
import { VaultCard } from './VaultCard';
import { SwapCard } from './SwapCard';
import {
  accountExplorerUrl, addressFor, emptyTokensCopy, heroExplorer, heroModel, homeNetworks, isNetworkScope, maskAmount, networkOptions, priceLine, tokenRows, tokenUsd,
  type AssetKind, type NetworkScope, type TokenDetailModel, type TokenRow,
} from './homeModel';
import './home.css';

// ---------- Account bar (both sides) ----------

export interface AccountBarProps {
  view: 'wallet' | 'vault';
  onView: (view: 'wallet' | 'vault', focus?: boolean) => void;
  /** The selected wallet's address (shown short), or null for the neutral line. */
  address: string | null;
  vaultNetwork: WalletChain;
  onVaultNetwork: (chain: WalletChain) => void;
}

/**
 * The Wallet/Vault segmented control (Arrow, Home and End keys), the address context and,
 * on the Vault side, the "Vault network" select (Solana default). Asserted: tabs "Wallet"
 * and "Vault", select "Vault network", tab panel `#wallet-account-panel`.
 */
export function AccountBar({ view, onView, address, vaultNetwork, onVaultNetwork }: AccountBarProps) {
  return (
    <div className="wallet-account-bar home-account-bar">
      <div className="wallet-account-switch home-switch" role="tablist" aria-label="Wallet account">
        {(['wallet', 'vault'] as const).map(item => (
          <button
            key={item}
            id={`account-tab-${item}`}
            type="button"
            role="tab"
            aria-selected={view === item}
            aria-controls="wallet-account-panel"
            tabIndex={view === item ? 0 : -1}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 'wallet' : event.key === 'End' ? 'vault' : view === 'wallet' ? 'vault' : 'wallet';
              onView(next, true);
            }}
            onClick={() => onView(item)}
          >
            <Icon name={item === 'vault' ? 'vault' : 'portfolio'} size={16} />
            {item === 'wallet' ? 'Wallet' : 'Vault'}
          </button>
        ))}
      </div>
      <span className="home-account-context ui-visually-hidden" data-address={address ? "" : undefined}>{address ? shortAddress(address) : "Your wallet, all in one place"}</span>
      {view === 'vault' && (
        <select className="home-select" aria-label="Vault network" value={vaultNetwork} onChange={event => onVaultNetwork(event.target.value as WalletChain)}>
          {homeNetworks().map(item => <option key={item.key} value={item.key}>{item.name}</option>)}
        </select>
      )}
    </div>
  );
}

// ---------- Activity tab ----------

const ACTIVITY_ICONS: Record<string, IconName> = { Sent: 'up', Swap: 'swap', Vault: 'vault' };

/** The fields the home reads from an activity item (8.4 ActivityItem). */
interface HomeActivityItem { key: string; kind: string; title: string; description: string; amount: string; timestamp: number; explorer?: string }

function HomeActivity({ privacy, signedOut, onSignIn, onReceive, onSeeAll }: { privacy: boolean; signedOut: boolean; onSignIn: () => void; onReceive: () => void; onSeeAll: () => void }) {
  // `loading` is optional: a hook that does not report it is read as loaded.
  const { items, error, loading }: { items: readonly HomeActivityItem[]; error: string; loading?: boolean } = useActivityItems(5);
  if (signedOut) {
    return (
      <EmptyState
        className="home-empty"
        title="Your activity, in one place"
        text="Sign in to see transfers and routes initiated on this device."
        action={<button type="button" className="ui-btn-primary" onClick={onSignIn}>Sign in</button>}
      />
    );
  }
  return (
    <div className="home-activity">
      {error && <p className="ui-alert home-inline-alert" role="alert">{error}</p>}
      {items.length ? (
        <ul className="home-activity-list">
          {items.map(item => (
            <li key={item.key} className="home-activity-row" data-activity-row={item.kind}>
              <span className="home-activity-icon" aria-hidden="true"><Icon name={ACTIVITY_ICONS[item.kind] ?? 'activity'} size={18} /></span>
              <span className="home-activity-text">
                <strong>{item.title}</strong>
                <small>{item.description} · {new Date(item.timestamp).toLocaleDateString()}</small>
              </span>
              <strong className="home-activity-amount">{maskAmount(item.amount, privacy)}</strong>
              {item.explorer && (
                <ExternalLink className="ui-icon-btn home-activity-link" href={item.explorer} aria-label="View transaction or account on explorer">
                  <Icon name="external" size={16} />
                </ExternalLink>
              )}
            </li>
          ))}
        </ul>
      ) : loading ? (
        <p className="home-activity-loading" role="status">Reading activity on this device…</p>
      ) : !error && (
        <EmptyState
          className="home-empty"
          title="No activity yet"
          text="Your transfers and swaps made here will appear on this device."
          action={<button type="button" className="ui-btn" onClick={onReceive}>Receive</button>}
        />
      )}
      <div className="home-activity-foot">
        <button type="button" className="ui-btn-text" onClick={onSeeAll}>See all activity <Icon name="arrow" size={15} /></button>
      </div>
    </div>
  );
}

// ---------- Wallet side ----------

export interface WalletHomeProps {
  scope: NetworkScope;
  onScope: (scope: NetworkScope) => void;
  /** The address the hero shows: Solana unless the account is EVM-only or an EVM network is selected. */
  currentAddress: string | null;
  solanaView: boolean;
  privacy: boolean;
  onPrivacy: () => void;
  narrow: boolean;
  onReceive: (chain: WalletChain, asset?: AssetKind, trigger?: HTMLElement | null) => void;
  onSend: (chain: WalletChain, asset?: AssetKind, trigger?: HTMLElement | null) => void;
  onSwap: (prefill?: TokenDetailModel['swap']) => void;
  onVault: () => void;
  /** The "Your vault" card: the paired Solana vault (switches an EVM scope back to Solana). Defaults to onVault. */
  onPairedVault?: () => void;
  onSignIn: () => void;
  onSeeActivity: () => void;
  onOpenProtection: () => void;
}

export function WalletHome(props: WalletHomeProps) {
  const { scope, onScope, currentAddress, solanaView, privacy, onPrivacy, narrow } = props;
  const wallet = useSolaresWallet();
  const signedOut = !wallet.authenticated;
  const [search, setSearch] = useState('');
  const [tab, setTab] = useHomeTab();
  const [detail, setDetail] = useState<{ chain: WalletChain; kind: AssetKind; trigger: HTMLElement | null } | null>(null);
  const restoreRow = useRef<string | null>(null);
  const selectedChain: WalletChain = scope === 'all' ? 'solana' : scope;
  // USD prices (Relay, through ANTARA's API) for the total, the rows and token detail; read only while signed in.
  const prices = usePrices(!signedOut);

  const hero = heroModel({
    authenticated: wallet.authenticated, ready: wallet.ready, scope, balances: wallet.balances,
    balancesLoading: wallet.balancesLoading, balancesError: wallet.balancesError, currentAddress, addresses: wallet.addresses, privacy, prices,
  });
  const rows = signedOut ? [] : tokenRows(wallet.balances, scope, search);
  const explorerChain = heroExplorer(scope, solanaView);
  const explorer = currentAddress ? { name: byKey(explorerChain).explorer.name, url: accountExplorerUrl(explorerChain, currentAddress) } : null;

  // Back from the desktop detail panel returns focus to the row that opened it.
  useEffect(() => {
    if (detail || !restoreRow.current) return;
    const id = restoreRow.current;
    restoreRow.current = null;
    document.querySelector<HTMLButtonElement>(`[data-token="${id}"] .home-token-open`)?.focus();
  }, [detail]);
  // A token whose network left the scope (or the account) closes its detail.
  useEffect(() => { if (signedOut) setDetail(null); }, [signedOut]);

  const openDetail = (row: TokenRow, trigger: HTMLButtonElement) => setDetail({ chain: row.chain, kind: row.kind, trigger });
  const closeDetail = () => {
    if (detail) restoreRow.current = `${detail.chain}-${detail.kind}`;
    setDetail(null);
  };
  const detailHolding = detail ? wallet.balances.find(balance => balance.chain === detail.chain && balance.isNative === (detail.kind === 'native')) ?? null : null;
  const detailView = detail && (
    <TokenDetail
      chain={detail.chain}
      kind={detail.kind}
      balance={detailHolding?.formatted ?? null}
      usd={detailHolding ? tokenUsd({ chain: detail.chain, kind: detail.kind, raw: detailHolding.raw, decimals: detailHolding.decimals }, prices) : null}
      price={priceLine(detail.chain, detail.kind, prices)}
      address={addressFor(detail.chain, wallet.addresses)}
      privacy={privacy}
      narrow={narrow}
      onClose={closeDetail}
      returnFocusTo={detail.trigger}
      onSend={(chain, kind) => { setDetail(null); props.onSend(chain, kind, null); }}
      onReceive={(chain, kind) => { setDetail(null); props.onReceive(chain, kind, null); }}
      onSwap={prefill => { setDetail(null); props.onSwap(prefill); }}
    />
  );
  // Desktop: the detail is a panel in place of the Wallet side. Narrow: a sheet over it.
  if (detailView && !narrow) return detailView;

  const empty = emptyTokensCopy({ loading: wallet.balancesLoading, error: !!wallet.balancesError, search, scope });
  const tokens = signedOut ? (
    <SignInWelcome configured={wallet.configured} ready={wallet.ready} onSignIn={props.onSignIn} />
  ) : rows.length ? (
    <TokenList rows={rows} privacy={privacy} prices={prices} onOpen={openDetail} />
  ) : (
    <div className="home-token-empty">
      <EmptyState className="home-empty" title={empty.title} text={empty.text} />
      {wallet.balancesLoading && <TokenSkeleton />}
    </div>
  );

  return (
    <>
      <div className="home-layout">
        <div className="home-grid">
          <div className="home-col-main">
            <BalanceHero hero={hero} signedOut={signedOut} privacy={privacy} onPrivacy={onPrivacy} address={currentAddress} explorer={explorer} onRetry={() => void wallet.refetchBalances()}>
              <ActionRow
                onReceive={trigger => props.onReceive(selectedChain, undefined, trigger)}
                onSend={trigger => props.onSend(selectedChain, undefined, trigger)}
                onSwap={() => props.onSwap()}
                onVault={props.onVault}
              />
            </BalanceHero>
            {(wallet.configError || (wallet.balancesError && !signedOut)) && (
              <div className="home-notices">
                {wallet.configError && <p className="ui-alert home-notice" role="alert">{wallet.configError}</p>}
                {wallet.balancesError && !signedOut && (
                  <p className="ui-alert home-notice" data-tone="warn" role="alert">
                    {wallet.balancesError}
                    {/* This tab's token belongs to another account (wallet/linkRecovery.ts): retrying cannot help, signing in again does. */}
                    {/* Privy's sign-out ends the session in this browser's shared storage, which is the other account's, in every tab. */}
                    {wallet.sessionChanged && wallet.signInAgain && <> <button type="button" className="ui-btn-text" onClick={wallet.signInAgain}>Sign in again</button> This also signs out the other account in this browser.</>}
                  </p>
                )}
              </div>
            )}
            <HomeTabs
              tab={tab}
              onTab={setTab}
              controls={(
                <>
                  <label className="home-search">
                    <Icon name="search" size={16} />
                    <input aria-label="Search tokens" placeholder="Search tokens" value={search} onChange={event => setSearch(event.target.value)} />
                  </label>
                  <select className="home-select" aria-label="Filter assets by network" value={scope} onChange={event => { if (isNetworkScope(event.target.value)) onScope(event.target.value); }}>
                    {networkOptions().map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <button type="button" className="ui-icon-btn home-refresh" title="Refresh balances" aria-label="Refresh balances" disabled={signedOut || wallet.balancesLoading} onClick={() => void wallet.refetchBalances()}>
                    <Icon name="refresh" size={17} />
                  </button>
                </>
              )}
              tokens={tokens}
              activity={<HomeActivity privacy={privacy} signedOut={signedOut} onSignIn={props.onSignIn} onReceive={() => props.onReceive(selectedChain)} onSeeAll={props.onSeeActivity} />}
            />
          </div>
          <div className="home-col-side">
            <VaultCard privacy={privacy} onOpenVault={props.onPairedVault ?? props.onVault} onOpenProtection={props.onOpenProtection} />
            <SwapCard chain={selectedChain} privacy={privacy} onSwap={props.onSwap} />
          </div>
        </div>
      </div>
      {detailView}
    </>
  );
}
