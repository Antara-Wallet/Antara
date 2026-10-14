// Send step 1, Asset (docs/UI_ARGUS_PARITY.md 6.8; ARGUS argus-ext-popup-16-send-select.png).
// The ten assets in registry order with the wallet's exact balance. A known zero balance
// cannot be picked ("No balance"); an unknown one can: it shows a muted "0.00" captioned
// "Loading…" or "Couldn't load" (never "—"), and its accessible name still says "Balance
// unavailable". The Network
// and Asset selects above the list are the current choice for keyboard use and keep the
// existing combobox contract (network first, then the network's two assets).
import { EmptyState, Icon } from '../../ui';
import { TokenLogo } from '../../TokenLogo';
import { SUPPORTED_NETWORKS } from '../../networks';
import { SOLANA_CLUSTER } from '../../wallet/config';
import type { WalletChain } from '../../wallet/types';
import { filterRows, networkDisplayName, type AssetKind, type AssetRow } from '../../receive/receiveModel';
import { SEND_COPY, type SendRowState } from './sendModel';
import { LOAD_FAILED_COPY, LoadFailed, PlaceholderAmount } from '../../wallet/BalancePlaceholder';

export interface AssetStepProps {
  rows: readonly { row: AssetRow; state: SendRowState }[];
  chain: WalletChain;
  asset: AssetKind;
  selected: { row: AssetRow; state: SendRowState };
  onChain: (chain: WalletChain) => void;
  onAsset: (asset: AssetKind) => void;
  query: string;
  onQuery: (query: string) => void;
  onPick: (row: AssetRow) => void;
  nothing: boolean;
  onReceive?: () => void;
  /** Unknown balances are still loading (caption "Loading…") rather than failed ("Couldn't load"). */
  balancesLoading?: boolean;
  /** The existing balance refresh, offered on the selected asset's line when its load failed. */
  onRetry?: () => void;
}

export function AssetStep({ rows, chain, asset, selected, onChain, onAsset, query, onQuery, onPick, nothing, onReceive, balancesLoading = false, onRetry }: AssetStepProps) {
  if (nothing) {
    return (
      <div className="ui-card send-nothing">
        <EmptyState
          title={SEND_COPY.nothingTitle}
          text={SEND_COPY.nothingText}
          action={onReceive && <button type="button" className="ui-btn-primary" onClick={onReceive}><Icon name="down" size={16} /> {SEND_COPY.receive}</button>}
        />
      </div>
    );
  }
  // Selectable with an unknown balance: a muted zero stand-in, never a dash and never a real zero.
  const placeholder = (state: SendRowState) => state.selectable && state.balance.status === 'unknown';
  const visible = filterRows(rows.map(item => ({ ...item.row, item })), query).map(entry => entry.item);
  const native = rows.find(item => item.row.chain === chain && item.row.asset === 'native')!.row;
  const stablecoin = rows.find(item => item.row.chain === chain && item.row.asset === 'stablecoin')!.row;
  return (
    <>
      <div className="send-pair">
        <label className="send-field">
          <span className="send-field-label">{SEND_COPY.network}</span>
          <select className="send-select" value={chain} onChange={event => onChain(event.target.value as WalletChain)}>
            {SUPPORTED_NETWORKS.map(network => <option key={network.key} value={network.key}>{networkDisplayName(network.key)}</option>)}
          </select>
        </label>
        <label className="send-field">
          <span className="send-field-label">{SEND_COPY.asset}</span>
          <select className="send-select" value={asset} onChange={event => onAsset(event.target.value as AssetKind)}>
            <option value="native">{native.label}</option>
            <option value="stablecoin" disabled={chain === 'solana' && SOLANA_CLUSTER === 'devnet'}>{stablecoin.label}</option>
          </select>
        </label>
      </div>
      <p className="send-available" data-tone={selected.state.selectable ? undefined : 'muted'}>
        {selected.state.balance.status === 'known' && selected.state.selectable ? <>{SEND_COPY.available}: <strong>{selected.state.note}</strong></>
          : placeholder(selected.state) ? <>
            {SEND_COPY.available}: <PlaceholderAmount unit={selected.row.label} reason={selected.state.note} />
            {balancesLoading ? <span className="send-available-caption">Loading…</span> : <LoadFailed onRetry={onRetry} />}
          </>
          : selected.state.note}
      </p>

      <div className="send-section">
        <h3 className="ui-eyebrow send-section-title">{SEND_COPY.yourAssets}</h3>
        <label className="send-search">
          <Icon name="search" size={16} />
          <input type="search" className="send-search-input" placeholder={SEND_COPY.search} aria-label={SEND_COPY.search} value={query} onChange={event => onQuery(event.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        {visible.length ? (
          <ul className="ui-card send-list">
            {visible.map(({ row, state }) => {
              const current = row.chain === chain && row.asset === asset;
              return (
                <li key={row.key} data-asset-row="send" data-chain={row.chain}>
                  <button
                    type="button"
                    className="send-row"
                    disabled={!state.selectable}
                    aria-current={current || undefined}
                    aria-label={`${row.label} on ${row.network}, ${state.note}`}
                    onClick={() => onPick(row)}
                  >
                    <span className="send-logo" aria-hidden="true"><TokenLogo symbol={row.mark} /></span>
                    <span className="send-main">
                      <span className="send-label">{row.label}</span>
                      <span className="send-sub">{row.network}</span>
                    </span>
                    {/* A known balance shows the exact amount (the label is on the left); an unknown one a muted zero
                        with its caption; otherwise why the asset cannot be picked. */}
                    <span className="send-balance" data-known={state.balance.status === 'known' && state.selectable || undefined} data-placeholder={placeholder(state) || undefined}>
                      {state.balance.status === 'known' && state.selectable ? state.balance.formatted
                        : placeholder(state) ? <>
                          <PlaceholderAmount />
                          <small className="send-balance-caption">{balancesLoading ? 'Loading…' : LOAD_FAILED_COPY}</small>
                        </>
                        : state.note}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : <p className="send-empty">{SEND_COPY.noMatch}</p>}
      </div>
    </>
  );
}
