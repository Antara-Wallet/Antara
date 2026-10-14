import {
  MAX_FUNDING_UNITS, evmNetworkFeeCap, formatAmount, isFundingAddress, isTerminal, sameAddress, tokenFor, tokenLabel, tradeNetwork,
  type ReviewedQuote, type TradeNetwork, type TradeRecord,
} from './model';

/**
 * Review and tracking text for Relay swaps (docs/RELAY_POLICY_2026-10.md section 5).
 * Every label comes from the network registry, never from quote-supplied symbols.
 * The terms are disclosed as they are: never as "protected", "guaranteed" or "insured".
 */

/**
 * The server's per-swap bound, in whole funding-stablecoin units: the protocol sanity ceiling (100,000). Owner
 * decision 2026-10-13: there is no other per-swap cap and no daily swap cap.
 */
export type RelayLimits = { tradeUnits: bigint };
export type RelayAvailability = { configured: boolean; limits: RelayLimits | null; error: string };
export const RELAY_POLICY_MODE = 'verified-funding-origin';
const UNITS = /^[1-9]\d{0,5}$/;

/** Reads the public `/config` response. A missing, malformed or out-of-range per-swap bound keeps swaps disabled; a daily value is ignored. */
export function parseRelayConfig(input: unknown): RelayAvailability {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { configured: false, limits: null, error: 'The ANTARA connection is unavailable. Check your connection and try again.' };
  const config = input as Record<string, unknown>;
  const configured = config.configured === true;
  if (typeof config.swapLimitsError === 'string' && config.swapLimitsError) {
    return { configured, limits: null, error: config.swapLimitsError.replace(/[\p{C}]/gu, '').slice(0, 200) };
  }
  if (config.mode !== RELAY_POLICY_MODE) return { configured, limits: null, error: 'This ANTARA server does not support the current swap terms yet. Swaps stay disabled.' };
  const trade = typeof config.maxTradeUnits === 'string' && UNITS.test(config.maxTradeUnits) ? BigInt(config.maxTradeUnits) : 0n;
  if (trade < 1n || trade > MAX_FUNDING_UNITS) {
    return { configured, limits: null, error: 'The swap terms are unavailable. Swaps stay disabled.' };
  }
  return { configured, limits: { tradeUnits: trade }, error: '' };
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
/** Exact amount with grouped whole units ("1,000.000000000000000001"); never rounded. */
export function formatExactGroupedAmount(value: string, decimals: number): string {
  if (!/^\d+$/.test(value)) return '0';
  const scale = 10n ** BigInt(decimals);
  const whole = (BigInt(value) / scale).toLocaleString('en-US');
  const fraction = decimals === 0 ? '' : (BigInt(value) % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
/**
 * Local date and time of an order deadline (Unix seconds), for example "Oct 20, 2026, 3:37 AM UTC".
 * `dateStyle`/`timeStyle` cannot be combined with `timeZoneName`, so the fields are listed explicitly.
 */
export function formatFillDeadline(seconds: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(seconds * 1000));
}
function feeLimit(source: TradeNetwork): { row: string; sentence: string } {
  if (source.vm === 'solana') return { row: 'Priority fee up to 0.02 SOL', sentence: 'priority fees above 0.02 SOL' };
  const cap = `${formatAmount(evmNetworkFeeCap(source).toString(), source.nativeDecimals)} ${source.nativeSymbol}`;
  return { row: `Up to ${cap} per transaction`, sentence: `network fees above ${cap}` };
}
export type SettlementRow = { label: string; value: string };
export type SettlementDisclosure = { rows: SettlementRow[]; paragraphs: string[]; acknowledgement: string };
export const SETTLEMENT_ACKNOWLEDGEMENT = 'I understand this swap relies on Relay and I could receive less than I deposited, or nothing.';

/** The review shown before Confirm, from a reviewed quote that already passed `verifyReviewedQuote`. `_limits` is kept for callers; no swap cap is shown. */
export function describeSettlement(reviewed: ReviewedQuote, _limits: RelayLimits | null, locale?: string, now = Date.now()): SettlementDisclosure {
  const { intent } = reviewed;
  const source = tradeNetwork(intent.originChainId);
  const destination = tradeNetwork(intent.destinationChainId);
  const token = tokenFor(destination, intent.destinationToken);
  const output = tokenLabel(token);
  const funding = source.funding;
  const order = reviewed.quote.protocol.v2.orderData;
  const payment = order.output.payments[0];
  const deadline = formatFillDeadline(order.output.deadline, locale);
  const currencyLabel = (currency: string) => isFundingAddress(destination, currency) ? destination.funding.label
    : sameAddress(currency, destination.native, destination.vm) ? destination.nativeSymbol
    : sameAddress(currency, token.address, destination.vm) ? output : 'an unrecognized token';
  // Distinct destination alternatives only; an option identical to the origin refund is listed once.
  const seen = new Set<string>();
  const alternatives: string[] = [];
  for (const refund of order.inputs[0].refunds) {
    const origin = refund.chainId === source.protocol && sameAddress(refund.recipient, intent.user, source.vm) && isFundingAddress(source, refund.currency);
    if (origin) continue;
    const key = destination.vm === 'ethereum' ? `${refund.chainId}|${refund.recipient.toLowerCase()}|${refund.currency.toLowerCase()}` : `${refund.chainId}|${refund.recipient}|${refund.currency}`;
    if (seen.has(key)) continue;
    seen.add(key);
    alternatives.push(`, or to your ${destination.name} wallet · ${shortAddress(refund.recipient)} in ${currencyLabel(refund.currency)}`);
  }
  const fee = feeLimit(source);
  const remaining = Math.max(0, Math.floor((reviewed.expiresAt - now) / 1000));
  const rows: SettlementRow[] = [
    { label: 'You pay', value: `${formatExactGroupedAmount(intent.amount, funding.decimals)} ${funding.label} on ${source.name}` },
    { label: 'Expected', value: `${formatAmount(payment.expectedAmount, token.decimals)} ${output} on ${destination.name}` },
    { label: 'Minimum if filled', value: `${formatAmount(payment.minimumAmount, token.decimals)} ${output}` },
    { label: 'Receive in', value: `Your ${destination.name} wallet · ${shortAddress(intent.recipient)}` },
    { label: 'Fill window', value: `Until ${deadline} (up to 7 days)` },
    { label: 'If not filled', value: `Refund to your ${source.name} wallet · ${shortAddress(intent.user)} in ${funding.label}${alternatives.join('')}` },
    { label: 'Quote valid', value: `${remaining}s` },
    { label: 'Slippage', value: intent.slippageBps === 50 ? '0.5%' : '1%' },
    { label: 'Network fee limit', value: fee.row },
    { label: 'Visibility', value: 'Public on-chain transaction' },
  ];
  const paragraphs = [
    `Relay can fill this order until ${deadline} (up to 7 days). Until Relay fills or refunds it, your ${funding.label} is held in Relay's depository on ${source.name}. If Relay neither fills nor refunds by ${deadline}, recovering the deposit requires Relay's protocol recovery, which ANTARA does not yet support in the app.`,
    `Refund amount is not guaranteed by the order; it can be reduced by gas or not sent if smaller than gas. Relay's solver can also mark the order refunded and pay less than you deposited, or nothing. Only swap an amount you can afford to lose.`,
    `This is a public on-chain transaction. Your wallet addresses, amounts and tokens are visible on ${source.name}${source.id !== destination.id ? ` and ${destination.name}` : ''}.`,
    `Swap fees are included. Your wallet shows the network fee before you sign. ANTARA refuses ${fee.sentence}.`,
  ];
  return { rows, paragraphs, acknowledgement: SETTLEMENT_ACKNOWLEDGEMENT };
}


/**
 * How long a saved swap blocks a new swap from the same source network. Unknown deposit state always
 * blocks (a second swap could duplicate it). A known deposit in escrow blocks for 30 minutes, which covers
 * confirmation and Relay's normal fill time, so a 7-day fill window cannot lock a network for a week.
 */
export const SOURCE_BLOCK_MS = 30 * 60_000;
export function blocksNewSwap(record: TradeRecord, now = Date.now()): boolean {
  if (isTerminal(record.status)) return false;
  if (record.status === 'waiting' || record.status === 'depositing' || record.status === 'unresolved') return true;
  return now - record.createdAt < SOURCE_BLOCK_MS;
}
/** Relay has reported the deposit (pending, submitted or delayed with a settlement timestamp). */
export function depositReported(record: TradeRecord): boolean {
  return (record.status === 'pending' || record.status === 'submitted' || record.status === 'delayed') && record.settlementUpdatedAt !== undefined;
}
/**
 * Deposit evidence: the wallet returned the deposit hash, or Relay reported the deposit
 * (`pending`, `submitted` or `delayed`; `depositReported` is the Relay-confirmed subset).
 * `waiting`, `depositing` and `unresolved` records may have no deposit at all, because the order is
 * saved before the wallet prompt opens (the app may close while it is open, or the wallet may fail).
 */
function depositKnown(record: TradeRecord): boolean {
  return record.status === 'pending' || record.status === 'submitted' || record.status === 'delayed';
}
/**
 * Fill-window line for a tracked, non-terminal record that kept its order. Older records return null.
 * Custody in Relay's depository is stated only with deposit evidence; otherwise the wording stays
 * conditional and the record keeps its own status label ("Awaiting deposit", "Status unresolved").
 */
export function fillWindowNote(record: TradeRecord, now = Date.now(), locale?: string): { notFilled: boolean; detail: string } | null {
  const deadline = record.order?.orderData?.output?.deadline;
  if (isTerminal(record.status) || !Number.isSafeInteger(deadline)) return null;
  const when = formatFillDeadline(deadline!, locale);
  const open = now < deadline! * 1000;
  if (!depositKnown(record)) {
    return open
      ? { notFilled: false, detail: `If your deposit was submitted, Relay can fill it until ${when}.` }
      : { notFilled: false, detail: `Fill window ended ${when}. Check status. If a deposit was made, it stays in Relay's depository until Relay refunds it or protocol recovery is used.` };
  }
  if (open) return { notFilled: false, detail: `Relay can fill until ${when}` };
  return { notFilled: true, detail: `Not filled by ${when}. Your deposit stays in Relay's depository until Relay refunds it or protocol recovery is used.` };
}
