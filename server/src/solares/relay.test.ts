import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { PublicKey } from '@solana/web3.js';
import { encodeFunctionData, sha256, toHex } from 'viem';
import { getOrderId } from '@relay-protocol/settlement-sdk/dist/order/index.js';
import { RELAY_EVM_FILL_CONTRACT, RELAY_NETWORKS, RELAY_SOLVER, SOLANA_CHAIN_ID, assertEvmNetworkFee, evmNetworkFeeCap, formatAmount, fundingToken, parseFundingAmount, parseUsdcAmount, receivingEnabled, tokenFor, tradeNetwork, type RelayQuote, type TradeIntent, type TradeNetwork, type TradeToken } from '../../../src/solares/relay/model';
import { validateIntent, validateRecordedIntent, validateQuote, validateReviewedQuoteWithoutSignature, expectedOrderExtraData, normalizeQuoteApprovals, APPROVE_ABI, DEPOSIT_ABI, EVM_DEPOSITORY, SOLANA_DEPOSITORY, SOLANA_DEPOSITORY_VAULT } from '../../../src/solares/relay/validation';
import { parseCurrencies } from '../../../src/solares/relay/currencies';
import { settlementOrderId, verifyClientSettlementIntegrity } from '../../../src/solares/relay/integrity';
import relayRouter, { verifySettlementIntegrity, relayQuoteRequest, verifyDestinationToken, verifiedChainMetadata } from './relay';

const evm = '0x1111111111111111111111111111111111111111';
const attacker = '0x2222222222222222222222222222222222222222';
const solana = 'GTtzwxqy67xx9DVESJjx28TgXqpc8xTqtiytgNMaQBTE';
const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ataProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
// Verified 2026-10-12. The bridged token calls itself USDC on Robinhood Chain; it is never funding.
const ROBINHOOD_LOOKALIKE = '0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8';
const AXL_USDC_BSC = '0x4268B8F0B87b6Eae5d897996E6b845ddbD99Adf3';
const ETHEREUM = 1, BSC = 56, ROBINHOOD = 4663, BASE = 8453;
const vmMap = Object.fromEntries(RELAY_NETWORKS.map((chain) => [chain.protocol, chain.vmType]));
const units = (network: TradeNetwork, whole: bigint) => (whole * 10n ** BigInt(network.funding.decimals)).toString();
function fixture(originId = BASE, destinationId = SOLANA_CHAIN_ID, destinationToken: TradeIntent['destinationToken'] = 'native', amount?: string) {
  const origin = tradeNetwork(originId);
  const destination = tradeNetwork(destinationId);
  const outputToken = tokenFor(destination, destinationToken);
  const funding = origin.funding.address;
  const intent: TradeIntent = { originChainId: originId, destinationChainId: destinationId, user: origin.vm === 'solana' ? solana : evm, recipient: destination.vm === 'solana' ? solana : evm, amount: amount ?? units(origin, 10n), destinationToken, slippageBps: 50 };
  // Policy-valid synthetic order (docs/RELAY_POLICY_2026-10.md): pinned solver, 7-day fill window, pinned extraData.
  // Synthetic orders cannot carry the solver's signature, so these tests use the synchronous validators only.
  const deadline = Math.floor(Date.now() / 1000) + 7 * 86_400;
  const orderData: RelayQuote['protocol']['v2']['orderData'] = {
    version: 'v1', solverChainId: RELAY_SOLVER.chain, solver: RELAY_SOLVER.address, salt: `0x${'01'.repeat(32)}`,
    inputs: [{ payment: { chainId: origin.protocol, currency: funding, amount: intent.amount, weight: '1' }, refunds: [{ chainId: origin.protocol, recipient: intent.user, currency: funding, minimumAmount: '1', deadline, extraData: expectedOrderExtraData(origin) }] }],
    output: { chainId: destination.protocol, payments: [{ recipient: intent.recipient, currency: outputToken.address, expectedAmount: '10000000', minimumAmount: '9950000' }], calls: [], deadline, extraData: expectedOrderExtraData(destination) }, fees: [],
  };
  const orderId = getOrderId(orderData, vmMap);
  const quote: RelayQuote = {
    requestId: `0x${'ab'.repeat(32)}`,
    details: { sender: intent.user, recipient: intent.recipient, currencyIn: { currency: { chainId: origin.id, address: funding, decimals: origin.funding.decimals }, amount: intent.amount }, currencyOut: { currency: { chainId: destination.id, address: outputToken.address, decimals: outputToken.decimals }, amount: '10000000', minimumAmount: '9950000' } },
    protocol: { v2: { orderId, hubType: 'onchain', orderSignature: `0x${'00'.repeat(65)}`, orderData, paymentDetails: { chainId: origin.protocol, currency: funding, amount: intent.amount, depository: origin.vm === 'solana' ? SOLANA_DEPOSITORY : EVM_DEPOSITORY } } },
    steps: [],
  };
  if (origin.vm === 'ethereum') {
    quote.steps = [
      { id: 'approve', kind: 'transaction', requestId: quote.requestId, items: [{ status: 'incomplete', data: { from: intent.user, to: funding, chainId: originId, value: '0', data: encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [EVM_DEPOSITORY, BigInt(intent.amount)] }) } }] },
      { id: 'deposit', kind: 'transaction', requestId: quote.requestId, items: [{ status: 'incomplete', data: { from: intent.user, to: EVM_DEPOSITORY, chainId: originId, value: '0', data: encodeFunctionData({ abi: DEPOSIT_ABI, functionName: 'depositErc20', args: [intent.user as `0x${string}`, funding as `0x${string}`, BigInt(intent.amount), orderId] }) }, check: { endpoint: `/intents/status/v3?requestId=${quote.requestId}`, method: 'GET' } }] },
    ];
  } else {
    const program = new PublicKey(SOLANA_DEPOSITORY);
    const [depository] = PublicKey.findProgramAddressSync([new TextEncoder().encode('relay_depository')], program);
    const [vault] = PublicKey.findProgramAddressSync([new TextEncoder().encode('vault')], program);
    const mint = new PublicKey(funding);
    const ata = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ataProgram)[0];
    const accounts = [depository.toBase58(), intent.user, intent.user, vault.toBase58(), funding, ata(new PublicKey(intent.user)).toBase58(), ata(vault).toBase58(), tokenProgram.toBase58(), ataProgram.toBase58(), '11111111111111111111111111111111'];
    const amountBytes = new Uint8Array(8); new DataView(amountBytes.buffer).setBigUint64(0, BigInt(intent.amount), true);
    const data = sha256(toHex('global:deposit_token')).slice(2, 18) + Buffer.from(amountBytes).toString('hex') + orderId.slice(2);
    quote.steps = [{ id: 'deposit', kind: 'transaction', requestId: quote.requestId, items: [{ status: 'incomplete', data: { instructions: [{ programId: SOLANA_DEPOSITORY, data, keys: accounts.map((pubkey, index) => ({ pubkey, isSigner: index === 1, isWritable: [1, 5, 6].includes(index) })) }], addressLookupTableAddresses: [] }, check: { endpoint: `/intents/status/v3?requestId=${quote.requestId}`, method: 'GET' } }] }];
  }
  return { quote, intent };
}
/** Rebuild the order id after a coherent hostile edit so only the pinned-value checks can catch it. */
function rehash(quote: RelayQuote) {
  quote.protocol.v2.orderId = getOrderId(quote.protocol.v2.orderData, vmMap);
  for (const step of quote.steps) for (const item of step.items) {
    if (step.id === 'deposit' && item.data.data) {
      const funding = quote.details.currencyIn.currency.address;
      item.data.data = encodeFunctionData({ abi: DEPOSIT_ABI, functionName: 'depositErc20', args: [item.data.from as `0x${string}`, funding as `0x${string}`, BigInt(quote.details.currencyIn.amount), quote.protocol.v2.orderId as `0x${string}`] });
    }
  }
}

test('supported Relay networks follow the registry: Solana first, BNB slug "bnb", pinned depositories, no Arbitrum or Polygon', () => {
  assert.deepEqual(RELAY_NETWORKS.map(chain => [chain.id, chain.protocol]), [[SOLANA_CHAIN_ID, 'solana'], [1, 'ethereum'], [56, 'bnb'], [4663, 'robinhood'], [8453, 'base']]);
  assert.equal(EVM_DEPOSITORY.toLowerCase(), '0x4cd00e387622c35bddb9b4c962c136462338bc31');
  for (const chain of RELAY_NETWORKS) assert.equal(chain.depository, chain.vm === 'solana' ? SOLANA_DEPOSITORY : EVM_DEPOSITORY);
  assert.deepEqual(RELAY_NETWORKS.map(chain => [chain.funding.label, chain.funding.decimals]), [['USDC', 6], ['USDC', 6], ['USDC (Binance-Peg)', 18], ['USDG', 6], ['USDC', 6]]);
  for (const id of [42161, 137, 548123634, 10]) assert.throws(() => tradeNetwork(id));
});

test('funding amounts preserve base units at each stablecoin\'s own decimals without floating point truncation', () => {
  assert.equal(parseUsdcAmount('0.000001'), '1');
  assert.equal(parseUsdcAmount('999.999999'), '999999999');
  assert.equal(parseUsdcAmount('1000'), '1000000000');
  // The default bound is the 100,000-unit protocol sanity ceiling (owner decision 2026-10-13: no 1,000-unit trade ceiling).
  assert.equal(parseUsdcAmount('1000.000001'), '1000000001');
  assert.equal(parseUsdcAmount('100000'), '100000000000');
  assert.throws(() => parseUsdcAmount('100000.000001'), /100,000 USDC/);
  assert.equal(formatAmount('99999999999'), '99,999.999999');
  assert.equal(formatAmount('1', 18), '0.000000000000000001');
  assert.equal(formatAmount('1234', 8), '0.00001234');
  assert.equal(formatAmount('0', 18), '0');
  for (const value of ['0', '-1', '1e6', '1.0000001', ' 2', '01', 'NaN', '100001', '1000000000', 'Infinity']) assert.throws(() => parseUsdcAmount(value), value);
  const bsc = tradeNetwork(BSC).funding, usdg = tradeNetwork(ROBINHOOD).funding;
  assert.equal(parseFundingAmount('0.000000000000000001', bsc), '1');
  assert.equal(parseFundingAmount('25', bsc), '25000000000000000000');
  assert.equal(parseFundingAmount('1000', bsc), (10n ** 21n).toString());
  assert.equal(parseFundingAmount('999.999999999999999999', bsc), (10n ** 21n - 1n).toString());
  assert.equal(parseFundingAmount('1001', bsc), (1001n * 10n ** 18n).toString());
  assert.equal(parseFundingAmount('100000', bsc), (10n ** 23n).toString());
  for (const value of ['100000.000000000000000001', '1.0000000000000000001', '100001', '0']) assert.throws(() => parseFundingAmount(value, bsc), /USDC \(Binance-Peg\)/);
  // An explicit bound applies the same way at 18 decimals.
  assert.equal(parseFundingAmount('100', bsc, 100n), (10n ** 20n).toString());
  assert.throws(() => parseFundingAmount('100.000000000000000001', bsc, 100n), /and 100 USDC \(Binance-Peg\)/);
  assert.equal(parseFundingAmount('1.5', usdg), '1500000');
  assert.throws(() => parseFundingAmount('1.0000001', usdg), /USDG amount with up to 6 decimal places/);
  assert.equal(formatAmount(parseFundingAmount('234.5', bsc), 18), '234.5');
  assert.equal(formatAmount(parseFundingAmount('1234.5', bsc, 100_000n), 18), '1,234.5');
});

test('intent rejects unknown and removed chains, fields, fractional atomic amounts and VM mismatches', () => {
  const { intent } = fixture();
  for (const patch of [{ originChainId: 9999 }, { originChainId: 42161 }, { destinationChainId: 137 }, { destinationChainId: 548123634 }, { amount: '1.2' }, { amount: '0' }, { recipient: evm }, { user: solana }, { slippageBps: 10000 }, { refundTo: attacker }]) assert.throws(() => validateIntent({ ...intent, ...patch }));
  assert.throws(() => validateIntent({ ...intent, originChainId: 137 }), /no longer supported/);
});

test('amount bounds follow the source stablecoin: only the 100,000-unit sanity ceiling, at 18 decimals on BSC and 6 decimals elsewhere', () => {
  for (const network of RELAY_NETWORKS) {
    const destination = network.id === SOLANA_CHAIN_ID ? BASE : SOLANA_CHAIN_ID;
    // Owner decision 2026-10-13: above the old 100-unit default and 1,000-unit ceiling is accepted.
    assert.doesNotThrow(() => validateIntent(fixture(network.id, destination, 'native', (1_000n * 10n ** BigInt(network.funding.decimals) + 1n).toString()).intent));
    const max = 100_000n * 10n ** BigInt(network.funding.decimals);
    assert.doesNotThrow(() => validateIntent(fixture(network.id, destination, 'native', max.toString()).intent));
    assert.throws(() => validateIntent(fixture(network.id, destination, 'native', (max + 1n).toString()).intent), new RegExp(`Invalid ${network.funding.label.replace(/[()]/g, '\\$&')} amount`));
    // Saved records share the same 100,000-unit bound so device history stays readable; they never authorize a quote.
    const recorded = 100_000n * 10n ** BigInt(network.funding.decimals);
    assert.doesNotThrow(() => validateRecordedIntent(fixture(network.id, destination, 'native', recorded.toString()).intent));
    assert.throws(() => validateRecordedIntent(fixture(network.id, destination, 'native', (recorded + 1n).toString()).intent));
    assert.doesNotThrow(() => validateRecordedIntent(fixture(network.id, destination, 'native', (50_000n * 10n ** BigInt(network.funding.decimals)).toString()).intent));
  }
  // A BSC-sized 18-decimal amount is rejected on a 6-decimal network instead of being read as a huge USDC trade.
  assert.throws(() => validateIntent(fixture(BASE, SOLANA_CHAIN_ID, 'native', '25000000000000000000').intent), /Invalid USDC amount/);
  assert.throws(() => validateIntent(fixture(BASE, SOLANA_CHAIN_ID, 'native', '100000000001').intent), /Invalid USDC amount/);
  assert.doesNotThrow(() => validateIntent(fixture(BSC, SOLANA_CHAIN_ID, 'native', '25000000000000000000').intent));
});

test('every supported origin and enabled destination verifies for native and funding-stablecoin outputs', () => {
  for (const origin of RELAY_NETWORKS) for (const destination of RELAY_NETWORKS) {
    const outputs: TradeIntent['destinationToken'][] = ['native', fundingToken(destination)];
    for (const output of outputs) {
      if (origin.id === destination.id && typeof output === 'object') continue;
      const { quote, intent } = fixture(origin.id, destination.id, output);
      // No captured order arrives in BSC or Robinhood Chain from another network yet: those routes fail closed.
      if (!receivingEnabled(origin.id, destination.id)) assert.throws(() => validateQuote(quote, intent), /not enabled yet/, `${origin.name} to ${destination.name}`);
      else validateQuote(quote, intent);
      verifySettlementIntegrity(quote);
      verifyClientSettlementIntegrity(quote);
      const upstream = relayQuoteRequest(intent);
      assert.equal(upstream.originCurrency, origin.funding.address, `${origin.name} origin currency`);
      assert.equal(upstream.destinationCurrency, tokenFor(destination, output).address);
    }
  }
});

test('cross-network routes into BSC and Robinhood Chain fail closed until captured; same-network and outbound routes stay enabled', () => {
  for (const origin of RELAY_NETWORKS) for (const destination of RELAY_NETWORKS) {
    const enabled = origin.id === destination.id || !['bsc', 'robinhood'].includes(destination.key);
    assert.equal(receivingEnabled(origin.id, destination.id), enabled, `${origin.name} to ${destination.name}`);
    const { intent } = fixture(origin.id, destination.id, 'native');
    if (enabled) assert.doesNotThrow(() => validateIntent(intent), `${origin.name} to ${destination.name}`);
    else assert.throws(() => validateIntent(intent), new RegExp(`Swaps from another network into ${destination.name} are not enabled yet`));
    // Saved records in those directions stay readable.
    assert.doesNotThrow(() => validateRecordedIntent(intent));
  }
  assert.equal(receivingEnabled(BASE, 42161), false);
  assert.equal(receivingEnabled(137, 137), false);
});

test('quote requests fund from the pinned stablecoin: Solana/Ethereum/Base USDC, BSC Binance-Peg USDC, Robinhood USDG', () => {
  const expected: Record<number, string> = {
    [SOLANA_CHAIN_ID]: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    [ETHEREUM]: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    [BSC]: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    [ROBINHOOD]: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    [BASE]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  };
  for (const network of RELAY_NETWORKS) {
    const request = relayQuoteRequest(fixture(network.id, network.id === BASE ? ROBINHOOD : BASE).intent);
    assert.equal(request.originCurrency, expected[network.id]);
    assert.notEqual(request.originCurrency.toLowerCase(), ROBINHOOD_LOOKALIKE);
  }
});

test('legacy USDC selector resolves only to Circle USDC and never relabels USDG or Binance-Peg USDC', () => {
  for (const id of [SOLANA_CHAIN_ID, ETHEREUM, BASE]) assert.doesNotThrow(() => validateIntent(fixture(ROBINHOOD, id, 'USDC').intent));
  for (const id of [BSC, ROBINHOOD]) {
    assert.throws(() => tokenFor(tradeNetwork(id), 'USDC'), /not available/);
    assert.throws(() => validateIntent({ ...fixture(BASE, id).intent, destinationToken: 'USDC' }), /USDC is not available/);
  }
});

test('hostile substitution of the funding stablecoin is rejected on every input surface', () => {
  const surfaces: ((quote: RelayQuote, token: string) => void)[] = [
    (quote, token) => { quote.details.currencyIn.currency.address = token; },
    (quote, token) => { quote.protocol.v2.orderData.inputs[0].payment.currency = token; rehash(quote); },
    (quote, token) => { quote.protocol.v2.orderData.inputs[0].refunds[0].currency = token; rehash(quote); },
    (quote, token) => { quote.protocol.v2.paymentDetails.currency = token; },
    (quote, token) => { quote.steps[0].items[0].data.to = token; },
    (quote, token) => { quote.details.currencyIn.currency.address = token; rehash(quote); },
  ];
  const substitutes: [number, string][] = [[ROBINHOOD, ROBINHOOD_LOOKALIKE], [ROBINHOOD, attacker], [BSC, AXL_USDC_BSC], [BASE, tradeNetwork(ETHEREUM).funding.address], [ETHEREUM, tradeNetwork(BASE).funding.address]];
  for (const [chainId, token] of substitutes) for (const [index, substitute] of surfaces.entries()) {
    const { quote, intent } = fixture(chainId, SOLANA_CHAIN_ID);
    substitute(quote, token);
    assert.throws(() => validateQuote(quote, intent), /Route input changed|Protocol input does not match|does not return refunds|refund outside|Protocol payment changed|Approval targets an unexpected token/, `${chainId} surface ${index}`);
  }
});

test('quoted funding decimals must match each network: BSC 18, Robinhood USDG 6', () => {
  for (const [chainId, wrong] of [[BSC, 6], [ROBINHOOD, 18], [BASE, 18], [SOLANA_CHAIN_ID, 9]] as const) {
    const { quote, intent } = fixture(chainId, chainId === SOLANA_CHAIN_ID ? BASE : SOLANA_CHAIN_ID);
    validateQuote(quote, intent);
    quote.details.currencyIn.currency.decimals = wrong;
    assert.throws(() => validateQuote(quote, intent), /decimals/);
  }
});

test('stablecoin lookalikes cannot be selected as destination tokens or appear in token search', () => {
  const lookalike = { chainId: ROBINHOOD, address: ROBINHOOD_LOOKALIKE, symbol: 'USDC', name: 'USD Coin', decimals: 6 };
  assert.throws(() => validateIntent(fixture(BASE, ROBINHOOD, lookalike).intent), /imitates a stablecoin/);
  assert.throws(() => validateIntent(fixture(BASE, ROBINHOOD, { ...lookalike, symbol: 'BRIDGED' }).intent), /imitates a stablecoin/);
  const fakeUsdg = { chainId: ROBINHOOD, address: attacker, symbol: 'usdg', name: 'Global Dollar', decimals: 6 };
  const fakeUsdc = { chainId: BASE, address: attacker, symbol: 'uSDC', name: 'USD Coin', decimals: 6 };
  assert.throws(() => validateIntent(fixture(BASE, ROBINHOOD, fakeUsdg).intent), /stablecoin ticker/);
  assert.throws(() => validateIntent(fixture(ETHEREUM, BASE, fakeUsdc).intent), /stablecoin ticker/);
  const usdg = fundingToken(tradeNetwork(ROBINHOOD));
  assert.deepEqual(parseCurrencies([lookalike, fakeUsdg, usdg, { ...usdg, decimals: 18 }], ROBINHOOD), [usdg]);
  const binancePeg = fundingToken(tradeNetwork(BSC));
  assert.deepEqual(parseCurrencies([{ ...binancePeg, decimals: 6 }, { chainId: BSC, address: AXL_USDC_BSC, symbol: 'USDC', name: 'Axelar USDC', decimals: 6 }, binancePeg], BSC), [binancePeg]);
  // Another issuer's stablecoin keeps its own ticker on networks where it is not the funding token.
  const ethereumUsdg = { chainId: ETHEREUM, address: attacker, symbol: 'USDG', name: 'Global Dollar', decimals: 6 };
  assert.deepEqual(parseCurrencies([ethereumUsdg], ETHEREUM), [ethereumUsdg]);
});

test('rejects unlimited approvals, wrong spender and token target', () => {
  for (const chainId of [BASE, BSC, ROBINHOOD]) for (const change of ['unlimited', 'spender', 'target']) {
    const { quote, intent } = fixture(chainId);
    const data = quote.steps[0].items[0].data;
    if (change === 'target') data.to = attacker;
    else data.data = encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [change === 'spender' ? attacker : EVM_DEPOSITORY, change === 'unlimited' ? 2n ** 256n - 1n : BigInt(intent.amount)] });
    assert.throws(() => validateQuote(quote, intent));
  }
});
test('backend lowers canonical upstream unlimited approval without accepting a changed spender', () => {
  for (const chainId of [BASE, BSC, ROBINHOOD]) {
    const { quote, intent } = fixture(chainId);
    quote.steps[0].items[0].data.data = encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [EVM_DEPOSITORY, 2n ** 256n - 1n] });
    normalizeQuoteApprovals(quote, intent);
    validateQuote(quote, intent);
    quote.steps[0].items[0].data.data = encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [attacker, 2n ** 256n - 1n] });
    assert.throws(() => normalizeQuoteApprovals(quote, intent));
    const lookalike = fixture(ROBINHOOD).quote;
    lookalike.steps[0].items[0].data.to = ROBINHOOD_LOOKALIKE;
    assert.throws(() => normalizeQuoteApprovals(lookalike, fixture(ROBINHOOD).intent), /unexpected token/);
  }
});
test('rejects deposit calldata substitutions, native value, extra calldata and wrong source chain', () => {
  for (const chainId of [BASE, BSC, ROBINHOOD]) for (const change of ['amount', 'id', 'payer', 'value', 'chain', 'trailing', 'token']) {
    const { quote, intent } = fixture(chainId);
    const funding = tradeNetwork(chainId).funding.address;
    const data = quote.steps[1].items[0].data;
    if (change === 'value') data.value = '1';
    else if (change === 'chain') data.chainId = chainId === ETHEREUM ? BASE : ETHEREUM;
    else if (change === 'trailing') data.data += '00';
    else data.data = encodeFunctionData({ abi: DEPOSIT_ABI, functionName: 'depositErc20', args: [change === 'payer' ? attacker : evm, (change === 'token' ? ROBINHOOD_LOOKALIKE : funding) as `0x${string}`, change === 'amount' ? 999n : BigInt(intent.amount), change === 'id' ? `0x${'cd'.repeat(32)}` : quote.protocol.v2.orderId as `0x${string}`] });
    assert.throws(() => validateQuote(quote, intent), `${chainId} ${change}`);
  }
});
test('rejects expired routes and minimum output below accepted slippage', () => {
  const expired = fixture();
  // Less than 5 minutes of fill window left: the deposit could land after the deadline.
  const deadline = expired.quote.protocol.v2.orderData.output.deadline * 1000;
  assert.doesNotThrow(() => validateQuote(expired.quote, expired.intent, deadline - 6 * 60_000));
  assert.throws(() => validateQuote(expired.quote, expired.intent, deadline - 4 * 60_000), /fill window/);
  const minimum = fixture();
  minimum.quote.details.currencyOut.minimumAmount = '1';
  minimum.quote.protocol.v2.orderData.output.payments[0].minimumAmount = '1';
  assert.throws(() => validateQuote(minimum.quote, minimum.intent));
});
test('settlement hashing rejects coherently tampered display and order output', () => {
  for (const chainId of [BASE, BSC, ROBINHOOD]) {
    const { quote, intent } = fixture(chainId);
    quote.details.currencyOut.minimumAmount = '9990000';
    quote.protocol.v2.orderData.output.payments[0].minimumAmount = '9990000';
    // The structural view remains consistent; the independently recomputed hash catches it.
    validateQuote(quote, intent);
    assert.throws(() => verifySettlementIntegrity(quote), /integrity/);
    assert.throws(() => verifyClientSettlementIntegrity(quote), /independent wallet verification/);
  }
});

test('browser settlement hash matches pinned upstream SDK for every supported origin and destination', () => {
  for (const origin of RELAY_NETWORKS) for (const destination of RELAY_NETWORKS) {
    if (origin.id === destination.id) continue;
    for (const token of ['native', fundingToken(destination)] as const) {
      const { quote } = fixture(origin.id, destination.id, token);
      assert.equal(settlementOrderId(quote.protocol.v2.orderData), quote.protocol.v2.orderId);
      const varied = structuredClone(quote.protocol.v2.orderData);
      varied.salt = '123456789012345678901234567890';
      varied.output.extraData = '0x123400';
      varied.inputs[0].refunds[0].extraData = '0xcafe';
      assert.equal(settlementOrderId(varied), getOrderId(varied, vmMap));
    }
  }
  // Removed chains have no settlement VM mapping and fail closed.
  const legacy = structuredClone(fixture().quote.protocol.v2.orderData);
  legacy.output.chainId = 'arbitrum';
  assert.throws(() => settlementOrderId(legacy), /Unsupported settlement network/);
});

test('reviewed quote binds tracker, intent, deadline and finite expiry before wallet access', () => {
  for (const chainId of [BASE, BSC]) {
    const { quote, intent } = fixture(chainId);
    const quotedAt = Date.now();
    const reviewed = { quote, intent, requestId: quote.requestId!, quotedAt, expiresAt: quotedAt + 90_000 };
    validateReviewedQuoteWithoutSignature(reviewed, intent, quotedAt);
    for (const patch of [
      { requestId: `0x${'ff'.repeat(32)}` }, { expiresAt: NaN }, { expiresAt: Infinity },
      { expiresAt: quotedAt + 90_001 }, { quotedAt: quotedAt + 20_000 },
      { expiresAt: quotedAt }, { intent: { ...intent, amount: (BigInt(intent.amount) + 1n).toString() } },
    ]) assert.throws(() => validateReviewedQuoteWithoutSignature({ ...reviewed, ...patch }, intent, quotedAt));
    const tampered = structuredClone(reviewed);
    tampered.quote.details.currencyOut.minimumAmount = '9990000';
    tampered.quote.protocol.v2.orderData.output.payments[0].minimumAmount = '9990000';
    assert.throws(() => validateReviewedQuoteWithoutSignature(tampered, intent, quotedAt), /independent wallet verification/);
  }
});
test('rejects redirected refunds, hidden destination calls and arbitrary status URLs', () => {
  for (const change of ['refund', 'calls', 'url']) {
    const { quote, intent } = fixture();
    if (change === 'refund') quote.protocol.v2.orderData.inputs[0].refunds[0].recipient = attacker;
    else if (change === 'calls') quote.protocol.v2.orderData.output.calls = ['0x12'];
    else quote.steps[1].items[0].check!.endpoint = 'https://attacker.invalid/collect';
    assert.throws(() => validateQuote(quote, intent), change);
  }
});
test('rejects additional Solana transfers, account substitutions and deposit amount changes', () => {
  for (const change of ['transfer', 'account', 'amount', 'duplicate', 'vault']) {
    const { quote, intent } = fixture(SOLANA_CHAIN_ID, BASE);
    const instructions = quote.steps[0].items[0].data.instructions!;
    if (change === 'transfer') instructions.push({ programId: '11111111111111111111111111111111', data: '02000000', keys: [] });
    else if (change === 'account') instructions[0].keys[2].pubkey = '11111111111111111111111111111111';
    else if (change === 'vault') instructions[0].keys[3].pubkey = solana;
    else if (change === 'duplicate') instructions.push(structuredClone(instructions[0]));
    else instructions[0].data = instructions[0].data.slice(0, 16) + '0100000000000000' + instructions[0].data.slice(32);
    assert.throws(() => validateQuote(quote, intent), change);
  }
});
test('Solana compute budget is bounded and cannot hide authority-changing instructions', () => {
  const { quote, intent } = fixture(SOLANA_CHAIN_ID, BASE);
  const price = new Uint8Array(9); price[0] = 3; new DataView(price.buffer).setBigUint64(1, 1_000_000_000_000n, true);
  quote.steps[0].items[0].data.instructions!.unshift({ programId: 'ComputeBudget111111111111111111111111111111', data: Buffer.from(price).toString('hex'), keys: [] });
  assert.throws(() => validateQuote(quote, intent), /priority fee/);
});

test('EVM network fee caps are per native token: 0.02 ETH on ETH-gas chains, 0.01 BNB on BSC, none for POL', () => {
  const gwei = 10n ** 9n;
  assert.equal(evmNetworkFeeCap(tradeNetwork(ETHEREUM)), 2n * 10n ** 16n);
  assert.equal(evmNetworkFeeCap(tradeNetwork(BASE)), 2n * 10n ** 16n);
  assert.equal(evmNetworkFeeCap(tradeNetwork(ROBINHOOD)), 2n * 10n ** 16n);
  assert.equal(evmNetworkFeeCap(tradeNetwork(BSC)), 10n ** 16n);
  assert.throws(() => evmNetworkFeeCap(tradeNetwork(SOLANA_CHAIN_ID)));
  assert.doesNotThrow(() => assertEvmNetworkFee(tradeNetwork(ETHEREUM), 1_000_000n, 20n * gwei));
  assert.throws(() => assertEvmNetworkFee(tradeNetwork(ETHEREUM), 1_000_000n, 20n * gwei + 1n), /network fee/);
  assert.doesNotThrow(() => assertEvmNetworkFee(tradeNetwork(BSC), 1_000_000n, 10n * gwei));
  assert.throws(() => assertEvmNetworkFee(tradeNetwork(BSC), 1_000_000n, 10n * gwei + 1n), /network fee/);
  assert.throws(() => assertEvmNetworkFee(tradeNetwork(BASE), 1_000_001n, 1n), /network fee/);
  assert.throws(() => assertEvmNetworkFee(tradeNetwork(BASE), 0n, 1n), /network fee/);
});

test('Relay chain metadata must pin every supported slug, depository, fill contract and the solver, and ignores same-named venues', () => {
  const healthy = () => [
    ...RELAY_NETWORKS.map(chain => ({
      id: chain.id, vmType: chain.vm === 'solana' ? 'svm' : 'evm',
      protocol: { v2: { chainId: chain.protocol, depository: chain.vm === 'solana' ? SOLANA_DEPOSITORY : EVM_DEPOSITORY.toLowerCase(), ...(chain.vm === 'solana' ? { depositoryVault: SOLANA_DEPOSITORY_VAULT } : {}) } },
      contracts: { erc20Router: chain.vm === 'solana' ? '' : RELAY_EVM_FILL_CONTRACT },
      solverAddresses: chain.vm === 'solana' ? [] : [RELAY_SOLVER.address, attacker],
    })),
    { id: 548123634, vmType: 'evm', protocol: { v2: { chainId: 'robinhood', depository: attacker } } },
    { id: 42161, vmType: 'evm', protocol: { v2: { chainId: 'arbitrum', depository: EVM_DEPOSITORY } } },
  ];
  const kept = verifiedChainMetadata(healthy());
  assert.deepEqual(kept.map(chain => chain.id), RELAY_NETWORKS.map(chain => chain.id));
  for (const [id, patch] of [[BSC, { chainId: 'bsc' }], [BSC, { depository: attacker }], [ROBINHOOD, { depository: attacker }], [ROBINHOOD, { chainId: 'robinhood-lighter' }], [SOLANA_CHAIN_ID, { depository: solana }], [SOLANA_CHAIN_ID, { depositoryVault: solana }], [SOLANA_CHAIN_ID, { depositoryVault: undefined }]] as const) {
    const chains = healthy();
    const target = chains.find(chain => chain.id === id)!;
    target.protocol.v2 = { ...target.protocol.v2, ...patch };
    assert.throws(() => verifiedChainMetadata(chains), /contracts changed/, `${id}`);
  }
  assert.throws(() => verifiedChainMetadata(healthy().filter(chain => chain.id !== ROBINHOOD)), /contracts changed/);
  assert.throws(() => verifiedChainMetadata([...healthy(), healthy()[2]]), /contracts changed/);
  assert.throws(() => verifiedChainMetadata(undefined), /unavailable/);
  // A changed EVM fill contract, or a solver dropped from Base, needs a reviewed update.
  for (const id of [ETHEREUM, BSC, ROBINHOOD, BASE]) {
    const chains = healthy();
    Object.assign(chains.find(chain => chain.id === id)!, { contracts: { erc20Router: attacker } });
    assert.throws(() => verifiedChainMetadata(chains), /contracts changed/, `${id} router`);
  }
  const noSolver = healthy();
  Object.assign(noSolver.find(chain => chain.id === BASE)!, { solverAddresses: [attacker] });
  assert.throws(() => verifiedChainMetadata(noSolver), /contracts changed/);
  // The live /chains response captured read-only on 2026-10-12 passes unchanged.
  const captured = JSON.parse(readFileSync(new URL('./fixtures/relay-orders/chains.json', import.meta.url), 'utf8')) as { chains: unknown };
  assert.deepEqual(verifiedChainMetadata(captured.chains).map(chain => chain.id).sort((a, b) => a - b), RELAY_NETWORKS.map(chain => chain.id).sort((a, b) => a - b));
});

test('public configuration lists supported networks with their funding stablecoins and no credentials', async () => {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use('/api/solares/relay', relayRouter);
  const config = await request(app).get('/api/solares/relay/config').expect(200);
  assert.equal(typeof config.body.configured, 'boolean');
  assert.deepEqual(Object.keys(config.body).sort(), ['configured', 'environment', 'fillWindowDays', 'maxDailyUnits', 'maxFundingUnits', 'maxTradeUnits', 'mode', 'networks', 'refundGuaranteed', 'swapLimitsError']);
  assert.equal(config.body.mode, 'verified-funding-origin');
  assert.equal(config.body.fillWindowDays, 7);
  assert.equal(config.body.refundGuaranteed, false);
  // Owner decision 2026-10-13: no swap cap; only the protocol sanity ceiling, whatever the removed cap variables say.
  assert.deepEqual([config.body.maxTradeUnits, config.body.maxFundingUnits, config.body.maxDailyUnits, config.body.swapLimitsError], ['100000', '100000', null, null]);
  assert.deepEqual(config.body.networks.map((chain: { id: number }) => chain.id), [SOLANA_CHAIN_ID, ETHEREUM, BSC, ROBINHOOD, BASE]);
  assert.deepEqual(config.body.networks.map((chain: { funding: { label: string; decimals: number } }) => `${chain.funding.label}/${chain.funding.decimals}`), ['USDC/6', 'USDC/6', 'USDC (Binance-Peg)/18', 'USDG/6', 'USDC/6']);
  const response = await request(app).post('/api/solares/relay/quote').send(fixture().intent);
  assert.ok(response.status === 401 || response.status === 503, 'Unauthenticated quote must fail before any upstream request');
  assert.equal(typeof response.body.error, 'string');
});

test('the removed swap cap variables are ignored at startup: no warning, swaps stay enabled', () => {
  // A fresh process loads the router the way the server does; no request is made.
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/solares/relay.ts'); process.exit(0)"], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, RELAY_MAX_TRADE_UNITS: 'invalid-cap-value', RELAY_DAILY_MAX_UNITS: '1', RELAY_MAX_DAILY_UNITS: '' },
  });
  assert.equal(result.status, 0, 'the router module loads');
  const output = `${result.stdout}${result.stderr}`;
  assert.ok(!output.includes('Swaps disabled'), 'no cap check runs');
  assert.ok(!output.includes('invalid-cap-value'), 'the value is never logged');
});

test('same-network swaps on every network retain exact source and payout verification', () => {
  for (const network of RELAY_NETWORKS) {
    const { quote, intent } = fixture(network.id, network.id, 'native');
    validateQuote(quote, intent);
    verifySettlementIntegrity(quote);
    verifyClientSettlementIntegrity(quote);
    const request = relayQuoteRequest(intent);
    assert.equal(request.originChainId, request.destinationChainId);
    assert.equal(request.forceSolverExecution, true);
    assert.equal(request.explicitDeposit, true);
    assert.equal(request.includeProtocolData, true);
    const label = new RegExp(`other than ${network.funding.label.replace(/[()]/g, '\\$&')}`);
    assert.throws(() => validateIntent(fixture(network.id, network.id, fundingToken(network)).intent), label);
    if (network.funding.circleIssued) assert.throws(() => validateIntent(fixture(network.id, network.id, 'USDC').intent), label);
  }
});

test('custom destination tokens bind chain, address and decimals through JSON review and execution', () => {
  for (const network of RELAY_NETWORKS) {
    const token: TradeToken = { chainId: network.id, address: network.vm === 'solana' ? solana : attacker, symbol: 'TOKEN', name: 'Test token', decimals: 8 };
    const { quote, intent } = fixture(network.id, network.id, token);
    validateQuote(quote, intent);
    verifySettlementIntegrity(quote);
    const now = Date.now();
    const reviewed = JSON.parse(JSON.stringify({ quote, intent, requestId: quote.requestId, quotedAt: now, expiresAt: now + 90_000 }));
    validateReviewedQuoteWithoutSignature(reviewed, intent, now);
    assert.equal(relayQuoteRequest(intent).destinationCurrency, token.address);
    for (const patch of [{ chainId: 10 }, { decimals: 18 }, { symbol: 'OTHER' }, { address: network.funding.address }]) {
      const changed = structuredClone(reviewed);
      changed.intent.destinationToken = { ...token, ...patch };
      assert.throws(() => validateReviewedQuoteWithoutSignature(changed, intent, now));
    }
    quote.details.currencyOut.currency.decimals = 18;
    assert.throws(() => validateQuote(quote, intent), /decimals/);
  }
});

test('token lookup rechecks provider metadata instead of trusting submitted decimals', async (t) => {
  const token = { chainId: BASE, address: attacker, symbol: 'TEST', name: 'Test token', decimals: 8 };
  const { intent } = fixture(ETHEREUM, BASE, token);
  const requests: { url: string; body: unknown }[] = [];
  const binancePeg = fundingToken(tradeNetwork(BSC));
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    requests.push({ url, body });
    return new Response(JSON.stringify(body.chainIds[0] === BSC ? [{ ...binancePeg, decimals: 6 }] : [token]), { status: 200 });
  });
  await verifyDestinationToken(intent);
  assert.equal(requests[0].url, 'https://api.relay.link/currencies/v2');
  // Relay's own list first; it resolved the token, so external search is not consulted.
  assert.deepEqual(requests.map(item => item.body), [{ chainIds: [BASE], address: attacker, useExternalSearch: false, limit: 10 }]);
  await assert.rejects(verifyDestinationToken({ ...intent, destinationToken: { ...token, decimals: 18 } }), /metadata changed/);
  await assert.rejects(verifyDestinationToken({ ...intent, destinationToken: { ...token, address: evm } }), /metadata changed/);
  // Binance-Peg USDC is pinned at 18 decimals: provider metadata (here 6) is never consulted, and a
  // submitted 6-decimal copy is rejected without a lookup.
  requests.length = 0;
  await verifyDestinationToken(fixture(BASE, BSC, binancePeg).intent);
  await assert.rejects(verifyDestinationToken(fixture(BASE, BSC, { ...binancePeg, decimals: 6 }).intent), /metadata changed/);
  assert.deepEqual(requests, []);
});

test('public token search restricts networks and forwards only fixed metadata requests', async (t) => {
  const token = { chainId: ROBINHOOD, address: attacker, symbol: 'TEST', name: 'Test token', decimals: 8 };
  const seen: { url: string; body: { chainIds: number[] } }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => { seen.push({ url, body: JSON.parse(init.body as string) }); return new Response(JSON.stringify([token, { ...token, chainId: 548123634 }]), { status: 200 }); });
  const app = express(); app.use('/relay', relayRouter);
  const result = await request(app).get('/relay/currencies?chainId=4663&term=TEST').expect(200);
  assert.deepEqual(result.body.tokens, [token]);
  assert.deepEqual(seen.map(item => [item.url, item.body.chainIds]), [['https://api.relay.link/currencies/v2', [ROBINHOOD]]]);
  await request(app).get('/relay/currencies?chainId=56&term=USDC').expect(200);
  for (const query of ['chainId=999', 'chainId=137&term=TEST', 'chainId=42161&term=TEST', 'chainId=548123634', 'chainId=4663&term[x]=test', 'chainId=4663&url=https://example.com', 'chainId=4663&term=' + 'x'.repeat(101)]) {
    await request(app).get('/relay/currencies?' + query).expect(400);
  }
  assert.equal(seen.length, 2);
});
