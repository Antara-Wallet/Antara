import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as multisig from '@sqds/multisig';
import bs58 from 'bs58';
import {
  PROPOSAL_APPROVE_DISCRIMINATOR, SOLANA_USDC_MINT, SPL_TOKEN_PROGRAM_ID, SQUADS_PROGRAM_ID,
  assertGuardianApproveTransaction, buildGuardianApproveTransaction, decodePairedMultisig, decodePairedProposal, decodeReleaseIntent,
  isSolanaWalletAddress, pairedMultisigMembers, pairedVaultAddresses, parseTransactionIndex, releaseTokenDestination, spendingLimitFilters,
  squadsTransactionKind, verifyUsdcDestinationAccount,
} from './solanaDecode';
import {
  TOKEN_2022, configTransactionAccount, guardianTransactionVariants, multisigAccount, newWallet, pairedKeys, proposalAccount,
  recentBlockhash, token2022UsdcAta, tokenAccount, usdcAta, vaultTransactionAccount,
} from './testFixtures';
import { SOLANA_NETWORK } from '../networks';

const expect = (keys: ReturnType<typeof pairedKeys>, extra: Partial<Parameters<typeof decodePairedMultisig>[1]> = {}) => ({ guardian: keys.guardian, spendingLimitCount: 0, ...extra });

describe('pinned constants', () => {
  it('match the installed Squads SDK and the network registry', () => {
    assert.equal(SQUADS_PROGRAM_ID, multisig.PROGRAM_ID.toBase58());
    assert.deepEqual([...PROPOSAL_APPROVE_DISCRIMINATOR], multisig.generated.proposalApproveInstructionDiscriminator);
    assert.equal(SOLANA_USDC_MINT, SOLANA_NETWORK.funding.address);
    assert.equal(SOLANA_USDC_MINT, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });
  it('build paired members with Initiate|Vote|Execute for the user and Vote only for the guardian', () => {
    const keys = pairedKeys();
    const members = pairedMultisigMembers(keys.user, keys.guardian);
    assert.deepEqual(members.map(m => [m.key.toBase58(), m.permissions.mask]), [[keys.user, 7], [keys.guardian, 2]]);
    assert.throws(() => pairedMultisigMembers(keys.user, keys.user), /different/);
    assert.throws(() => pairedMultisigMembers(keys.vault, keys.guardian), /signing wallet/);
  });
  it('parse only canonical positive u64 transaction indexes', () => {
    assert.equal(parseTransactionIndex('1'), 1n);
    assert.equal(parseTransactionIndex(18446744073709551615n), 18446744073709551615n);
    for (const bad of ['0', '-1', '01', '1.5', ' 1', '18446744073709551616', 0n, 1, null]) assert.throws(() => parseTransactionIndex(bad));
  });
  it('encode the spending-limit discovery filters for RPC', () => {
    const keys = pairedKeys();
    const [discriminator, owner] = spendingLimitFilters(keys.multisig);
    assert.deepEqual([...bs58.decode(discriminator.memcmp.bytes)], multisig.accounts.spendingLimitDiscriminator);
    assert.deepEqual(owner.memcmp, { offset: 8, bytes: keys.multisig });
  });
  it('distinguish signing wallets from program addresses', () => {
    const keys = pairedKeys();
    assert.equal(isSolanaWalletAddress(keys.user), true);
    assert.equal(isSolanaWalletAddress(keys.vault), false);
    assert.equal(isSolanaWalletAddress('not-an-address'), false);
  });
});

describe('decodePairedMultisig', () => {
  it('accepts the exact paired configuration and derives its deposit address', () => {
    const keys = pairedKeys();
    const state = decodePairedMultisig(multisigAccount(keys), expect(keys, { user: keys.user }));
    assert.equal(state.user, keys.user); assert.equal(state.guardian, keys.guardian);
    assert.equal(state.vault, keys.vault); assert.equal(state.threshold, 2); assert.equal(state.timeLockSeconds, 0);
    assert.equal(state.transactionIndex, 1n); assert.equal(state.rentCollector, keys.user);
    assert.equal(decodePairedMultisig(multisigAccount(keys, { rentCollector: null }), expect(keys)).rentCollector, null);
  });
  it('rejects a wrong member set', () => {
    const keys = pairedKeys(), other = newWallet();
    const cases = [
      [{ key: keys.user, mask: 7 }, { key: keys.guardian, mask: 2 }, { key: other, mask: 7 }],
      [{ key: keys.user, mask: 7 }],
      [{ key: keys.user, mask: 7 }, { key: other, mask: 2 }],
      [{ key: keys.guardian, mask: 2 }, { key: keys.guardian, mask: 2 }],
    ];
    for (const members of cases) assert.throws(() => decodePairedMultisig(multisigAccount(keys, { members }), expect(keys)), /exactly two members|not a member|guardian/);
    assert.throws(() => decodePairedMultisig(multisigAccount(keys, { members: [{ key: other, mask: 7 }, { key: keys.guardian, mask: 2 }] }), expect(keys, { user: keys.user })), /different wallet/);
  });
  it('rejects a guardian that can initiate or execute, and a user without full permissions', () => {
    const keys = pairedKeys();
    for (const mask of [1, 3, 4, 6, 7, 0]) {
      assert.throws(() => decodePairedMultisig(multisigAccount(keys, { members: [{ key: keys.user, mask: 7 }, { key: keys.guardian, mask }] }), expect(keys)), /vote permission only/);
    }
    for (const mask of [3, 5, 6, 2]) {
      assert.throws(() => decodePairedMultisig(multisigAccount(keys, { members: [{ key: keys.user, mask }, { key: keys.guardian, mask: 2 }] }), expect(keys)), /initiate, vote and execute/);
    }
  });
  it('rejects threshold 1, a config authority, spending limits and a foreign rent collector', () => {
    const keys = pairedKeys();
    assert.throws(() => decodePairedMultisig(multisigAccount(keys, { threshold: 1 }), expect(keys)), /exactly two approvals/);
    assert.throws(() => decodePairedMultisig(multisigAccount(keys, { configAuthority: newWallet() }), expect(keys)), /configuration authority/);
    assert.throws(() => decodePairedMultisig(multisigAccount(keys), expect(keys, { spendingLimitCount: 1 })), /spending limits/);
    assert.throws(() => decodePairedMultisig(multisigAccount(keys), expect(keys, { spendingLimitCount: null })), /did not complete/);
    assert.throws(() => decodePairedMultisig(multisigAccount(keys), { guardian: keys.guardian } as never), /did not complete/);
    assert.throws(() => decodePairedMultisig(multisigAccount(keys, { rentCollector: newWallet() }), expect(keys)), /rent collector/);
  });
  it('rejects any time lock: paired vaults execute as soon as both votes land', () => {
    const keys = pairedKeys();
    for (const timeLock of [1, 60, 3600, 7_776_000]) {
      assert.throws(() => decodePairedMultisig(multisigAccount(keys, { timeLock }), expect(keys)), /no time lock/, String(timeLock));
    }
    assert.equal(decodePairedMultisig(multisigAccount(keys, { timeLock: 0 }), expect(keys)).timeLockSeconds, 0);
  });
  it('rejects accounts that are not a Squads multisig at its derived address', () => {
    const keys = pairedKeys();
    assert.throws(() => decodePairedMultisig(null, expect(keys)), /not found/);
    assert.throws(() => decodePairedMultisig(multisigAccount(keys, { owner: SPL_TOKEN_PROGRAM_ID }), expect(keys)), /Squads v4/);
    assert.throws(() => decodePairedMultisig(multisigAccount(keys, { address: pairedKeys().multisig }), expect(keys)), /derivation/);
    assert.throws(() => decodePairedMultisig(proposalAccount(keys, { address: keys.multisig }), expect(keys)), /not a Squads multisig/);
    const truncated = multisigAccount(keys); truncated.data = truncated.data.slice(0, 60);
    assert.throws(() => decodePairedMultisig(truncated, expect(keys)), /could not be decoded/);
  });
});

describe('decodeReleaseIntent', () => {
  const setup = () => {
    const keys = pairedKeys();
    return { keys, vault: decodePairedMultisig(multisigAccount(keys, { transactionIndex: 3n }), expect(keys)) };
  };
  it('decodes a SOL transfer from the vault to a wallet', () => {
    const { keys, vault } = setup();
    const intent = decodeReleaseIntent(vaultTransactionAccount(keys, { index: 2n, instructions: [{ kind: 'sol', to: keys.user, lamports: 250_000_000n }] }), vault, 2n);
    assert.deepEqual(intent, { asset: 'SOL', amountRaw: 250_000_000n, recipient: keys.user, destination: keys.user, transactionIndex: 2n });
  });
  it('decodes a canonical USDC TransferChecked and resolves the owning linked wallet', () => {
    const { keys, vault } = setup();
    const account = vaultTransactionAccount(keys, { instructions: [{ kind: 'usdc', to: keys.user, amount: 12_500_000n }] });
    const intent = decodeReleaseIntent(account, vault, 1n, { recipientCandidates: [newWallet(), keys.user] });
    assert.deepEqual(intent, { asset: 'USDC', amountRaw: 12_500_000n, recipient: keys.user, destination: usdcAta(keys.user), transactionIndex: 1n });
    assert.equal(releaseTokenDestination(account), usdcAta(keys.user));
    assert.equal(releaseTokenDestination(vaultTransactionAccount(keys, { instructions: [{ kind: 'sol', to: keys.user, lamports: 1n }] })), null);
  });
  it('rejects a non-USDC mint, wrong decimals, a foreign recipient and non-canonical token accounts', () => {
    const { keys, vault } = setup();
    const opts = { recipientCandidates: [keys.user] };
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [{ kind: 'usdc', to: keys.user, amount: 1n, mint: newWallet() }] }), vault, 1n, opts), /canonical USDC|wrong decimals|USDC/);
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [{ kind: 'usdc', to: keys.user, amount: 1n, decimals: 9 }] }), vault, 1n, opts), /decimals/);
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [{ kind: 'usdc', to: newWallet(), amount: 1n }] }), vault, 1n, opts), /linked wallets/);
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [{ kind: 'usdc', to: keys.user, amount: 1n, destination: newWallet() }] }), vault, 1n, opts), /linked wallets/);
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [{ kind: 'usdc', to: keys.user, amount: 1n, destination: token2022UsdcAta(keys.user) }] }), vault, 1n, opts), /linked wallets/);
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [{ kind: 'usdc', to: keys.user, amount: 1n, destination: usdcAta(keys.vault, SOLANA_USDC_MINT, true) }] }), vault, 1n, opts), /outside this vault|linked wallets/);
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [{ kind: 'usdc', to: keys.user, amount: 1n }] }), vault, 1n, {}), /linked wallets/);
  });
  it('rejects ALTs, ephemeral signers, extra instructions, other vault indexes and other programs', () => {
    const { keys, vault } = setup();
    const sol = { kind: 'sol' as const, to: keys.user, lamports: 1n };
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [sol], lookupTables: 1 }), vault, 1n), /lookup tables/);
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [sol], ephemeralSignerBumps: [254] }), vault, 1n), /ephemeral/);
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [sol, { kind: 'sol', to: newWallet(), lamports: 1n }] }), vault, 1n), /exactly one/);
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [{ kind: 'computeBudget' }, sol] }), vault, 1n), /exactly one/);
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [sol], vaultIndex: 1 }), vault, 1n), /index 0/);
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [{ kind: 'computeBudget' }] }), vault, 1n), /Unsupported release/);
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [{ kind: 'sol', to: keys.vault, lamports: 1n }] }), vault, 1n), /signing wallet|outside|invalid flags/);
  });
  it('never approves configuration transactions and checks the stored address and index', () => {
    const { keys, vault } = setup();
    const config = configTransactionAccount(keys, 1n);
    assert.equal(squadsTransactionKind(config), 'config');
    assert.throws(() => decodeReleaseIntent(config, vault, 1n), /Configuration changes are never approved/);
    const sol = { kind: 'sol' as const, to: keys.user, lamports: 1n };
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [sol], index: 2n }), vault, 1n), /address does not match/);
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [sol], owner: SPL_TOKEN_PROGRAM_ID }), vault, 1n), /Squads v4/);
    assert.throws(() => decodeReleaseIntent(null, vault, 1n), /not found/);
    const other = pairedKeys();
    const foreign = vaultTransactionAccount(other, { instructions: [{ kind: 'sol', to: other.user, lamports: 1n }], address: pairedVaultAddresses(keys.multisig, 1n).transaction! });
    assert.throws(() => decodeReleaseIntent(foreign, vault, 1n), /different vault|vault deposit|only signer/);
  });
});

describe('decodeReleaseIntent: forged messages and edge recipients', () => {
  const setup = () => {
    const keys = pairedKeys();
    return { keys, vault: decodePairedMultisig(multisigAccount(keys, { transactionIndex: 3n }), expect(keys)) };
  };
  const sol = (to: string, extra: Partial<{ from: string }> = {}) => ({ kind: 'sol' as const, to, lamports: 5_000_000n, ...extra });
  it('refuses a SOL transfer signed by the user wallet instead of the vault (two signers)', () => {
    const { keys, vault } = setup();
    let signers = 0;
    const account = vaultTransactionAccount(keys, { instructions: [sol(newWallet(), { from: keys.user })], mutateMessage: m => { signers = m.numSigners; } });
    assert.equal(signers, 2, 'the fixture must really carry a second signer');
    assert.throws(() => decodeReleaseIntent(account, vault, 1n), /only signer/);
  });
  it('refuses a message that repeats an account key', () => {
    const { keys, vault } = setup();
    const account = vaultTransactionAccount(keys, { instructions: [sol(keys.user)], mutateMessage: m => { m.accountKeys[2] = m.accountKeys[1]; } });
    assert.throws(() => decodeReleaseIntent(account, vault, 1n), /repeats an account/);
  });
  it('refuses a read-only recipient, a signer recipient and an out-of-range writable count', () => {
    const { keys, vault } = setup();
    const readOnly = vaultTransactionAccount(keys, { instructions: [sol(keys.user)], mutateMessage: m => { assert.equal(m.numWritableNonSigners, 1); m.numWritableNonSigners = 0; } });
    assert.throws(() => decodeReleaseIntent(readOnly, vault, 1n), /recipient account has invalid flags/);
    const signer = vaultTransactionAccount(keys, { instructions: [sol(keys.user)], mutateMessage: m => { m.numSigners = 2; m.numWritableSigners = 2; m.numWritableNonSigners = 0; } });
    assert.throws(() => decodeReleaseIntent(signer, vault, 1n), /only signer/);
    const overflow = vaultTransactionAccount(keys, { instructions: [sol(keys.user)], mutateMessage: m => { m.numWritableNonSigners = m.accountKeys.length; } });
    assert.throws(() => decodeReleaseIntent(overflow, vault, 1n), /header is invalid/);
    const usdcReadOnly = vaultTransactionAccount(keys, { instructions: [{ kind: 'usdc', to: keys.user, amount: 1_000_000n }], mutateMessage: m => { m.numWritableNonSigners = 1; } });
    assert.throws(() => decodeReleaseIntent(usdcReadOnly, vault, 1n, { recipientCandidates: [keys.user] }), /invalid flags/);
  });
  it('refuses USDC drawn from a token account other than the vault’s canonical one', () => {
    const { keys, vault } = setup();
    const account = vaultTransactionAccount(keys, { instructions: [{ kind: 'usdc', to: keys.user, amount: 1_000_000n, source: usdcAta(newWallet()) }] });
    assert.throws(() => decodeReleaseIntent(account, vault, 1n, { recipientCandidates: [keys.user] }), /canonical token account/);
  });
  it('refuses SOL to the guardian or to the multisig, and accepts U itself as a recipient', () => {
    const { keys, vault } = setup();
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [sol(keys.guardian)] }), vault, 1n), /cannot pay the ANTARA guardian/);
    assert.throws(() => decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [sol(keys.multisig)] }), vault, 1n), /signing wallet/);
    assert.equal(decodeReleaseIntent(vaultTransactionAccount(keys, { instructions: [sol(keys.user)] }), vault, 1n).recipient, keys.user);
  });
});

describe('decodePairedProposal', () => {
  it('decodes status and votes and binds them to the vault and index', () => {
    const keys = pairedKeys();
    const vault = decodePairedMultisig(multisigAccount(keys, { transactionIndex: 2n }), expect(keys));
    const proposal = decodePairedProposal(proposalAccount(keys, { index: 2n, approved: [keys.user, keys.guardian], status: 'Approved' }), vault, 2n);
    assert.equal(proposal.status, 'Approved'); assert.deepEqual(proposal.approved, [keys.user, keys.guardian]);
    assert.equal(decodePairedProposal(proposalAccount(keys, { status: 'Executing' }), vault, 1n).status, 'Executing');
    assert.throws(() => decodePairedProposal(proposalAccount(keys, { index: 2n }), vault, 1n), /address does not match/);
    assert.throws(() => decodePairedProposal(proposalAccount(keys, { multisig: pairedKeys().multisig }), vault, 1n), /different vault/);
    assert.throws(() => decodePairedProposal(multisigAccount(keys, { address: pairedVaultAddresses(keys.multisig, 1n).proposal! }), vault, 1n), /not a Squads proposal/);
  });
});

describe('verifyUsdcDestinationAccount', () => {
  it('accepts only an unencumbered canonical account owned by the recipient', () => {
    const user = newWallet(), address = usdcAta(user);
    const intent = { asset: 'USDC' as const, amountRaw: 1n, recipient: user, destination: address, transactionIndex: 1n };
    verifyUsdcDestinationAccount(tokenAccount({ address, owner: user }), intent);
    assert.throws(() => verifyUsdcDestinationAccount(null, intent), /does not exist/);
    assert.throws(() => verifyUsdcDestinationAccount(tokenAccount({ address, owner: newWallet() }), intent), /not owned/);
    assert.throws(() => verifyUsdcDestinationAccount(tokenAccount({ address, owner: user, delegate: newWallet() }), intent), /delegate/);
    assert.throws(() => verifyUsdcDestinationAccount(tokenAccount({ address, owner: user, closeAuthority: newWallet() }), intent), /close authority/);
    assert.throws(() => verifyUsdcDestinationAccount(tokenAccount({ address, owner: user, state: 2 }), intent), /frozen/);
    assert.throws(() => verifyUsdcDestinationAccount(tokenAccount({ address, owner: user, programOwner: TOKEN_2022 }), intent), /standard token account/);
    assert.throws(() => verifyUsdcDestinationAccount(tokenAccount({ address, owner: user, mint: newWallet() }), intent), /not owned/);
  });
});

describe('guardian approve transaction', () => {
  it('builds exactly one proposal_approve by the guardian, who also pays the fee', () => {
    const keys = pairedKeys();
    const request = { multisig: keys.multisig, transactionIndex: 4n, guardian: keys.guardian, recentBlockhash: recentBlockhash() };
    const bytes = buildGuardianApproveTransaction(request);
    assert.doesNotThrow(() => assertGuardianApproveTransaction(bytes, request));
    assert.throws(() => assertGuardianApproveTransaction(bytes, { ...request, transactionIndex: 5n }), /unexpected accounts|wrong/);
    assert.throws(() => assertGuardianApproveTransaction(bytes, { ...request, guardian: newWallet() }), /fee payer|unexpected accounts/);
  });
  it('refuses every other transaction shape', () => {
    const keys = pairedKeys();
    const request = { multisig: keys.multisig, transactionIndex: 4n, guardian: keys.guardian, recentBlockhash: recentBlockhash() };
    const { valid, refused } = guardianTransactionVariants(request);
    assert.doesNotThrow(() => assertGuardianApproveTransaction(valid, request));
    for (const [name, bytes] of Object.entries(refused)) {
      assert.throws(() => assertGuardianApproveTransaction(bytes, request), /guardian/, `${name} must be refused`);
    }
  });
});
