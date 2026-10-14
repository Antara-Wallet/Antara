import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELAY_NETWORKS } from '../relay/model';
import { SEND_NETWORKS } from '../transfers/transfer';
import { EVM_NETWORKS } from '../vaults/evm';
import { NETWORK_KEYS, PRIMARY_NETWORK } from './config';
import { isDemoMode, setDemoMode } from '../../lib/demo';

test('Solana is first across transfer and routing networks; Safe vaults follow the registry EVM order', () => {
  assert.equal(PRIMARY_NETWORK, 'solana');
  assert.equal(RELAY_NETWORKS[0].id, 792703809);
  assert.equal(SEND_NETWORKS[0].key, 'solana');
  assert.deepEqual(SEND_NETWORKS.map(network => network.key), [...NETWORK_KEYS]);
  assert.deepEqual(EVM_NETWORKS.map(network => network.id), [1, 56, 4663, 8453]);
  assert.equal(RELAY_NETWORKS.length, 5);
  assert.equal(SEND_NETWORKS.length, 5);
  // Arbitrum and Polygon are removed everywhere a new action can start.
  for (const id of [42161, 137]) {
    assert.equal(RELAY_NETWORKS.some(chain => chain.id === id), false);
    assert.equal(SEND_NETWORKS.some(network => network.id === id), false);
    assert.equal(EVM_NETWORKS.some(network => network.id === id), false);
  }
});

test('historical recording controls cannot enable fictional wallet operations', () => {
  setDemoMode(true);
  assert.equal(isDemoMode(), false);
});
