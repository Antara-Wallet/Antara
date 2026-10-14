import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EVM_NETWORKS, evmVaultNetwork, parseEvmProposal, type EvmProposal } from './evm';
import { zeroAddress } from 'viem';
import { getCompatibilityFallbackHandlerDeployment, getProxyFactoryDeployment, getSafeL2SingletonDeployments, getSafeSingletonDeployments } from '@safe-global/safe-deployments';

const proposal: EvmProposal = {
  version: 1, chainId: 8453,
  safeAddress: '0x1111111111111111111111111111111111111111',
  safeTxHash: `0x${'ab'.repeat(32)}`,
  data: { to: '0x2222222222222222222222222222222222222222', value: '1000000000000000000', data: '0x', operation: 0, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: 2 },
};
describe('untrusted shared Safe proposal import', () => {
  it('accepts a structurally valid direct withdrawal (hash is verified separately on chain)', () => assert.deepEqual(parseEvmProposal(JSON.stringify(proposal)), proposal));
  it('rejects delegatecall, self configuration, hidden refunds, and oversized gas fields', () => {
    for (const change of [{ operation: 1 }, { to: proposal.safeAddress }, { to: zeroAddress }, { gasPrice: '1' }, { safeTxGas: '1' }, { baseGas: '1' }, { refundReceiver: proposal.data.to }, { gasToken: proposal.data.to }]) {
      assert.throws(() => parseEvmProposal(JSON.stringify({ ...proposal, data: { ...proposal.data, ...change } })));
    }
  });
  it('accepts every registry Safe network and rejects Arbitrum, Polygon and unknown chains', () => {
    for (const chainId of [1, 56, 4663, 8453]) assert.equal(parseEvmProposal(JSON.stringify({ ...proposal, chainId })).chainId, chainId);
    for (const chainId of [42161, 137, 46630, 10, 0]) assert.throws(() => parseEvmProposal(JSON.stringify({ ...proposal, chainId })), /Unsupported vault network/);
  });
  it('rejects unsupported chains, oversized documents, and ambiguous numeric fields', () => {
    assert.throws(() => parseEvmProposal(JSON.stringify({ ...proposal, chainId: 42161 })));
    assert.throws(() => parseEvmProposal(' '.repeat(16_385)));
    for (const change of [{ nonce: -1 }, { nonce: 1.2 }, { nonce: Number.MAX_SAFE_INTEGER + 1 }, { value: '-1' }, { value: '1e18' }, { data: '0x0' }]) assert.throws(() => parseEvmProposal(JSON.stringify({ ...proposal, data: { ...proposal.data, ...change } })));
  });
});
describe('Safe vault networks', () => {
  it('follow the registry order with each network’s own native coin and pinned stablecoin', () => {
    assert.deepEqual(EVM_NETWORKS.map(network => [network.id, network.name, network.native, network.stablecoin.label, network.stablecoin.decimals, network.chain.id]), [
      [1, 'Ethereum', 'ETH', 'USDC', 6, 1], [56, 'BNB Smart Chain', 'BNB', 'USDC (Binance-Peg)', 18, 56], [4663, 'Robinhood Chain', 'ETH', 'USDG', 6, 4663], [8453, 'Base', 'ETH', 'USDC', 6, 8453],
    ]);
    assert.equal(evmVaultNetwork(4663).stablecoin.address, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
    assert.equal(evmVaultNetwork(56).stablecoin.address, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d');
    // viem's third-party default RPCs are replaced with the registry's endpoints.
    assert.deepEqual(evmVaultNetwork(56).chain.rpcUrls.default.http, ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com']);
  });
  it('have the canonical Safe singleton, factory and fallback handler that vault verification requires', () => {
    for (const network of EVM_NETWORKS) for (const version of ['1.3.0', '1.4.1', '1.5.0']) {
      const filter = { version, network: String(network.id), released: true };
      assert.ok(getSafeSingletonDeployments(filter) && getSafeL2SingletonDeployments(filter), `${network.name} Safe ${version} singleton`);
      assert.ok(getProxyFactoryDeployment(filter)?.networkAddresses[String(network.id)], `${network.name} Safe ${version} factory`);
      assert.ok(getCompatibilityFallbackHandlerDeployment(filter), `${network.name} Safe ${version} fallback handler`);
    }
    // Safe 1.4.1 uses the same canonical addresses on BNB Smart Chain and Robinhood Chain.
    for (const chainId of ['56', '4663']) {
      const filter = { version: '1.4.1', network: chainId, released: true };
      assert.equal(getSafeSingletonDeployments(filter)?.networkAddresses[chainId], '0x41675C099F32341bf84BFc5382aF534df5C7461a');
      assert.equal(getSafeL2SingletonDeployments(filter)?.networkAddresses[chainId], '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762');
      assert.equal(getProxyFactoryDeployment(filter)?.networkAddresses[chainId], '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67');
      assert.equal(getCompatibilityFallbackHandlerDeployment(filter)?.networkAddresses[chainId], '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99');
    }
  });
});
