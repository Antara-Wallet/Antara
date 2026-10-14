import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePairedVault } from './paired';

const owner = '0x1111111111111111111111111111111111111111';
const response = { owner, chain: 'base', creationEnabled: false, transfersEnabled: false, status: 'deployed', address: '0x3333333333333333333333333333333333333333', cosigner: '0x2222222222222222222222222222222222222222' };
it('binds a discovered vault to the selected wallet and network', () => {
  assert.equal(parsePairedVault(response, owner, 'base').status, 'deployed');
  assert.throws(() => parsePairedVault(response, owner, 'ethereum'));
  assert.throws(() => parsePairedVault(response, response.cosigner, 'base'));
});
it('rejects malformed vaults and a second signer identical to the wallet', () => {
  for (const change of [{ address: 'bad' }, { cosigner: owner }, { status: 'active' }, { transfersEnabled: true }, { creationEnabled: true }]) {
    assert.throws(() => parsePairedVault({ ...response, ...change }, owner, 'base'));
  }
});
it('does not treat a Solana address as an EVM policy vault', () => {
  assert.throws(() => parsePairedVault({ ...response, chain: 'solana' }, owner, 'solana'));
});
it('binds BNB Smart Chain and Robinhood Chain vaults to their own network and rejects removed networks', () => {
  for (const chain of ['bsc', 'robinhood'] as const) {
    assert.equal(parsePairedVault({ ...response, chain }, owner, chain).status, 'deployed');
    assert.throws(() => parsePairedVault({ ...response, chain }, owner, 'base'));
  }
  for (const chain of ['arbitrum', 'polygon']) {
    assert.throws(() => parsePairedVault({ ...response, chain }, owner, chain as 'base'), /not supported/);
    assert.throws(() => parsePairedVault({ ...response, chain, status: 'unsupported' }, owner, chain as 'base'), /not supported/);
  }
});
