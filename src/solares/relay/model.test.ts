import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_FUNDING_UNITS, RELAY_NETWORKS, RELAY_SOLVER, RELAY_TRADE_CEILING_UNITS, SOLANA_CHAIN_ID, formatExactAmount, formatIntentAmount, fundingMicroUnits, fundingToken, isFundingAddress, isLegacyRelayNetwork, nativeToken, parseFundingAmount, relayNetwork, tokenFor, tokenLabel, tradeNetwork } from './model';

test('Relay networks are Solana-first and carry each network\'s own funding stablecoin', () => {
  assert.deepEqual(RELAY_NETWORKS.map(chain => chain.name), ['Solana', 'Ethereum', 'BNB Smart Chain', 'Robinhood Chain', 'Base']);
  assert.equal(RELAY_NETWORKS[0].id, SOLANA_CHAIN_ID);
  assert.ok(RELAY_NETWORKS.every(chain => !chain.legacy));
  const bsc = tradeNetwork(56), robinhood = tradeNetwork(4663);
  assert.deepEqual([bsc.protocol, bsc.nativeSymbol, bsc.funding.label, bsc.funding.decimals, bsc.funding.circleIssued], ['bnb', 'BNB', 'USDC (Binance-Peg)', 18, false]);
  assert.deepEqual([robinhood.protocol, robinhood.nativeSymbol, robinhood.funding.symbol, robinhood.funding.decimals, robinhood.funding.circleIssued], ['robinhood', 'ETH', 'USDG', 6, false]);
  assert.ok(RELAY_NETWORKS.filter(chain => chain.funding.circleIssued).every(chain => chain.funding.symbol === 'USDC' && chain.funding.decimals === 6));
  assert.ok(Object.isFrozen(RELAY_NETWORKS[2].funding));
});

test('removed networks resolve only as read-only legacy metadata', () => {
  for (const [id, name] of [[42161, 'Arbitrum'], [137, 'Polygon']] as const) {
    const legacy = relayNetwork(id);
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.name, name);
    assert.match(legacy.label, /no longer supported/);
    assert.ok(isLegacyRelayNetwork(id));
    assert.throws(() => tradeNetwork(id), /no longer supported/);
    assert.ok(!RELAY_NETWORKS.some(chain => chain.id === id));
  }
  assert.throws(() => relayNetwork(548123634), /not enabled/);
  assert.throws(() => tradeNetwork(548123634), /not enabled/);
});

test('labels never present USDG or Binance-Peg USDC as plain USDC', () => {
  assert.equal(tokenLabel(fundingToken(tradeNetwork(56))), 'USDC (Binance-Peg)');
  assert.equal(tokenLabel(fundingToken(tradeNetwork(4663))), 'USDG');
  assert.equal(tokenLabel(fundingToken(tradeNetwork(8453))), 'USDC');
  assert.equal(tokenLabel(nativeToken(tradeNetwork(56))), 'BNB');
  assert.throws(() => tokenFor(tradeNetwork(4663), 'USDC'), /not available on Robinhood Chain/);
  assert.throws(() => tokenFor(tradeNetwork(56), 'USDC'), /not available on BNB Smart Chain/);
  assert.equal(formatIntentAmount({ originChainId: 56, amount: '1500000000000000000' }), '1.5 USDC (Binance-Peg)');
  assert.equal(formatIntentAmount({ originChainId: 4663, amount: '1500000' }), '1.5 USDG');
  assert.equal(formatIntentAmount({ originChainId: SOLANA_CHAIN_ID, amount: '1500000' }), '1.5 USDC');
});

test('funding identity is address-pinned and rejects the Robinhood bridged USDC lookalike', () => {
  const robinhood = tradeNetwork(4663);
  assert.ok(isFundingAddress(robinhood, '0x5fc5360d0400a0fd4f2af552add042d716f1d168'));
  assert.ok(!isFundingAddress(robinhood, '0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8'));
  assert.ok(!isFundingAddress(tradeNetwork(56), '0x4268B8F0B87b6Eae5d897996E6b845ddbD99Adf3'));
  // Solana mints compare exactly.
  assert.ok(!isFundingAddress(tradeNetwork(SOLANA_CHAIN_ID), 'epjfwdd5aufqssqem2qn1xzybapc8g4wegggkzwytdt1v'));
});

test('exact amounts round-trip at 18 decimals for the Max control, within the 100,000-unit sanity ceiling (no swap cap)', () => {
  const funding = tradeNetwork(56).funding;
  // Owner decision 2026-10-13: the per-swap bound is the protocol sanity ceiling, not the old 1,000-unit ceiling.
  assert.equal(RELAY_TRADE_CEILING_UNITS, 100_000n);
  assert.equal(RELAY_TRADE_CEILING_UNITS, MAX_FUNDING_UNITS);
  for (const raw of ['1', '25000000000000000000', '123456789012345678901', '1000000000000000000001', '100000000000000000000000']) {
    assert.equal(parseFundingAmount(formatExactAmount(raw, funding.decimals), funding), raw);
  }
  // One base unit above the ceiling is refused, with the ceiling grouped in the message.
  assert.throws(() => parseFundingAmount(formatExactAmount('100000000000000000000001', funding.decimals), funding), /100,000 USDC \(Binance-Peg\)/);
  // An explicit bound below the ceiling applies the same way.
  assert.equal(parseFundingAmount('100', funding, 100n), '100000000000000000000');
  assert.throws(() => parseFundingAmount('100.000000000000000001', funding, 100n), /and 100 USDC \(Binance-Peg\) at a time/);
  // A saved 100,000-unit record stays readable with the record bound.
  assert.equal(parseFundingAmount(formatExactAmount('100000000000000000000000', 18), funding, MAX_FUNDING_UNITS), '100000000000000000000000');
  assert.equal(formatExactAmount('1500000', 6), '1.5');
  assert.equal(formatExactAmount('0', 6), '0');
  assert.equal(formatExactAmount('bad', 6), '0');
});

test('funding micro-units put 6- and 18-decimal stablecoins on one cap scale, rounding up', () => {
  assert.equal(fundingMicroUnits('5000000', 6), 5_000_000n);
  assert.equal(fundingMicroUnits('1000000000000000001', 18), 1_000_001n);
  assert.equal(fundingMicroUnits('1000000000000', 18), 1n);
  assert.equal(fundingMicroUnits('1', 18), 1n);
  assert.equal(fundingMicroUnits('0', 18), 0n);
  assert.throws(() => fundingMicroUnits('1.5', 6));
  assert.throws(() => fundingMicroUnits('-1', 6));
});

test('the pinned Relay solver is frozen and lowercase', () => {
  assert.deepEqual({ ...RELAY_SOLVER }, { chain: 'base', address: '0xf70da97812cb96acdf810712aa562db8dfa3dbef' });
  assert.ok(Object.isFrozen(RELAY_SOLVER));
});
