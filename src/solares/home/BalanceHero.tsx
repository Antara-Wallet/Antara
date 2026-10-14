// Balance card of the Wallet side (docs/UI_ARGUS_PARITY.md 6.4; ARGUS PWA home hero; the
// owner's Solflare reference). Top: the label ("Total balance"), and the address with copy and
// explorer. Then the total in US dollars with the privacy eye ("≈ $8.43", owner decision
// 2026-10-13), what the total leaves out, the meta line with the price source and time, and
// inside the card, the action row (Receive, Send, Swap, Vault).
// No change pill. Unknown (signed out, loading, failed) is a muted "0.00" with the reason as its
// accessible name and the meta line as caption, never "—"; a network that failed to load adds
// "Couldn't load · Retry" wired to the balance refresh. Without prices the headline is the
// largest holding as a token amount, never "$0" for funds held.
//
// Asserted by the browser specs: region "Wallet balance"; `.desktop-balance-top`
// holds only the label; `.desktop-balance-number` reads e.g. "≈ $8.43" or "0.00"
// and carries the reason as aria-label; "Hide balances" / "Show balances"; label
// "Other holdings"; `.home-notes`; `.desktop-balance-meta`; `.desktop-hero-art`; chips labelled
// "Supported networks" while signed out.
import type { ReactNode } from 'react';
import { AddressText, Icon } from '../ui';
import { TokenLogo } from '../TokenLogo';
import { ExternalLink } from '../../platform/ExternalLink';
import { MASK, UNKNOWN, homeNetworks, type HeroModel } from './homeModel';
import { LoadFailed, PlaceholderAmount } from '../wallet/BalancePlaceholder';
import type { WalletChain } from '../wallet/types';

export interface BalanceHeroProps {
  hero: HeroModel;
  signedOut: boolean;
  privacy: boolean;
  onPrivacy: () => void;
  address: string | null;
  /** Explorer for the address: the selected network's, Solscan on All networks. */
  explorer: { name: string; url: string } | null;
  /** The existing balance refresh (wallet.refetchBalances), offered when the balance failed to load. */
  onRetry?: () => void;
  /** The action row, rendered inside the card. */
  children?: ReactNode;
}

export function BalanceHero({ hero, signedOut, privacy, onPrivacy, address, explorer, onRetry, children }: BalanceHeroProps) {
  const value = hero.value;
  // Signed out: the networks ANTARA supports. Signed in: the loaded networks, when there is more than one to tell apart.
  const chips: WalletChain[] = signedOut ? homeNetworks().map(item => item.key) : hero.chains.length > 1 ? hero.chains : [];
  const names = new Map(homeNetworks().map(item => [item.key, item.name]));
  return (
    <section className="home-hero ui-card" data-view="wallet" data-signed-out={signedOut || undefined} data-value={value.kind} aria-label="Wallet balance">
      <div className="desktop-hero-art home-hero-art" aria-hidden="true" />
      <div className="home-hero-top">
        <span className="desktop-balance-top home-hero-label ui-eyebrow">{hero.label}</span>
        <div className="home-address">
          {address ? (
            <>
              <AddressText address={address} form="short" copy copyLabel="Copy wallet address" />
              {explorer && (
                <ExternalLink className="home-explorer" href={explorer.url} aria-label={`View on ${explorer.name}`} title={`View on ${explorer.name}`}>
                  <span className="home-explorer-text">{explorer.name}</span>
                  <Icon name="external" size={13} />
                </ExternalLink>
              )}
            </>
          ) : !signedOut && (
            <span className="home-address-empty">Wallet loading…</span>
          )}
        </div>
      </div>
      <div className="home-hero-body">
        <div className="home-hero-value">
          <h2 className="desktop-balance-number home-balance" aria-label={hero.hint} title={hero.title} data-state={value.kind}>
            {value.kind === 'masked' ? MASK
              : value.kind === 'usd' ? <>{value.approx && <span className="home-approx">≈ </span>}{value.amount}</>
              : value.kind === 'amount' ? <>{value.amount}<small>{value.unit}</small></>
              : <PlaceholderAmount value={UNKNOWN} />}
          </h2>
          <button type="button" className="ui-icon-btn home-privacy" onClick={onPrivacy} aria-label={privacy ? 'Show balances' : 'Hide balances'} title={privacy ? 'Show balances' : 'Hide balances'}>
            <Icon name={privacy ? 'hidden' : 'eye'} size={18} />
          </button>
        </div>
        {hero.breakdown.length > 0 && (
          <p className="home-breakdown" aria-label="Other holdings">
            {hero.breakdown.map(item => <span key={item.label}>{item.amount} {item.label}</span>)}
          </p>
        )}
        {hero.notes.length > 0 && (
          <p className="home-notes">
            {hero.notes.map(note => <span key={note}>{note}</span>)}
          </p>
        )}
        <div className="home-meta-row">
          <p className="desktop-balance-meta home-meta">{hero.meta}</p>
          {chips.length > 0 && (
            <div className="home-chips" aria-label={signedOut ? 'Supported networks' : 'Networks with loaded assets'}>
              {chips.map(chain => (
                <span className="home-chip" key={chain} title={names.get(chain)}>
                  <TokenLogo symbol={chain} />
                  <span>{names.get(chain)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        {hero.failed && !signedOut && <LoadFailed className="home-load-failed" onRetry={onRetry} />}
      </div>
      {children}
    </section>
  );
}
