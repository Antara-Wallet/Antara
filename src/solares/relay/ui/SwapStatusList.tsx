// "Swap status" (docs/UI_ARGUS_PARITY.md 6.10): this device's swaps that still need
// attention, with their real status, the fill window, explorer links, a status refresh,
// and the explicit "Start another swap" release for a settling deposit. Saved swaps on
// removed networks (Arbitrum, Polygon) are read-only: never refreshed, re-quoted or signed.
import { ExternalLink } from '../../../platform/ExternalLink';
import { describeChainId, explorerAddressUrl } from '../../networks';
import { StatusChip } from '../../ui';
import { formatIntentAmount, isTerminal, relayNetwork, tokenFor, tokenLabel, type TradeRecord } from '../model';
import { blocksNewSwap, depositReported, fillWindowNote } from '../review';
import { statusTone } from './swapModel';

const STATUS_LABELS: Record<TradeRecord['status'], string> = {
  waiting: 'Awaiting deposit', depositing: 'Deposit confirming', pending: 'Swapping', submitted: 'Destination submitted', delayed: 'Settlement delayed',
  success: 'Delivered', refund: 'Refunded', failure: 'Needs attention', unresolved: 'Status unresolved',
};

/** Explorer page for the sender's wallet on a saved route's source network (supported or legacy), for records without a transaction hash. */
function sourceWalletExplorer(record: TradeRecord): { url: string; name: string } | null {
  const source = describeChainId(record.intent.originChainId);
  const target = source.status === 'supported' ? source.network : source.status === 'legacy' ? source.legacy : null;
  return target && typeof record.intent.user === 'string' && record.intent.user ? { url: explorerAddressUrl(target, record.intent.user), name: target.explorer.name } : null;
}

export interface SwapStatusListProps {
  records: TradeRecord[];
  now: number;
  /** requestId being refreshed. */
  refreshing: string;
  /** A signature is in progress: refresh waits. */
  executing: boolean;
  /** Settling swaps the user already allowed a new swap past. */
  released: readonly string[];
  /** requestId whose "Start another swap" confirmation is open. */
  confirmRelease: string;
  onRefresh: (record: TradeRecord) => void;
  onAskRelease: (requestId: string) => void;
  onRelease: (requestId: string) => void;
}

export function SwapStatusList({ records, now, refreshing, executing, released, confirmRelease, onRefresh, onAskRelease, onRelease }: SwapStatusListProps) {
  if (records.length === 0) return null;
  return (
    <section className="swap-status ui-card" aria-label="Swap status">
      <h3 className="swap-status-title">Swap status</h3>
      {records.map(record => {
        const origin = relayNetwork(record.intent.originChainId), target = relayNetwork(record.intent.destinationChainId);
        const output = tokenFor(target, record.intent.destinationToken);
        const legacy = origin.legacy ? origin : target.legacy ? target : null;
        // A Relay order can stay open for up to 7 days; after its deadline the record says so instead of "Swapping".
        const fill = legacy ? null : fillWindowNote(record, now);
        const releasable = !legacy && blocksNewSwap(record, now) && depositReported(record) && !released.includes(record.requestId);
        const status = legacy && !isTerminal(record.status) ? 'Not tracked' : fill?.notFilled ? 'Not filled' : STATUS_LABELS[record.status];
        const explorer = legacy && record.sourceTxHashes.length === 0 ? sourceWalletExplorer(record) : null;
        return (
          <article key={record.requestId} className="swap-status-item">
            <div className="swap-status-head">
              <strong>{formatIntentAmount(record.intent)} → {tokenLabel(output)}</strong>
              <StatusChip tone={statusTone(record.status, { legacy: Boolean(legacy), notFilled: fill?.notFilled })} label={status} />
            </div>
            <p className="swap-status-route">{origin.label}{origin.id !== target.id ? ` → ${target.label}` : ''}</p>
            {legacy && <p>{legacy.label}. This saved swap is read-only and no longer tracked; check the explorer for its final status.</p>}
            {fill && <p>{fill.detail}</p>}
            {record.detail && <p>{record.detail.replace(/_/g, ' ')}</p>}
            <div className="swap-status-links">
              {explorer && <ExternalLink href={explorer.url}>View wallet on {explorer.name} ↗</ExternalLink>}
              {record.sourceTxHashes.map((hash, index) => <ExternalLink key={hash} href={`${origin.explorer}${encodeURIComponent(hash)}`}>Transaction {index + 1} ↗</ExternalLink>)}
              {!legacy && <button type="button" disabled={refreshing === record.requestId || executing} onClick={() => onRefresh(record)}>{refreshing === record.requestId ? 'Checking…' : 'Refresh status'}</button>}
              {releasable && confirmRelease !== record.requestId && <button type="button" onClick={() => onAskRelease(record.requestId)}>Start another swap</button>}
            </div>
            {releasable && confirmRelease === record.requestId && (
              <div className="swap-release" role="group" aria-label="Start another swap">
                <p>Your earlier swap is still settling. Its deposit is already in Relay's depository.</p>
                <div className="swap-status-links">
                  <button type="button" onClick={() => onRelease(record.requestId)}>Start another swap</button>
                  <button type="button" onClick={() => onAskRelease('')}>Cancel</button>
                </div>
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
