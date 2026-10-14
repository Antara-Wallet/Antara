import { useEffect, useRef, useState } from 'react';
import { useSolaresWallet } from '../wallet';
import { PRIMARY_NETWORK, byKey } from '../networks';
import { Icon } from '../ui';
import { executeTrade, fetchQuote, loadTradeHistory, persistTrade, refreshTrade, RELAY_API } from './client';
import { formatAmount, formatIntentAmount, isTerminal, parseFundingAmount, receivingEnabled, relayNetwork, sameAddress, tokenFor, tradeNetwork, type ReviewedQuote, type TradeIntent, type TradeRecord, type TradeToken } from './model';
import { blocksNewSwap, depositReported, describeSettlement, parseRelayConfig, type RelayLimits } from './review';
import { TokenPicker } from './TokenPicker';
import { PayCard } from './ui/PayCard';
import { ReceiveCard } from './ui/ReceiveCard';
import { SwapReviewPanel } from './ui/SwapReviewPanel';
import { SwapSettingsSheet } from './ui/SwapSettingsSheet';
import { SwapStatusList } from './ui/SwapStatusList';
import { chipAmounts, fundingBalance, nativeBalance, nativeFeeNotice, slippageLabel, swapActionLabel, typedUnits } from './ui/swapModel';
import './relay.css';

function errorText(error: unknown) { return error instanceof Error ? error.message : 'The swap could not be loaded.'; }
/** Solana is the primary network: swaps open on Solana USDC. */
const PRIMARY_CHAIN_ID = byKey(PRIMARY_NETWORK).relay.chainId;
/** Saved routes on removed networks (Arbitrum, Polygon) are display-only: never polled, refreshed or re-quoted. */
function isLegacyRecord(record: TradeRecord) {
  return relayNetwork(record.intent.originChainId).legacy || relayNetwork(record.intent.destinationChainId).legacy;
}

/**
 * Swap (docs/UI_ARGUS_PARITY.md 6.10): ARGUS S15's pay/receive structure on Relay. Pay is always the
 * pay network's pinned funding stablecoin; the review shows `describeSettlement()` verbatim and Confirm
 * waits for its acknowledgement. Every `persistTrade` call (relay/history.ts) dispatches the window
 * event `solares:relay-activity` itself, so Activity re-reads after each saved swap update.
 */
export function TradeWorkspace({ initialSourceChainId, initialReceive }: { initialSourceChainId?: number; initialReceive?: TradeToken } = {}) {
  const wallet = useSolaresWallet();
  const [sourceId, setSourceId] = useState<number>(() => startingSource(initialSourceChainId, initialReceive));
  const [destinationId, setDestinationId] = useState<number>(() => startingReceive(initialSourceChainId, initialReceive).chainId);
  const [destinationToken, setDestinationToken] = useState<TradeToken>(() => startingReceive(initialSourceChainId, initialReceive));
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState(50);
  const [relayConfigured, setRelayConfigured] = useState<boolean | null>(null);
  const [configError, setConfigError] = useState('');
  const [limits, setLimits] = useState<RelayLimits | null>(null);
  const [quote, setQuote] = useState<ReviewedQuote | null>(null);
  // Unchecked for every new quote; Confirm stays disabled until the Relay terms are acknowledged.
  const [acknowledged, setAcknowledged] = useState(false);
  const [records, setRecords] = useState<TradeRecord[]>(loadTradeHistory);
  const [busy, setBusy] = useState<'quote' | 'execute' | null>(null);
  const [error, setError] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lastTradeId, setLastTradeId] = useState('');
  const [now, setNow] = useState(Date.now());
  const [refreshing, setRefreshing] = useState('');
  // Settling swaps whose deposit Relay already reported, and which the user chose to stop blocking new swaps.
  const [released, setReleased] = useState<string[]>([]);
  const [confirmRelease, setConfirmRelease] = useState('');
  const queryVersion = useRef(0);
  const mounted = useRef(true);
  const source = tradeNetwork(sourceId);
  const destination = tradeNetwork(destinationId);
  const funding = source.funding;
  const receiveToken = tokenFor(destination, destinationToken);
  const sourceAddress = wallet.addresses[source.vm];
  const recipient = wallet.addresses[destination.vm];
  const sourceBalance = wallet.authenticated ? fundingBalance(wallet.balances, source) : undefined;
  // A missing balance is unknown (signed out, loading or failed): PayCard shows a muted "0.00" stand-in
  // with the reason, never a dash, and it never counts as a real zero (chips and checks stay off).
  const balanceLoading = wallet.authenticated && (wallet.balancesLoading || !wallet.ready);
  const balanceText = sourceBalance ? `${formatAmount(sourceBalance.raw, funding.decimals)} ${funding.label}` : null;
  const balanceHint = balanceText ? undefined : !wallet.authenticated ? 'Sign in to load balances' : balanceLoading ? 'Loading balance' : `${funding.label} balance could not be loaded`;
  const balanceFailed = !balanceText && wallet.authenticated && !balanceLoading;
  const visibleRecords = records.filter((record) => {
    const network = relayNetwork(record.intent.originChainId);
    const address = wallet.addresses[network.vm];
    return address && sameAddress(record.intent.user, address, network.vm);
  });
  const pending = visibleRecords.filter((record) => !isTerminal(record.status) && !isLegacyRecord(record));
  const expired = Boolean(quote && now >= quote.expiresAt);
  const liveReady = wallet.configured && wallet.authenticated && relayConfigured === true && limits !== null && Boolean(sourceAddress && recipient);
  const releasedRecord = (record: TradeRecord) => released.includes(record.requestId) && depositReported(record);
  // Unknown deposit state always blocks; a known deposit in escrow blocks for 30 minutes unless the user lifts it.
  const sourcePending = pending.some((record) => record.intent.originChainId === sourceId && blocksNewSwap(record, now) && !releasedRecord(record));
  // 50% and Max use half and all of the balance (no swap cap; only the 100,000-unit sanity ceiling); both stay disabled while the swap terms or the balance are unknown.
  const chips = chipAmounts(sourceBalance?.raw, limits, funding.decimals);
  // Only a known balance can refuse an amount; with an unknown balance the quote and the wallet decide.
  const typed = typedUnits(amount.trim(), funding.decimals);
  const insufficient = Boolean(sourceBalance && typed !== null && typed > BigInt(sourceBalance.raw));
  const feeNotice = wallet.authenticated ? nativeFeeNotice(nativeBalance(wallet.balances, source), source) : null;

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    fetch(`${RELAY_API}/config`, { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error('The ANTARA connection is unavailable. Check your connection and try again.'); return response.json(); })
      .then((config: unknown) => {
        // Missing or unsupported swap terms keep Review disabled; the server enforces the same sanity ceiling.
        const parsed = parseRelayConfig(config);
        setLimits(parsed.limits);
        setRelayConfigured(parsed.configured && parsed.limits !== null);
        setConfigError(parsed.configured ? parsed.error : '');
      })
      .catch((failure: unknown) => { if (!controller.signal.aborted) { setRelayConfigured(false); setLimits(null); setConfigError(errorText(failure)); } });
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { controller.abort(); window.clearInterval(timer); mounted.current = false; };
  }, []);
  useEffect(() => {
    queryVersion.current += 1;
    setQuote(null); setAcknowledged(false); setError('');
  }, [sourceId, destinationId, destinationToken, amount, slippage, sourceAddress, recipient, wallet.authenticated, wallet.userId]);
  useEffect(() => {
    if (!wallet.authenticated || pending.length === 0 || busy === 'execute') return;
    let alive = true;
    let polling = false;
    async function poll() {
      if (!alive || polling) return;
      polling = true;
      try {
      const latest = loadTradeHistory().filter((record) => {
        const network = relayNetwork(record.intent.originChainId);
        const address = wallet.addresses[network.vm];
        return address && sameAddress(record.intent.user, address, network.vm) && !isTerminal(record.status) && !isLegacyRecord(record);
      }).slice(0, 5);
      for (const record of latest) {
        if (!alive) return;
        try {
          const next = await refreshTrade(wallet, record);
          if (alive) setRecords(persistTrade(next));
          if (next.status === 'success' || next.status === 'refund') void wallet.refetchBalances();
        } catch { /* Polling errors leave the last known status intact. Manual refresh explains the issue. */ }
      }
      } finally { polling = false; }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 15_000);
    return () => { alive = false; window.clearInterval(timer); };
    // Wallet methods are context callbacks; polling resets only on identity/state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.authenticated, wallet.addresses.solana, wallet.addresses.ethereum, pending.length, busy]);

  async function review() {
    setError('');
    if (!wallet.authenticated && wallet.configured) { wallet.login(); return; }
    if (!liveReady || !limits) return;
    const version = queryVersion.current;
    setBusy('quote');
    try {
      // Base units of this network's funding stablecoin (18 decimals for Binance-Peg USDC, 6 otherwise), within the protocol sanity ceiling.
      const atomicAmount = parseFundingAmount(amount, funding, limits.tradeUnits);
      if (sourceBalance && BigInt(atomicAmount) > BigInt(sourceBalance.raw)) throw new Error(`Your ${source.name} ${funding.label} balance is below this amount.`);
      const intent: TradeIntent = { originChainId: sourceId, destinationChainId: destinationId, user: sourceAddress!, recipient: recipient!, amount: atomicAmount, destinationToken, slippageBps: slippage };
      const result = await fetchQuote(wallet, intent);
      if (mounted.current && version === queryVersion.current) { setQuote(result); setAcknowledged(false); }
    } catch (failure) { if (mounted.current && version === queryVersion.current) setError(errorText(failure)); }
    finally { if (mounted.current) setBusy(null); }
  }
  async function execute() {
    if (!quote || expired || busy || !acknowledged) return;
    setBusy('execute'); setError('');
    try {
      const result = await executeTrade(wallet, quote, (record) => { if (mounted.current) setRecords(persistTrade(record)); });
      if (mounted.current) { setRecords(persistTrade(result)); setLastTradeId(result.requestId); setQuote(null); setAcknowledged(false); }
      void wallet.refetchBalances();
    } catch (failure) { if (mounted.current) setError(errorText(failure)); }
    finally { if (mounted.current) setBusy(null); }
  }
  async function refresh(record: TradeRecord) {
    setRefreshing(record.requestId); setError('');
    try { const next = await refreshTrade(wallet, record); setRecords(persistTrade(next)); if (isTerminal(next.status)) void wallet.refetchBalances(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setRefreshing(''); }
  }

  function chooseSource(id: number) {
    setSourceId(id);
    if (destinationId === sourceId || !receivingEnabled(id, destinationId)) { setDestinationId(id); setDestinationToken(tokenFor(tradeNetwork(id), 'native')); }
  }
  function chooseDestination(id: number) {
    setDestinationId(id); setDestinationToken(tokenFor(tradeNetwork(id), 'native'));
  }
  function chooseToken(token: TradeToken) {
    setDestinationId(token.chainId); setDestinationToken(token); setPickerOpen(false);
  }
  const sameCurrency = sourceId === destinationId && sameAddress(receiveToken.address, funding.address, source.vm);
  // Cross-network routes into BNB Smart Chain or Robinhood Chain have no captured order yet; the validator refuses them too.
  const receiveBlocked = !receivingEnabled(sourceId, destinationId);
  const tracked = visibleRecords.filter(record => !isTerminal(record.status) || record.status === 'failure' || record.requestId === lastTradeId);
  const disclosure = quote && limits ? describeSettlement(quote, limits, undefined, now) : null;
  const actionLabel = swapActionLabel({
    busy, configured: wallet.configured, authenticated: wallet.authenticated, sourcePending, sameCurrency, receiveBlocked, relayConfigured, liveReady, insufficient,
    quote: quote ? (expired ? 'expired' : 'valid') : 'none', quoteAmount: quote ? formatIntentAmount(quote.intent) : '', fundingLabel: funding.label,
  });
  const actionDisabled = busy !== null || !wallet.configured || !wallet.ready
    || (wallet.authenticated && (!liveReady || sourcePending || !amount || sameCurrency || receiveBlocked || insufficient))
    || (quote !== null && !expired && !acknowledged);
  const unavailable = wallet.authenticated && !liveReady
    ? configError || (relayConfigured === false ? 'Swaps are not available yet.' : !sourceAddress || !recipient ? `Your ${sourceAddress ? destination.name : source.name} wallet is not ready.` : 'Checking swap availability…')
    : '';

  return <section className="swap-screen" aria-label={`Swap ${funding.label}`}>
    <header className="swap-head">
      <div>
        <h2>Trade from your wallet</h2>
        <p>{funding.label} in. The token you want out.</p>
      </div>
      <button type="button" className="ui-icon-btn swap-settings-button" aria-label="Swap settings" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>
        <Icon name="settings" size={19} />
      </button>
    </header>
    <div className="trade-card swap-card ui-card">
      <fieldset disabled={busy === 'execute'}>
        <legend className="ui-visually-hidden">Swap details</legend>
        <PayCard
          amount={amount}
          onAmount={setAmount}
          source={source}
          onSource={chooseSource}
          balanceText={balanceText}
          balanceHint={balanceHint}
          balanceFailed={balanceFailed}
          onRetryBalance={() => void wallet.refetchBalances()}
          half={chips.half}
          max={chips.max}
          insufficient={insufficient}
        />
        {/* Decorative, never a flip: pay is always the pay network's stablecoin. */}
        <div className="swap-divider" aria-hidden="true"><span><Icon name="down" size={16} /></span></div>
        <ReceiveCard
          sourceChainId={sourceId}
          destination={destination}
          onDestination={chooseDestination}
          token={receiveToken}
          estimate={quote ? formatAmount(quote.quote.details.currencyOut.amount, receiveToken.decimals) : null}
          onPickToken={() => setPickerOpen(true)}
        />
      </fieldset>
      {disclosure && <SwapReviewPanel disclosure={disclosure} expired={expired} acknowledged={acknowledged} locked={expired || busy !== null} onAcknowledge={setAcknowledged} />}
      {error && <p role="alert" className="ui-alert swap-error">{error}</p>}
      {unavailable && <p className="trade-notice swap-notice">{unavailable}</p>}
      {feeNotice && <p className="swap-notice swap-fee-notice" role="status">{feeNotice}</p>}
      <button type="button" className="ui-btn-primary swap-submit" aria-busy={busy !== null || undefined} onClick={() => void (quote && !expired ? execute() : review())} disabled={actionDisabled}>{actionLabel}</button>
      <p className="swap-attribution">Powered by Relay · Slippage {slippageLabel(slippage)}</p>
    </div>
    <SwapStatusList
      records={tracked}
      now={now}
      refreshing={refreshing}
      executing={busy === 'execute'}
      released={released}
      confirmRelease={confirmRelease}
      onRefresh={record => void refresh(record)}
      onAskRelease={setConfirmRelease}
      onRelease={requestId => { setReleased(list => [...list, requestId]); setConfirmRelease(''); }}
    />
    {pickerOpen && <TokenPicker selected={receiveToken} sourceChainId={sourceId} onSelect={chooseToken} onClose={() => setPickerOpen(false)} />}
    {settingsOpen && <SwapSettingsSheet slippage={slippage} onSlippage={setSlippage} onClose={() => setSettingsOpen(false)} />}
  </section>;
}

/** The pay network to open on: a supported `initialSourceChainId`, else Solana (registry order). */
function startingSource(initialSourceChainId?: number, initialReceive?: TradeToken): number {
  const preferred = initialSourceChainId ?? initialReceive?.chainId;
  return preferred !== undefined && isTradeNetwork(preferred) ? preferred : PRIMARY_CHAIN_ID;
}
/** The receive token to open on: `initialReceive` when it can be received from the pay network, else the pay network's native coin. */
function startingReceive(initialSourceChainId?: number, initialReceive?: TradeToken): TradeToken {
  const sourceId = startingSource(initialSourceChainId, initialReceive);
  if (initialReceive && isTradeNetwork(initialReceive.chainId) && receivingEnabled(sourceId, initialReceive.chainId)) return initialReceive;
  return tokenFor(tradeNetwork(sourceId), 'native');
}
function isTradeNetwork(chainId: number): boolean {
  try { tradeNetwork(chainId); return true; } catch { return false; }
}
