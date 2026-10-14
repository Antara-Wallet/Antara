// Activity (docs/UI_ARGUS_PARITY.md 6.11, ARGUS S4b): what this device started, with
// All · Sent · Swaps · Vault filters and a detail sheet. Rows come only from
// useActivityItems (8.4); a route refresh re-reads through `solares:relay-activity`.
//
// Kept for the browser specs until the post-gate test update: the heading "Your activity,
// in one place", the row class `desktop-activity-row`, the row texts "<status> · <network>"
// (transfers) and "<network> · <status>" (routes), and the button "Refresh route status".
import { useEffect, useRef, useState } from 'react';
import { useSolaresWallet } from '../wallet';
import { detectRuntime } from '../../platform';
import { ExternalLink } from '../../platform/ExternalLink';
import type { TradeRecord } from '../relay/model';
import { EmptyState, Icon } from '../ui';
import { ACTIVITY_COPY, ACTIVITY_FILTERS, filterActivity, useActivityItems, type ActivityFilter, type ActivityItem } from './activityModel';
import { ActivityDetailSheet } from './ActivityDetailSheet';
import { activityIcon, formatActivityDate } from './format';
import './activity.css';

const HIDDEN = '••••••';
const NARROW_QUERY = '(max-width: 640px), (max-height: 500px) and (pointer: coarse)';

/** 4.5: the Activity empty state has art on desktop only; narrow layouts never load it. */
function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const media = matchMedia(NARROW_QUERY);
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return narrow;
}

export function ActivityScreen({ privacy, onConnect, onSwap }: { privacy: boolean; onConnect: () => void; onSwap: () => void }) {
  const wallet = useSolaresWallet();
  const { items, error, loading } = useActivityItems();
  const [filter, setFilter] = useState<ActivityFilter>('All');
  const [refreshing, setRefreshing] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const signedOut = !wallet.authenticated;
  const visible = filterActivity(items, filter);
  const detail = selected ? items.find(item => item.key === selected) ?? null : null;
  const extension = detectRuntime() === 'extension';
  const art = useNarrow() ? undefined : 'observatory' as const;

  async function refresh(record: TradeRecord) {
    setRefreshing(record.requestId);
    setRefreshError('');
    try {
      const { refreshTrade } = await import('../relay/client');
      await refreshTrade(wallet, record);
      // Every screen reading routes (this list, Wallet home, Swap status) re-reads now, not on the next reload.
      window.dispatchEvent(new CustomEvent('solares:relay-activity'));
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : ACTIVITY_COPY.refreshError);
    } finally {
      setRefreshing('');
    }
  }

  const signInLabel = !wallet.configured ? 'Open setup' : wallet.ready ? 'Sign in' : 'Wallet loading…';
  return (
    <section className="act-screen" aria-labelledby="act-heading">
      <header className="act-head">
        <div className="act-heading">
          <h2 id="act-heading">Activity</h2>
          <p>Transfers, swaps and vault actions started on this device.</p>
        </div>
        {!signedOut && (
          <div className="act-filters" role="group" aria-label="Filter activity">
            {ACTIVITY_FILTERS.map(option => (
              <button key={option.value} type="button" aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}</button>
            ))}
          </div>
        )}
      </header>
      {(error || refreshError) && <p className="ui-alert" role="alert">{refreshError || error}</p>}
      {signedOut ? (
        <EmptyState
          className="act-empty ui-card"
          art={art}
          title={ACTIVITY_COPY.signedOutTitle}
          text={ACTIVITY_COPY.signedOutText}
          action={<button type="button" className="ui-btn-primary" disabled={wallet.configured && !wallet.ready} onClick={onConnect}>{signInLabel} <Icon name="arrow" size={16} /></button>}
        />
      ) : loading && !items.length ? (
        <div className="act-loading ui-card" role="status">
          <p>Loading activity…</p>
          <div className="act-skeleton" aria-hidden="true"><span /><span /><span /></div>
        </div>
      ) : !items.length ? (
        <EmptyState className="act-empty ui-card" art={art} title={ACTIVITY_COPY.emptyTitle} text={ACTIVITY_COPY.emptyText} />
      ) : (
        <>
          {visible.length ? (
            <ul className="act-list ui-card" aria-label={filter === 'All' ? 'Activity on this device' : `${ACTIVITY_FILTERS.find(option => option.value === filter)!.label} on this device`}>
              {visible.map(item => (
                <ActivityRow
                  key={item.key}
                  item={item}
                  privacy={privacy}
                  refreshing={refreshing}
                  onOpen={element => { opener.current = element; setSelected(item.key); }}
                  onRefresh={record => void refresh(record)}
                />
              ))}
            </ul>
          ) : (
            <p className="act-filter-empty ui-card">{ACTIVITY_COPY.filterEmpty[filter as Exclude<ActivityFilter, 'All'>]}</p>
          )}
          <div className="act-foot">
            <p className="act-note">
              {ACTIVITY_COPY.footnote}
              {extension && <> {ACTIVITY_COPY.extensionNote}</>}
            </p>
            <button type="button" className="ui-btn-text" onClick={onSwap}>Route details <Icon name="arrow" size={15} /></button>
          </div>
        </>
      )}
      {detail && (
        <ActivityDetailSheet
          item={detail}
          privacy={privacy}
          returnFocusTo={opener.current}
          onClose={() => setSelected(null)}
          refreshing={!!detail.route && refreshing === detail.route.requestId}
          onRefresh={detail.route ? () => void refresh(detail.route!) : undefined}
        />
      )}
    </section>
  );
}

function ActivityRow({ item, privacy, refreshing, onOpen, onRefresh }: {
  item: ActivityItem;
  privacy: boolean;
  refreshing: string;
  onOpen: (element: HTMLElement) => void;
  onRefresh: (record: TradeRecord) => void;
}) {
  return (
    <li className="act-row desktop-activity-row" data-kind={item.kind}>
      <button type="button" className="act-row-main" aria-haspopup="dialog" onClick={event => onOpen(event.currentTarget)}>
        <span className="act-icon" data-tone={item.tone} aria-hidden="true"><Icon name={activityIcon(item)} size={18} /></span>
        <span className="act-text">
          <span className="act-title">{item.title}</span>
          <span className="act-meta">{item.description} · <time dateTime={new Date(item.timestamp).toISOString()}>{formatActivityDate(item.timestamp)}</time></span>
        </span>
        {item.amount && (privacy
          ? <span className="act-amount"><span aria-hidden="true">{HIDDEN}</span><span className="ui-visually-hidden">Amount hidden</span></span>
          : <span className="act-amount">{item.amount}</span>)}
      </button>
      {item.route ? (
        <button
          type="button"
          className="ui-icon-btn act-action"
          aria-label="Refresh route status"
          aria-busy={refreshing === item.route.requestId || undefined}
          disabled={!!refreshing}
          onClick={() => onRefresh(item.route!)}
        >
          <Icon name="refresh" size={16} />
        </button>
      ) : item.explorer ? (
        <ExternalLink className="ui-icon-btn act-action" href={item.explorer} aria-label={`${item.hash ? 'View transaction' : 'View account'} on ${item.explorerName ?? 'explorer'}`}>
          <Icon name="external" size={16} />
        </ExternalLink>
      ) : (
        <span className="act-action act-action-none" aria-hidden="true" />
      )}
    </li>
  );
}
