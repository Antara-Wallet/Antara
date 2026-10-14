import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NO_RELEASE_LIMITS, SNAPSHOT_MAX_AGE_MS, approvalsInWindow, effectiveReleaseLimits, evaluateRegistration, evaluateRelease, formatRawAmount, hasReleaseCap,
  privyUserFacts, rawCaps, usageInWindow, type LinkedSolanaWallet, type OnchainSnapshot, type PrivyUserFacts, type ReleaseDecision, type ReleaseEvaluationInput,
  type ReleaseLimits,
} from './vaultPolicy.js';
import { createVaultStore, type LedgerEntry, type PairedVaultRecord } from './vaultStore.js';
import {
  configTransactionAccount, multisigAccount, newWallet, pairedKeys, proposalAccount, tokenAccount, usdcAta, vaultTransactionAccount,
  type ReleaseInstructionFixture,
} from '../../../src/solares/paired/testFixtures';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const RENT_MINIMUM = 650_240n;
/** A linked Solana wallet: a non-delegated embedded wallet by default, or an external one. */
function linkedWallet(address: string, embedded = true, extra: Partial<LinkedSolanaWallet> = {}): LinkedSolanaWallet {
  return { address, embedded, delegated: false, imported: false, userCanSign: embedded ? true : null, ...extra };
}
/** User-set caps (Limits layer) in raw units; anything not given is no cap. */
function caps(values: { perRelease?: Partial<Record<'SOL' | 'USDC', bigint>>; perDay?: Partial<Record<'SOL' | 'USDC', bigint>> }): ReleaseLimits {
  return {
    perRelease: { SOL: values.perRelease?.SOL ?? null, USDC: values.perRelease?.USDC ?? null },
    perDay: { SOL: values.perDay?.SOL ?? null, USDC: values.perDay?.USDC ?? null },
  };
}

function scenario(instruction: ReleaseInstructionFixture | null = null) {
  const keys = pairedKeys();
  const user: PrivyUserFacts = { id: 'did:privy:alice', solanaWallets: [linkedWallet(keys.user)] };
  const registration: PairedVaultRecord = { privyUserId: user.id, user: keys.user, multisig: keys.multisig, guardian: keys.guardian, vault: keys.vault, createdAt: new Date(NOW - 2 * DAY).toISOString() };
  const release = instruction ?? { kind: 'sol', to: keys.user, lamports: 100_000_000n };
  const onchain: OnchainSnapshot = {
    observedAt: NOW - 1_000,
    multisig: multisigAccount(keys, { transactionIndex: 1n }),
    proposal: proposalAccount(keys),
    transaction: vaultTransactionAccount(keys, { instructions: [release] }),
    spendingLimitCount: 0,
    // A well-funded vault and the mainnet rent-exempt minimum observed on 2026-10-13 (the server always reads it live).
    vaultLamports: 10_000_000_000_000n,
    rentExemptMinimum: RENT_MINIMUM,
  };
  const ledger: LedgerEntry[] = [];
  const input: ReleaseEvaluationInput = {
    user, guardian: keys.guardian, registration, request: { multisig: keys.multisig, transactionIndex: '1' }, onchain,
    limits: NO_RELEASE_LIMITS, ledger: () => ledger, now: NOW,
  };
  return { keys, user, registration, onchain, ledger, input };
}
function denied(decision: ReleaseDecision, pattern: RegExp) {
  assert.equal(decision.allow, false, 'expected a denial');
  assert.ok(!decision.allow && !decision.alreadyApproved, 'expected a denial, not an idempotent answer');
  assert.match(decision.reason, pattern);
}
function usdcScenario(amount = 10_000_000n, account?: (owner: string) => ReturnType<typeof tokenAccount> | null) {
  const s = scenario();
  s.onchain.transaction = vaultTransactionAccount(s.keys, { instructions: [{ kind: 'usdc', to: s.keys.user, amount }] });
  s.onchain.destinationTokenAccount = account ? account(s.keys.user) : tokenAccount({ address: usdcAta(s.keys.user), owner: s.keys.user });
  return s;
}

describe('evaluateRelease: allowed releases', () => {
  it('allows a SOL release to the user’s own wallet and returns the ledger entry to reserve', () => {
    const { input, keys } = scenario();
    const decision = evaluateRelease(input);
    assert.equal(decision.allow, true);
    if (!decision.allow) return;
    assert.deepEqual(decision.entry, {
      multisig: keys.multisig, transactionIndex: '1', privyUserId: 'did:privy:alice', asset: 'SOL', amountRaw: '100000000', recipient: keys.user, approvedAt: new Date(NOW).toISOString(),
    });
    assert.equal(decision.usedToday, 0n);
  });
  it('allows a canonical USDC release into an unencumbered account the user owns', () => {
    const { input } = usdcScenario();
    const decision = evaluateRelease(input);
    assert.equal(decision.allow, true);
    assert.equal(decision.allow && decision.intent.asset, 'USDC');
  });
  it('answers an already-approved proposal idempotently without a new vote', () => {
    const s = scenario();
    s.onchain.proposal = proposalAccount(s.keys, { status: 'Approved', approved: [s.keys.user, s.keys.guardian] });
    const decision = evaluateRelease(s.input);
    assert.equal(decision.allow, false);
    assert.equal(!decision.allow && decision.alreadyApproved, true);
    s.onchain.proposal = proposalAccount(s.keys, { status: 'Executed', approved: [s.keys.user, s.keys.guardian] });
    assert.equal((evaluateRelease(s.input) as { alreadyApproved?: boolean }).alreadyApproved, true);
  });
});

describe('evaluateRelease: on-chain configuration', () => {
  const variants: Array<[string, (s: ReturnType<typeof scenario>) => void, RegExp]> = [
    ['wrong member set', s => { s.onchain.multisig = multisigAccount(s.keys, { members: [{ key: s.keys.user, mask: 7 }, { key: s.keys.guardian, mask: 2 }, { key: newWallet(), mask: 7 }] }); }, /exactly two members/],
    ['guardian can initiate', s => { s.onchain.multisig = multisigAccount(s.keys, { members: [{ key: s.keys.user, mask: 7 }, { key: s.keys.guardian, mask: 3 }] }); }, /vote permission only/],
    ['guardian can execute', s => { s.onchain.multisig = multisigAccount(s.keys, { members: [{ key: s.keys.user, mask: 7 }, { key: s.keys.guardian, mask: 6 }] }); }, /vote permission only/],
    ['threshold 1', s => { s.onchain.multisig = multisigAccount(s.keys, { threshold: 1 }); }, /exactly two approvals/],
    ['config authority set', s => { s.onchain.multisig = multisigAccount(s.keys, { configAuthority: newWallet() }); }, /configuration authority/],
    ['spending limit present', s => { s.onchain.spendingLimitCount = 1; }, /spending limits/],
    ['spending-limit check missing', s => { s.onchain.spendingLimitCount = null; }, /did not complete/],
    ['multisig missing', s => { s.onchain.multisig = null; }, /does not match|not found/],
    ['address lookup table', s => { s.onchain.transaction = vaultTransactionAccount(s.keys, { instructions: [{ kind: 'sol', to: s.keys.user, lamports: 1n }], lookupTables: 1 }); }, /lookup tables/],
    ['ephemeral signer', s => { s.onchain.transaction = vaultTransactionAccount(s.keys, { instructions: [{ kind: 'sol', to: s.keys.user, lamports: 1n }], ephemeralSignerBumps: [255] }); }, /ephemeral/],
    ['second instruction', s => { s.onchain.transaction = vaultTransactionAccount(s.keys, { instructions: [{ kind: 'sol', to: s.keys.user, lamports: 1n }, { kind: 'sol', to: s.keys.user, lamports: 2n }] }); }, /exactly one/],
    ['non-USDC mint', s => { s.onchain.transaction = vaultTransactionAccount(s.keys, { instructions: [{ kind: 'usdc', to: s.keys.user, amount: 1n, mint: newWallet() }] }); }, /USDC/],
    ['non-canonical token account', s => { s.onchain.transaction = vaultTransactionAccount(s.keys, { instructions: [{ kind: 'usdc', to: s.keys.user, amount: 1n, destination: newWallet() }] }); }, /canonical USDC account of one of your linked wallets/],
    ['configuration transaction', s => { s.onchain.transaction = configTransactionAccount(s.keys, 1n); }, /Configuration changes are never approved/],
  ];
  for (const [name, mutate, reason] of variants) {
    it(`denies: ${name}`, () => { const s = scenario(); mutate(s); denied(evaluateRelease(s.input), reason); });
  }
});

describe('evaluateRelease: proposal state', () => {
  it('denies stale, closed, unapproved or foreign-voted proposals', () => {
    let s = scenario();
    s.onchain.multisig = multisigAccount(s.keys, { transactionIndex: 2n, staleTransactionIndex: 1n });
    denied(evaluateRelease(s.input), /stale/);
    for (const status of ['Draft', 'Rejected', 'Cancelled', 'Executed', 'Approved'] as const) {
      s = scenario(); s.onchain.proposal = proposalAccount(s.keys, { status });
      denied(evaluateRelease(s.input), /not open/);
    }
    s = scenario(); s.onchain.proposal = proposalAccount(s.keys, { approved: [] });
    denied(evaluateRelease(s.input), /Approve the release with your wallet/);
    s = scenario(); s.onchain.proposal = proposalAccount(s.keys, { approved: [s.keys.user], rejected: [newWallet()] });
    denied(evaluateRelease(s.input), /rejected or cancelled/);
    s = scenario(); s.input.request = { ...s.input.request, transactionIndex: '2' };
    denied(evaluateRelease(s.input), /does not exist yet/);
    s = scenario(); s.onchain.proposal = null;
    denied(evaluateRelease(s.input), /not found/);
  });
  it('denies a stale or future-dated on-chain snapshot', () => {
    let s = scenario(); s.onchain.observedAt = NOW - SNAPSHOT_MAX_AGE_MS - 1;
    denied(evaluateRelease(s.input), /could not be read/);
    s = scenario(); s.onchain.observedAt = NOW + 60_000;
    denied(evaluateRelease(s.input), /could not be read/);
  });
});

describe('evaluateRelease: the vault keeps Solana’s account minimum', () => {
  const sol = (vaultLamports: bigint | null | undefined, lamports: bigint, read: { minimum: bigint | null | undefined } = { minimum: RENT_MINIMUM }) => {
    const s = scenario();
    s.onchain.transaction = vaultTransactionAccount(s.keys, { instructions: [{ kind: 'sol', to: s.keys.user, lamports }] });
    s.onchain.vaultLamports = vaultLamports;
    s.onchain.rentExemptMinimum = read.minimum;
    return evaluateRelease(s.input);
  };
  it('allows releasing everything, or leaving at least the minimum', () => {
    assert.equal(sol(5_000_000n, 5_000_000n).allow, true, 'the whole balance');
    assert.equal(sol(5_000_000n, 5_000_000n - RENT_MINIMUM).allow, true, 'leaves exactly the minimum');
    assert.equal(sol(5_000_000n, 1n).allow, true, 'leaves far more than the minimum');
  });
  it('refuses a release that would leave dust below the minimum, with a 409 and the amounts', () => {
    for (const left of [1n, 100_000n, RENT_MINIMUM - 1n]) {
      const decision = sol(5_000_000n, 5_000_000n - left);
      denied(decision, /below Solana’s 0\.00065024 SOL account minimum\. Release all of it or leave at least that minimum\. Nothing was approved/);
      assert.equal(!decision.allow && 'status' in decision && decision.status, 409);
    }
    denied(sol(5_000_000n, 4_900_000n), /would leave 0\.0001 SOL in the vault/);
  });
  it('refuses a release larger than the vault holds', () => {
    const decision = sol(5_000_000n, 5_000_001n);
    denied(decision, /The vault holds 0\.005 SOL, less than this release/);
    assert.equal(!decision.allow && 'status' in decision && decision.status, 409);
  });
  it('fails closed when the balance or the minimum was not read', () => {
    for (const [balance, minimum] of [[null, RENT_MINIMUM], [undefined, RENT_MINIMUM], [5_000_000n, null], [5_000_000n, undefined], [5_000_000n, 0n], [-1n, RENT_MINIMUM]] as const) {
      const decision = sol(balance, 5_000_000n, { minimum });
      denied(decision, /vault balance could not be read/);
      assert.equal(!decision.allow && 'status' in decision && decision.status, 503);
    }
  });
  it('does not apply to USDC releases, and an already-approved proposal is still answered idempotently', () => {
    const usdc = usdcScenario();
    usdc.onchain.vaultLamports = null; usdc.onchain.rentExemptMinimum = null;
    assert.equal(evaluateRelease(usdc.input).allow, true);
    const s = scenario();
    s.onchain.vaultLamports = 1n;
    s.onchain.proposal = proposalAccount(s.keys, { status: 'Approved', approved: [s.keys.user, s.keys.guardian] });
    assert.equal((evaluateRelease(s.input) as { alreadyApproved?: boolean }).alreadyApproved, true);
  });
});

describe('evaluateRelease: identity, recipient and MFA', () => {
  it('denies a foreign recipient, and allows a wallet linked just now (no link-age wait)', () => {
    const outsider = newWallet();
    let s = scenario({ kind: 'sol', to: outsider, lamports: 1n });
    denied(evaluateRelease(s.input), /linked to your account/);
    s = scenario();
    // Owner decision 2026-10-13: a freshly linked wallet of the user's own account can receive at once.
    const fresh = newWallet();
    s.user.solanaWallets.push(linkedWallet(fresh, false));
    s.onchain.transaction = vaultTransactionAccount(s.keys, { instructions: [{ kind: 'sol', to: fresh, lamports: 1n }] });
    assert.equal(evaluateRelease(s.input).allow, true);
    // Still only the user's own wallets: unlinking it refuses.
    s.user.solanaWallets.pop();
    denied(evaluateRelease(s.input), /linked to your account/);
    s = scenario({ kind: 'usdc', to: outsider, amount: 1n });
    denied(evaluateRelease(s.input), /linked wallets/);
  });
  it('needs no Privy MFA, and denies without a registration, for another account, a rotated guardian or an unlinked vault wallet', () => {
    // Owner decision 2026-10-13: the regular wallet has no MFA; the vault's own authenticator is a protection layer.
    let s = scenario();
    assert.equal(evaluateRelease(s.input).allow, true);
    s = scenario(); s.input.registration = null;
    denied(evaluateRelease(s.input), /not registered/);
    s = scenario(); s.input.registration = { ...s.registration, privyUserId: 'did:privy:mallory' };
    denied(evaluateRelease(s.input), /another account/);
    s = scenario(); s.input.registration = { ...s.registration, guardian: newWallet() };
    denied(evaluateRelease(s.input), /previous ANTARA guardian/);
    s = scenario(); s.user.solanaWallets = [];
    denied(evaluateRelease(s.input), /no longer linked/);
    s = scenario(); s.input.guardian = newWallet(); s.input.registration = { ...s.registration, guardian: s.input.guardian };
    denied(evaluateRelease(s.input), /not a member/);
  });
  it('denies when U became delegated, unconfirmed or not user-signable after registration', () => {
    let s = scenario(); s.user.solanaWallets[0].delegated = true;
    denied(evaluateRelease(s.input), /delegated \(server\) signing/);
    s = scenario(); s.user.solanaWallets[0].delegated = null;
    denied(evaluateRelease(s.input), /could not confirm that only you can sign/);
    s = scenario(); s.user.solanaWallets[0].userCanSign = false;
    denied(evaluateRelease(s.input), /cannot sign with your ANTARA wallet on your own/);
    s = scenario(); s.user.solanaWallets[0].embedded = false;
    denied(evaluateRelease(s.input), /embedded Solana wallet/);
    s = scenario(); s.user.solanaWallets[0].userCanSign = null;
    assert.equal(evaluateRelease(s.input).allow, true, 'an unreported user_can_sign alone does not deny');
  });
  it('denies USDC into a missing, delegated or foreign-owned token account', () => {
    denied(evaluateRelease(usdcScenario(1n, () => null).input), /does not exist/);
    denied(evaluateRelease(usdcScenario(1n, owner => tokenAccount({ address: usdcAta(owner), owner, delegate: newWallet() })).input), /delegate/);
    denied(evaluateRelease(usdcScenario(1n, owner => tokenAccount({ address: usdcAta(owner), owner: newWallet() })).input), /not owned/);
  });
});

describe('evaluateRelease: limits and ledger', () => {
  const ledgerEntry = (s: ReturnType<typeof scenario>, transactionIndex: string, amountRaw: string, at: number, asset: 'SOL' | 'USDC' = 'SOL'): LedgerEntry => ({
    multisig: s.keys.multisig, transactionIndex, privyUserId: s.user.id, asset, amountRaw, recipient: s.keys.user, approvedAt: new Date(at).toISOString(),
  });
  it('applies no cap by default: large, tiny and repeated releases are all allowed', () => {
    denied(evaluateRelease(scenario({ kind: 'sol', to: pairedKeys().user, lamports: 1n }).input), /linked/);
    // Owner decision 2026-10-13: no default per-release cap (was 0.5 SOL / 50 USDC), no minimum (was 0.001 SOL / 0.1 USDC).
    for (const lamports of [1n, 500_000_001n, 5_000_000_001n, 1_000_000_000_000n]) {
      const s = scenario({ kind: 'sol', to: pairedKeys().user, lamports });
      s.onchain.transaction = vaultTransactionAccount(s.keys, { instructions: [{ kind: 'sol', to: s.keys.user, lamports }] });
      assert.equal(evaluateRelease(s.input).allow, true, `${lamports} lamports`);
    }
    for (const amount of [1n, 50_000_001n, 500_000_001n, 10_000_000_000_000n]) assert.equal(evaluateRelease(usdcScenario(amount).input).allow, true, `${amount} USDC raw`);
    // No rolling daily cap either (was 2 SOL / 200 USDC per 24 hours).
    const s = scenario();
    s.ledger.push({ multisig: s.keys.multisig, transactionIndex: '7', privyUserId: s.user.id, asset: 'SOL', amountRaw: '50000000000000', recipient: s.keys.user, approvedAt: new Date(NOW - 60_000).toISOString() });
    assert.equal(evaluateRelease(s.input).allow, true);
  });
  it('enforces a per-release cap the user set, and only for that asset', () => {
    const s = scenario();
    s.input.limits = caps({ perRelease: { SOL: 100_000_000n } });
    assert.equal(evaluateRelease(s.input).allow, true, 'exactly at the cap');
    s.onchain.transaction = vaultTransactionAccount(s.keys, { instructions: [{ kind: 'sol', to: s.keys.user, lamports: 100_000_001n }] });
    denied(evaluateRelease(s.input), /0\.1 SOL per-release limit you set/);
    const usdc = usdcScenario(1_000_000_000n);
    usdc.input.limits = caps({ perRelease: { SOL: 1n } });
    assert.equal(evaluateRelease(usdc.input).allow, true, 'a SOL cap does not limit USDC');
    usdc.input.limits = caps({ perRelease: { USDC: 999_999_999n } });
    denied(evaluateRelease(usdc.input), /999\.999999 USDC per-release limit you set/);
  });
  it('counts a user’s reservations per window, excluding the proposal being retried', () => {
    const s = scenario();
    s.ledger.push(
      ledgerEntry(s, '7', '1000000', NOW - 30 * 60_000),
      ledgerEntry(s, '8', '1000000', NOW - 2 * 60 * 60_000, 'USDC'),
      ledgerEntry(s, '9', '1000000', NOW - DAY - 1),
      { ...ledgerEntry(s, '10', '1000000', NOW - 1_000), privyUserId: 'did:privy:bob' },
    );
    assert.equal(approvalsInWindow(s.ledger, s.user.id, NOW, 60 * 60_000), 1);
    assert.equal(approvalsInWindow(s.ledger, s.user.id, NOW, DAY), 2);
    assert.equal(approvalsInWindow(s.ledger, s.user.id, NOW, DAY, { multisig: s.keys.multisig, transactionIndex: '7' }), 1);
  });
  it('enforces a daily cap the user set, per vault and asset, ignoring older, other-asset, other-vault and other-user entries', () => {
    const s = scenario();
    s.input.limits = caps({ perDay: { SOL: 2_000_000_000n } });
    s.ledger.push(
      ledgerEntry(s, '7', '1950000000', NOW - DAY + 60_000),
      ledgerEntry(s, '8', '1900000000', NOW - DAY - 1),
      ledgerEntry(s, '9', '150000000', NOW - 1_000, 'USDC'),
      { ...ledgerEntry(s, '10', '1900000000', NOW - 1_000), privyUserId: 'did:privy:bob' },
      { ...ledgerEntry(s, '11', '1900000000', NOW - 1_000), multisig: pairedKeys().multisig },
    );
    denied(evaluateRelease(s.input), /daily limit you set for this vault\. 0\.05 SOL remains/);
    s.ledger.splice(0, 1);
    assert.equal(evaluateRelease(s.input).allow, true);
    // Without the cap, the same ledger never blocks.
    s.ledger.push(ledgerEntry(s, '7', '1950000000', NOW - 60_000));
    s.input.limits = NO_RELEASE_LIMITS;
    assert.equal(evaluateRelease(s.input).allow, true);
  });
  it('sums usage per vault and owner within the window', () => {
    const s = scenario();
    const other = pairedKeys().multisig;
    s.ledger.push(
      ledgerEntry(s, '7', '5', NOW - 1_000), ledgerEntry(s, '8', '7', NOW - DAY - 1), { ...ledgerEntry(s, '9', '11', NOW - 1_000), multisig: other },
      { ...ledgerEntry(s, '10', '13', NOW - 1_000), privyUserId: 'did:privy:bob' }, ledgerEntry(s, '12', '17', NOW - 1_000, 'USDC'),
    );
    assert.equal(usageInWindow(s.ledger, { privyUserId: s.user.id, multisig: s.keys.multisig }, 'SOL', NOW), 5n);
    assert.equal(usageInWindow(s.ledger, { privyUserId: s.user.id, multisig: other }, 'SOL', NOW), 11n);
    assert.equal(usageInWindow(s.ledger, { privyUserId: s.user.id, multisig: s.keys.multisig }, 'USDC', NOW), 17n);
    assert.equal(usageInWindow(s.ledger, { privyUserId: s.user.id, multisig: s.keys.multisig }, 'SOL', NOW, { multisig: s.keys.multisig, transactionIndex: '7' }), 0n);
  });
  it('does not double count a retry of the same proposal but refuses a conflicting record', () => {
    const s = scenario();
    s.input.limits = caps({ perDay: { SOL: 2_000_000_000n } });
    s.ledger.push(ledgerEntry(s, '1', '100000000', NOW - 5_000), ledgerEntry(s, '2', '1900000000', NOW - 5_000));
    const retry = evaluateRelease(s.input);
    assert.equal(retry.allow, true);
    assert.equal(retry.allow && retry.entry.approvedAt, new Date(NOW - 5_000).toISOString());
    s.ledger[0] = { ...s.ledger[0], amountRaw: '5' };
    denied(evaluateRelease(s.input), /different approval/);
  });
  it('denies when the ledger is unreadable, including a corrupt store on disk', () => {
    const s = scenario();
    s.input.ledger = () => { throw new Error('EIO'); };
    const decision = evaluateRelease(s.input);
    denied(decision, /could not be verified/);
    assert.equal(!decision.allow && 'status' in decision && decision.status, 503);
    const dir = mkdtempSync(join(tmpdir(), 'antara-policy-'));
    try {
      const file = join(dir, 'paired-vaults-solana.json');
      writeFileSync(file, '{"version":1,"vaults":{},"ledger":');
      const store = createVaultStore(file);
      s.input.ledger = () => store.ledger();
      denied(evaluateRelease(s.input), /could not be verified/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('denies when the limits themselves are invalid', () => {
    const s = scenario();
    s.input.limits = { perRelease: { SOL: 0n, USDC: null }, perDay: { SOL: null, USDC: null } };
    denied(evaluateRelease(s.input), /misconfigured/);
    s.input.limits = { perRelease: { SOL: null, USDC: null }, perDay: { SOL: -1n, USDC: null } };
    denied(evaluateRelease(s.input), /misconfigured/);
  });
});

describe('vault release limits (optional Limits layer)', () => {
  it('has no server default, ceiling or minimum: no stored limits means no cap', () => {
    assert.deepEqual(effectiveReleaseLimits(null), NO_RELEASE_LIMITS);
    assert.deepEqual(effectiveReleaseLimits(undefined), NO_RELEASE_LIMITS);
    assert.equal(hasReleaseCap(NO_RELEASE_LIMITS), false);
  });
  it('uses exactly the caps the user set, any positive size, and null as no cap', () => {
    const huge = '9'.repeat(30);
    const limits = effectiveReleaseLimits({ perReleaseRaw: { SOL: '1', USDC: null }, perDayRaw: { SOL: null, USDC: huge } });
    assert.deepEqual(limits, { perRelease: { SOL: 1n, USDC: null }, perDay: { SOL: null, USDC: BigInt(huge) } });
    assert.equal(hasReleaseCap(limits), true);
    assert.deepEqual(rawCaps(limits), { perReleaseRaw: { SOL: '1', USDC: null }, perDayRaw: { SOL: null, USDC: huge } });
    for (const bad of ['0', '-1', '1.5', '', 'abc', '01']) {
      assert.throws(() => effectiveReleaseLimits({ perReleaseRaw: { SOL: bad, USDC: null }, perDayRaw: { SOL: null, USDC: null } }), /invalid/, bad);
    }
    assert.equal(formatRawAmount(1_500_000n, 'USDC'), '1.5 USDC');
    assert.equal(formatRawAmount(0n, 'SOL'), '0 SOL');
  });
});

describe('privyUserFacts', () => {
  it('maps linked Solana wallets with embedded and signing flags (no link time, no Privy MFA)', () => {
    const embedded = newWallet(), external = newWallet(), unknown = newWallet(), delegated = newWallet(), legacy = newWallet();
    const privy = { connector_type: 'embedded', wallet_client_type: 'privy' };
    const facts = privyUserFacts({
      id: 'did:privy:alice',
      linked_accounts: [
        { type: 'email', address: 'a@example.test' },
        { type: 'wallet', chain_type: 'ethereum', address: '0x1111111111111111111111111111111111111111', first_verified_at: 1 },
        { type: 'wallet', chain_type: 'solana', address: embedded, ...privy, delegated: false, imported: false, user_can_sign: true, first_verified_at: 1_760_000_000, verified_at: 1_760_500_000 },
        { type: 'wallet', chain_type: 'solana', address: external, connector_type: 'phantom', delegated: true, first_verified_at: null, verified_at: 1_760_100_000_000 },
        { type: 'wallet', chain_type: 'solana', address: unknown, first_verified_at: null, verified_at: null },
        { type: 'wallet', chain_type: 'solana', address: delegated, ...privy, delegated: true, imported: true, user_can_sign: false, first_verified_at: 1_760_000_000 },
        { type: 'wallet', chain_type: 'solana', address: legacy, ...privy, first_verified_at: 1_760_000_000 },
      ],
      mfa_methods: [{ type: 'sms' }, { type: 'totp', verified_at: 1 }],
    });
    assert.deepEqual(facts, {
      id: 'did:privy:alice',
      solanaWallets: [
        { address: embedded, embedded: true, delegated: false, imported: false, userCanSign: true },
        { address: external, embedded: false, delegated: false, imported: false, userCanSign: null },
        { address: unknown, embedded: false, delegated: false, imported: false, userCanSign: null },
        { address: delegated, embedded: true, delegated: true, imported: true, userCanSign: false },
        { address: legacy, embedded: true, delegated: null, imported: false, userCanSign: null },
      ],
    });
    assert.deepEqual(Object.keys(privyUserFacts({ id: 'x', linked_accounts: [], mfa_methods: [{ type: 'totp' }] })).sort(), ['id', 'solanaWallets']);
    assert.deepEqual(privyUserFacts({ id: 'x', linked_accounts: [] }), { id: 'x', solanaWallets: [] });
    assert.throws(() => privyUserFacts({ id: '', linked_accounts: [] }));
  });
});

describe('evaluateRegistration', () => {
  const setup = () => {
    const keys = pairedKeys();
    const user: PrivyUserFacts = { id: 'did:privy:alice', solanaWallets: [linkedWallet(keys.user)] };
    return { keys, input: { user, guardian: keys.guardian, request: { multisig: keys.multisig }, onchain: { observedAt: NOW, multisig: multisigAccount(keys), spendingLimitCount: 0 } as OnchainSnapshot, now: NOW } };
  };
  it('registers an exact paired vault of the user’s embedded wallet', () => {
    const { keys, input } = setup();
    const decision = evaluateRegistration(input);
    assert.deepEqual(decision, { allow: true, record: { privyUserId: 'did:privy:alice', user: keys.user, multisig: keys.multisig, guardian: keys.guardian, vault: keys.vault, createdAt: new Date(NOW).toISOString() } });
  });
  it('needs no Privy MFA, and refuses an external or unlinked wallet, or a non-paired vault', () => {
    let s = setup();
    assert.equal(evaluateRegistration(s.input).allow, true);
    s = setup(); s.input.user.solanaWallets[0].embedded = false;
    assert.match((evaluateRegistration(s.input) as { reason: string }).reason, /embedded/);
    s = setup(); s.input.user.solanaWallets[0].delegated = true;
    assert.match((evaluateRegistration(s.input) as { reason: string }).reason, /delegated \(server\) signing/);
    s = setup(); s.input.user.solanaWallets[0].delegated = null;
    assert.match((evaluateRegistration(s.input) as { reason: string }).reason, /could not confirm/);
    s = setup(); s.input.user.solanaWallets[0].userCanSign = false;
    assert.match((evaluateRegistration(s.input) as { reason: string }).reason, /on your own/);
    s = setup(); s.input.user.solanaWallets = [];
    assert.match((evaluateRegistration(s.input) as { reason: string }).reason, /not paired with a wallet linked/);
    s = setup(); s.input.onchain.multisig = multisigAccount(s.keys, { threshold: 1 });
    assert.match((evaluateRegistration(s.input) as { reason: string }).reason, /two approvals/);
    s = setup(); s.input.onchain.spendingLimitCount = 2;
    assert.match((evaluateRegistration(s.input) as { reason: string }).reason, /spending limits/);
    s = setup(); s.input.guardian = newWallet();
    assert.match((evaluateRegistration(s.input) as { reason: string }).reason, /not a member/);
    s = setup(); s.input.request = { multisig: pairedKeys().multisig };
    assert.match((evaluateRegistration(s.input) as { reason: string }).reason, /does not match/);
  });
});
