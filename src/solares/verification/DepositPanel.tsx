// Vault deposit (docs/UI_ARGUS_PARITY.md 6.13): SOL or USDC from the spending wallet into the
// chain-verified vault. Amount → review → result. The deposit itself is a prop: PairedSolanaVault
// passes depositPairedSolanaVault, which re-reads and re-verifies the vault before paying, and
// stays the only caller of vault functions. Nothing can be deposited while `depositBlock` says
// why (layers unreadable, no passkey yet).
import { useState } from 'react';
import { ExternalLink } from '../../platform/ExternalLink';
import { formatAmount } from '../relay/model';
import { SOLANA_NETWORK } from '../networks';
import { VaultTransactionError } from '../vaults/transaction';
import { AddressText, ButtonLabel } from '../ui';
import './verification.css';
import { PLACEHOLDER_AMOUNT } from '../wallet/BalancePlaceholder';
import { friendlyError } from '../ui/friendlyError';
import { NO_SOLANA_USDC, PRIVATE_DEPOSIT_PROBLEM, VaultAmountError, solDepositProblem, solMinimumText } from '../vaults/vaultAmounts';

export type DepositAsset = 'SOL' | 'USDC';
const DECIMALS: Record<DepositAsset, number> = { SOL: 9, USDC: 6 };

/** Raw units for a typed amount, or null when it is not a positive amount with at most the asset's decimals. */
export function parseDepositAmount(value: string, asset: DepositAsset): bigint | null {
  const text = value.trim();
  const match = /^(\d{1,20})(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2] && match[2].length > DECIMALS[asset])) return null;
  const raw = BigInt(match[1]) * 10n ** BigInt(DECIMALS[asset]) + BigInt((match[2] ?? '').padEnd(DECIMALS[asset], '0') || '0');
  return raw > 0n ? raw : null;
}

/** The existing VaultTransactionError notices (PairedSolanaVault), verbatim. */
export function transactionNotice(failure: VaultTransactionError): string {
  return failure.outcome === 'reverted' ? 'The transaction reverted on-chain. Nothing moved; network fees may have been charged.'
    : failure.confirmed ? 'The transaction is confirmed, but the result could not be verified yet. Check the explorer before trying again.'
    : 'The transaction was submitted but is not confirmed yet. Check the explorer and do not repeat it.';
}

export interface DepositPanelProps {
  /** vault.depositAddress, verified on-chain. */
  depositAddress: string;
  /** The spending wallet that signs and pays. */
  from: string;
  cluster: 'mainnet-beta' | 'devnet';
  /** Spending-wallet balances in raw units; null when unknown (never read as zero). */
  balances: Record<DepositAsset, bigint | null>;
  /** The vault's verified SOL balance in lamports; null or absent when unknown. */
  vaultSol?: bigint | null;
  /** Solana's live rent-exempt minimum for the deposit address in lamports; null or absent until read. */
  rentMinimum?: bigint | null;
  /** Why deposits are paused here, or ''. */
  depositBlock: string;
  /** Sends the deposit; resolves with the confirmed signature. */
  deposit: (asset: DepositAsset, amount: string) => Promise<string>;
  explorerUrl: (signature: string) => string;
  privacy?: boolean;
  initialAsset?: DepositAsset;
  /** Opens at a step with these values (the parity harness). */
  initial?: { step: 'form' | 'review'; amount: string };
}

export function DepositPanel({ depositAddress, from, cluster, balances, vaultSol = null, rentMinimum = null, depositBlock, deposit, explorerUrl, privacy = false, initialAsset = 'SOL', initial }: DepositPanelProps) {
  const [asset, setAsset] = useState<DepositAsset>(cluster === 'devnet' ? 'SOL' : initialAsset);
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [step, setStep] = useState<'form' | 'review' | 'done'>(initial?.step ?? 'form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [signature, setSignature] = useState('');

  const raw = parseDepositAmount(amount, asset);
  const available = balances[asset];
  const tooMuch = raw !== null && available !== null && raw > available;
  // What Solana would reject, said before review: no USDC at all, or a first SOL deposit below the live account minimum.
  const noUsdc = asset === 'USDC' && available === 0n ? NO_SOLANA_USDC : null;
  const belowMinimum = asset === 'SOL' && raw !== null && vaultSol !== null && rentMinimum !== null ? solDepositProblem(vaultSol, raw, rentMinimum) : null;
  const amountProblem = noUsdc ?? (tooMuch ? `Not enough ${asset} in your wallet.` : belowMinimum);
  // These sentences can state wallet or vault balances: with privacy on, only that the amount can't be used.
  const problemText = amountProblem && privacy ? PRIVATE_DEPOSIT_PROBLEM : amountProblem;
  const firstDepositHint = asset === 'SOL' && vaultSol === 0n && rentMinimum !== null && !amountProblem && !privacy ? `The first SOL deposit must be at least ${solMinimumText(rentMinimum)} SOL.` : '';
  const feeNotice = asset === 'USDC' && balances.SOL === 0n;
  const canReview = !depositBlock && raw !== null && !amountProblem && !busy;
  const shown = (value: bigint | null) => privacy ? '••••••' : value === null ? `${PLACEHOLDER_AMOUNT} ${asset}` : `${formatAmount(value.toString(), DECIMALS[asset])} ${asset}`;

  async function confirm() {
    if (busy || depositBlock || raw === null || amountProblem) return;
    setBusy(true); setError(''); setSignature('');
    try {
      const hash = await deposit(asset, amount.trim());
      setSignature(hash); setStep('done'); setAmount('');
    } catch (failure) {
      if (failure instanceof VaultTransactionError) { setSignature(failure.signature); setError(`${friendlyError(failure.message)} ${transactionNotice(failure)}`); }
      else if (failure instanceof VaultAmountError && privacy) setError(PRIVATE_DEPOSIT_PROBLEM);
      else setError(failure instanceof Error && failure.message ? friendlyError(failure.message, 'The vault action could not be completed.') : 'The vault action could not be completed.');
    } finally { setBusy(false); }
  }

  return (
    <section className="ui-card vseq-deposit" aria-label="Deposit into your vault">
      <header className="vseq-deposit-head">
        <h3>Deposit</h3>
        <p>From your spending wallet into your vault. ANTARA verifies the vault on Solana before your wallet pays.</p>
      </header>

      {step === 'form' && <>
        <div className="vseq-field-row">
          <label className="vseq-field">
            <span>Asset</span>
            <select value={asset} disabled={busy} onChange={event => { setAsset(event.target.value as DepositAsset); setError(''); }}>
              <option value="SOL">SOL</option>
              {cluster !== 'devnet' && <option value="USDC">USDC</option>}
            </select>
          </label>
          <label className="vseq-field vseq-field-grow">
            <span>Amount</span>
            <span className="vseq-input-wrap">
              <input value={amount} disabled={busy} inputMode="decimal" placeholder="0.00" autoComplete="off" aria-describedby="vseq-deposit-available"
                onChange={event => { setAmount(event.target.value); setError(''); }} />
              {asset === 'USDC' && <button type="button" className="ui-btn-text vseq-max" disabled={busy || available === null || available === 0n}
                onClick={() => available !== null && setAmount(formatAmount(available.toString(), DECIMALS.USDC).replace(/,/g, ''))}>Max</button>}
            </span>
          </label>
        </div>
        <p className="vseq-hint" id="vseq-deposit-available">
          Available in your wallet: <span className="ui-mono" aria-label={available === null && !privacy ? 'Balance unavailable' : undefined}>{shown(available)}</span>
        </p>
        {firstDepositHint && <p className="vseq-hint">{firstDepositHint}</p>}
        {problemText && <p className="ui-alert" role="alert">{problemText}</p>}
        {feeNotice && <p className="ui-alert" data-tone="warn" role="note">Your wallet pays the Solana network fee in SOL.</p>}
        {depositBlock && <p className="ui-alert" data-tone="warn" role="note">{depositBlock}</p>}
        <div className="vseq-actions">
          <button type="button" className="ui-btn-primary" disabled={!canReview} onClick={() => setStep('review')}>Review deposit</button>
        </div>
      </>}

      {step === 'review' && <>
        <dl className="vseq-review">
          <div><dt>Amount</dt><dd className="vseq-review-amount">{privacy ? '••••••' : `${amount.trim()} ${asset}`}</dd></div>
          <div><dt>From</dt><dd><span className="vseq-review-label">Your wallet</span><AddressText address={from} /></dd></div>
          <div><dt>To</dt><dd><span className="vseq-review-label">Your vault’s deposit address</span><AddressText address={depositAddress} copy copyLabel="Copy vault deposit address" /></dd></div>
          <div><dt>Network</dt><dd>{SOLANA_NETWORK.name}</dd></div>
        </dl>
        {feeNotice && <p className="ui-alert" data-tone="warn" role="note">Your wallet pays the Solana network fee in SOL.</p>}
        {depositBlock && <p className="ui-alert" data-tone="warn" role="note">{depositBlock}</p>}
        {problemText && !error && <p className="ui-alert" role="alert">{problemText}</p>}
        {error && <p className="ui-alert" role="alert">{error}</p>}
        <div className="vseq-actions">
          <button type="button" className="ui-btn-primary" disabled={!!depositBlock || busy || raw === null || !!amountProblem} aria-busy={busy || undefined} onClick={() => void confirm()}>
            <ButtonLabel busy={busy} label="Deposit from your wallet" busyLabel="Waiting for your wallet…" />
          </button>
          <button type="button" className="ui-btn" disabled={busy} onClick={() => { setStep('form'); setError(''); }}>Back</button>
          {signature && <ExternalLink className="ui-btn-text vseq-link" href={explorerUrl(signature)}>View transaction ↗</ExternalLink>}
        </div>
      </>}

      {step === 'done' && <>
        <p className="vseq-result" role="status">Deposit confirmed on-chain.</p>
        <div className="vseq-actions">
          {signature && <ExternalLink className="ui-btn-text vseq-link" href={explorerUrl(signature)}>View transaction ↗</ExternalLink>}
          <button type="button" className="ui-btn" onClick={() => { setStep('form'); setSignature(''); }}>Done</button>
        </div>
      </>}
    </section>
  );
}
