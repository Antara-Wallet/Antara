import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import {
  BROWSER_REFUSED_RPC_HOSTS, LEGACY_NETWORKS, NETWORK_KEYS, PRIMARY_NETWORK, RELAY_EVM_DEPOSITORY, SOLANA_RELAY_CHAIN_ID, SUPPORTED_EVM_CHAIN_IDS, SUPPORTED_EVM_NETWORKS, SUPPORTED_NETWORKS,
  byEvmChainId, byKey, byRelayChainId, describeChainId, describeLegacyChain, explorerAddressUrl, explorerTxUrl, isFundingToken, isNetworkKey, isSupported, requireNetwork, rpcUrlFor,
} from './networks';
import { SUPPORTED_VIEM_CHAINS, VIEM_CHAINS, viemChainFor } from './evmChains';
import { EVM_CHAIN_IDS, NETWORK_KEYS as CONFIG_NETWORK_KEYS, PRIMARY_NETWORK as CONFIG_PRIMARY, SOLANA_RPC_URL, SOLANA_WS_URL, USDC_SOLANA } from './wallet/config';

test('Solana is primary and networks keep the owner-approved display order', () => {
  assert.equal(PRIMARY_NETWORK, 'solana');
  assert.deepEqual(NETWORK_KEYS, ['solana', 'ethereum', 'bsc', 'robinhood', 'base']);
  assert.deepEqual(SUPPORTED_NETWORKS.map(network => network.name), ['Solana', 'Ethereum', 'BNB Smart Chain', 'Robinhood Chain', 'Base']);
  assert.equal(SUPPORTED_NETWORKS[0].key, PRIMARY_NETWORK);
  assert.deepEqual(SUPPORTED_EVM_NETWORKS.map(network => network.key), ['ethereum', 'bsc', 'robinhood', 'base']);
  assert.deepEqual(SUPPORTED_EVM_CHAIN_IDS, [1, 56, 4663, 8453]);
});

test('wallet config derives its network list, order and primary network from the registry', () => {
  assert.equal(CONFIG_PRIMARY, 'solana');
  assert.deepEqual(CONFIG_NETWORK_KEYS, NETWORK_KEYS);
  assert.deepEqual(EVM_CHAIN_IDS, [1, 56, 4663, 8453]);
  assert.equal(USDC_SOLANA, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
});

test('keys, chain ids, Relay ids and slugs are unique and match verified values', () => {
  for (const values of [
    SUPPORTED_NETWORKS.map(network => network.key),
    SUPPORTED_NETWORKS.map(network => network.relay.chainId),
    SUPPORTED_NETWORKS.map(network => network.relay.slug),
    SUPPORTED_NETWORKS.map(network => network.name),
    SUPPORTED_EVM_NETWORKS.map(network => network.evmChainId),
  ] as unknown[][]) assert.equal(new Set(values).size, values.length);
  assert.deepEqual(SUPPORTED_NETWORKS.map(network => [network.key, network.relay.chainId, network.relay.slug]), [
    ['solana', SOLANA_RELAY_CHAIN_ID, 'solana'], ['ethereum', 1, 'ethereum'], ['bsc', 56, 'bnb'], ['robinhood', 4663, 'robinhood'], ['base', 8453, 'base'],
  ]);
  assert.equal(SOLANA_RELAY_CHAIN_ID, 792703809);
  assert.equal(byKey('solana').evmChainId, null);
  for (const network of SUPPORTED_EVM_NETWORKS) {
    assert.equal(network.relay.chainId, network.evmChainId);
    assert.equal(network.relay.depository, RELAY_EVM_DEPOSITORY);
  }
});

test('Robinhood Chain is chain 4663 and is never Base', () => {
  const robinhood = byKey('robinhood'), base = byKey('base');
  assert.equal(robinhood.evmChainId, 4663);
  assert.equal(base.evmChainId, 8453);
  assert.notEqual(robinhood.evmChainId, base.evmChainId);
  assert.equal(byEvmChainId(4663)?.key, 'robinhood');
  assert.equal(byEvmChainId(8453)?.key, 'base');
  assert.equal(byEvmChainId(46630), undefined, 'Robinhood testnet is not supported');
  assert.equal(byRelayChainId(548123634), undefined, 'Robinhood Lighter is a different venue');
  assert.notEqual(robinhood.explorer.tx, base.explorer.tx);
  assert.notEqual(robinhood.funding.address.toLowerCase(), base.funding.address.toLowerCase());
});

test('native and funding stablecoin decimals are pinned per network', () => {
  assert.deepEqual(SUPPORTED_NETWORKS.map(network => [network.key, network.native.symbol, network.native.decimals]), [
    ['solana', 'SOL', 9], ['ethereum', 'ETH', 18], ['bsc', 'BNB', 18], ['robinhood', 'ETH', 18], ['base', 'ETH', 18],
  ]);
  assert.deepEqual(SUPPORTED_NETWORKS.map(network => [network.key, network.funding.symbol, network.funding.decimals]), [
    ['solana', 'USDC', 6], ['ethereum', 'USDC', 6], ['bsc', 'USDC', 18], ['robinhood', 'USDG', 6], ['base', 'USDC', 6],
  ]);
  assert.equal(byKey('solana').funding.address, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(byKey('ethereum').funding.address, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  assert.equal(byKey('bsc').funding.address, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d');
  assert.equal(byKey('robinhood').funding.address, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
  assert.equal(byKey('base').funding.address, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
});

test('a non-Circle token is never labelled as plain USDC', () => {
  for (const network of SUPPORTED_NETWORKS) {
    const { funding } = network;
    assert.ok(funding.issuerNote.trim().length > 0, `${network.key} needs an issuer note`);
    if (funding.circleIssued) {
      assert.equal(funding.issuer, 'Circle');
      assert.equal(funding.symbol, 'USDC');
      assert.equal(funding.decimals, 6);
      continue;
    }
    assert.notEqual(funding.issuer, 'Circle');
    assert.notEqual(funding.label, 'USDC', `${network.key} must qualify its label`);
    assert.match(funding.issuerNote, /not (?:by Circle|USDC)/i);
    if (funding.symbol === 'USDC') assert.match(funding.label, /\(.+\)/, `${network.key} must name its issuer in the label`);
  }
  assert.equal(byKey('bsc').funding.label, 'USDC (Binance-Peg)');
  assert.equal(byKey('robinhood').funding.symbol, 'USDG');
  assert.ok(!/USDC/.test(byKey('robinhood').funding.label + byKey('robinhood').funding.name));
});

test('Robinhood rejects the unverified USDC lookalike as funding', () => {
  const robinhood = byKey('robinhood');
  assert.equal(isFundingToken(robinhood, '0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8'), false);
  assert.equal(isFundingToken(robinhood, '0x5FC5360D0400A0FD4F2AF552ADD042D716F1D168'), true);
  assert.equal(isFundingToken(byKey('base'), robinhood.funding.address), false);
  // Solana mints are case-sensitive.
  assert.equal(isFundingToken(byKey('solana'), byKey('solana').funding.address.toLowerCase()), false);
});

test('EVM addresses are EIP-55 checksummed', () => {
  const addresses = [RELAY_EVM_DEPOSITORY, ...SUPPORTED_EVM_NETWORKS.flatMap(network => [network.funding.address, ...network.rejectedLookalikes]), ...LEGACY_NETWORKS.map(network => network.usdc.address)];
  for (const address of addresses) assert.equal(getAddress(address), address);
});

test('Arbitrum and Polygon are not supported but stay describable for saved records', () => {
  for (const chainId of [42161, 137]) {
    assert.ok(!SUPPORTED_NETWORKS.some(network => network.relay.chainId === chainId));
    assert.equal(byEvmChainId(chainId), undefined);
    assert.equal(byRelayChainId(chainId), undefined);
    assert.equal(isSupported(chainId), false);
    assert.throws(() => requireNetwork(chainId), /not supported/);
    assert.throws(() => viemChainFor(chainId), /not supported/);
    const legacy = describeLegacyChain(chainId);
    assert.ok(legacy);
    assert.equal(legacy.selectable, false);
    assert.match(legacy.label, /no longer supported/);
    const description = describeChainId(chainId);
    assert.equal(description.status, 'legacy');
    assert.match(description.label, /no longer supported/);
  }
  for (const key of ['arbitrum', 'polygon']) {
    assert.equal(isNetworkKey(key), false);
    assert.equal(isSupported(key), false);
    assert.throws(() => requireNetwork(key), /not supported/);
  }
  assert.equal(describeLegacyChain(8453), undefined);
  assert.equal(describeChainId(4663).status, 'supported');
  assert.equal(describeChainId(999).status, 'unknown');
  assert.equal(describeChainId(999).label, 'Unknown network (999)');
  assert.equal(describeChainId(Number.NaN).label, 'Unknown network');
});

test('the registry is frozen', () => {
  assert.ok(Object.isFrozen(SUPPORTED_NETWORKS));
  assert.ok(Object.isFrozen(byKey('bsc').funding));
  assert.ok(Object.isFrozen(byKey('robinhood').rejectedLookalikes));
  assert.ok(Object.isFrozen(LEGACY_NETWORKS[0].usdc));
  assert.throws(() => { (byKey('bsc').funding as { decimals: number }).decimals = 6; });
});

test('RPC configuration prefers explicit overrides and rejects malformed ones without echoing them', () => {
  const bsc = byKey('bsc');
  assert.deepEqual(SUPPORTED_NETWORKS.map(network => network.rpc.serverEnv), ['SOLANA_RPC_URL', 'ETHEREUM_RPC_URL', 'BSC_RPC_URL', 'ROBINHOOD_RPC_URL', 'BASE_RPC_URL']);
  assert.deepEqual(SUPPORTED_NETWORKS.map(network => network.rpc.browserEnv), ['VITE_SOLANA_RPC_URL', 'VITE_ETHEREUM_RPC_URL', 'VITE_BSC_RPC_URL', 'VITE_ROBINHOOD_RPC_URL', 'VITE_BASE_RPC_URL']);
  for (const network of SUPPORTED_NETWORKS) for (const url of network.rpc.defaults) assert.match(url, /^https:\/\//);
  assert.equal(rpcUrlFor(bsc, {}, 'server'), 'https://bsc-dataseed.bnbchain.org');
  assert.equal(rpcUrlFor(bsc, { BSC_RPC_URL: ' https://bsc.example/v1 ' }, 'server'), 'https://bsc.example/v1');
  assert.equal(rpcUrlFor(bsc, { BSC_RPC_URL: 'https://bsc.example/v1' }, 'browser'), 'https://bsc-dataseed.bnbchain.org');
  assert.equal(rpcUrlFor(byKey('solana'), {}, 'server', { solanaCluster: 'devnet' }), 'https://api.devnet.solana.com');
  assert.equal(rpcUrlFor(byKey('robinhood'), {}, 'browser'), 'https://rpc.mainnet.chain.robinhood.com');
  assert.throws(() => rpcUrlFor(bsc, { BSC_RPC_URL: 'secret-key-without-scheme' }, 'server'), error => error instanceof Error && error.message.includes('BSC_RPC_URL') && !error.message.includes('secret'));
  assert.throws(() => rpcUrlFor(bsc, { BSC_RPC_URL: 'ftp://bsc.example' }, 'server'), /http\(s\)/);
});

test('browser RPC defaults never use a host that refuses Origin-bearing requests; the server keeps the official Solana RPC', () => {
  const solana = byKey('solana');
  assert.equal(rpcUrlFor(solana, {}, 'server'), 'https://api.mainnet-beta.solana.com');
  assert.equal(rpcUrlFor(solana, {}, 'browser'), 'https://solana-rpc.publicnode.com');
  assert.equal(rpcUrlFor(solana, {}, 'browser', { solanaCluster: 'devnet' }), 'https://api.devnet.solana.com');
  assert.equal(rpcUrlFor(solana, { VITE_SOLANA_RPC_URL: 'https://sol.provider.dev' }, 'browser'), 'https://sol.provider.dev');
  for (const network of SUPPORTED_NETWORKS) {
    const browser = rpcUrlFor(network, {}, 'browser');
    // A browser default is still a known public endpoint (server rpcConfigured and the extension CORS list rely on it).
    assert.ok(network.rpc.defaults.includes(browser), network.key);
    assert.equal(BROWSER_REFUSED_RPC_HOSTS.includes(new URL(browser).hostname), false, network.key);
  }
  // Without a build value (Node tests), the wallet uses the registry's browser default and its WebSocket twin.
  assert.equal(SOLANA_RPC_URL, 'https://solana-rpc.publicnode.com');
  assert.equal(SOLANA_WS_URL, 'wss://solana-rpc.publicnode.com');
  assert.ok(Object.isFrozen(BROWSER_REFUSED_RPC_HOSTS));
});

test('explorer links use each network\'s own explorer', () => {
  assert.equal(explorerTxUrl(byKey('robinhood'), '0xabc'), 'https://robinhoodchain.blockscout.com/tx/0xabc');
  assert.equal(explorerTxUrl(byKey('bsc'), '0xabc'), 'https://bscscan.com/tx/0xabc');
  assert.equal(explorerAddressUrl(byKey('solana'), 'Abc', { solanaCluster: 'devnet' }), 'https://solscan.io/account/Abc?cluster=devnet');
  assert.equal(explorerTxUrl(LEGACY_NETWORKS[0], '0xabc'), 'https://arbiscan.io/tx/0xabc');
});

test('viem chains match the registry and pin official RPC defaults', () => {
  assert.deepEqual(SUPPORTED_VIEM_CHAINS.map(chain => chain.id), [1, 56, 4663, 8453]);
  for (const network of SUPPORTED_EVM_NETWORKS) {
    const chain = VIEM_CHAINS[network.key];
    assert.equal(chain.id, network.evmChainId);
    assert.equal(viemChainFor(network.evmChainId), chain);
    assert.deepEqual(chain.rpcUrls.default.http, network.rpc.defaults);
    assert.equal(chain.rpcUrls.default.webSocket, undefined);
  }
});
