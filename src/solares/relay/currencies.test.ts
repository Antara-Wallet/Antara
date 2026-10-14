import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCurrencies, currencySearchRequest, initialCurrencies, pinnedCurrency, sameTokenSymbol, tokenLookupRequests } from './currencies';
import { validateIntent } from './validation';
import { tokenFor, relayNetwork, fundingToken, nativeToken, tradeNetwork, RELAY_NETWORKS } from './model';
const token = { chainId: 8453, address: '0x2222222222222222222222222222222222222222', symbol: 'TEST', name: 'Test token', decimals: 8 };

test('search removes malformed metadata, duplicate addresses and unrelated networks', () => {
  const data = [token, { ...token, extra: 'discarded' }, { ...token, chainId: 1 }, { ...token, decimals: 256 }, { ...token, address: 'bad' }, { ...token, symbol: '\u202EETH' }, { ...token, name: '' }, null];
  assert.deepEqual(parseCurrencies(data, 8453), [token]);
  assert.throws(() => parseCurrencies({}, 8453));
  assert.throws(() => parseCurrencies(Array(101).fill(token), 8453));
});
test('native and funding-stablecoin metadata cannot be spoofed with another ticker or decimals', () => {
  const chain = relayNetwork(8453);
  const usdc = tokenFor(chain, 'USDC'), native = tokenFor(chain, 'native');
  assert.deepEqual(parseCurrencies([usdc, native], 8453), [usdc, native]);
  assert.deepEqual(parseCurrencies([{ ...usdc, decimals: 18 }, { ...native, symbol: 'BTC' }], 8453), []);
  const bsc = fundingToken(tradeNetwork(56)), usdg = fundingToken(tradeNetwork(4663));
  assert.deepEqual(parseCurrencies([{ ...bsc, decimals: 6 }, bsc], 56), [bsc]);
  assert.deepEqual(parseCurrencies([{ ...usdg, symbol: 'USDC' }, { ...usdg, decimals: 18 }, usdg], 4663), [usdg]);
  assert.deepEqual(parseCurrencies([{ ...native, chainId: 56, symbol: 'ETH' }], 56), []);
});
test('stablecoin lookalikes never reach the picker', () => {
  const bridged = { chainId: 4663, address: '0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8', symbol: 'USDC', name: 'USD Coin', decimals: 6 };
  assert.deepEqual(parseCurrencies([bridged, { ...bridged, address: bridged.address.toUpperCase().replace('0X', '0x'), symbol: 'BUSDC' }], 4663), []);
  assert.deepEqual(parseCurrencies([{ ...token, symbol: 'USDC' }, { ...token, address: '0x3333333333333333333333333333333333333333', symbol: 'usdc' }], 8453), []);
  assert.deepEqual(parseCurrencies([{ ...token, chainId: 4663, symbol: 'USDG' }], 4663), []);
});
test('initial picker tokens are the native token and the pinned funding stablecoin for each network', () => {
  assert.deepEqual(initialCurrencies(792703809).map(item => item.symbol), ['SOL', 'USDC']);
  assert.deepEqual(initialCurrencies(56).map(item => [item.symbol, item.decimals, item.address]), [['BNB', 18, '0x0000000000000000000000000000000000000000'], ['USDC', 18, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d']]);
  assert.deepEqual(initialCurrencies(4663).map(item => [item.symbol, item.decimals, item.address]), [['ETH', 18, '0x0000000000000000000000000000000000000000'], ['USDG', 6, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168']]);
  for (const id of [42161, 137, 10]) assert.throws(() => initialCurrencies(id));
});
test('search accepts names and addresses with bounded terms and supported networks', () => {
  assert.deepEqual(currencySearchRequest(8453, ' cbBTC '), { chainIds: [8453], limit: 50, term: 'cbBTC', useExternalSearch: true });
  assert.deepEqual(currencySearchRequest(8453, ''), { chainIds: [8453], limit: 50, defaultList: true, verified: true });
  assert.deepEqual(currencySearchRequest(8453, token.address), { chainIds: [8453], limit: 50, address: token.address, useExternalSearch: true });
  assert.deepEqual(currencySearchRequest(56, ''), { chainIds: [56], limit: 50, defaultList: true, verified: true });
  assert.deepEqual(currencySearchRequest(4663, 'USDG'), { chainIds: [4663], limit: 50, term: 'USDG', useExternalSearch: true });
  for (const id of [10, 137, 42161, 548123634]) assert.throws(() => currencySearchRequest(id, 'ETH'));
  assert.throws(() => currencySearchRequest(8453, 'a'.repeat(101)));
});
test('intent rejects destination token objects with hidden fields or invalid units', () => {
  const intent = { originChainId: 1, destinationChainId: 8453, user: '0x1111111111111111111111111111111111111111', recipient: '0x1111111111111111111111111111111111111111', amount: '1000000', slippageBps: 50, destinationToken: token };
  for (const patch of [{ decimals: -1 }, { decimals: 1.5 }, { chainId: 1 }, { address: 'bad' }, { symbol: '' }, { approval: 'unlimited' }]) {
    assert.throws(() => validateIntent({ ...intent, destinationToken: { ...token, ...patch } }));
  }
});
test('destination re-verification: pinned assets come from the registry, other tokens from Relay\'s own list first', () => {
  for (const network of RELAY_NETWORKS) {
    for (const pinned of [nativeToken(network), fundingToken(network)]) {
      assert.deepEqual(pinnedCurrency(network.id, network.vm === 'ethereum' ? pinned.address.toLowerCase() : pinned.address), pinned);
    }
  }
  // Robinhood Chain ETH is pinned whatever a provider calls the zero address ("WETH" with external search).
  assert.equal(pinnedCurrency(4663, '0x0000000000000000000000000000000000000000')?.symbol, 'ETH');
  assert.equal(pinnedCurrency(8453, token.address), undefined);
  // A bridged "USDC" lookalike is never a pinned asset.
  assert.equal(pinnedCurrency(4663, '0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8'), undefined);
  for (const id of [42161, 137]) assert.throws(() => pinnedCurrency(id, token.address));
  assert.deepEqual(tokenLookupRequests(token), [
    { chainIds: [8453], address: token.address, useExternalSearch: false, limit: 10 },
    { chainIds: [8453], address: token.address, useExternalSearch: true, limit: 10 },
  ]);
  assert.ok(sameTokenSymbol('nvda', 'NVDA') && sameTokenSymbol('Bonk', 'BONK'));
  assert.ok(!sameTokenSymbol('WETH', 'ETH') && !sameTokenSymbol('NVDA', 'NVDA2'));
});
