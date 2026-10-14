// "You receive" (docs/UI_ARGUS_PARITY.md 6.10, ARGUS S15): the quoted output, or a muted "0"
// captioned "No quote yet" before a quote (never "—"), the token button that opens the
// picker, and the receiving network. Networks that cannot receive from the pay network are
// listed but disabled, with the reason in the option.
import { useId } from 'react';
import { Icon } from '../../ui';
import { PLACEHOLDER_INTEGER, PlaceholderAmount } from '../../wallet/BalancePlaceholder';
import { RELAY_NETWORKS, receivingEnabled, tokenLabel, type TradeNetwork, type TradeToken } from '../model';
import { TokenAvatar } from '../TokenAvatar';

export interface ReceiveCardProps {
  sourceChainId: number;
  destination: TradeNetwork;
  onDestination: (chainId: number) => void;
  token: TradeToken;
  /** Formatted estimate from a reviewed quote, or null before a quote (a muted "0", captioned "No quote yet"). */
  estimate: string | null;
  onPickToken: () => void;
}

export function ReceiveCard({ sourceChainId, destination, onDestination, token, estimate, onPickToken }: ReceiveCardProps) {
  const label = tokenLabel(token);
  const captionId = useId();
  return (
    <div className="swap-panel swap-receive">
      <div className="swap-panel-head">
        <span className="swap-panel-label">You receive</span>
        <div className="swap-network">
          <label htmlFor="sol-relay-destination">On</label>
          <select id="sol-relay-destination" aria-label="Receive network" value={destination.id} onChange={event => onDestination(Number(event.target.value))}>
            {RELAY_NETWORKS.map(chain => {
              const enabled = receivingEnabled(sourceChainId, chain.id);
              return <option value={chain.id} key={chain.id} disabled={!enabled}>{enabled ? chain.name : `${chain.name} (same-network swaps only)`}</option>;
            })}
          </select>
        </div>
      </div>
      <div className="swap-amount-row">
        <output className="swap-amount swap-estimate" aria-label="Estimated tokens received" aria-describedby={captionId} title={estimate === null ? 'No quote yet' : undefined} data-quoted={estimate !== null || undefined}>
          {estimate ?? <PlaceholderAmount value={PLACEHOLDER_INTEGER} />}
        </output>
        <button type="button" className="swap-token-button" aria-label={`Select token, ${label} on ${destination.name}`} onClick={onPickToken}>
          <TokenAvatar token={token} />
          <strong>{label}</strong>
          <Icon name="chevron" size={16} />
        </button>
      </div>
      {/* The output is Relay's estimate; the review states the minimum if the order fills. */}
      <div className="swap-panel-foot">
        {estimate !== null
          ? <span id={captionId} className="swap-estimated">Estimated</span>
          : <span id={captionId} className="swap-quote-caption">No quote yet</span>}
      </div>
    </div>
  );
}
