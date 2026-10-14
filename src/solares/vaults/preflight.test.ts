import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from '@solana/web3.js';
import { sendSimulatedVaultTransaction, simulationFailureMessage } from './preflight';
import { friendlyError } from '../ui/friendlyError';

function withdrawal() {
  const from = Keypair.generate().publicKey, to = Keypair.generate().publicKey;
  return new VersionedTransaction(new TransactionMessage({ payerKey: from, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: 1n })] }).compileToV0Message());
}

test('Solana preflight passes the same transaction bytes to simulation and the signing boundary', async () => {
  const transaction = withdrawal();
  const steps: string[] = [];
  const connection = { simulateTransaction: async (tx: VersionedTransaction, config: unknown) => {
    steps.push('simulate');
    assert.deepEqual(config, { commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: false });
    assert.deepEqual(tx.serialize(), transaction.serialize());
    return { context: { slot: 1 }, value: { err: null, logs: [] } };
  } } as unknown as Pick<Connection, 'simulateTransaction'>;
  const hash = await sendSimulatedVaultTransaction(connection, transaction, async bytes => {
    steps.push('send'); assert.deepEqual(bytes, transaction.serialize()); return 'broadcast-hash';
  });
  assert.equal(hash, 'broadcast-hash');
  assert.deepEqual(steps, ['simulate', 'send']);
});

test('a rejected Squads transaction or missing simulation result never opens the wallet', async () => {
  let calls = 0;
  for (const err of [{ InstructionError: [0, { Custom: 6018 }] }, 'InsufficientFundsForFee', undefined]) {
    const connection = { simulateTransaction: async () => ({ context: { slot: 1 }, value: { err, logs: [] } }) } as unknown as Pick<Connection, 'simulateTransaction'>;
    await assert.rejects(sendSimulatedVaultTransaction(connection, withdrawal(), async () => { calls++; return 'bad'; }), /No signature was requested/);
  }
  assert.equal(calls, 0);
});

test('an unavailable simulation service fails closed before any signature request', async () => {
  let calls = 0;
  const connection = { simulateTransaction: async () => { throw new Error('RPC timeout'); } } as unknown as Pick<Connection, 'simulateTransaction'>;
  await assert.rejects(sendSimulatedVaultTransaction(connection, withdrawal(), async () => { calls++; return 'bad'; }), /RPC timeout/);
  assert.equal(calls, 0);
});

test('simulation failures seen on mainnet become specific calm sentences, never a time delay', async () => {
  // Shapes recorded from mainnet simulateTransaction on 2026-10-13 (a 0.0005 SOL first deposit; USDC from a wallet without a USDC account).
  const rent = simulationFailureMessage({ InsufficientFundsForRent: { account_index: 1 } }, ['Program 11111111111111111111111111111111 invoke [1]', 'Program 11111111111111111111111111111111 success']);
  assert.equal(rent, 'Solana keeps an account only while it holds a small minimum of SOL, and this would leave one below it. Check the amount. No signature was requested.');
  const usdc = simulationFailureMessage({ InstructionError: [1, 'InvalidAccountData'] }, ['Program log: Error: InvalidAccountData', 'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: invalid account data for instruction']);
  assert.equal(usdc, 'A token account this transaction needs is missing. If you’re moving USDC, check that this wallet holds USDC on Solana. No signature was requested.');
  assert.match(simulationFailureMessage('InsufficientFundsForFee'), /enough SOL for the network fee/);
  assert.match(simulationFailureMessage({ InstructionError: [0, { Custom: 1 }] }, ['Transfer: insufficient lamports 5, need 10']), /isn’t enough SOL/);
  const generic = simulationFailureMessage({ InstructionError: [0, { Custom: 6018 }] }, []);
  assert.equal(generic, 'The vault transaction failed its on-chain simulation. Refresh the vault and check its balance and approvals. No signature was requested.');
  for (const message of [rent, usdc, generic, simulationFailureMessage(undefined)]) {
    assert.doesNotMatch(message, /delay|time lock/i);
    assert.equal(friendlyError(message), message, 'shown as written, never replaced by a fallback');
  }
  // Through the preflight itself: the wallet is never opened.
  let calls = 0;
  const connection = { simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: { InsufficientFundsForRent: { account_index: 1 } }, logs: [] } }) } as unknown as Pick<Connection, 'simulateTransaction'>;
  await assert.rejects(sendSimulatedVaultTransaction(connection, withdrawal(), async () => { calls++; return 'bad'; }), { message: rent });
  assert.equal(calls, 0);
});

test('raw Solana rent and account-data errors from elsewhere get the same specific sentences', () => {
  assert.match(friendlyError('Transaction simulation failed: Transaction results in an account (1) with insufficient funds for rent'), /^Solana keeps an account only while it holds a small minimum of SOL/);
  assert.match(friendlyError('failed to send transaction: InsufficientFundsForRent'), /small minimum of SOL/);
  assert.match(friendlyError('Simulation failed. Error processing Instruction 1: invalid account data for instruction'), /^A token account this needs is missing/);
  assert.match(friendlyError('InvalidAccountData'), /holds USDC on Solana/);
});
