import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { PrivyClient } from '@privy-io/node';
import { getOrderId } from '@relay-protocol/settlement-sdk/dist/order/index.js';
import {
  MAX_FUNDING_UNITS, RELAY_EVM_FILL_CONTRACT, RELAY_NETWORKS, RELAY_SOLVER, formatIntentAmount, tradeNetwork,
  type RelayQuote, type ReviewedQuote, type TradeIntent, type TradeNetwork,
} from '../../../src/solares/relay/model';
import {
  expectedOrderExtraData, normalizeQuoteApprovals, validateIntent, validateQuote, validateRecordedIntent,
  validateReviewedQuoteWithoutSignature, verifyReviewedQuote,
} from '../../../src/solares/relay/validation';
import { settlementOrderId, verifyOrderSignature } from '../../../src/solares/relay/integrity';
import { describeSettlement, formatFillDeadline, SETTLEMENT_ACKNOWLEDGEMENT } from '../../../src/solares/relay/review';
import relayRouter, { relayQuoteRequest, verifiedChainMetadata, verifySettlementIntegrity } from './relay';

// Live Relay orders captured read-only on 2026-10-12 (fixtures/relay-orders/README.md). Each test
// validates a structuredClone at the capture's own receivedAt, because the orders expire on 2026-10-20.
type Route = { file: string; antaraRequestShape: boolean; receivedAt: number; request: Record<string, unknown>; intent: TradeIntent; builderDifference?: Record<string, string> };
const FIXTURES = new URL('./fixtures/relay-orders/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', FIXTURES), 'utf8')) as { routes: Record<string, Route>; placeholders: { evm: string; solana: string } };
const chainsFixture = JSON.parse(readFileSync(new URL('chains.json', FIXTURES), 'utf8')) as { chains: Array<Record<string, unknown>> };
const ROUTES = Object.entries(manifest.routes);
const vmMap = Object.fromEntries(RELAY_NETWORKS.map((chain) => [chain.protocol, chain.vmType]));
const EVM_ATTACKER = '0x2222222222222222222222222222222222222222';
const SOLANA_ATTACKER = 'GTtzwxqy67xx9DVESJjx28TgXqpc8xTqtiytgNMaQBTE';
const EVM_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const SOLANA_USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const ROBINHOOD_LOOKALIKE = '0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8';
const attacker = (network: TradeNetwork) => network.vm === 'solana' ? SOLANA_ATTACKER : EVM_ATTACKER;
const foreignToken = (network: TradeNetwork) => network.vm === 'solana' ? SOLANA_USDT : EVM_USDT;

function load(name: string) {
  const route = manifest.routes[name];
  const raw = JSON.parse(readFileSync(new URL(route.file, FIXTURES), 'utf8')) as RelayQuote;
  const intent = structuredClone(route.intent);
  const quote = normalizeQuoteApprovals(structuredClone(raw), intent);
  return { route, quote, intent, now: route.receivedAt, source: tradeNetwork(intent.originChainId), destination: tradeNetwork(intent.destinationChainId) };
}
/** Recompute the order id after a coherent hostile edit and replace the old id everywhere (order, calldata, Solana data). */
function rehash(quote: RelayQuote): RelayQuote {
  const previous = quote.protocol.v2.orderId.slice(2);
  const next = settlementOrderId(quote.protocol.v2.orderData).slice(2).toLowerCase();
  return JSON.parse(JSON.stringify(quote).replace(new RegExp(previous, 'gi'), next)) as RelayQuote;
}
function reviewedOf(quote: RelayQuote, intent: TradeIntent, now: number): ReviewedQuote {
  return { quote, intent, requestId: quote.requestId!, quotedAt: now, expiresAt: Math.min(now + 90_000, quote.protocol.v2.orderData.output.deadline * 1000 - 10_000) };
}
const order = (quote: RelayQuote) => quote.protocol.v2.orderData;

test('every captured Relay order is accepted under the October 2026 policy, signature included', async () => {
  assert.equal(ROUTES.length, 12);
  for (const [name] of ROUTES) {
    const { quote, intent, now } = load(name);
    // The browser verifier and the pinned SDK both reproduce Relay's order id.
    assert.equal(settlementOrderId(order(quote)), quote.protocol.v2.orderId, name);
    assert.equal(getOrderId(order(quote), vmMap).toLowerCase(), quote.protocol.v2.orderId.toLowerCase(), name);
    verifySettlementIntegrity(quote);
    validateQuote(quote, intent, now);
    validateQuote(quote, intent, now + 90_000);
    await verifyReviewedQuote(reviewedOf(quote, intent, now), intent, now);
    await verifyOrderSignature(quote);
    // The pinned terms the policy relies on.
    assert.equal(order(quote).solver, RELAY_SOLVER.address);
    assert.equal(quote.protocol.v2.hubType, 'onchain');
    assert.ok(order(quote).inputs[0].refunds.every(refund => refund.minimumAmount === '0' && refund.deadline === order(quote).output.deadline), name);
  }
});

test('the captured /chains metadata passes, and drift in router, solver, depository or chain ids fails closed', () => {
  const kept = verifiedChainMetadata(chainsFixture.chains);
  assert.deepEqual(kept.map(chain => chain.id).sort((a, b) => a - b), RELAY_NETWORKS.map(chain => chain.id).sort((a, b) => a - b));
  const mutate = (change: (chains: Array<Record<string, any>>) => void) => { const chains = structuredClone(chainsFixture.chains) as Array<Record<string, any>>; change(chains); return chains; };
  for (const id of [1, 56, 4663, 8453]) {
    assert.throws(() => verifiedChainMetadata(mutate(chains => { chains.find(chain => chain.id === id)!.contracts.erc20Router = EVM_ATTACKER; })), /contracts changed/, `${id} router`);
    assert.throws(() => verifiedChainMetadata(mutate(chains => { chains.find(chain => chain.id === id)!.protocol.v2.depository = EVM_ATTACKER; })), /contracts changed/, `${id} depository`);
  }
  assert.throws(() => verifiedChainMetadata(mutate(chains => { const base = chains.find(chain => chain.id === 8453)!; base.solverAddresses = base.solverAddresses.filter((address: string) => address !== RELAY_SOLVER.address); })), /contracts changed/);
  assert.throws(() => verifiedChainMetadata(mutate(chains => { chains.push(structuredClone(chains.find(chain => chain.id === 56)!)); })), /contracts changed/);
  assert.equal(RELAY_EVM_FILL_CONTRACT, '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f');
});

test('ANTARA builds each captured request; only checksummed EVM letter case may differ', () => {
  for (const [name, route] of ROUTES) {
    const built = relayQuoteRequest(route.intent) as Record<string, unknown>;
    const captured = { ...route.request };
    if (!route.antaraRequestShape) { assert.equal(captured.refundOnOrigin, true); delete captured.refundOnOrigin; }
    assert.deepEqual(Object.keys(built).sort(), Object.keys(captured).sort(), name);
    const caseOnly: string[] = [];
    for (const key of Object.keys(captured)) {
      if (built[key] === captured[key]) continue;
      // EVM addresses compare case-insensitively; Solana addresses and every other field exactly.
      assert.ok(typeof built[key] === 'string' && /^0x[\da-f]{40}$/i.test(String(built[key])) && String(built[key]).toLowerCase() === String(captured[key]).toLowerCase(), `${name} ${key}`);
      caseOnly.push(key);
    }
    assert.deepEqual(caseOnly, Object.keys(route.builderDifference ?? {}), name);
  }
});

type Mutation = { id: string; pattern: RegExp; rehash?: boolean; at?: (now: number, deadlineMs: number) => number; apply(quote: RelayQuote, ctx: ReturnType<typeof load>): void };
const lastRefund = (quote: RelayQuote) => order(quote).inputs[0].refunds[order(quote).inputs[0].refunds.length - 1];
const thirdChain = (ctx: ReturnType<typeof load>) => RELAY_NETWORKS.find(network => network.vm === 'ethereum' && network.protocol !== ctx.source.protocol && network.protocol !== ctx.destination.protocol)!;
const MUTATIONS: Mutation[] = [
  { id: '1 origin refund to an attacker', pattern: /refund/, apply: (q, c) => { order(q).inputs[0].refunds[0].recipient = attacker(c.source); } },
  { id: '2 origin refund in a foreign token', pattern: /refund/, apply: (q, c) => { order(q).inputs[0].refunds[0].currency = foreignToken(c.source); } },
  { id: '3 refund to the pay-the-depositor sentinel', pattern: /refund/, apply: (q, c) => { order(q).inputs[0].refunds[0].recipient = c.source.native; } },
  { id: '4 destination refund to an attacker', pattern: /refund/, apply: (q, c) => { Object.assign(lastRefund(q), { chainId: c.destination.protocol, recipient: attacker(c.destination), currency: c.destination.native, extraData: expectedOrderExtraData(c.destination) }); } },
  { id: '5 destination refund in an unrelated token', pattern: /refund/, apply: (q, c) => { Object.assign(lastRefund(q), { chainId: c.destination.protocol, recipient: c.intent.recipient, currency: foreignToken(c.destination), extraData: expectedOrderExtraData(c.destination) }); } },
  { id: '6 refund on a third chain', pattern: /refund|settlement/, apply: (q, c) => { const third = thirdChain(c); Object.assign(lastRefund(q), { chainId: third.protocol, recipient: c.source.vm === 'ethereum' ? c.intent.user : manifest.placeholders.evm, currency: third.funding.address, extraData: expectedOrderExtraData(third) }); } },
  { id: '7 no origin refund option', pattern: /refund/, apply: (q, c) => { order(q).inputs[0].refunds = [{ chainId: c.destination.protocol, recipient: c.intent.recipient, currency: c.destination.native, minimumAmount: '0', deadline: order(q).output.deadline, extraData: expectedOrderExtraData(c.destination) }]; } },
  { id: '8 three refund options', pattern: /Unsupported refund terms/, apply: (q) => { order(q).inputs[0].refunds.push(structuredClone(order(q).inputs[0].refunds[0])); } },
  { id: '9 refund deadline after the fill deadline', pattern: /deadline/, apply: (q) => { order(q).inputs[0].refunds[0].deadline = order(q).output.deadline + 1; } },
  { id: '10 refund extraData substituted', pattern: /refund/, apply: (q, c) => { order(q).inputs[0].refunds[0].extraData = c.source.vm === 'solana' ? '0x01' : '0x'; } },
  // Every origin-shaped option (same-chain routes can duplicate it) asks for more than was deposited.
  { id: '11 origin refund minimum above the deposit', pattern: /refund/, apply: (q, c) => { for (const refund of order(q).inputs[0].refunds) if (refund.chainId === c.source.protocol && refund.currency.toLowerCase() === c.source.funding.address.toLowerCase()) refund.minimumAmount = (BigInt(c.intent.amount) + 1n).toString(); } },
  { id: '11b negative refund minimum', pattern: /refund minimum/, rehash: false, apply: (q) => { order(q).inputs[0].refunds[0].minimumAmount = '-1'; } },
  { id: '11c fractional refund minimum', pattern: /refund minimum/, rehash: false, apply: (q) => { order(q).inputs[0].refunds[0].minimumAmount = '1.5'; } },
  { id: '12 fill window too long', pattern: /fill window/, at: (now) => now - 16 * 60_000, apply: () => {} },
  { id: '12b fill window too short', pattern: /fill window/, at: (_now, deadline) => deadline - 4 * 60_000, apply: () => {} },
  { id: '13 destination calls', pattern: /Complex settlement/, apply: (q) => { order(q).output.calls = ['0x1234']; } },
  { id: '14 fee to an attacker', pattern: /Complex settlement/, apply: (q, c) => { order(q).fees = [{ recipientChainId: c.source.protocol, recipient: attacker(c.source), currencyChainId: c.source.protocol, currency: c.source.funding.address, amount: '1' }]; } },
  { id: '15 depository substituted', pattern: /Protocol payment changed/, apply: (q, c) => { q.protocol.v2.paymentDetails.depository = attacker(c.source); } },
  { id: '16 deposit target substituted', pattern: /Unsupported transaction target|outside the verified/, apply: (q, c) => {
    const deposit = q.steps.find(step => step.id === 'deposit')!.items[0].data;
    if (c.source.vm === 'ethereum') deposit.to = EVM_ATTACKER; else deposit.instructions![0].programId = SOLANA_ATTACKER;
  } },
  { id: '19 solver substituted', pattern: /solver/, apply: (q) => { order(q).solver = EVM_ATTACKER; } },
  { id: '19b solver chain substituted', pattern: /solver/, apply: (q) => { order(q).solverChainId = 'ethereum'; } },
  { id: '20 fill contract substituted', pattern: /settlement contract/, apply: (q) => { order(q).output.extraData = `0x${'0'.repeat(24)}${EVM_ATTACKER.slice(2)}`; } },
  { id: '21 off-chain hub', pattern: /verifiable settlement order/, apply: (q) => { q.protocol.v2.hubType = 'offchain'; } },
  { id: '23 funding decimals swapped', pattern: /decimals/, apply: (q, c) => { q.details.currencyIn.currency.decimals = c.source.funding.decimals === 6 ? 18 : 6; } },
  { id: '24 funding token relabelled', pattern: /metadata/, apply: (q, c) => { q.details.currencyIn.currency.symbol = c.source.funding.symbol === 'USDG' ? 'USDC' : 'USDG'; } },
  { id: '25 input weight changed', pattern: /Protocol input/, apply: (q) => { order(q).inputs[0].payment.weight = '2'; } },
];

test('hostile order mutations fail on policy even when the order hash is recomputed', () => {
  let checked = 0;
  for (const [name] of ROUTES) for (const mutation of MUTATIONS) {
    const ctx = load(name);
    const mutated = structuredClone(ctx.quote);
    mutation.apply(mutated, ctx);
    const quote = mutation.rehash === false ? mutated : rehash(mutated);
    const at = mutation.at ? mutation.at(ctx.now, order(quote).output.deadline * 1000) : ctx.now;
    assert.throws(() => validateQuote(quote, ctx.intent, at), mutation.pattern, `${name}: ${mutation.id}`);
    // The full synchronous gate (which also recomputes the hash) stops it with the same policy reason.
    if (mutation.rehash !== false && !mutation.at) assert.throws(() => validateReviewedQuoteWithoutSignature(reviewedOf(quote, ctx.intent, ctx.now), ctx.intent, ctx.now), mutation.pattern, `${name}: ${mutation.id} (reviewed)`);
    checked += 1;
  }
  assert.equal(checked, ROUTES.length * MUTATIONS.length);
});

test('unhashed edits to the output or refund minimum fail independent order verification', () => {
  for (const [name] of ROUTES) {
    const ctx = load(name);
    // Captured minimums sit exactly at the slippage bound, so the edit raises the minimum by one base unit.
    const lowered = structuredClone(ctx.quote);
    const minimum = (BigInt(order(lowered).output.payments[0].minimumAmount) + 1n).toString();
    order(lowered).output.payments[0].minimumAmount = minimum;
    lowered.details.currencyOut.minimumAmount = minimum;
    validateQuote(lowered, ctx.intent, ctx.now);
    assert.throws(() => validateReviewedQuoteWithoutSignature(reviewedOf(lowered, ctx.intent, ctx.now), ctx.intent, ctx.now), /independent wallet verification/, name);
    assert.throws(() => verifySettlementIntegrity(lowered), /integrity/, name);
    const refund = structuredClone(ctx.quote);
    order(refund).inputs[0].refunds[0].minimumAmount = '1';
    assert.throws(() => validateReviewedQuoteWithoutSignature(reviewedOf(refund, ctx.intent, ctx.now), ctx.intent, ctx.now), /independent wallet verification/, name);
  }
});

test('the solver signature is required: a flipped digit, another order\'s signature or a rehashed order is refused', async () => {
  const names = ROUTES.map(([name]) => name);
  for (const [index, name] of names.entries()) {
    const ctx = load(name);
    const flipped = structuredClone(ctx.quote);
    const signature = flipped.protocol.v2.orderSignature;
    flipped.protocol.v2.orderSignature = signature.slice(0, 20) + (signature[20] === '0' ? '1' : '0') + signature.slice(21);
    await assert.rejects(verifyReviewedQuote(reviewedOf(flipped, ctx.intent, ctx.now), ctx.intent, ctx.now), /signed/, `${name} flipped`);
    const borrowed = structuredClone(ctx.quote);
    borrowed.protocol.v2.orderSignature = load(names[(index + 1) % names.length]).quote.protocol.v2.orderSignature;
    await assert.rejects(verifyReviewedQuote(reviewedOf(borrowed, ctx.intent, ctx.now), ctx.intent, ctx.now), /signed/, `${name} borrowed`);
    const missing = structuredClone(ctx.quote);
    Reflect.deleteProperty(missing.protocol.v2, 'orderSignature');
    await assert.rejects(verifyOrderSignature(missing), /not signed/, `${name} missing`);
    // A coherent rehash passes the synchronous checks but carries no valid solver signature.
    const rehashed = structuredClone(ctx.quote);
    order(rehashed).salt = '0x1234';
    const tampered = rehash(rehashed);
    validateReviewedQuoteWithoutSignature(reviewedOf(tampered, ctx.intent, ctx.now), ctx.intent, ctx.now);
    await assert.rejects(verifyReviewedQuote(reviewedOf(tampered, ctx.intent, ctx.now), ctx.intent, ctx.now), /signed/, `${name} rehashed`);
  }
});

test('the Robinhood bridged USDC lookalike is refused as a refund currency in either option', () => {
  for (const index of [0, 1]) {
    const ctx = load('robinhood-usdg-to-robinhood-eth');
    order(ctx.quote).inputs[0].refunds[index].currency = ROBINHOOD_LOOKALIKE;
    assert.throws(() => validateQuote(rehash(ctx.quote), ctx.intent, ctx.now), /refund/, `option ${index + 1}`);
  }
});

test('with distinct user and recipient wallets, the origin option binds to the user and the destination option to the recipient', async () => {
  const second: Record<string, string> = { ethereum: '0x3333333333333333333333333333333333333333', solana: SOLANA_ATTACKER };
  for (const name of ['base-usdc-to-base-eth', 'bsc-usdc-to-bsc-bnb', 'robinhood-usdg-to-robinhood-eth', 'solana-usdc-to-solana-sol']) {
    const build = (change?: (quote: RelayQuote, intent: TradeIntent) => void) => {
      const ctx = load(name);
      const recipient = second[ctx.destination.vm];
      const intent = { ...ctx.intent, recipient };
      order(ctx.quote).output.payments[0].recipient = recipient;
      ctx.quote.details.recipient = recipient;
      order(ctx.quote).inputs[0].refunds[1].recipient = recipient;
      change?.(ctx.quote, intent);
      return { ...ctx, intent, quote: rehash(ctx.quote) };
    };
    const rebuilt = build();
    validateReviewedQuoteWithoutSignature(reviewedOf(rebuilt.quote, rebuilt.intent, rebuilt.now), rebuilt.intent, rebuilt.now);
    await assert.rejects(verifyReviewedQuote(reviewedOf(rebuilt.quote, rebuilt.intent, rebuilt.now), rebuilt.intent, rebuilt.now), /signed/, name);
    const originToRecipient = build((quote, intent) => { order(quote).inputs[0].refunds[0].recipient = intent.recipient; });
    assert.throws(() => validateQuote(originToRecipient.quote, originToRecipient.intent, originToRecipient.now), /source wallet/, `${name} origin`);
    const destinationToUser = build((quote, intent) => { order(quote).inputs[0].refunds[1].recipient = intent.user; });
    assert.throws(() => validateQuote(destinationToUser.quote, destinationToUser.intent, destinationToUser.now), /refund/, `${name} destination`);
    const swapped = build((quote, intent) => { order(quote).inputs[0].refunds[0].recipient = intent.recipient; order(quote).inputs[0].refunds[1].recipient = intent.user; });
    assert.throws(() => validateQuote(swapped.quote, swapped.intent, swapped.now), /refund|source wallet/, `${name} swapped`);
  }
});

test('every signing path goes through verifyReviewedQuote; the unsigned check stays inside validation.ts', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'fixtures' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(path);
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'server', 'src'));
  const using = (name: string) => files.filter(file => readFileSync(file, 'utf8').includes(name)).map(file => file.slice(root.length).replace(/\\/g, '/')).sort();
  assert.deepEqual(using('validateReviewedQuoteWithoutSignature'), ['src/solares/relay/validation.ts']);
  assert.deepEqual(using('verifyOrderSignature'), ['src/solares/relay/integrity.ts', 'src/solares/relay/validation.ts']);
  assert.ok(using('validateReviewedQuote(').length === 0, 'the old unsigned gate name is gone');
  for (const file of ['src/solares/relay/client.ts', 'server/src/solares/relay.ts']) assert.match(readFileSync(join(root, file), 'utf8'), /await verifyReviewedQuote\(/, file);
});

test('the only per-swap bound is the 100,000-unit protocol sanity ceiling: BSC 18-decimal bounds, USDG is never USDC, records stay readable', () => {
  // Owner decision 2026-10-13: the old 1,000-unit trade ceiling (and the 100-unit default cap) are gone.
  assert.equal(MAX_FUNDING_UNITS, 100_000n);
  const bscIntent = (amount: string): TradeIntent => ({ ...load('bsc-usdc-to-bsc-bnb').intent, amount });
  assert.doesNotThrow(() => validateIntent(bscIntent((1000n * 10n ** 18n + 1n).toString())), 'above the old 1,000-unit ceiling');
  assert.doesNotThrow(() => validateIntent(bscIntent((100_000n * 10n ** 18n).toString())));
  assert.throws(() => validateIntent(bscIntent((100_000n * 10n ** 18n + 1n).toString())), /Invalid USDC \(Binance-Peg\) amount/);
  const usdcIntent = (amount: bigint): TradeIntent => ({ ...load('base-usdc-to-base-eth').intent, amount: amount.toString() });
  assert.doesNotThrow(() => validateIntent(usdcIntent(101n * 10n ** 6n)), 'above the old 100-unit default');
  assert.doesNotThrow(() => validateIntent(usdcIntent(100_000n * 10n ** 6n)));
  assert.throws(() => validateIntent(usdcIntent(100_000n * 10n ** 6n + 1n)), /Invalid USDC amount/);
  assert.throws(() => validateIntent({ ...load('base-usdc-to-base-eth').intent, amount: (5n * 10n ** 18n).toString() }), /Invalid USDC amount/);
  assert.doesNotThrow(() => validateRecordedIntent({ ...load('base-usdc-to-base-eth').intent, amount: (50_000n * 10n ** 6n).toString() }));
  assert.equal(formatIntentAmount(load('robinhood-usdg-to-robinhood-eth').intent), '5 USDG');
  assert.equal(formatIntentAmount(load('bsc-usdc-to-bsc-bnb').intent), '5 USDC (Binance-Peg)');
});

test('the review discloses the fill window, refund terms and public visibility for every capture, and no swap cap', () => {
  const limits = { tradeUnits: MAX_FUNDING_UNITS };
  for (const [name] of ROUTES) {
    const ctx = load(name);
    const reviewed = reviewedOf(ctx.quote, ctx.intent, ctx.now);
    const disclosure = describeSettlement(reviewed, limits, 'en-US', ctx.now);
    const rows = Object.fromEntries(disclosure.rows.map(row => [row.label, row.value]));
    const text = [...disclosure.rows.map(row => `${row.label} ${row.value}`), ...disclosure.paragraphs, disclosure.acknowledgement].join('\n');
    const deadline = formatFillDeadline(order(ctx.quote).output.deadline, 'en-US');
    const label = ctx.source.funding.label;
    assert.equal(rows['You pay'], `5 ${label} on ${ctx.source.name}`, name);
    assert.ok(rows.Expected.endsWith(` on ${ctx.destination.name}`) && rows['Minimum if filled'], name);
    assert.equal(rows['Fill window'], `Until ${deadline} (up to 7 days)`, name);
    assert.ok(rows['If not filled'].startsWith(`Refund to your ${ctx.source.name} wallet · `) && rows['If not filled'].includes(` in ${label}`), name);
    assert.equal(rows['Quote valid'], '90s', name);
    assert.equal(rows['Swap limit'], undefined, name);
    assert.doesNotMatch(text, /per 24 hours|daily|the limit is/i, name);
    assert.equal(rows.Visibility, 'Public on-chain transaction', name);
    assert.ok(rows['Network fee limit'] === (ctx.source.vm === 'solana' ? 'Priority fee up to 0.02 SOL' : ctx.source.key === 'bsc' ? 'Up to 0.01 BNB per transaction' : 'Up to 0.02 ETH per transaction'), name);
    for (const sentence of [
      `Relay can fill this order until ${deadline} (up to 7 days). Until Relay fills or refunds it, your ${label} is held in Relay's depository on ${ctx.source.name}.`,
      `If Relay neither fills nor refunds by ${deadline}, recovering the deposit requires Relay's protocol recovery, which ANTARA does not yet support in the app.`,
      'Refund amount is not guaranteed by the order; it can be reduced by gas or not sent if smaller than gas.',
      "Relay's solver can also mark the order refunded and pay less than you deposited, or nothing.",
      'Only swap an amount you can afford to lose.',
      'This is a public on-chain transaction.',
    ]) assert.ok(text.includes(sentence), `${name}: ${sentence}`);
    assert.equal(disclosure.acknowledgement, SETTLEMENT_ACKNOWLEDGEMENT);
    assert.equal(SETTLEMENT_ACKNOWLEDGEMENT, 'I understand this swap relies on Relay and I could receive less than I deposited, or nothing.');
    // Never framed as protection; the only "guarantee" is the negative statement.
    assert.doesNotMatch(text.replace('not guaranteed by the order', ''), /protect|guarante|insur/i, name);
    // Same-chain routes to a token Relay's solver does not hold duplicate the origin option: one refund line.
    const alternatives = rows['If not filled'].split(', or to your').length - 1;
    assert.equal(alternatives, ['solana-usdc-to-solana-bonk', 'base-usdc-to-base-aero'].includes(name) ? 0 : 1, name);
    for (const locale of ['de-DE', 'ja-JP', undefined]) assert.doesNotThrow(() => describeSettlement(reviewed, limits, locale, ctx.now), `${name} ${locale}`);
  }
  const robinhood = load('robinhood-usdg-to-robinhood-eth');
  const robinhoodText = JSON.stringify(describeSettlement(reviewedOf(robinhood.quote, robinhood.intent, robinhood.now), limits, 'en-US', robinhood.now));
  assert.ok(robinhoodText.includes('5 USDG on Robinhood Chain'));
  assert.doesNotMatch(robinhoodText, /USDC/);
  const bsc = load('bsc-usdc-to-bsc-bnb');
  const bscText = JSON.stringify(describeSettlement(reviewedOf(bsc.quote, bsc.intent, bsc.now), limits, 'en-US', bsc.now));
  assert.ok(bscText.includes('5 USDC (Binance-Peg) on BNB Smart Chain'));
  assert.doesNotMatch(bscText, /USDC(?! \(Binance-Peg\))/);
});

// /quote with a real capture: Privy, the clock and Relay's HTTP API are mocked; nothing leaves the process.
function quoteApp(t: TestContext, userId: string, name = 'solana-usdc-to-solana-sol', evmAccount: Record<string, unknown> = { connector_type: 'embedded', wallet_client_type: 'privy' }) {
  const ctx = load(name);
  const capture = readFileSync(new URL(ctx.route.file, FIXTURES), 'utf8');
  // The removed cap variables are saved too: tests set them to show they are ignored now.
  const saved = new Map(['RELAY_API_KEY', 'PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'RELAY_MAX_TRADE_UNITS', 'RELAY_DAILY_MAX_UNITS', 'RELAY_MAX_DAILY_UNITS'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, { RELAY_API_KEY: 'relay-test-key', PRIVY_APP_ID: 'test-app', PRIVY_APP_SECRET: 'test-secret' });
  delete process.env.RELAY_MAX_TRADE_UNITS; delete process.env.RELAY_DAILY_MAX_UNITS; delete process.env.RELAY_MAX_DAILY_UNITS;
  t.mock.timers.enable({ apis: ['Date'], now: ctx.now });
  t.mock.method(PrivyClient.prototype, 'utils', () => ({ auth: () => ({ verifyAccessToken: async () => ({ user_id: userId }) }) }));
  t.mock.method(PrivyClient.prototype, 'users', () => ({ _get: async (id: string) => ({ id, mfa_methods: [], linked_accounts: [
    { type: 'wallet', chain_type: 'solana', address: manifest.placeholders.solana, connector_type: 'embedded', wallet_client_type: 'privy' },
    { type: 'wallet', chain_type: 'ethereum', address: manifest.placeholders.evm, ...evmAccount },
  ] }) }));
  const calls: string[] = [];
  let respond: (path: string) => Promise<Response> = async (path) => {
    if (path === '/chains') return new Response(JSON.stringify({ chains: chainsFixture.chains }), { status: 200 });
    if (path === '/quote/v2') return new Response(capture, { status: 200 });
    if (path === '/transactions/index') return new Response('{}', { status: 200 });
    return new Response('{}', { status: 404 });
  };
  t.mock.method(globalThis, 'fetch', async (url: string) => { const path = new URL(url).pathname; calls.push(path); return respond(path); });
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/relay', relayRouter);
  const post = (path: string, body: unknown) => request(app).post(`/relay${path}`).set('Authorization', 'Bearer test-token').send(body as object);
  return { ...ctx, app, calls, post, override(next: typeof respond) { respond = next; } };
}

test('/quote returns a capture only after the signature check', async (t) => {
  const user = 'did:privy:relay-orders-accept';
  const { post, calls, intent, now } = quoteApp(t, user);
  const response = await post('/quote', intent).expect(200);
  // /chains may already be cached by an earlier request in this process.
  assert.ok(calls.includes('/quote/v2') && calls.every(path => path === '/chains' || path === '/quote/v2'), calls.join());
  await verifyReviewedQuote(response.body, intent, now);
  assert.equal(response.body.quotedAt, now);
});

test('/quote refuses a capture with a tampered signature', async (t) => {
  const user = 'did:privy:relay-orders-flipped';
  const { post, intent, override, route } = quoteApp(t, user);
  const capture = JSON.parse(readFileSync(new URL(route.file, FIXTURES), 'utf8')) as RelayQuote;
  const signature = capture.protocol.v2.orderSignature;
  capture.protocol.v2.orderSignature = signature.slice(0, 40) + (signature[40] === 'a' ? 'b' : 'a') + signature.slice(41);
  override(async (path) => new Response(JSON.stringify(path === '/chains' ? { chains: chainsFixture.chains } : capture), { status: 200 }));
  const response = await post('/quote', intent).expect(400);
  assert.match(response.body.error, /signed/);
  assert.equal(response.body.code, 'ROUTE_REJECTED');
});

test('/quote accepts a linked recipient wallet as soon as it is linked (no link-age wait), and still only the caller\'s own', async (t) => {
  const user = 'did:privy:relay-orders-recipient-age';
  const ctx = load('solana-usdc-to-base-usdc');
  const nowSeconds = Math.floor(ctx.now / 1000);
  // Owner decision 2026-10-13: an external wallet linked a minute ago, or with no link time reported, passes the
  // recipient check and the route goes on to Relay's token and quote checks.
  for (const account of [
    { connector_type: 'injected', wallet_client_type: 'metamask', first_verified_at: nowSeconds - 60 },
    { connector_type: 'injected', wallet_client_type: 'metamask' },
  ]) {
    const { post, calls, intent } = quoteApp(t, user, 'solana-usdc-to-base-usdc', account);
    const accepted = await post('/quote', intent);
    assert.notEqual(accepted.status, 403, JSON.stringify(accepted.body));
    assert.notEqual(accepted.body.code, 'RECIPIENT_TOO_NEW');
    assert.ok(calls.length > 0);
    t.mock.restoreAll();
    t.mock.timers.reset();
  }
  // A recipient that is not one of the caller's linked wallets is still refused before any upstream request.
  const { post, calls, intent } = quoteApp(t, user, 'solana-usdc-to-base-usdc');
  const foreign = await post('/quote', { ...intent, recipient: '0x1111111111111111111111111111111111111111' }).expect(403);
  assert.match(foreign.body.error, /belong to your authenticated Privy account/);
  assert.deepEqual(calls, []);
});

test('/quote has no per-swap or daily cap below the 100,000-unit sanity ceiling, and ignores the removed cap variables', async (t) => {
  const user = 'did:privy:relay-orders-caps';
  const { post, calls, intent, app } = quoteApp(t, user);
  // Set to values that used to refuse, or to disable swaps: all ignored now.
  process.env.RELAY_MAX_TRADE_UNITS = '2O';
  process.env.RELAY_DAILY_MAX_UNITS = '1';
  const config = await request(app).get('/relay/config').expect(200);
  assert.deepEqual([config.body.maxTradeUnits, config.body.maxFundingUnits, config.body.maxDailyUnits, config.body.swapLimitsError], ['100000', '100000', null, null]);
  // Above the old 100-unit default and 1,000-unit ceiling: no cap refusal; Relay is asked (this capture is for 5 USDC, so the
  // order checks then refuse it as a mismatch, which shows every order check still runs).
  for (const amount of ['100000001', '1000000001', '100000000000']) {
    const before = calls.filter(path => path === '/quote/v2').length;
    const response = await post('/quote', { ...intent, amount });
    assert.equal(response.status, 400, amount); assert.equal(response.body.code, 'ROUTE_REJECTED', amount);
    assert.doesNotMatch(response.body.error, /limit/i, amount);
    assert.equal(calls.filter(path => path === '/quote/v2').length, before + 1, `${amount} reached Relay`);
  }
  // Above the protocol sanity ceiling: refused before any upstream request.
  const before = calls.length;
  const over = await post('/quote', { ...intent, amount: '100000000001' }).expect(400);
  assert.match(over.body.error, /Invalid USDC amount/);
  const bsc = load('bsc-usdc-to-bsc-bnb').intent;
  assert.match((await post('/quote', { ...bsc, amount: (100_000n * 10n ** 18n + 1n).toString() }).expect(400)).body.error, /Invalid USDC \(Binance-Peg\) amount/);
  assert.equal(calls.length, before);
});

test('/quote never refuses repeated swaps for a daily total, and deposit reports are only forwarded to Relay', async (t) => {
  const user = 'did:privy:relay-orders-daily';
  const { post, calls, intent } = quoteApp(t, user);
  process.env.RELAY_MAX_TRADE_UNITS = '5';
  process.env.RELAY_DAILY_MAX_UNITS = '10';
  const report = (requestId: string) => post('/transactions/index', { chainId: String(intent.originChainId), txHash: '5'.repeat(88), requestId }).expect(200);
  // Well past the old 10-unit (and 500-unit default) daily cap with the variables set: every quote returns.
  for (let round = 0; round < 4; round++) {
    const quoted = await post('/quote', intent).expect(200);
    await report(quoted.body.requestId);
  }
  const [c, d] = await Promise.all([post('/quote', intent), post('/quote', intent)]);
  assert.deepEqual([c.status, d.status], [200, 200]);
  // A malformed request id is refused; a well-formed one is forwarded to Relay's indexer.
  await post('/transactions/index', { chainId: String(intent.originChainId), txHash: '5'.repeat(88), requestId: 'not-an-id' }).expect(400);
  const indexed = calls.filter(path => path === '/transactions/index').length;
  await report(`0x${'9'.repeat(64)}`);
  assert.equal(calls.filter(path => path === '/transactions/index').length, indexed + 1);
});
