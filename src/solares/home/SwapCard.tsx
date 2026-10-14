// The Swap entry of the Wallet home's right column (wide screens). It is not a second swap:
// no amount input, quote or route lives here. It shows what Swap pays with (the selected
// network's funding stablecoin, from the registry) and the wallet's loaded balance of it,
// and opens the one Swap screen (relay/TradeWorkspace) prefilled with that network.
import { Icon } from '../ui';
import { byKey } from '../networks';
import { useSolaresWallet } from '../wallet';
import { PlaceholderAmount } from '../wallet/BalancePlaceholder';
import type { WalletChain } from '../wallet/types';
import { TokenMark } from './TokenList';
import { MASK, UNKNOWN, assetMark, networkName, tokenDetail, type TokenDetailModel } from './homeModel';

export interface SwapCardProps {
  chain: WalletChain;
  privacy: boolean;
  onSwap: (prefill?: TokenDetailModel['swap']) => void;
}

export function SwapCard({ chain, privacy, onSwap }: SwapCardProps) {
  const wallet = useSolaresWallet();
  const funding = byKey(chain).funding;
  const loaded = wallet.authenticated && !wallet.balancesLoading
    ? wallet.balances.find(balance => balance.chain === chain && !balance.isNative) ?? null
    : null;
  const prefill = tokenDetail(chain, 'stablecoin').swap;
  const open = () => onSwap(prefill);
  const available = !wallet.authenticated ? 'Sign in to swap'
    : wallet.balancesLoading ? 'Loading balance'
    : loaded ? 'available' : 'Balance unavailable';

  return (
    <section className="ui-card home-side-card home-swap-card" aria-labelledby="home-swap-title">
      <div className="home-side-head">
        <h2 id="home-swap-title" className="home-side-title">Swap</h2>
        <span className="home-side-meta">Routed by Relay</span>
      </div>
      <div className="home-swap-legs">
        <button type="button" className="home-swap-leg" onClick={open} aria-label={`Pay with ${funding.label} on ${networkName(chain)}`}>
          <span className="home-swap-leg-label">You pay</span>
          <span className="home-swap-leg-asset">
            <TokenMark mark={assetMark(chain, 'stablecoin')} className="home-swap-mark" />
            <span className="home-swap-leg-name"><strong>{funding.label}</strong><small>{networkName(chain)}</small></span>
          </span>
          <span className="home-swap-leg-amount">
            <strong>{privacy && loaded ? MASK : loaded ? loaded.formatted : <PlaceholderAmount value={UNKNOWN} />}</strong>
            <small>{available}</small>
          </span>
        </button>
        <span className="home-swap-switch" aria-hidden="true"><Icon name="down" size={16} /></span>
        <button type="button" className="home-swap-leg" onClick={open} aria-label="Choose the token to receive">
          <span className="home-swap-leg-label">You receive</span>
          <span className="home-swap-leg-asset">
            <span className="home-swap-pick"><Icon name="search" size={16} /></span>
            <span className="home-swap-leg-name"><strong>Choose a token</strong><small>Any supported network</small></span>
          </span>
          <Icon name="chevron" size={16} className="home-swap-leg-chevron" />
        </button>
      </div>
      <button type="button" className="ui-btn home-side-action home-swap-open" onClick={open}>
        Open swap <Icon name="arrow" size={15} />
      </button>
    </section>
  );
}
