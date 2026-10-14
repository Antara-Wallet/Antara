import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicKey, Keypair } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import * as multisig from '@sqds/multisig';
import {
  PAIRED_VAULT_MEMO, SQUADS_PROGRAM, assertCanonicalUsdcDestination, assertOwnRecipient, assertReleaseRecipient, buildPairedCreateInstruction, createPairedSolanaVault,
  proposePairedSolanaRelease, verifyPairedSolanaVault,
} from './solana';
import { USDC_SOLANA } from '../wallet/config';

test('withdrawal review rejects attacker-recreatable token accounts that merely report the recipient as owner', () => {
  const owner = Keypair.generate().publicKey;
  const attacker = Keypair.generate().publicKey;
  const mint = new PublicKey(USDC_SOLANA);
  const destination = { owner, mint, delegate: null, delegatedAmount: 0n, closeAuthority: null };
  const canonical = getAssociatedTokenAddressSync(mint, owner);
  assertCanonicalUsdcDestination(canonical, destination);
  assert.throws(() => assertCanonicalUsdcDestination(Keypair.generate().publicKey, destination), /canonical/);
  assert.throws(() => assertCanonicalUsdcDestination(canonical, { ...destination, owner: attacker }), /canonical/);
  assert.throws(() => assertCanonicalUsdcDestination(canonical, { ...destination, closeAuthority: attacker }), /authority/);
  assert.throws(() => assertCanonicalUsdcDestination(canonical, { ...destination, delegate: attacker, delegatedAmount: 1n }), /authority/);
});
test('Squads releases cannot target the vault deposit or multisig address', () => {
  const address = multisig.getMultisigPda({ createKey: Keypair.generate().publicKey })[0];
  const vault = { address: address.toBase58(), depositAddress: multisig.getVaultPda({ multisigPda: address, index: 0 })[0].toBase58() };
  assert.throws(() => assertReleaseRecipient(vault.depositAddress, vault), /outside this vault/);
  assert.throws(() => assertReleaseRecipient(vault.address, vault), /outside this vault/);
  assert.throws(() => assertReleaseRecipient('not-a-solana-address', vault));
  assert.doesNotThrow(() => assertReleaseRecipient(Keypair.generate().publicKey.toBase58(), vault));
});
test('paired vault creation sends exactly U:7, G:2, threshold 2, no time lock, no config authority, rent to U, the paired memo and a fresh createKey', () => {
  const user = Keypair.generate().publicKey.toBase58(), guardian = Keypair.generate().publicKey.toBase58(), treasury = Keypair.generate().publicKey;
  const createKey = Keypair.generate();
  const built = buildPairedCreateInstruction(user, guardian, treasury, createKey);
  assert.ok(built.instruction.programId.equals(SQUADS_PROGRAM));
  const [decoded, length] = multisig.generated.multisigCreateV2Struct.deserialize(built.instruction.data);
  assert.equal(length, built.instruction.data.length, 'no trailing data');
  assert.deepEqual(decoded.instructionDiscriminator, multisig.generated.multisigCreateV2InstructionDiscriminator);
  assert.equal(decoded.args.threshold, 2);
  assert.equal(decoded.args.timeLock, 0);
  assert.equal(decoded.args.configAuthority, null);
  assert.equal(decoded.args.rentCollector?.toBase58(), user);
  assert.equal(decoded.args.memo, PAIRED_VAULT_MEMO);
  assert.equal(PAIRED_VAULT_MEMO, 'ANTARA paired vault v1');
  assert.deepEqual(decoded.args.members.map(member => [member.key.toBase58(), member.permissions.mask]), [[user, 7], [guardian, 2]]);
  assert.equal(built.multisig, multisig.getMultisigPda({ createKey: createKey.publicKey })[0].toBase58());
  assert.deepEqual(built.instruction.keys.slice(0, 5).map(key => [key.pubkey.toBase58(), key.isSigner, key.isWritable]), [
    [multisig.getProgramConfigPda({})[0].toBase58(), false, false], [treasury.toBase58(), false, true], [built.multisig, false, true],
    [createKey.publicKey.toBase58(), true, false], [user, true, true],
  ]);
  // Production calls take a fresh random createKey: never reused, never the user's key.
  const first = buildPairedCreateInstruction(user, guardian, treasury), second = buildPairedCreateInstruction(user, guardian, treasury);
  assert.notEqual(first.createKey.publicKey.toBase58(), second.createKey.publicKey.toBase58());
  assert.notEqual(first.multisig, second.multisig);
  assert.notEqual(first.createKey.publicKey.toBase58(), user);
  // The guardian can never be U, and both must be signing wallets.
  assert.throws(() => buildPairedCreateInstruction(user, user, treasury), /different/);
  assert.throws(() => buildPairedCreateInstruction(user, built.multisig, treasury), /signing wallet/);
});
test('a paired release goes only to a wallet this device knows to be yours, refused before any read or signature', async () => {
  let signatures = 0;
  const signer = { address: Keypair.generate().publicKey.toBase58(), send: async () => { signatures += 1; return 'never'; } };
  const own = Keypair.generate().publicKey.toBase58(), attacker = Keypair.generate().publicKey.toBase58();
  const address = multisig.getMultisigPda({ createKey: Keypair.generate().publicKey })[0];
  const vault = {
    kind: 'squads-paired' as const, address: address.toBase58(), depositAddress: multisig.getVaultPda({ multisigPda: address, index: 0 })[0].toBase58(),
    user: signer.address, guardian: Keypair.generate().publicKey.toBase58(), cluster: 'mainnet-beta', threshold: 2, timeLockSeconds: 0,
    transactionIndex: '0', staleTransactionIndex: '0', observedAt: new Date(0).toISOString(), nativeBalance: '1000000000', usdcBalance: '0',
  };
  assert.doesNotThrow(() => assertOwnRecipient(own, [signer.address, own]));
  for (const [recipient, allowed] of [[attacker, [signer.address, own]], [own, []], ['', ['']]] as const) {
    assert.throws(() => assertOwnRecipient(recipient, allowed), /not one of the wallets this device knows/);
  }
  await assert.rejects(proposePairedSolanaRelease(signer, vault, attacker, 'SOL', '0.01', [signer.address, own]), /not one of the wallets this device knows/);
  // An allowed recipient reaches the next check (here the missing build pin), still before any network read.
  await assert.rejects(proposePairedSolanaRelease(signer, vault, own, 'SOL', '0.01', [signer.address, own]), /no pinned ANTARA guardian/);
  assert.equal(signatures, 0);
});
test('paired vaults refuse to create or verify anything when this build pins no guardian, before any network call or signature', async () => {
  let signatures = 0;
  const signer = { address: Keypair.generate().publicKey.toBase58(), send: async () => { signatures += 1; return 'never'; } };
  const guardian = Keypair.generate().publicKey.toBase58();
  await assert.rejects(createPairedSolanaVault(signer, guardian), /no pinned ANTARA guardian/);
  await assert.rejects(verifyPairedSolanaVault(multisig.getMultisigPda({ createKey: Keypair.generate().publicKey })[0].toBase58(), signer.address, guardian), /no pinned ANTARA guardian/);
  assert.equal(signatures, 0);
});

test('deposits Solana would reject are refused before anything is built: a first SOL deposit below the live minimum, or USDC this wallet lacks', async () => {
  const { assertDepositFits } = await import('./solana');
  const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
  const from = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(new PublicKey(USDC_SOLANA), from);
  const reads: string[] = [];
  const connection = (usdc: { owner: PublicKey; amount: string } | null) => ({
    getMinimumBalanceForRentExemption: async (size: number) => { reads.push(`rent:${size}`); return 650_240; },
    getAccountInfo: async (key: PublicKey) => { reads.push(`account:${key.toBase58()}`); return usdc && { owner: usdc.owner, data: Buffer.alloc(165), lamports: 2_039_280, executable: false, rentEpoch: 0 }; },
    getTokenAccountBalance: async () => ({ context: { slot: 1 }, value: { amount: usdc?.amount ?? '0', decimals: 6, uiAmount: null } }),
  }) as unknown as Parameters<typeof assertDepositFits>[0];
  await assert.rejects(assertDepositFits(connection(null), from, 0n, 'SOL', 500_000n), { message: 'The first SOL deposit must be at least 0.00066 SOL. Solana needs this minimum to open your vault’s account.' });
  assert.deepEqual(reads, ['rent:0'], 'the minimum is read live for a 0-byte account');
  await assertDepositFits(connection(null), from, 0n, 'SOL', 650_240n);
  await assertDepositFits(connection(null), from, 1_000_000n, 'SOL', 1n);
  reads.length = 0;
  await assert.rejects(assertDepositFits(connection(null), from, 0n, 'USDC', 10_000n), { message: 'You have no USDC on Solana in this wallet.' });
  assert.deepEqual(reads, [`account:${ata.toBase58()}`], 'the wallet’s own canonical USDC account is checked');
  await assert.rejects(assertDepositFits(connection({ owner: TOKEN_PROGRAM_ID, amount: '0' }), from, 0n, 'USDC', 10_000n), /no USDC on Solana/);
  await assert.rejects(assertDepositFits(connection({ owner: Keypair.generate().publicKey, amount: '99' }), from, 0n, 'USDC', 10_000n), /no USDC on Solana/);
  await assert.rejects(assertDepositFits(connection({ owner: TOKEN_PROGRAM_ID, amount: '5000' }), from, 0n, 'USDC', 10_000n), /holds 0\.005 USDC on Solana, less than this deposit/);
  await assertDepositFits(connection({ owner: TOKEN_PROGRAM_ID, amount: '10000' }), from, 0n, 'USDC', 10_000n);
  // An amount problem is typed, so with privacy on the UI can replace its balance figures (vaultAmounts.ts).
  await assert.rejects(assertDepositFits(connection(null), from, 0n, 'SOL', 500_000n), { name: 'VaultAmountError' });
  await assert.rejects(assertDepositFits(connection({ owner: TOKEN_PROGRAM_ID, amount: '5000' }), from, 0n, 'USDC', 10_000n), { name: 'VaultAmountError' });
});

test('a SOL release must empty the vault or leave the live minimum, and an empty recipient must receive the minimum', async () => {
  const { assertSolReleaseFits } = await import('./solana');
  const recipient = Keypair.generate().publicKey;
  const connection = (recipientLamports: number) => ({
    getMinimumBalanceForRentExemption: async () => 650_240,
    getBalance: async (key: PublicKey) => { assert.ok(key.equals(recipient)); return recipientLamports; },
  }) as unknown as Parameters<typeof assertSolReleaseFits>[0];
  await assertSolReleaseFits(connection(1_000_000), 5_000_000n, 5_000_000n, recipient);
  await assertSolReleaseFits(connection(1_000_000), 5_000_000n, 5_000_000n - 650_240n, recipient);
  await assert.rejects(assertSolReleaseFits(connection(1_000_000), 5_000_000n, 4_900_000n, recipient), /^VaultAmountError: Release all 0\.005 SOL, or at most 0\.00434 SOL/);
  await assert.rejects(assertSolReleaseFits(connection(0), 5_000_000n, 100_000n, recipient), /receiving wallet has no SOL yet, so this release must be at least 0\.00066 SOL/);
  await assertSolReleaseFits(connection(0), 5_000_000n, 1_000_000n, recipient);
});
