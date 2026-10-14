// Send step 4, Result (docs/UI_ARGUS_PARITY.md 6.8; ARGUS argus-ext-popup-34-simple-send-success.png).
// The existing status titles and texts, the explorer link and the hash (or the attempt
// id while the wallet's outcome is unknown). An unknown outcome is never shown as failed.
import { AddressText, Icon, type IconName } from '../../ui';
import { ExternalLink } from '../../../platform/ExternalLink';
import { transferExplorer, transferNetworkLabel, type TransferRecord } from '../transfer';
import { resultCopy } from './sendModel';

const MARK: Record<TransferRecord['status'], IconName> = { confirmed: 'check', submitted: 'refresh', reverted: 'close', 'submission-unknown': 'activity' };

export function ResultStep({ record }: { record: TransferRecord }) {
  const copy = resultCopy(record.status);
  const explorer = transferExplorer(record.chain, record.hash, record.sender);
  return (
    <div className="send-result" data-status={record.status}>
      <span className="send-result-mark" aria-hidden="true"><Icon name={MARK[record.status]} size={26} /></span>
      <p className="send-hero-amount"><span className="send-hero-value">{record.amount}</span> <span className="send-hero-unit">{record.symbol}</span></p>
      <p className="send-result-to">on {transferNetworkLabel(record.chain)} to <AddressText address={record.recipient} form="short" /></p>
      <p className="send-result-text">{copy.text}</p>
      {explorer && (
        <ExternalLink className="ui-btn-text send-explorer" href={explorer}>
          {record.hash ? 'View transaction' : 'View sending account'} <span aria-hidden="true">↗</span>
        </ExternalLink>
      )}
      <code className="send-code">{record.hash || `Attempt ${record.id}${record.nonce === undefined ? '' : ` · nonce ${record.nonce}`}`}</code>
    </div>
  );
}
