import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { executeTrade, type RelayWalletAccess } from './client';
import { TRADE_STORAGE_KEY } from './history';
import type { RelayQuote, ReviewedQuote, TradeIntent, TradeRecord } from './model';
import { normalizeQuoteApprovals } from './validation';

// Live Relay orders captured read-only on 2026-10-12 (server/src/solares/fixtures/relay-orders/README.md).
const FIXTURES = new URL('../../../server/src/solares/fixtures/relay-orders/', import.meta.url);
type Route = { file: string; receivedAt: number; intent: TradeIntent };
const manifest = JSON.parse(readFileSync(new URL('manifest.json', FIXTURES), 'utf8')) as { routes: Record<string, Route>; placeholders: { evm: string; solana: string } };

/** A captured, policy-valid quote whose solver signature has one hex digit flipped. */
function tamperedReview(name: string): { reviewed: ReviewedQuote; now: number } {
  const route = manifest.routes[name];
  const intent = structuredClone(route.intent);
  const quote = normalizeQuoteApprovals(JSON.parse(readFileSync(new URL(route.file, FIXTURES), 'utf8')) as RelayQuote, intent);
  const signature = quote.protocol.v2.orderSignature;
  quote.protocol.v2.orderSignature = signature.slice(0, 20) + (signature[20] === '0' ? '1' : '0') + signature.slice(21);
  const now = route.receivedAt;
  const expiresAt = Math.min(now + 90_000, quote.protocol.v2.orderData.output.deadline * 1000 - 10_000);
  return { reviewed: { quote, intent, requestId: quote.requestId!, quotedAt: now, expiresAt }, now };
}
function memoryStorage() {
  const items = new Map<string, string>();
  const writes: string[] = [];
  return {
    writes,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push(key); items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  };
}

for (const name of ['solana-usdc-to-solana-sol', 'base-usdc-to-base-eth']) {
  test(`a tampered solver signature never reaches the wallet, saves no swap and frees the signing guard (${name})`, async (t) => {
    const { reviewed, now } = tamperedReview(name);
    t.mock.timers.enable({ apis: ['Date'], now });
    const storage = memoryStorage();
    const globals = globalThis as { localStorage?: unknown };
    const previousStorage = globals.localStorage;
    globals.localStorage = storage;
    t.after(() => { if (previousStorage === undefined) delete globals.localStorage; else globals.localStorage = previousStorage; });
    const fetches: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => { fetches.push(String(url)); return new Response('{}', { status: 500 }); });
    const walletCalls: string[] = [];
    const wallet: RelayWalletAccess = {
      getSession: () => ({ authenticated: true, userId: 'did:privy:client-test', addresses: { solana: manifest.placeholders.solana, ethereum: manifest.placeholders.evm } }),
      getAccessToken: async () => { walletCalls.push('getAccessToken'); return 'test-token'; },
      getEvmProvider: async () => { walletCalls.push('getEvmProvider'); throw new Error('This test never grants wallet access.'); },
      sendSolanaTransaction: async () => { walletCalls.push('sendSolanaTransaction'); throw new Error('This test never grants wallet access.'); },
    };
    const updates: TradeRecord[] = [];
    // A second call while the first is verifying is refused by the guard, which is claimed before any await.
    const first = executeTrade(wallet, reviewed, record => updates.push(record));
    await assert.rejects(executeTrade(wallet, reviewed, record => updates.push(record)), /A trade is already waiting for your wallet/);
    await assert.rejects(first, /not signed/);
    // The guard is released: a retry is verified again (and refused again) instead of being reported as busy.
    await assert.rejects(executeTrade(wallet, reviewed, record => updates.push(record)), /not signed/);
    assert.deepEqual(walletCalls, [], 'no wallet method was called');
    assert.deepEqual(fetches, [], 'no request left the device');
    assert.deepEqual(updates, [], 'no swap progress was reported');
    assert.deepEqual(storage.writes, [], 'no TradeRecord was saved');
    assert.equal(storage.getItem(TRADE_STORAGE_KEY), null);
  });
}
