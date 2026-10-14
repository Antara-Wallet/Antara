// Send step 3, Review (docs/UI_ARGUS_PARITY.md 6.8; ARGUS argus-ext-popup-18-send-confirm.png).
// Every field the wallet will sign, the full recipient address, the public-visibility row
// and the neutral spending-wallet banner. No fiat, no price, no estimate beyond the fee
// the network quoted.
import { AddressText, Icon, StatusChip } from '../../ui';
import { TokenLogo } from '../../TokenLogo';
import type { AssetRow } from '../../receive/receiveModel';
import type { PreparedTransfer } from '../transfer';
import { SEND_COPY, type RecipientChip } from './sendModel';

export interface ReviewStepProps {
  review: PreparedTransfer;
  row: AssetRow;
  chips: readonly RecipientChip[];
  warning: string;
  seconds: number;
}

export function ReviewStep({ review, row, chips, warning, seconds }: ReviewStepProps) {
  return (
    <div className="send-review">
      <div className="send-hero">
        <span className="send-logo send-hero-logo" aria-hidden="true"><TokenLogo symbol={row.mark} /></span>
        <p className="send-hero-amount"><span className="send-hero-value">{review.amount}</span> <span className="send-hero-unit">{review.symbol}</span></p>
        <p className="send-hero-network">on {row.network}</p>
        {seconds > 0
          ? <p className="send-countdown">{SEND_COPY.reviewValid(seconds)}</p>
          : <p className="ui-alert" role="alert">{SEND_COPY.expired}</p>}
      </div>
      <dl className="ui-card send-dl">
        <div data-stack=""><dt>From</dt><dd><AddressText address={review.sender} /></dd></div>
        <div data-stack="">
          <dt>To</dt>
          <dd>
            <AddressText address={review.recipient} />
            {chips.length > 0 && <span className="send-chips">{chips.map(chip => <StatusChip key={chip.kind} tone="ok" label={chip.text} />)}</span>}
          </dd>
        </div>
        <div><dt>Network</dt><dd>{row.network}</dd></div>
        {row.tokenAddress ? (
          <div data-stack="">
            <dt>Token</dt>
            <dd>
              <span>{row.label} · {row.name}</span>
              <AddressText address={row.tokenAddress} />
              {row.issuerNote && <small>{row.issuerNote}</small>}
            </dd>
          </div>
        ) : (
          <div><dt>Asset</dt><dd>{row.label} · {SEND_COPY.nativeCoin(row.network)}</dd></div>
        )}
        <div><dt>Network fee</dt><dd className="ui-mono">{review.fee}</dd></div>
        {review.rent !== '0' && <div><dt>Recipient token account rent</dt><dd className="ui-mono">{review.rent}</dd></div>}
        <div><dt>Approval scope</dt><dd>{SEND_COPY.approvalScope}</dd></div>
        <div><dt>Visibility</dt><dd>{SEND_COPY.visibility}</dd></div>
      </dl>
      {warning && <p className="ui-alert" data-tone="warn" role="alert">{warning}</p>}
      <p className="send-banner"><Icon name="shield" size={16} /> {SEND_COPY.banner}</p>
      <p className="send-note">{SEND_COPY.verify}</p>
    </div>
  );
}
