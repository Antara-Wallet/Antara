// Transaction details (docs/UI_ARGUS_PARITY.md 6.11, ARGUS S4c): every field comes from the
// stored record. Amounts follow the privacy switch. Never shows protection-layer chips:
// a layer's status is shown only inside the vault, from ANTARA's answer for that vault.
import type { ReactNode } from 'react';
import { ExternalLink } from '../../platform/ExternalLink';
import { AddressText, ButtonLabel, Icon, Sheet, StatusChip } from '../ui';
import { ACTIVITY_COPY, type ActivityItem } from './activityModel';
import { activityIcon, formatActivityDate } from './format';
import './activity.css';

const VAULT_TYPES = { deposit: 'Vault deposit', release: 'Vault release', activation: 'Vault activation' } as const;

function typeLabel(item: ActivityItem) {
  if (item.vault) return VAULT_TYPES[item.vault.kind];
  return item.kind === 'Sent' ? 'Transfer' : item.kind;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="act-detail-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

export function ActivityDetailSheet({ item, privacy, onClose, returnFocusTo, onRefresh, refreshing = false }: {
  item: ActivityItem;
  privacy: boolean;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
  /** Relay status refresh; offered only for routes on supported networks (`item.route`). */
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const hidden = '••••••';
  const relayDetail = item.trade?.detail ? item.trade.detail.replace(/_/g, ' ') : '';
  const release = item.vault?.kind === 'release';
  const actions = item.explorer || (item.route && onRefresh) ? (
    <>
      {item.route && onRefresh && (
        <button type="button" className="ui-btn" aria-busy={refreshing || undefined} disabled={refreshing} onClick={onRefresh}>
          <Icon name="refresh" size={16} />
          <ButtonLabel busy={refreshing} label="Refresh route status" busyLabel="Checking…" />
        </button>
      )}
      {item.explorer && (
        <ExternalLink className="ui-btn" href={item.explorer}>
          {item.hash ? 'View transaction' : 'View account'} on {item.explorerName ?? 'explorer'} <span aria-hidden="true">↗</span>
        </ExternalLink>
      )}
    </>
  ) : undefined;
  return (
    <Sheet title="Transaction details" onClose={onClose} returnFocusTo={returnFocusTo} className="act-sheet" footer={actions}>
      <div className="act-detail-hero">
        <span className="act-icon act-icon-lg" data-tone={item.tone} aria-hidden="true"><Icon name={activityIcon(item)} size={24} /></span>
        <p className="act-detail-title">{item.title}</p>
        {item.status && <StatusChip tone={item.tone ?? 'neutral'} label={item.status} />}
      </div>
      <dl className="act-detail-list">
        <Row label="Type">{typeLabel(item)}</Row>
        {item.status && <Row label="Status">{item.status}</Row>}
        {item.network && <Row label="Network">{item.network}</Row>}
        {item.amount && <Row label="Amount">{privacy ? <><span aria-hidden="true">{hidden}</span><span className="ui-visually-hidden">Amount hidden</span></> : item.amount}</Row>}
        {item.receive && <Row label="Receive">{item.receive}</Row>}
        <Row label="Date"><time dateTime={new Date(item.timestamp).toISOString()}>{formatActivityDate(item.timestamp, true)}</time></Row>
        {item.from && <Row label="From"><AddressText address={item.from} copy copyLabel="Copy sender address" /></Row>}
        {item.to && <Row label="To"><AddressText address={item.to} copy copyLabel="Copy recipient address" /></Row>}
        {item.vault && <Row label="Vault"><AddressText address={item.vault.multisig} copy copyLabel="Copy vault address" /></Row>}
        {item.hash && <Row label="Transaction"><AddressText address={item.hash} copy copyLabel="Copy transaction hash" copiedMessage="Transaction hash copied." /></Row>}
        {item.kind === 'Swap' && item.settlement && <Row label="Settlement">{item.settlement}{relayDetail && <span className="act-detail-sub">{relayDetail}</span>}</Row>}
        {item.fill && <Row label="Fill window">{item.fill.detail}</Row>}
        {release && <Row label="Approval">{item.vault?.index ? `Release #${item.vault.index} · ` : ''}{ACTIVITY_COPY.releaseApproval}</Row>}
      </dl>
      {item.legacy && <p className="act-detail-note">{item.network}. This record is read-only{item.kind === 'Swap' ? ' and no longer tracked; check the explorer for its final status' : ''}.</p>}
    </Sheet>
  );
}
