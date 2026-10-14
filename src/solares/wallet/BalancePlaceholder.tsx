// Balance stand-ins (owner rule, 2026-10-13). A balance or amount the wallet does not know
// (signed out, still loading, a failed load, no quote yet) renders as a muted zero, never as
// "—" or "Unavailable". Honesty travels with it: the muted style, a visible context caption
// where the surface has one, the reason in the accessible name, and, for a failed load, a
// "Couldn't load · Retry" line wired to the existing balance refresh.
import './balancePlaceholder.css';

/** The muted stand-in for an unknown decimal balance. */
export const PLACEHOLDER_AMOUNT = '0.00';
/** The muted stand-in for an integer-style or not-yet-quoted amount (swap output before a quote). */
export const PLACEHOLDER_INTEGER = '0';
/** Visible copy of a failed balance load. */
export const LOAD_FAILED_COPY = "Couldn't load";
export const RETRY_COPY = 'Retry';

export interface PlaceholderAmountProps {
  /** Defaults to "0.00". */
  value?: string;
  /** "USDC": rendered after the value, inside the muted span. */
  unit?: string;
  /** Why the value is unknown; read by screen readers only (the surface shows its own caption). */
  reason?: string;
  className?: string;
}

export function PlaceholderAmount({ value = PLACEHOLDER_AMOUNT, unit, reason, className }: PlaceholderAmountProps) {
  return (
    <span className={className ? `balance-placeholder ${className}` : 'balance-placeholder'} data-placeholder="">
      {unit ? `${value} ${unit}` : value}
      {reason && <span className="ui-visually-hidden"> ({reason})</span>}
    </span>
  );
}

export interface LoadFailedProps {
  /** The existing refresh (wallet.refetchBalances). Without it only "Couldn't load" shows. */
  onRetry?: () => void;
  /** Accessible name of the retry button; it always starts with the visible "Retry". */
  retryLabel?: string;
  className?: string;
}

/** "Couldn't load · Retry": shown under a placeholder whose load failed. */
export function LoadFailed({ onRetry, retryLabel = 'Retry loading balances', className }: LoadFailedProps) {
  return (
    <span className={className ? `balance-load-failed ${className}` : 'balance-load-failed'} data-load-failed="">
      <span>{LOAD_FAILED_COPY}</span>
      {onRetry && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="balance-retry" aria-label={retryLabel} onClick={onRetry}>{RETRY_COPY}</button>
        </>
      )}
    </span>
  );
}
