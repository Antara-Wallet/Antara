/**
 * Pure view logic for the Swap screen (docs/UI_ARGUS_PARITY.md 6.10). No React, no I/O:
 * balances, chip amounts, the submit label ladder and status tones. The Relay policy
 * itself (limits, review text, validation) stays in ../review.ts and ../validation.ts.
 */
import type { WalletBalance } from '../../wallet/types';
import { RELAY_TRADE_CEILING_UNITS, sameAddress, type TradeNetwork, type TradeStatus } from '../model';
import type { RelayLimits } from '../review';

/** The neutral line above every swap review (ARGUS showed "Not Protected" on swap confirms; this is the honest form). */
export const SPENDING_WALLET_LINE = 'Spending wallet · funds here are not protected by your vault.';
/** Settings sheet: the terms are disclosed in full in the review, never paraphrased here. */
export const SETTINGS_TERMS_NOTE = 'The full order terms, including the fill window and what happens if Relay does not fill the order, are shown in the review before you confirm.';
/** The only slippage values the validator accepts (validation.ts: 50 or 100 bps). */
export const SLIPPAGE_OPTIONS = Object.freeze([{ bps: 50, label: '0.5%' }, { bps: 100, label: '1%' }] as const);
export function slippageLabel(bps: number): string {
  return SLIPPAGE_OPTIONS.find(option => option.bps === bps)?.label ?? `${bps / 100}%`;
}

/** The pinned funding-stablecoin balance only: matched by network, contract and decimals, never by ticker. */
export function fundingBalance(balances: readonly WalletBalance[], network: TradeNetwork): WalletBalance | undefined {
  return balances.find(balance => String(balance.chain) === network.key && !balance.isNative && typeof balance.address === 'string' &&
    sameAddress(balance.address, network.funding.address, network.vm) && balance.decimals === network.funding.decimals && /^\d+$/.test(balance.raw));
}

/** The network's native balance in base units when the wallet reported it; null is unknown (signed out, loading or failed), never zero. */
export function nativeBalance(balances: readonly WalletBalance[], network: TradeNetwork): bigint | null {
  const entry = balances.find(balance => String(balance.chain) === network.key && balance.isNative && balance.decimals === network.nativeDecimals && /^\d+$/.test(balance.raw));
  return entry ? BigInt(entry.raw) : null;
}

/**
 * A typed amount in base units of `decimals`, without any cap, or null when it is not a plain
 * decimal. Same accepted form as relay/model.ts `parseFundingAmount` (at most 9 whole digits and
 * `decimals` fraction digits), so "Not enough" never disagrees with the quote's own parsing.
 */
export function typedUnits(text: string, decimals: number): bigint | null {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const pattern = new RegExp(`^(?:0|[1-9]\\d{0,8})${decimals > 0 ? `(?:\\.\\d{1,${decimals}})?` : ''}$`);
  if (!pattern.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/**
 * The 50% and Max chip amounts in base units: half and all of the known balance. Owner decision
 * 2026-10-13: ANTARA sets no swap cap, so the only bound is the protocol sanity ceiling the server
 * reports in `/relay/config` (100,000 units), which matters only for a balance above it. Null (the
 * chip is disabled) while the swap terms or the balance are unknown, or when the amount would be zero.
 */
export function chipAmounts(balanceRaw: string | null | undefined, limits: RelayLimits | null, decimals: number): { half: bigint | null; max: bigint | null } {
  if (!limits || typeof balanceRaw !== 'string' || !/^\d+$/.test(balanceRaw) || limits.tradeUnits < 1n || limits.tradeUnits > RELAY_TRADE_CEILING_UNITS) return { half: null, max: null };
  const cap = limits.tradeUnits * 10n ** BigInt(decimals);
  const balance = BigInt(balanceRaw);
  const capped = (value: bigint) => { const amount = value < cap ? value : cap; return amount > 0n ? amount : null; };
  return { half: capped(balance / 2n), max: capped(balance) };
}


/** "You need some ETH on Base to pay the network fee." Only for a native balance known to be zero. */
export function nativeFeeNotice(native: bigint | null, network: TradeNetwork): string | null {
  return native === 0n ? `You need some ${network.nativeSymbol} on ${network.name} to pay the network fee.` : null;
}

export interface SwapActionState {
  busy: 'quote' | 'execute' | null;
  configured: boolean;
  authenticated: boolean;
  sourcePending: boolean;
  sameCurrency: boolean;
  receiveBlocked: boolean;
  /** null while /relay/config is loading. */
  relayConfigured: boolean | null;
  liveReady: boolean;
  /** The typed amount is above a known funding balance. */
  insufficient: boolean;
  quote: 'none' | 'valid' | 'expired';
  /** "5 USDC" for the Confirm label. */
  quoteAmount: string;
  fundingLabel: string;
}

/** The submit label ladder (6.10), in precedence order. "Not enough <label>" is the new rung. */
export function swapActionLabel(state: SwapActionState): string {
  if (state.busy === 'execute') return 'Confirm in your wallet…';
  if (state.busy === 'quote') return 'Getting quote…';
  if (!state.configured) return 'Sign-in setup required';
  if (!state.authenticated) return 'Sign in to swap';
  if (state.sourcePending) return 'Swap in progress';
  if (state.sameCurrency) return 'Choose another token';
  if (state.receiveBlocked) return 'Choose another receiving network';
  if (state.relayConfigured === null) return 'Loading…';
  if (!state.liveReady) return 'Swaps unavailable';
  if (state.insufficient) return `Not enough ${state.fundingLabel}`;
  if (state.quote === 'valid') return `Confirm swap · ${state.quoteAmount}`;
  if (state.quote === 'expired') return 'Refresh quote';
  return 'Review swap';
}

export type StatusTone = 'neutral' | 'ok' | 'warn' | 'danger';
/** Chip tone for a tracked swap. The label stays the visible signal; the tone only adds a mark. */
export function statusTone(status: TradeStatus, flags: { legacy?: boolean; notFilled?: boolean } = {}): StatusTone {
  if (flags.legacy) return 'neutral';
  if (flags.notFilled) return 'warn';
  if (status === 'success') return 'ok';
  if (status === 'failure') return 'danger';
  if (status === 'delayed' || status === 'unresolved') return 'warn';
  return 'neutral';
}
