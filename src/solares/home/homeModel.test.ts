import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBalance } from '../wallet/balances';
import { formatClock, parsePriceSnapshot, type PricesState } from '../wallet/prices';
import type { WalletBalance } from '../wallet/types';
import {
  MASK, UNKNOWN, accountExplorerUrl, addressFor, compareAssets, defaultScope, emptyTokensCopy, heroExplorer, heroModel,
  isNetworkScope, maskAmount, networkOptions, priceLine, tokenDetail, tokenRows, tokenUsd, type HeroInput,
} from './homeModel';

const SOLANA = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const EVM = '0x1111111111111111111111111111111111111111';

/** Every network loaded, deliberately out of registry order. */
const ALL: WalletBalance[] = [
  canonicalBalance('base', 10_000_000n, false),
  canonicalBalance('robinhood', 2_500_000n, false),
  canonicalBalance('bsc', 1_500_000_000_000_000_000n, false),
  canonicalBalance('ethereum', 25_000_000n, false),
  canonicalBalance('solana', 42_500_000n, false),
  canonicalBalance('base', 0n, true),
  canonicalBalance('robinhood', 10_000_000_000_000_000n, true),
  canonicalBalance('bsc', 250_000_000_000_000_000n, true),
  canonicalBalance('ethereum', 50_000_000_000_000_000n, true),
  canonicalBalance('solana', 1_250_000_000n, true),
];

/** The API's answer with Relay's prices of 2026-10-14 (server/src/solares/fixtures/relay-prices). */
const PRICES_BODY = {
  prices: {
    solana: { native: { usd: 107.831068, symbol: 'SOL' }, funding: { usd: 0.999898, symbol: 'USDC' } },
    ethereum: { native: { usd: 2511.149244, symbol: 'ETH' }, funding: { usd: 0.999859, symbol: 'USDC' } },
    bsc: { native: { usd: 744.462048, symbol: 'BNB' }, funding: { usd: 0.999859, symbol: 'USDC' } },
    robinhood: { native: { usd: 2511.149244, symbol: 'ETH' }, funding: { usd: 0.999881, symbol: 'USDG' } },
    base: { native: { usd: 2511.149244, symbol: 'ETH' }, funding: { usd: 0.999859, symbol: 'USDC' } },
  },
  observedAt: '2026-10-14T05:00:52.000Z',
  source: 'Relay',
};
const PRICES: PricesState = { status: 'ready', snapshot: parsePriceSnapshot(PRICES_BODY) };
const CLOCK = formatClock(PRICES_BODY.observedAt);
const STAMP = `prices from Relay, ${CLOCK}`;

const signedIn = (overrides: Partial<HeroInput> = {}): HeroInput => ({
  authenticated: true, ready: true, scope: 'solana', balances: ALL, balancesLoading: false, balancesError: null,
  currentAddress: SOLANA, addresses: { solana: SOLANA, ethereum: EVM }, privacy: false, prices: PRICES, cluster: 'mainnet-beta', ...overrides,
});

test('network filter options are All networks, then the five networks with Solana first', () => {
  assert.deepEqual(networkOptions('mainnet-beta').map(option => option.label), ['All networks', 'Solana', 'Ethereum', 'BNB Smart Chain', 'Robinhood Chain', 'Base']);
  assert.deepEqual(networkOptions('mainnet-beta').map(option => option.value), ['all', 'solana', 'ethereum', 'bsc', 'robinhood', 'base']);
  assert.equal(networkOptions('devnet')[1].label, 'Solana devnet');
  assert.equal(defaultScope(false), 'solana');
  assert.equal(defaultScope(true), 'all');
  assert.equal(isNetworkScope('all'), true);
  assert.equal(isNetworkScope('bsc'), true);
  assert.equal(isNetworkScope('arbitrum'), false);
});

test('token rows are Solana first, in registry order, native before stablecoin', () => {
  const rows = tokenRows(ALL, 'all', '', 'mainnet-beta');
  assert.deepEqual(rows.map(row => row.id), [
    'solana-native', 'solana-stablecoin', 'ethereum-native', 'ethereum-stablecoin', 'bsc-native', 'bsc-stablecoin',
    'robinhood-native', 'robinhood-stablecoin', 'base-native', 'base-stablecoin',
  ]);
  assert.equal(rows[0].chain, 'solana');
  assert.equal(rows[0].rowName, 'SOL on Solana');
  assert.equal(compareAssets({ chain: 'solana', kind: 'stablecoin' }, { chain: 'ethereum', kind: 'native' }) < 0, true);
});

test('rows use registry labels and never give USDG or Binance-Peg USDC the USDC mark', () => {
  const rows = tokenRows(ALL, 'all', '', 'mainnet-beta');
  const bsc = rows.find(row => row.id === 'bsc-stablecoin')!;
  assert.equal(bsc.label, 'USDC (Binance-Peg)');
  assert.equal(bsc.name, 'Binance-Peg USD Coin');
  assert.equal(bsc.mark, 'stablecoin');
  assert.equal(bsc.balance, '1.5');
  assert.equal(bsc.rowName, 'USDC (Binance-Peg) on BNB Smart Chain');
  const usdg = rows.find(row => row.id === 'robinhood-stablecoin')!;
  assert.equal(usdg.label, 'USDG');
  assert.equal(usdg.mark, 'stablecoin');
  assert.doesNotMatch(`${usdg.name} ${usdg.label} ${usdg.rowName}`, /USDC/);
  assert.equal(rows.find(row => row.id === 'solana-stablecoin')!.mark, 'USDC');
  assert.equal(rows.find(row => row.id === 'base-stablecoin')!.mark, 'USDC');
});

test('a loaded zero is a zero row; a network that did not load has no rows', () => {
  const rows = tokenRows(ALL, 'base', '', 'mainnet-beta');
  assert.deepEqual(rows.map(row => [row.id, row.balance]), [['base-native', '0'], ['base-stablecoin', '10']]);
  const failed = ALL.filter(balance => balance.chain !== 'base');
  assert.deepEqual(tokenRows(failed, 'base', '', 'mainnet-beta'), []);
  // Duplicates are dropped rather than double counted.
  assert.equal(tokenRows([...ALL, ...ALL], 'solana', '', 'mainnet-beta').length, 2);
});

test('search matches name, label or network, case-insensitively', () => {
  assert.deepEqual(tokenRows(ALL, 'all', 'paxos', 'mainnet-beta').map(row => row.id), ['robinhood-stablecoin']);
  assert.deepEqual(tokenRows(ALL, 'all', '  BNB smart ', 'mainnet-beta').map(row => row.id), ['bsc-native', 'bsc-stablecoin']);
  assert.deepEqual(tokenRows(ALL, 'all', 'nothing like this', 'mainnet-beta'), []);
});

test('privacy masks every amount, the total and what it leaves out', () => {
  assert.equal(maskAmount('42.5', true), MASK);
  assert.equal(maskAmount('42.5', false), '42.5');
  const hero = heroModel(signedIn({ privacy: true, scope: 'all' }));
  assert.deepEqual(hero.value, { kind: 'masked' });
  assert.deepEqual(hero.breakdown, []);
  assert.equal(hero.hint, undefined);
  assert.equal(hero.title, undefined);
  const noUsdg: PricesState = { status: 'ready', snapshot: parsePriceSnapshot({ ...PRICES_BODY, prices: { ...PRICES_BODY.prices, robinhood: { native: PRICES_BODY.prices.robinhood.native } } }) };
  const masked = heroModel(signedIn({ privacy: true, scope: 'robinhood', currentAddress: EVM, prices: noUsdg }));
  assert.deepEqual(masked.notes, ['Excludes USDG (no price)'], 'the note names the asset, never its amount');
  const unpriced = heroModel(signedIn({ privacy: true, prices: { status: 'unavailable' } }));
  assert.deepEqual(unpriced.value, { kind: 'masked' });
  assert.deepEqual(unpriced.breakdown, []);
});

test('the hero is the total of every asset in scope, in US dollars, with its source and time', () => {
  const solana = heroModel(signedIn());
  assert.equal(solana.label, 'Total balance');
  // 1.25 SOL at $107.831068 + 42.5 USDC at $0.999898 = $177.2845
  assert.deepEqual(solana.value, { kind: 'usd', amount: '$177.28', approx: true });
  assert.equal(solana.meta, `2 assets · Solana · ${STAMP}`);
  assert.deepEqual(solana.notes, []);
  assert.deepEqual(solana.chains, ['solana']);
  assert.equal(solana.failed, false);
  assert.match(solana.title!, /^Estimated value in US dollars, using Relay prices read at \d\d:\d\d\. Not a quote\.$/);
  // Binance-Peg USDC has 18 decimals: 0.25 BNB + 1.5 USDC (Binance-Peg) = $187.6153005.
  assert.deepEqual(heroModel(signedIn({ scope: 'bsc', currentAddress: EVM })).value, { kind: 'usd', amount: '$187.62', approx: true });
  assert.deepEqual(heroModel(signedIn({ scope: 'robinhood', currentAddress: EVM })).value, { kind: 'usd', amount: '$27.61', approx: true });
  const all = heroModel(signedIn({ scope: 'all' }));
  assert.deepEqual(all.value, { kind: 'usd', amount: '$553.06', approx: true });
  assert.deepEqual(all.breakdown, []);
  assert.equal(all.meta, `10 assets · 5 networks · ${STAMP}`);
});

test('the owner case: SOL held and 0 USDC is a dollar total, never "0 USDC"', () => {
  const balances = [canonicalBalance('solana', 98_333_920n, true), canonicalBalance('solana', 0n, false)];
  const hero = heroModel(signedIn({ balances }));
  assert.deepEqual(hero.value, { kind: 'usd', amount: '$10.60', approx: true });
  assert.equal(hero.meta, `2 assets · Solana · ${STAMP}`);
  assert.doesNotMatch(JSON.stringify(hero), /0 USDC|USDC balance/);
  // Without prices, the SOL itself leads: never a zero.
  const unpriced = heroModel(signedIn({ balances, prices: { status: 'unavailable' } }));
  assert.deepEqual(unpriced.value, { kind: 'amount', amount: '0.0983', unit: 'SOL' });
  assert.equal(unpriced.meta, '2 assets · Solana · USD value unavailable');
  assert.deepEqual(unpriced.breakdown, [], 'a zero balance is not listed as another holding');
  // While prices load, a muted stand-in that says so.
  const loading = heroModel(signedIn({ balances, prices: { status: 'loading' } }));
  assert.deepEqual(loading.value, { kind: 'loading' });
  assert.equal(loading.hint, 'Reading prices');
  assert.equal(loading.meta, '2 assets · Solana · Reading prices');
});

test('an asset without a price is excluded by name; with no price at all the largest holding leads', () => {
  const noUsdg: PricesState = { status: 'ready', snapshot: parsePriceSnapshot({ ...PRICES_BODY, prices: { ...PRICES_BODY.prices, robinhood: { native: PRICES_BODY.prices.robinhood.native } } }) };
  const robinhood = heroModel(signedIn({ scope: 'robinhood', currentAddress: EVM, prices: noUsdg }));
  assert.deepEqual(robinhood.value, { kind: 'usd', amount: '$25.11', approx: true });
  assert.deepEqual(robinhood.notes, ['Excludes 2.5 USDG (no price)']);
  const none = heroModel(signedIn({ scope: 'all', prices: { status: 'unavailable' } }));
  // One entry per token: Circle USDC on Solana, Ethereum and Base adds up to 77.5; ETH on three networks to 0.06.
  assert.deepEqual(none.value, { kind: 'amount', amount: '77.5', unit: 'USDC' });
  assert.deepEqual(none.breakdown, [
    { label: 'USDG', amount: '2.5' }, { label: 'USDC (Binance-Peg)', amount: '1.5' }, { label: 'SOL', amount: '1.25' },
    { label: 'BNB', amount: '0.25' }, { label: 'ETH', amount: '0.06' },
  ]);
  assert.equal(none.meta, '10 assets · 5 networks · USD value unavailable');
  assert.equal(none.title, undefined);
});

test('unknown is never zero: a failed network is excluded by name, a loaded zero stays zero', () => {
  const failed = ALL.filter(balance => balance.chain !== 'base');
  const error = 'Live balances unavailable on Base. Check your RPC connections.';
  const all = heroModel(signedIn({ scope: 'all', balances: failed, balancesError: error }));
  // Everything that loaded still counts ($553.06 less Base's 10 USDC), and Base is named as left out.
  assert.deepEqual(all.value, { kind: 'usd', amount: '$543.06', approx: true });
  assert.deepEqual(all.notes, ["Excludes Base (couldn't load)"]);
  assert.equal(all.failed, true);
  assert.equal(all.meta, `8 assets · 4 networks · ${STAMP}`);
  const base = heroModel(signedIn({ scope: 'base', currentAddress: EVM, balances: failed, balancesError: error }));
  assert.deepEqual(base.value, { kind: 'unavailable' });
  assert.equal(base.hint, 'Balance unavailable on Base');
  assert.equal(base.meta, 'Unable to load balances');
  assert.equal(base.failed, true);
  // The Solana view loaded, so it stays known while Base failed.
  const solana = heroModel(signedIn({ balances: failed, balancesError: error }));
  assert.deepEqual(solana.value, { kind: 'usd', amount: '$177.28', approx: true });
  assert.equal(solana.failed, false);
  const zero = heroModel(signedIn({ scope: 'base', currentAddress: EVM, balances: [canonicalBalance('base', 0n, false), canonicalBalance('base', 0n, true)] }));
  assert.deepEqual(zero.value, { kind: 'usd', amount: '$0.00', approx: false });
  // Nothing held needs no price: still an exact $0.00 when prices are unavailable.
  assert.deepEqual(heroModel(signedIn({ scope: 'base', currentAddress: EVM, balances: [canonicalBalance('base', 0n, false), canonicalBalance('base', 0n, true)], prices: { status: 'unavailable' } })).value, { kind: 'usd', amount: '$0.00', approx: false });
  const nothing = heroModel(signedIn({ scope: 'all', balances: [], balancesError: error }));
  assert.deepEqual(nothing.value, { kind: 'unavailable' });
  assert.equal(nothing.hint, 'Balances unavailable');
});

test('signed out and loading never show an amount', () => {
  const out = heroModel(signedIn({ authenticated: false, balances: [], currentAddress: null, addresses: { solana: null, ethereum: null } }));
  assert.deepEqual(out.value, { kind: 'signed-out' });
  assert.equal(out.hint, 'Sign in to load balances');
  assert.equal(out.meta, 'Sign in to view your balance');
  assert.deepEqual(out.chains, []);
  assert.deepEqual(out.notes, []);
  assert.equal(out.failed, false);
  const loading = heroModel(signedIn({ balances: [], balancesLoading: true }));
  assert.deepEqual(loading.value, { kind: 'loading' });
  assert.equal(loading.meta, 'Syncing your wallets');
  assert.equal(loading.hint, undefined);
  // Nothing loaded yet and no error: still syncing, never zero.
  assert.deepEqual(heroModel(signedIn({ balances: [] })).value, { kind: 'loading' });
  assert.equal(UNKNOWN, '0.00');
});

test('an EVM-only account totals only its EVM networks on All networks', () => {
  const evm = ALL.filter(balance => balance.chain !== 'solana');
  const hero = heroModel(signedIn({ scope: 'all', balances: evm, currentAddress: EVM, addresses: { solana: null, ethereum: EVM } }));
  assert.deepEqual(hero.value, { kind: 'usd', amount: '$375.78', approx: true });
  assert.deepEqual(hero.chains, ['ethereum', 'bsc', 'robinhood', 'base']);
  assert.deepEqual(hero.notes, []);
});

test('Solana devnet is never valued at mainnet prices', () => {
  const balances = [canonicalBalance('solana', 2_000_000_000n, true)];
  const hero = heroModel(signedIn({ balances, cluster: 'devnet' }));
  assert.deepEqual(hero.value, { kind: 'amount', amount: '2', unit: 'SOL' });
  assert.equal(hero.meta, '1 asset · Solana devnet · USD value unavailable');
  assert.equal(priceLine('solana', 'native', PRICES, 'devnet'), 'Devnet tokens have no market price.');
});

test('token rows carry their USD value; token detail names the price, its source and time', () => {
  const rows = tokenRows(ALL, 'all', '', 'mainnet-beta');
  const sol = rows.find(row => row.id === 'solana-native')!;
  assert.equal(sol.raw, '1250000000');
  assert.equal(sol.decimals, 9);
  assert.equal(tokenUsd(sol, PRICES, 'mainnet-beta'), '≈ $134.79');
  assert.equal(tokenUsd(rows.find(row => row.id === 'bsc-stablecoin')!, PRICES, 'mainnet-beta'), '≈ $1.50');
  assert.equal(tokenUsd(rows.find(row => row.id === 'base-native')!, PRICES, 'mainnet-beta'), '$0.00');
  assert.equal(tokenUsd(sol, { status: 'unavailable' }, 'mainnet-beta'), null);
  assert.equal(tokenUsd(sol, { status: 'loading' }, 'mainnet-beta'), null);
  assert.equal(priceLine('solana', 'native', PRICES, 'mainnet-beta'), `Price ≈ $107.83 · Relay, ${CLOCK}`);
  assert.equal(priceLine('robinhood', 'stablecoin', PRICES, 'mainnet-beta'), `Price ≈ $0.9999 · Relay, ${CLOCK}`);
  assert.equal(priceLine('solana', 'native', { status: 'unavailable' }, 'mainnet-beta'), 'No price from Relay right now.');
  assert.equal(priceLine('solana', 'native', { status: 'loading' }, 'mainnet-beta'), 'Reading the price…');
});

test('empty copy follows the per-network wording', () => {
  assert.deepEqual(emptyTokensCopy({ loading: false, error: false, search: '', scope: 'solana' }), { title: 'No assets on this network', text: 'Receive SOL or USDC into your wallet to get started.' });
  assert.equal(emptyTokensCopy({ loading: false, error: false, search: '', scope: 'robinhood' }).text, 'Receive ETH or USDG into your wallet to get started.');
  assert.equal(emptyTokensCopy({ loading: false, error: false, search: '', scope: 'bsc' }).text, 'Receive BNB or USDC (Binance-Peg) into your wallet to get started.');
  assert.equal(emptyTokensCopy({ loading: true, error: false, search: '', scope: 'all' }).title, 'Loading balances…');
  assert.equal(emptyTokensCopy({ loading: false, error: false, search: 'x', scope: 'all' }).title, 'No matching tokens');
});

test('token detail states identity from the registry, with issuer notes for non-Circle stablecoins', () => {
  const sol = tokenDetail('solana', 'native', 'mainnet-beta');
  assert.equal(sol.identity.heading, 'Native coin of Solana');
  assert.equal(sol.identity.address, null);
  assert.equal(sol.identity.decimals, 9);
  assert.equal(sol.explorerName, 'Solscan');
  assert.equal(sol.swap.initialReceive?.chainId, 792703809);
  assert.equal(sol.swap.initialSourceChainId, undefined);
  const usdc = tokenDetail('solana', 'stablecoin', 'mainnet-beta');
  assert.equal(usdc.identity.heading, 'Token · USD Coin');
  assert.equal(usdc.identity.addressLabel, 'Mint');
  assert.equal(usdc.identity.address, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(usdc.identity.issuerNote, null);
  assert.equal(usdc.swap.initialSourceChainId, 792703809);
  const bsc = tokenDetail('bsc', 'stablecoin', 'mainnet-beta');
  assert.equal(bsc.identity.addressLabel, 'Contract');
  assert.equal(bsc.identity.decimals, 18);
  assert.match(bsc.identity.issuerNote!, /Binance-Peg USDC is a bridged token issued by Binance/);
  assert.equal(bsc.mark, 'stablecoin');
  const usdg = tokenDetail('robinhood', 'stablecoin', 'mainnet-beta');
  assert.equal(usdg.label, 'USDG');
  assert.match(usdg.identity.issuerNote!, /It is not USDC/);
  assert.equal(usdg.swap.initialSourceChainId, 4663);
  assert.equal(tokenDetail('base', 'native', 'mainnet-beta').identity.heading, 'Native coin of Base');
});

test('explorer links use the selected network, and Solscan for All networks', () => {
  assert.equal(accountExplorerUrl('solana', SOLANA, 'mainnet-beta'), `https://solscan.io/account/${SOLANA}`);
  assert.equal(accountExplorerUrl('solana', SOLANA, 'devnet'), `https://solscan.io/account/${SOLANA}?cluster=devnet`);
  assert.equal(accountExplorerUrl('bsc', EVM, 'mainnet-beta'), `https://bscscan.com/address/${EVM}`);
  assert.equal(heroExplorer('all', true), 'solana');
  assert.equal(heroExplorer('all', false), 'ethereum');
  assert.equal(heroExplorer('robinhood', false), 'robinhood');
  assert.equal(addressFor('solana', { solana: SOLANA, ethereum: EVM }), SOLANA);
  assert.equal(addressFor('base', { solana: SOLANA, ethereum: EVM }), EVM);
});
