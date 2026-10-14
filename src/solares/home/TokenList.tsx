// Token rows of the Wallet side (docs/UI_ARGUS_PARITY.md 6.4): logo, name, "label · network",
// the exact balance (or "••••••") and, muted under it, its USD value at Relay prices ("≈ $8.43",
// nothing while the price is not known), Solana first. Each row opens token detail (6.5)
// through a button named "<label> on <network>" (the parity scenarios click it).
//
// Asserted by the browser specs: rows are `.desktop-token-table tbody tr`; the mark is
// `.desktop-token-mark.desktop-token-<mark>` (`usdc` only for Circle USDC, `stablecoin` for
// Binance-Peg USDC and USDG); a row contains its name, label, network and amount.
import { TokenLogo } from '../TokenLogo';
import { maskAmount, tokenUsd, type TokenRow } from './homeModel';
import type { PricesState } from '../wallet/prices';

export interface TokenListProps {
  rows: TokenRow[];
  privacy: boolean;
  prices: PricesState;
  onOpen: (row: TokenRow, trigger: HTMLButtonElement) => void;
}

export function TokenMark({ mark, className = '' }: { mark: string; className?: string }) {
  return (
    <span className={`desktop-token-mark desktop-token-${mark.toLowerCase()} home-token-mark ${className}`.trim()} data-mark={mark.toLowerCase()} aria-hidden="true">
      <TokenLogo symbol={mark} />
    </span>
  );
}

export function TokenList({ rows, privacy, prices, onOpen }: TokenListProps) {
  return (
    <table className="desktop-token-table home-token-table">
      <thead className="ui-visually-hidden">
        <tr><th scope="col">Asset</th><th scope="col">Balance</th></tr>
      </thead>
      <tbody>
        {rows.map(row => {
          const usd = tokenUsd(row, prices);
          return (
          <tr key={row.id} className="home-token-row" data-asset-row="token" data-chain={row.chain} data-token={row.id}>
            <th scope="row" className="home-token-asset">
              <button type="button" className="home-token-open" aria-label={row.rowName} onClick={event => onOpen(row, event.currentTarget)}>
                <TokenMark mark={row.mark} />
                <span className="home-token-name">
                  <strong>{row.name}</strong>
                  <small>{row.label} · {row.networkName}</small>
                </span>
              </button>
            </th>
            <td className="home-token-balance">
              <strong>{maskAmount(row.balance, privacy)}</strong>
              <small>{row.label}</small>
              {usd && <small className="home-token-usd">{maskAmount(usd, privacy)}</small>}
            </td>
          </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Three placeholder rows while balances load (never a zero). */
export function TokenSkeleton() {
  return (
    <div className="home-token-skeleton" aria-hidden="true">
      {[0, 1, 2].map(index => (
        <div key={index} className="home-skeleton-row">
          <span className="home-skeleton-dot" />
          <span className="home-skeleton-lines"><span /><span /></span>
          <span className="home-skeleton-amount" />
        </div>
      ))}
    </div>
  );
}
