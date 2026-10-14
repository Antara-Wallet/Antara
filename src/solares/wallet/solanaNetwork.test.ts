import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSolanaCluster, SOLANA_GENESIS } from './solanaNetwork';

test('a devnet or unknown RPC cannot pass as Solana mainnet', async () => {
  await assertSolanaCluster({ getGenesisHash: async () => SOLANA_GENESIS['mainnet-beta'] }, 'mainnet-beta');
  for (const value of [SOLANA_GENESIS.devnet, 'unknown']) {
    await assert.rejects(assertSolanaCluster({ getGenesisHash: async () => value }, 'mainnet-beta'), /RPC is not on/);
  }
  await assert.rejects(assertSolanaCluster({ getGenesisHash: async () => SOLANA_GENESIS['mainnet-beta'] }, 'devnet'));
});
