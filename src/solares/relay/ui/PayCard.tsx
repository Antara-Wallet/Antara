// "You pay" (docs/UI_ARGUS_PARITY.md 6.10, ARGUS S15): the amount, the pay network's pinned
// funding stablecoin (never a flip: pay is always that stablecoin), its "On" network, the
// known balance or a muted "0.00" stand-in (never "—"), and the 50% / Max chips over the
// whole balance (no swap cap; owner decision 2026-10-13). A failed balance load adds
// "Couldn't load · Retry".
import { useId } from 'react';
import { RELAY_NETWORKS, formatExactAmount, fundingToken, type TradeNetwork } from '../model';
import { TokenAvatar } from '../TokenAvatar';
import { LoadFailed, PlaceholderAmount } from '../../wallet/BalancePlaceholder';

export interface PayCardProps {
  amount: string;
  onAmount: (value: string) => void;
  source: TradeNetwork;
  onSource: (chainId: number) => void;
  /** "42.5 USDC", or null when unknown: a muted "0.00 <label>" with `balanceHint` as its accessible reason. */
  balanceText: string | null;
  balanceHint?: string;
  /** The wallet finished loading without this balance: adds "Couldn't load · Retry". */
  balanceFailed?: boolean;
  /** The existing balance refresh (wallet.refetchBalances). */
  onRetryBalance?: () => void;
  /** Base units for 50% and Max; null disables the chip. Half and all of the balance (only the protocol sanity ceiling applies). */
  half: bigint | null;
  max: bigint | null;
  /** The amount is above the known balance. */
  insufficient: boolean;
}

export function PayCard({ amount, onAmount, source, onSource, balanceText, balanceHint, balanceFailed, onRetryBalance, half, max, insufficient }: PayCardProps) {
  const balanceId = useId();
  const { funding } = source;
  const fill = (value: bigint | null) => { if (value !== null) onAmount(formatExactAmount(value.toString(), funding.decimals)); };
  return (
    <div className="swap-panel swap-pay" data-invalid={insufficient || undefined}>
      <div className="swap-panel-head">
        <label className="swap-panel-label" htmlFor="sol-relay-amount">You pay</label>
        <div className="swap-network">
          <label htmlFor="sol-relay-source">On</label>
          <select id="sol-relay-source" aria-label="Pay network" value={source.id} onChange={event => onSource(Number(event.target.value))}>
            {RELAY_NETWORKS.map(chain => <option value={chain.id} key={chain.id}>{chain.name}</option>)}
          </select>
        </div>
      </div>
      <div className="swap-amount-row">
        <input
          id="sol-relay-amount"
          className="swap-amount"
          aria-label={`${funding.label} amount to spend`}
          aria-describedby={balanceId}
          aria-invalid={insufficient || undefined}
          value={amount}
          placeholder="0"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          onChange={event => onAmount(event.target.value)}
        />
        {/* Not a button: pay is always this network's pinned stablecoin. The issuer note names non-Circle stablecoins. */}
        <span className="trade-asset swap-asset" title={funding.circleIssued ? undefined : source.registry.funding.issuerNote}>
          <TokenAvatar token={fundingToken(source)} />
          <strong>{funding.label}</strong>
        </span>
      </div>
      <div className="swap-panel-foot">
        <div className="swap-balance-col">
          <span id={balanceId} className="swap-balance" title={balanceHint} data-known={balanceText !== null || undefined}>
            Balance: {balanceText ?? <PlaceholderAmount unit={funding.label} reason={balanceHint} />}
          </span>
          {balanceText === null && balanceFailed && <LoadFailed onRetry={onRetryBalance} retryLabel={`Retry loading ${funding.label} balance`} />}
        </div>
        <div className="swap-chips">
          <button type="button" className="swap-chip" disabled={half === null} onClick={() => fill(half)}>50%</button>
          <button type="button" className="swap-chip" disabled={max === null} onClick={() => fill(max)}>Max</button>
        </div>
      </div>
    </div>
  );
}
