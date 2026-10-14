// Send step 2, Details (docs/UI_ARGUS_PARITY.md 6.8; ARGUS argus-ext-popup-17-send-details-filled.png).
// Recipient with the address book, what ANTARA recognises about it, the lookalike
// warning, and the amount against the wallet's *known* balance. The vault is never a
// plain transfer target: its addresses hand off to the vault's Deposit.
import type { RefObject } from 'react';
import { Icon, StatusChip } from '../../ui';
import { TokenLogo } from '../../TokenLogo';
import type { AssetRow } from '../../receive/receiveModel';
import { SEND_COPY, type AmountCheck, type KnownBalance, type RecipientChip } from './sendModel';
import { LoadFailed, PlaceholderAmount } from '../../wallet/BalancePlaceholder';

export interface DetailsStepProps {
  formId: string;
  row: AssetRow;
  busy: boolean;
  recipient: string;
  onRecipient: (value: string) => void;
  recipientRef: RefObject<HTMLTextAreaElement | null>;
  onOpenBook: () => void;
  chips: readonly RecipientChip[];
  warning: string;
  vaultHandoff: 'deposit' | 'config' | null;
  onOpenVaultDeposit: () => void;
  amount: string;
  onAmount: (value: string) => void;
  balance: KnownBalance;
  check: AmountCheck;
  max: string | null;
  feeNotice: string;
  nativeSymbol: string;
  onSubmit: () => void;
  /** An unknown balance is still loading rather than failed. */
  balancesLoading?: boolean;
  /** The existing balance refresh, offered when the balance failed to load. */
  onRetry?: () => void;
}

/** A recipient is one value: pasted line breaks (CR or LF) are dropped. */
const stripLineBreaks = (value: string) => value.replace(/[\r\n]+/g, '');

export function DetailsStep(props: DetailsStepProps) {
  const { formId, row, busy, recipient, chips, warning, vaultHandoff, amount, balance, check, max } = props;
  // An unknown balance is a muted "0.00 <label>" stand-in (never "—"); the help line below says why.
  const available = balance.status === 'known' ? `${balance.formatted} ${row.label}` : <PlaceholderAmount unit={row.label} />;
  return (
    <form id={formId} className="send-details" onSubmit={event => { event.preventDefault(); props.onSubmit(); }} noValidate>
      <div className="send-asset-head">
        <span className="send-logo" aria-hidden="true"><TokenLogo symbol={row.mark} /></span>
        <span className="send-main">
          <span className="send-label">{row.label}</span>
          <span className="send-sub">{row.name === row.network ? row.network : `${row.name} · ${row.network}`}</span>
        </span>
      </div>

      <div className="send-field">
        <label className="send-field-label" htmlFor={`${formId}-recipient`}>{SEND_COPY.recipient}</label>
        <div className="send-input-group">
          {/* One value, shown wrapped: Enter submits and line breaks are never kept. */}
          <textarea
            id={`${formId}-recipient`}
            ref={props.recipientRef}
            className="send-input send-recipient"
            rows={1}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={recipient}
            onChange={event => props.onRecipient(stripLineBreaks(event.target.value))}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
            placeholder={row.family === 'solana' ? 'Solana wallet address' : '0x…'}
            maxLength={64}
          />
          <button type="button" className="ui-icon-btn send-book" aria-label={SEND_COPY.addressBook} title={SEND_COPY.addressBook} disabled={busy} onClick={props.onOpenBook}>
            <Icon name="book" />
          </button>
        </div>
        {chips.length > 0 && (
          <div className="send-chips">
            {chips.map(chip => <StatusChip key={chip.kind} tone={chip.kind === 'vault-config' ? 'warn' : chip.kind === 'vault' ? 'neutral' : 'ok'} label={chip.text} />)}
          </div>
        )}
      </div>

      {vaultHandoff && (
        <div className="ui-card send-handoff" role="note">
          <p>{vaultHandoff === 'deposit' ? SEND_COPY.vaultHandoff : SEND_COPY.vaultConfig}</p>
          {vaultHandoff === 'deposit' && (
            <button type="button" className="ui-btn" onClick={props.onOpenVaultDeposit}><Icon name="deposit" size={16} /> {SEND_COPY.continueToVault}</button>
          )}
        </div>
      )}
      {warning && <p className="ui-alert" data-tone="warn" role="alert">{warning}</p>}

      <div className="send-field">
        <div className="send-field-row">
          <label className="send-field-label" htmlFor={`${formId}-amount`}>{SEND_COPY.amount}</label>
          <span className="send-field-aside" title={balance.status === 'unknown' ? SEND_COPY.unknownBalance : undefined}>
            {SEND_COPY.available}: <span className="ui-mono">{available}</span>
          </span>
        </div>
        <div className="send-input-group send-amount-group" data-invalid={check === 'over' || undefined}>
          <input
            id={`${formId}-amount`}
            className="send-input send-amount"
            disabled={busy}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={event => props.onAmount(event.target.value.replace(',', '.'))}
            placeholder="0.00"
            maxLength={90}
            aria-invalid={check === 'over' || undefined}
            aria-describedby={`${formId}-amount-help`}
          />
          <span className="send-unit">{row.label}</span>
          {max !== null && (
            <button type="button" className="ui-btn-text send-max" disabled={busy} onClick={() => props.onAmount(max)}>{SEND_COPY.max}</button>
          )}
        </div>
        <div id={`${formId}-amount-help`} className="send-help">
          {check === 'over' && <p className="send-field-error" role="alert">{SEND_COPY.notEnough(row.label)}</p>}
          {balance.status === 'unknown' && <p>{props.balancesLoading ? 'Loading your balance.' : `${SEND_COPY.unknownBalance}.`} Your wallet and the network check the amount.</p>}
          {balance.status === 'unknown' && !props.balancesLoading && <p><LoadFailed onRetry={props.onRetry} /></p>}
          {row.asset === 'native' && <p>{SEND_COPY.keepFees(props.nativeSymbol)}</p>}
        </div>
      </div>
      {props.feeNotice && <p className="ui-alert" data-tone="warn">{props.feeNotice}</p>}

      <p className="send-note">{SEND_COPY.spendNote}</p>
    </form>
  );
}
