// The review shown before Confirm (docs/UI_ARGUS_PARITY.md 6.10). It renders the
// `describeSettlement()` rows and paragraphs from ../review.ts VERBATIM, after the neutral
// spending-wallet line, and ends with the acknowledgement Confirm waits for. Nothing here
// paraphrases, shortens or reorders the terms.
import { Icon } from '../../ui';
import type { SettlementDisclosure } from '../review';
import { SPENDING_WALLET_LINE } from './swapModel';

export interface SwapReviewPanelProps {
  disclosure: SettlementDisclosure;
  /** The quote's 90-second validity has passed: the "Quote valid" row says so and the checkbox locks. */
  expired: boolean;
  acknowledged: boolean;
  /** The checkbox is locked (expired quote, or a quote or signature in progress). */
  locked: boolean;
  onAcknowledge: (value: boolean) => void;
}

export function SwapReviewPanel({ disclosure, expired, acknowledged, locked, onAcknowledge }: SwapReviewPanelProps) {
  return (
    <div className="swap-review" role="region" aria-label="Swap review" aria-live="polite" data-expired={expired || undefined}>
      <p className="swap-spending"><Icon name="shield" size={15} />{SPENDING_WALLET_LINE}</p>
      <dl className="swap-review-rows">
        {disclosure.rows.map(row => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            {/* The countdown is not announced every second; expiry replaces it with a fixed line. */}
            {row.label === 'Quote valid'
              ? <dd aria-live="off" data-expired={expired || undefined}>{expired ? 'Expired · refresh to continue' : row.value}</dd>
              : <dd>{row.value}</dd>}
          </div>
        ))}
      </dl>
      <div className="swap-terms">
        {disclosure.paragraphs.map(text => <p key={text}>{text}</p>)}
      </div>
      <label className="swap-acknowledge">
        <input type="checkbox" checked={acknowledged} disabled={locked} onChange={event => onAcknowledge(event.target.checked)} />
        <span>{disclosure.acknowledgement}</span>
      </label>
    </div>
  );
}
