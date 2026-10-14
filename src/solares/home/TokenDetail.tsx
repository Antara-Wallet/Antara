// Token detail (docs/UI_ARGUS_PARITY.md 6.5; ARGUS S10): one asset on one network. The
// exact balance with its USD value ("≈ $8.43"), the asset's identity from the registry (contract
// or mint, decimals, the issuer note for stablecoins Circle does not issue), the wallet's own
// account on the explorer, Send / Receive / Swap shortcuts, and the current price with its source
// and time ("Price ≈ $107.83 · Relay, 12:41", owner decision 2026-10-13). Never a market cap, FDV,
// volume, liquidity or 24-hour change: ANTARA reads a current price only.
// A panel on desktop (with Back) and a bottom sheet when narrow; both carry
// data-screen="token-detail".
import { useEffect, useRef } from 'react';
import { AddressText, Icon, Sheet } from '../ui';
import { TokenLogo } from '../TokenLogo';
import { ExternalLink } from '../../platform/ExternalLink';
import { MASK, UNKNOWN, accountExplorerUrl, tokenDetail, type AssetKind, type TokenDetailModel } from './homeModel';
import { TokenMark } from './TokenList';
import { PlaceholderAmount } from '../wallet/BalancePlaceholder';
import type { WalletChain } from '../wallet/types';

export interface TokenDetailProps {
  chain: WalletChain;
  kind: AssetKind;
  /** The exact formatted balance, or null when that network's balance is not loaded. */
  balance: string | null;
  /** The balance's USD value ("≈ $8.43"), or null while its price is not known. */
  usd: string | null;
  /** "Price ≈ $107.83 · Relay, 12:41", or why there is no price (homeModel.priceLine). */
  price: string;
  /** The wallet's address on this network, for the explorer link. */
  address: string | null;
  privacy: boolean;
  narrow: boolean;
  /** Must be referentially stable (the narrow sheet's focus handling). */
  onClose: () => void;
  /** The narrow sheet returns focus here on close. */
  returnFocusTo: HTMLElement | null;
  onSend: (chain: WalletChain, kind: AssetKind) => void;
  onReceive: (chain: WalletChain, kind: AssetKind) => void;
  onSwap: (swap: TokenDetailModel['swap']) => void;
}

function DetailBody({ model, heading, balance, usd, price, address, privacy, onSend, onReceive, onSwap }: { model: TokenDetailModel; heading: boolean } & Pick<TokenDetailProps, 'balance' | 'usd' | 'price' | 'address' | 'privacy' | 'onSend' | 'onReceive' | 'onSwap'>) {
  const identity = model.identity;
  return (
    <>
      <div className="home-detail-head">
        <TokenMark mark={model.mark} className="home-detail-mark" />
        {/* The sheet's own title already names the asset when narrow. */}
        {heading && <h2 className="home-detail-name">{model.name}</h2>}
        <p className="home-detail-label">{model.label}</p>
        <span className="home-network-chip"><TokenLogo symbol={model.chain} /><span>{model.networkName}</span></span>
      </div>

      <section className="ui-card home-detail-card" aria-label="Your balance">
        <p className="ui-eyebrow">Your balance</p>
        {balance === null ? (
          <>
            <p className="home-detail-amount" aria-label={`Balance unavailable on ${model.networkName}`}><PlaceholderAmount value={UNKNOWN} /></p>
            <p className="home-detail-note">Balance unavailable on {model.networkName}</p>
          </>
        ) : (
          <>
            <p className="home-detail-amount">{privacy ? MASK : balance}<small>{model.label}</small></p>
            {usd && <p className="home-detail-usd">{privacy ? MASK : usd}</p>}
          </>
        )}
      </section>

      <section className="ui-card home-detail-card" aria-label="Asset identity">
        <p className="ui-eyebrow">Asset identity</p>
        <p className="home-detail-identity">{identity.heading}</p>
        <dl className="home-detail-facts">
          {identity.address && identity.addressLabel && (
            <div>
              <dt>{identity.addressLabel}</dt>
              <dd><AddressText address={identity.address} copy copyLabel={`Copy ${identity.addressLabel.toLowerCase()} address`} /></dd>
            </div>
          )}
          <div>
            <dt>Decimals</dt>
            <dd className="ui-mono">{identity.decimals}</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>{model.networkName}</dd>
          </div>
        </dl>
        {identity.issuerNote && <p className="home-detail-issuer">{identity.issuerNote}</p>}
      </section>

      {address && (
        <ExternalLink className="home-detail-explorer" href={accountExplorerUrl(model.chain, address)}>
          View your account on {model.explorerName} <span aria-hidden="true">↗</span>
        </ExternalLink>
      )}

      <div className="home-detail-actions">
        <button type="button" className="ui-btn" onClick={() => onSend(model.chain, model.kind)}><Icon name="up" size={17} />Send</button>
        <button type="button" className="ui-btn" onClick={() => onReceive(model.chain, model.kind)}><Icon name="down" size={17} />Receive</button>
        <button type="button" className="ui-btn" onClick={() => onSwap(model.swap)}><Icon name="swap" size={17} />Swap</button>
      </div>

      <p className="home-detail-foot">{price}</p>
    </>
  );
}

export function TokenDetail(props: TokenDetailProps) {
  const { chain, kind, narrow, onClose, returnFocusTo } = props;
  const model = tokenDetail(chain, kind);
  const back = useRef<HTMLButtonElement>(null);
  // Desktop panel: focus Back on open. WalletHome returns focus to the row on close.
  useEffect(() => { if (!narrow) back.current?.focus(); }, [narrow]);

  if (narrow) {
    return (
      <Sheet title={model.name} description={`${model.label} on ${model.networkName}`} onClose={onClose} returnFocusTo={returnFocusTo} closeLabel="Close token details" className="home-detail-sheet">
        <div className="home-detail" data-screen="token-detail">
          <DetailBody {...props} model={model} heading={false} />
        </div>
      </Sheet>
    );
  }
  return (
    <section className="home-detail home-detail-panel" data-screen="token-detail" aria-label={`${model.label} on ${model.networkName}`}>
      <button ref={back} type="button" className="ui-btn-text home-detail-back" onClick={onClose}>
        <Icon name="back" size={17} /> Back
      </button>
      <DetailBody {...props} model={model} heading />
    </section>
  );
}
