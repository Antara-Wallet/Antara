// Send in four steps (docs/UI_ARGUS_PARITY.md 6.8; ARGUS S11): 1 Asset · 2 Details ·
// 3 Review · 4 Result, on the shared Sheet (full screen when narrow).
//
// The transfer itself is unchanged from TransferDialog: prepareTransfer, sendEvmTransfer
// or the wallet's sendSolanaTransaction, confirmTransfer, recordTransfer and
// removeTransfer from ./transfer, with the same session checks, the same
// persist-before-signing record and the same "never call an unknown outcome a failure"
// rules. recordTransfer/removeTransfer dispatch `solares:transfers` themselves (8.4), so
// Activity and the address book's recents follow on this page.
//
// The vault is never a plain transfer target: its deposit address (or its configuration
// account) disables Review and offers "Continue to vault deposit" (8.6).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSolaresWallet } from '../wallet';
import { PRIMARY_NETWORK, SOLANA_CLUSTER } from '../wallet/config';
import { assertWalletSession } from '../wallet/session';
import { SolanaTransactionExpiredError } from '../wallet/solanaConfirm';
import { walletIdentity } from '../wallet/walletIdentity';
import type { WalletChain, WalletSession } from '../wallet/types';
import { ButtonLabel, Icon, Sheet, Stepper, shortAddress } from '../ui';
import {
  SEND_NETWORKS, TransferNotSubmittedError, confirmTransfer, hasUnresolvedTransfer, prepareTransfer, recordTransfer, removeTransfer, sendEvmTransfer, sendSolanaTransfer,
  type PreparedTransfer, type SendAsset, type TransferRecord,
} from './transfer';
import { assetRows, networkDisplayName, walletAddressFor, type AssetRow } from '../receive/receiveModel';
import { vaultAddresses, type VaultSummaryInput } from '../receive/vaultTarget';
import { familyOf } from '../addressbook/family';
import { lookalike, lookalikeWarning, type LookalikeCandidate } from '../addressbook/poisoning';
import { savedEntryFor, useAddressBook } from '../addressbook/useAddressBook';
import { AddressPicker } from '../addressbook/AddressPicker';
import { AddressForm } from '../addressbook/AddressForm';
import {
  SEND_COPY, SEND_STEPS, amountCheck, balanceFor, blocksTransfer, detailsTitle, isKnownZero, maxAmount, nativeSymbol, nothingToSend,
  recognise, resultCopy, secondsLeft, sendRowState,
} from './send/sendModel';
import { AssetStep } from './send/AssetStep';
import { DetailsStep } from './send/DetailsStep';
import { ReviewStep } from './send/ReviewStep';
import { ResultStep } from './send/ResultStep';
import './transfers.css';

export interface SendFlowProps {
  initialChain: WalletChain;
  /** With an asset (Token detail), Send opens on Details for that asset. */
  initialAsset?: SendAsset;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
  /** The recipient is your Solana vault: the shell opens the vault's Deposit instead (8.6). */
  onOpenVaultDeposit: () => void;
  /** Additive to 8.1: the vault summary (8.2), to recognise the vault's addresses. */
  vaultSummary?: VaultSummaryInput | null;
  /** Additive to 8.1: "Receive" when there is nothing to send. Without it the action is omitted. */
  onReceive?: (chain: WalletChain) => void;
}

const devnetStablecoin = (chain: WalletChain, asset: SendAsset) => chain === 'solana' && asset === 'stablecoin' && SOLANA_CLUSTER === 'devnet';

export function SendFlow({ initialChain, initialAsset, returnFocusTo, onClose, onOpenVaultDeposit, vaultSummary, onReceive }: SendFlowProps) {
  const wallet = useSolaresWallet();
  const walletRef = useRef(wallet); walletRef.current = wallet;
  const requested: WalletChain = SEND_NETWORKS.some(n => n.key === initialChain) ? initialChain : PRIMARY_NETWORK;
  // An account without a wallet for that network family (EVM-only, for example) starts on its first network that has one.
  const startChain: WalletChain = wallet.authenticated && !walletAddressFor(familyOf(requested), wallet.addresses)
    ? SEND_NETWORKS.find(n => walletAddressFor(familyOf(n.key), wallet.addresses))?.key ?? requested
    : requested;
  const startAsset: SendAsset = initialAsset && !devnetStablecoin(startChain, initialAsset) ? initialAsset : 'native';
  const [chain, setChain] = useState<WalletChain>(startChain);
  const [asset, setAsset] = useState<SendAsset>(startAsset);
  const [stage, setStage] = useState<'asset' | 'details'>(initialAsset && startAsset === initialAsset ? 'details' : 'asset');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [review, setReview] = useState<PreparedTransfer | null>(null);
  const reviewSession = useRef<WalletSession | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [record, setRecord] = useState<TransferRecord | null>(null);
  const [query, setQuery] = useState('');
  const [picker, setPicker] = useState(false);
  const [saveForm, setSaveForm] = useState(false);
  const formId = `${useId()}-send`;
  const stepRef = useRef<HTMLDivElement>(null);
  const recipientRef = useRef<HTMLTextAreaElement>(null);
  const network = SEND_NETWORKS.find(n => n.key === chain)!;
  const family = familyOf(chain);
  const sender = chain === 'solana' ? wallet.addresses.solana : wallet.addresses.ethereum;
  const userId = wallet.authenticated ? wallet.userId : null;
  const { book, recents } = useAddressBook(userId);

  // Unchanged from TransferDialog: any change to the intent or the session drops the review.
  useEffect(() => { setReview(null); reviewSession.current = null; }, [sender, wallet.userId, wallet.authenticated, chain, asset, amount, recipient]);
  useEffect(() => { setRecord(null); setError(''); }, [wallet.userId, sender]);

  const rows = useMemo(() => assetRows(), []);
  const rowStates = useMemo(() => rows.map(row => ({
    row,
    state: sendRowState(row, wallet.authenticated && !!walletAddressFor(row.family, wallet.addresses), balanceFor(wallet, row.chain, row.asset)),
  })), [rows, wallet]);
  const current = rowStates.find(item => item.row.chain === chain && item.row.asset === asset)!;
  const row: AssetRow = current.row;
  const balance = current.state.balance;
  const check = amountCheck(amount, row.decimals, balance);
  const nativeBalance = balanceFor(wallet, chain, 'native');
  const feeNotice = asset === 'stablecoin' && isKnownZero(nativeBalance) ? SEND_COPY.needFee(nativeSymbol(chain), networkDisplayName(chain)) : '';

  const vault = vaultAddresses(vaultSummary);
  const saved = book.status === 'ok' ? book.entries : [];
  // Named as everywhere else: "ANTARA wallet", never "Privy" (walletIdentity).
  const own = (family === 'solana' ? wallet.solanaSigners : wallet.evmSigners).map(signer => ({ name: walletIdentity(signer, family === 'solana' ? 'solana' : 'evm').label, address: signer.address }));
  const chips = recognise(recipient, family, { saved, own, vault });
  const blocked = blocksTransfer(chips);
  const candidates: LookalikeCandidate[] = [
    ...saved.filter(entry => entry.family === family).map(entry => ({ label: entry.label, address: entry.address })),
    ...own.map(item => ({ label: item.name, address: item.address })),
    ...recents[family].map(address => ({ label: `a recent recipient (${shortAddress(address)})`, address })),
    ...(family === 'solana' && vault ? [{ label: 'Your Solana vault', address: vault.depositAddress }] : []),
  ];
  const similar = recipient.trim() ? lookalike(recipient, candidates) : null;
  const warning = similar ? lookalikeWarning(similar) : '';

  const step = record ? 3 : review ? 2 : stage === 'details' ? 1 : 0;
  const now = useNow(step === 2);
  const seconds = review ? secondsLeft(review.expires, now) : 0;

  useEffect(() => {
    // Move focus with the step: Details starts at the recipient; other steps at their content.
    if (step === 1 && !recipient) recipientRef.current?.focus();
    else stepRef.current?.focus();
    // Only a step change moves focus, so `recipient` is deliberately not a dependency.
  }, [step]);

  function chooseChain(next: WalletChain) {
    setChain(next);
    if (devnetStablecoin(next, asset)) setAsset('native');
  }
  function pick(next: AssetRow) {
    setChain(next.chain); setAsset(next.asset); setStage('details'); setError('');
  }

  async function prepare() {
    if (!sender || !wallet.authenticated || inFlight.current || blocked) return;
    inFlight.current = true;
    const session = wallet.getSession();
    setBusy(true); setError('');
    try {
      if (wallet.userId && hasUnresolvedTransfer(wallet.userId, { chain, asset, sender, recipient, amount })) throw new Error('A matching payment is already awaiting confirmation. Check Activity and your wallet before attempting another payment.');
      const provider = chain === 'solana' ? undefined : await wallet.getEvmProvider(network.id);
      const prepared = await prepareTransfer({ chain, asset, sender, recipient, amount }, provider);
      assertWalletSession(session, wallet.getSession());
      const active = chain === 'solana' ? walletRef.current.addresses.solana : walletRef.current.addresses.ethereum;
      if (!walletRef.current.authenticated || active !== sender) throw new Error('The sending wallet changed. Review the transfer again.');
      reviewSession.current = session; setReview(prepared);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to prepare this transfer.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function send() {
    if (!review || inFlight.current || record || !wallet.userId) return;
    inFlight.current = true;
    const userId = wallet.userId;
    const session = wallet.getSession();
    const isCurrent = () => { try { assertWalletSession(session, wallet.getSession()); return true; } catch { return false; } };
    setBusy(true); setError('');
    let submitted: TransferRecord | null = null;
    try {
      if (!reviewSession.current) throw new Error('Review the transfer again with your current wallet.');
      assertWalletSession(reviewSession.current, session);
      if (Date.now() >= review.expires) throw new Error('Review expired. Go back and refresh the network fee.');
      const provider = chain === 'solana' ? undefined : await wallet.getEvmProvider(network.id);
      assertWalletSession(session, wallet.getSession());
      const active = chain === 'solana' ? walletRef.current.addresses.solana : walletRef.current.addresses.ethereum;
      if (!walletRef.current.authenticated || walletRef.current.userId !== userId || active !== review.sender) throw new Error('The sending wallet changed. Review the transfer again.');
      if (hasUnresolvedTransfer(userId, review)) throw new Error('A matching payment is already pending. Check Activity.');
      // Persist before invoking any wallet: a timeout can occur after the RPC
      // accepted a transaction but before its hash reaches this page.
      const attempt: TransferRecord = { id: crypto.randomUUID(), chain, symbol: review.symbol, amount: review.amount, recipient: review.recipient, sender: review.sender, nonce: review.evm?.nonce, hash: '', status: 'submission-unknown', createdAt: new Date().toISOString() };
      recordTransfer(userId, attempt, true);
      submitted = attempt;
      setRecord(submitted);
      const hash = review.solana ? await sendSolanaTransfer(review, wallet.sendSolanaTransaction) : await sendEvmTransfer(review, provider!);
      submitted = { ...submitted, hash, status: 'submitted' };
      if (isCurrent()) setRecord(submitted); recordTransfer(userId, submitted);
      const status = await confirmTransfer(review, hash, provider);
      submitted = { ...submitted, status };
      if (isCurrent()) setRecord(submitted); recordTransfer(userId, submitted);
      void wallet.refetchBalances();
    } catch (e) {
      const rejected = !!e && typeof e === 'object' && 'code' in e && e.code === 4001;
      if (submitted?.status === 'submission-unknown' && (rejected || e instanceof TransferNotSubmittedError)) { removeTransfer(userId, submitted.id); if (isCurrent()) setRecord(null); submitted = null; }
      // Expired on Solana: it never landed and never can, so the attempt is dropped and a fresh review is safe.
      if (submitted && e instanceof SolanaTransactionExpiredError) { removeTransfer(userId, submitted.id); if (isCurrent()) { setRecord(null); setReview(null); reviewSession.current = null; } submitted = null; }
      if (e instanceof TransferNotSubmittedError && isCurrent()) { setReview(null); reviewSession.current = null; }
      // A network timeout after broadcast is never presented as a failed send.
      if (isCurrent()) setError(submitted ? submitted.hash ? 'Submitted. Confirmation is still pending; follow the explorer link. Do not send this payment again.' : 'The wallet outcome is unknown. Check your wallet and account history before making another payment. Automatic retry is disabled.' : e instanceof Error ? e.message : 'The wallet could not submit this transfer.');
    } finally { inFlight.current = false; setBusy(false); }
  }

  if (!wallet.authenticated) {
    return (
      <Sheet title={SEND_COPY.title} closeLabel={SEND_COPY.closeLabel} onClose={onClose} returnFocusTo={returnFocusTo} className="send-sheet">
        <div className="ui-card send-signed-out" data-screen="send">
          <span className="send-signed-out-icon" aria-hidden="true"><Icon name="up" size={22} /></span>
          <p>{SEND_COPY.signedOut}</p>
          <button type="button" className="ui-btn-primary" disabled={!wallet.configured} onClick={wallet.login}>{wallet.configured ? SEND_COPY.signIn : SEND_COPY.setupRequired}</button>
        </div>
      </Sheet>
    );
  }

  const title = record ? resultCopy(record.status).title : review ? SEND_COPY.reviewTitle : stage === 'details' ? detailsTitle(row) : SEND_COPY.title;
  const back = step === 1
    ? <button type="button" className="ui-icon-btn" aria-label="Back to assets" disabled={busy} onClick={() => { setStage('asset'); setError(''); }}><Icon name="back" /></button>
    : step === 2
      ? <button type="button" className="ui-icon-btn" aria-label={SEND_COPY.backToDetails} disabled={busy} onClick={() => setReview(null)}><Icon name="back" /></button>
      : undefined;
  const recipientSaved = record ? !!savedEntryFor(book, familyOf(record.chain as WalletChain), record.recipient) : true;
  const canSaveRecipient = !!record && !!userId && book.status === 'ok' && !recipientSaved && (record.status === 'submitted' || record.status === 'confirmed');
  const nothing = nothingToSend(rowStates.map(item => item.state));
  const footer = step === 0 ? (
    nothing ? undefined : <>
      <button type="button" className="ui-btn" onClick={onClose}>{SEND_COPY.cancel}</button>
      <button type="button" className="ui-btn-primary" disabled={!current.state.selectable} onClick={() => pick(row)}>{SEND_COPY.continue} <Icon name="arrow" size={16} /></button>
    </>
  ) : step === 1 ? <>
    <button type="button" className="ui-btn" disabled={busy} onClick={onClose}>{SEND_COPY.cancel}</button>
    <button type="submit" form={formId} className="ui-btn-primary" aria-busy={busy || undefined} disabled={busy || !sender || !amount || !recipient || check === 'over' || blocked}>
      <ButtonLabel busy={busy} label={SEND_COPY.review} busyLabel={SEND_COPY.reviewBusy} />
    </button>
  </> : step === 2 ? <>
    <button type="button" className="ui-btn" disabled={busy} onClick={() => setReview(null)}>{SEND_COPY.backToDetails}</button>
    <button type="button" className="ui-btn-primary" aria-busy={busy || undefined} disabled={busy || seconds <= 0} onClick={() => void send()}>
      <ButtonLabel busy={busy} label={SEND_COPY.confirm} busyLabel={SEND_COPY.confirmBusy} />
    </button>
  </> : <>
    {canSaveRecipient && <button type="button" className="ui-btn" disabled={busy} onClick={() => setSaveForm(true)}><Icon name="book" size={16} /> {SEND_COPY.saveAddress}</button>}
    <button type="button" className="ui-btn-primary" disabled={busy} onClick={onClose}><ButtonLabel busy={busy} label={SEND_COPY.done} busyLabel={SEND_COPY.doneBusy} /></button>
  </>;

  return (
    <Sheet
      title={title}
      closeLabel={SEND_COPY.closeLabel}
      onClose={onClose}
      busy={busy}
      returnFocusTo={returnFocusTo}
      fullScreenNarrow
      headerStart={back}
      footer={footer}
      className="send-sheet"
    >
      <div ref={stepRef} tabIndex={-1} className="send-step" data-screen="send" data-step={SEND_STEPS[step].toLowerCase()}>
        <Stepper steps={SEND_STEPS} current={step} className="send-stepper" />
        {step === 0 && (
          <AssetStep
            rows={rowStates}
            chain={chain}
            asset={asset}
            selected={current}
            onChain={chooseChain}
            onAsset={setAsset}
            query={query}
            onQuery={setQuery}
            onPick={pick}
            nothing={nothing}
            onReceive={onReceive && (() => onReceive(chain))}
            balancesLoading={wallet.balancesLoading}
            onRetry={() => void wallet.refetchBalances()}
          />
        )}
        {step === 1 && (
          <DetailsStep
            formId={formId}
            row={row}
            busy={busy}
            recipient={recipient}
            onRecipient={value => { setRecipient(value); setError(''); }}
            recipientRef={recipientRef}
            onOpenBook={() => setPicker(true)}
            chips={chips}
            warning={warning}
            vaultHandoff={chips.some(chip => chip.kind === 'vault') ? 'deposit' : chips.some(chip => chip.kind === 'vault-config') ? 'config' : null}
            onOpenVaultDeposit={onOpenVaultDeposit}
            amount={amount}
            onAmount={value => { setAmount(value); setError(''); }}
            balance={balance}
            check={check}
            max={maxAmount(asset, balance)}
            feeNotice={feeNotice}
            nativeSymbol={nativeSymbol(chain)}
            onSubmit={() => void prepare()}
            balancesLoading={wallet.balancesLoading}
            onRetry={() => void wallet.refetchBalances()}
          />
        )}
        {step === 2 && review && <ReviewStep review={review} row={row} chips={chips} warning={warning} seconds={seconds} />}
        {step === 3 && record && <ResultStep record={record} />}
        {error && <p className="ui-alert" role="alert">{error}</p>}
      </div>
      {picker && (
        <AddressPicker
          family={family}
          exclude={sender}
          vaultSummary={vaultSummary}
          onClose={() => setPicker(false)}
          onPick={choice => { setRecipient(choice.address); setPicker(false); setError(''); }}
        />
      )}
      {saveForm && record && userId && (
        <AddressForm
          privyUserId={userId}
          initial={{ family: familyOf(record.chain as WalletChain), address: record.recipient }}
          lockFamily
          onClose={() => setSaveForm(false)}
        />
      )}
    </Sheet>
  );
}

/** The current time, ticking every second while `active` (the review countdown). */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
