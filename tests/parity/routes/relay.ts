/**
 * Area C route module (docs/UI_ARGUS_PARITY.md 10.2): the Relay proxy paths under
 * `/api/solares/relay/`. Everything else falls back to the base guard.
 *
 * Profiles (`scenario.profile.relay`):
 * - unset or 'ready': `/config` answers the RELAY_CONFIG of tests/browser/wallet.spec.ts
 *   (no swap cap: only the 100,000-unit sanity ceiling, owner decision 2026-10-13);
 * - 'config-500': `/config` answers 500, so the screen shows its connection error.
 *
 * Every profile also answers:
 * - `/currencies`: real token identities (symbol, name, contract, decimals), never prices;
 * - `/quote`: a live Relay order captured read-only on 2026-10-12
 *   (server/src/solares/fixtures/relay-orders, read only). The capture is signed by Relay's
 *   pinned solver and commits to the capture's placeholder wallets, so it only verifies on
 *   tests/parity/swap-harness.html, which signs in as those placeholders. A request that
 *   matches no capture gets 502 and the screen shows the error; nothing is invented;
 * - `/status/:id`: the seeded record's own status, so polling leaves seeded records unchanged
 *   (503 "temporarily unavailable" for an unresolved or unknown record, as the server does).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PARITY_TIME, fulfillJson, type RouteInstaller } from '../types';

/** The public /config shape the server returns (as tests/browser/wallet.spec.ts): no swap cap, only the sanity ceiling. */
export const RELAY_CONFIG = Object.freeze({
  configured: true, mode: 'verified-funding-origin', maxTradeUnits: '100000', maxDailyUnits: null, maxFundingUnits: '100000',
  fillWindowDays: 7, refundGuaranteed: false, swapLimitsError: null,
});

const SOLANA = 792703809;
const BASE = 8453;
/** Identity only (as Relay's /currencies returns it, after the server's parseCurrencies): no price, volume or liquidity. */
const TOKENS: Readonly<Record<number, readonly { chainId: number; address: string; symbol: string; name: string; decimals: number }[]>> = {
  [SOLANA]: [
    { chainId: SOLANA, address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', name: 'Jupiter', decimals: 6 },
    { chainId: SOLANA, address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk', decimals: 5 },
  ],
  [BASE]: [
    { chainId: BASE, address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8 },
    { chainId: BASE, address: '0x940181a94a35a4569e4529a3cdfb74e38fd98631', symbol: 'AERO', name: 'Aerodrome', decimals: 18 },
  ],
};

/** Captured Relay orders (read only; never edited). Only Solana-funded captures: they need no approval normalization. */
const CAPTURES = path.resolve('server/src/solares/fixtures/relay-orders');
const CAPTURED_ROUTES = ['solana-usdc-to-solana-sol', 'solana-usdc-to-solana-bonk'] as const;
interface CaptureManifest { placeholders: { evm: string; solana: string }; routes: Record<string, { file: string; intent: unknown }> }
function readCaptures() {
  const manifest = JSON.parse(fs.readFileSync(path.join(CAPTURES, 'manifest.json'), 'utf8')) as CaptureManifest;
  return { manifest, routes: CAPTURED_ROUTES.map(name => ({ name, intent: manifest.routes[name].intent, file: path.join(CAPTURES, manifest.routes[name].file) })) };
}
/** The wallets the captured orders commit to; tests/parity/swap-harness.tsx signs in as these. */
export const CAPTURE_PLACEHOLDERS = readCaptures().manifest.placeholders;

/** relay/history.ts TRADE_STORAGE_KEY (device-local swap history). */
export const TRADE_STORAGE_KEY = 'solares.relay.activity.v1';
function seededRecords(json: string | undefined): { requestId: string; status: string; settlementUpdatedAt?: number }[] {
  try { const parsed: unknown = JSON.parse(json ?? '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

/** Solana's native-token address in Relay requests (the screen sends SOL as a token object, captures say 'native'). */
const SOLANA_NATIVE = '11111111111111111111111111111111';
/**
 * The route a quote request asks for, as relay/model.ts `sameTradeIntent` compares it: networks, wallets,
 * amount, slippage and the output token's address ('native' and the native token object are the same).
 * Solana-only, because only Solana captures are served.
 */
function routeKey(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const intent = input as Record<string, unknown>;
  const token = intent.destinationToken;
  const output = token === 'native' ? SOLANA_NATIVE : token && typeof token === 'object' ? (token as { address?: unknown }).address : token;
  return JSON.stringify([intent.originChainId, intent.destinationChainId, intent.user, intent.recipient, intent.amount, intent.slippageBps, output]);
}

export const install: RouteInstaller = async (context, ctx) => {
  const profile = ctx.profile.relay ?? 'ready';
  const captures = readCaptures().routes;
  await context.route(url => url.pathname.startsWith('/api/solares/relay/'), async route => {
    const request = route.request();
    const url = new URL(request.url());
    const name = url.pathname.slice('/api/solares/relay/'.length);
    if (name === 'config' && request.method() === 'GET') {
      if (profile === 'config-500') return fulfillJson(route, 500, { error: 'Parity fixture: the ANTARA server is unavailable.' });
      return fulfillJson(route, 200, RELAY_CONFIG);
    }
    if (name === 'currencies' && request.method() === 'GET') {
      const chainId = Number(url.searchParams.get('chainId'));
      const term = (url.searchParams.get('term') ?? '').trim().toLowerCase();
      const tokens = (TOKENS[chainId] ?? []).filter(token => !term || [token.symbol, token.name, token.address].some(value => value.toLowerCase().includes(term)));
      return fulfillJson(route, 200, { tokens });
    }
    if (name === 'quote' && request.method() === 'POST') {
      const intent = request.postDataJSON() as unknown;
      const key = routeKey(intent);
      const match = key === null ? undefined : captures.find(capture => routeKey(capture.intent) === key);
      if (!match) return fulfillJson(route, 502, { error: 'Parity fixture: no captured Relay order matches this request.' });
      const quote = JSON.parse(fs.readFileSync(match.file, 'utf8')) as { requestId: string; protocol: { v2: { orderData: { output: { deadline: number } } } } };
      // The page clock starts at PARITY_TIME and runs; a quote is valid for at most 90 seconds (server rule).
      const quotedAt = PARITY_TIME.getTime();
      const expiresAt = Math.min(quotedAt + 90_000, quote.protocol.v2.orderData.output.deadline * 1000 - 10_000);
      return fulfillJson(route, 200, { quote, intent, requestId: quote.requestId, quotedAt, expiresAt });
    }
    if (name.startsWith('status/') && request.method() === 'GET') {
      // Polling reads the scenario's own seeded record back, so seeded records keep their state.
      const requestId = name.slice('status/'.length);
      const saved = seededRecords(ctx.scenario.storage?.[TRADE_STORAGE_KEY]).find(record => record.requestId === requestId);
      // An unresolved record stays unresolved: the server's answer when Relay's status is unavailable.
      if (!saved || saved.status === 'unresolved') return fulfillJson(route, 503, { error: 'Settlement status is temporarily unavailable. Do not submit the deposit again.', status: 'unresolved' });
      return fulfillJson(route, 200, { status: saved.status, inTxHashes: [], txHashes: [], updatedAt: saved.settlementUpdatedAt, failReason: null, refundFailReason: null });
    }
    return route.fallback();
  });
};
