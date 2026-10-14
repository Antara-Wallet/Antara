import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PairedVaultApiError, hasPairedCap, pairedReleaseBounds, parsePairedAccount, parsePairedApproval, parsePairedConfig, parsePairedRegistration, parsePairedUsage,
  requestGuardianApproval,
} from './pairedApi';
import { newWallet, pairedKeys } from '../paired/testFixtures';

/** A vault's caps as GET /limits?multisig= returns them: Limits off by default, so every value is null. */
const noCaps = { perReleaseRaw: { SOL: null, USDC: null }, perDayRaw: { SOL: null, USDC: null } };

describe('paired vault API responses', () => {
  const keys = pairedKeys();
  const config = { configured: true, guardian: keys.guardian, cluster: 'mainnet-beta', policyVersion: 'antara-paired-solana-v1' };
  it('accepts only the guardian pinned in this build, on this cluster and policy version', () => {
    const parsed = parsePairedConfig(config, keys.guardian, 'mainnet-beta');
    assert.deepEqual(parsed, { guardian: keys.guardian, cluster: 'mainnet-beta', policyVersion: 'antara-paired-solana-v1' }, 'no server-wide limits');
    assert.throws(() => parsePairedConfig(config, '', 'mainnet-beta'), /no pinned ANTARA guardian/);
    assert.throws(() => parsePairedConfig(config, newWallet(), 'mainnet-beta'), /does not match this build/);
    assert.throws(() => parsePairedConfig(config, keys.guardian, 'devnet'), /different Solana cluster/);
    assert.throws(() => parsePairedConfig({ ...config, policyVersion: 'antara-paired-solana-v2' }, keys.guardian, 'mainnet-beta'), /policy version/);
    assert.throws(() => parsePairedConfig({ ...config, configured: false }, keys.guardian, 'mainnet-beta'), /unexpected response/);
    // A program address (the vault PDA) can never be the guardian.
    assert.throws(() => parsePairedConfig({ ...config, guardian: keys.vault }, keys.vault, 'mainnet-beta'), /unexpected response/);
  });
  it('reads one vault\'s optional caps (none by default) and refuses inconsistent or malformed values', () => {
    const multisig = keys.multisig;
    const usage = parsePairedUsage({ multisig, limits: noCaps, usedLast24h: { SOL: '300000000', USDC: '0' } }, multisig);
    assert.deepEqual(usage.limits, { perRelease: { SOL: null, USDC: null }, perDay: { SOL: null, USDC: null } });
    assert.equal(usage.usedLast24h.SOL, 300_000_000n); assert.equal(hasPairedCap(usage.limits), false);
    assert.deepEqual(pairedReleaseBounds(usage, 'SOL'), { perRelease: null, remainingToday: null }, 'no cap applies by default');
    // A cap the user set, of any size: the per-release cap and what is left of the daily cap.
    const capped = parsePairedUsage({ multisig, limits: { perReleaseRaw: { SOL: '500000000', USDC: null }, perDayRaw: { SOL: '1000000000', USDC: '9'.repeat(30) } }, usedLast24h: { SOL: '300000000', USDC: '0' } }, multisig);
    assert.equal(hasPairedCap(capped.limits), true);
    assert.deepEqual(pairedReleaseBounds(capped, 'SOL'), { perRelease: 500_000_000n, remainingToday: 700_000_000n });
    assert.deepEqual(pairedReleaseBounds(capped, 'USDC'), { perRelease: null, remainingToday: BigInt('9'.repeat(30)) });
    const spent = parsePairedUsage({ multisig, limits: { perReleaseRaw: { SOL: null, USDC: null }, perDayRaw: { SOL: '1', USDC: null } }, usedLast24h: { SOL: '5', USDC: '0' } }, multisig);
    assert.deepEqual(pairedReleaseBounds(spent, 'SOL'), { perRelease: null, remainingToday: 0n });
    for (const change of [
      { perReleaseRaw: { SOL: '3000000000', USDC: null }, perDayRaw: { SOL: '2000000000', USDC: null } }, { perReleaseRaw: { SOL: '0', USDC: null }, perDayRaw: noCaps.perDayRaw },
      { perReleaseRaw: noCaps.perReleaseRaw, perDayRaw: { SOL: '2 SOL', USDC: null } }, { perReleaseRaw: { SOL: '-1', USDC: null }, perDayRaw: noCaps.perDayRaw },
      { perReleaseRaw: noCaps.perReleaseRaw }, { ...noCaps, minimumRaw: { SOL: '1', USDC: '1' } },
    ]) assert.throws(() => parsePairedUsage({ multisig, limits: change, usedLast24h: { SOL: '0', USDC: '0' } }, multisig), JSON.stringify(change));
    assert.throws(() => parsePairedUsage({ multisig, limits: noCaps, usedLast24h: { SOL: 0.3, USDC: '0' } }, multisig));
    assert.throws(() => parsePairedUsage({ multisig: pairedKeys().multisig, limits: noCaps, usedLast24h: { SOL: '0', USDC: '0' } }, multisig), /unexpected response/, 'bound to the vault asked for');
  });
  it('derives every registered deposit address instead of trusting the server', () => {
    const vault = { multisig: keys.multisig, vault: keys.vault, user: keys.user, guardian: keys.guardian, createdAt: '2026-10-12T12:00:00.000Z' };
    const wallet = { address: keys.user, embedded: true, pairProblem: null };
    const external = newWallet();
    const account = parsePairedAccount({ mfaEnrolled: true, wallets: [wallet, { ...wallet, address: external, embedded: false, pairProblem: 'External wallet.' }], vaults: [vault] });
    // Every linked wallet can receive releases at once: no link-age field is kept.
    assert.deepEqual(account.wallets, [{ address: keys.user, embedded: true, pairProblem: null }, { address: external, embedded: false, pairProblem: 'External wallet.' }]);
    // An older server's `receivesReleasesFrom` is ignored, never a reason to block a wallet.
    assert.deepEqual(parsePairedAccount({ mfaEnrolled: true, wallets: [{ ...wallet, receivesReleasesFrom: null }], vaults: [] }).wallets, [wallet]);
    assert.deepEqual(account.vaults, [vault]);
    assert.throws(() => parsePairedAccount({ mfaEnrolled: true, wallets: [], vaults: [{ ...vault, vault: newWallet() }] }), /unexpected response/);
    assert.throws(() => parsePairedAccount({ mfaEnrolled: 'yes', wallets: [], vaults: [] }));
    assert.throws(() => parsePairedAccount({ mfaEnrolled: true, wallets: [{ ...wallet, address: 'not-an-address' }], vaults: [] }));
  });
  it('binds a registration to the requested vault and the pinned guardian', () => {
    const body = { status: 'registered', multisig: keys.multisig, vault: keys.vault, guardian: keys.guardian };
    assert.equal(parsePairedRegistration(body, keys.multisig, keys.guardian).vault, keys.vault);
    assert.equal(parsePairedRegistration({ ...body, status: 'already-registered' }, keys.multisig, keys.guardian).status, 'already-registered');
    for (const change of [{ status: 'ok' }, { vault: newWallet() }, { guardian: newWallet() }, { multisig: pairedKeys().multisig }]) {
      assert.throws(() => parsePairedRegistration({ ...body, ...change }, keys.multisig, keys.guardian), JSON.stringify(change));
    }
    assert.throws(() => parsePairedRegistration(body, keys.multisig, ''));
  });
  it('reads approvals, pending votes and repeats exactly', () => {
    const signature = '5'.repeat(88);
    assert.deepEqual(parsePairedApproval({ status: 'already-approved' }), { status: 'already-approved' });
    assert.deepEqual(parsePairedApproval({ status: 'pending', signature }), { status: 'pending', signature });
    assert.deepEqual(parsePairedApproval({ status: 'approved', signature, asset: 'USDC', amountRaw: '20000000', recipient: keys.user }), { status: 'approved', signature, asset: 'USDC', amountRaw: 20_000_000n, recipient: keys.user });
    for (const value of [{ status: 'approved', signature, asset: 'ETH', amountRaw: '1', recipient: keys.user }, { status: 'pending' }, { status: 'approved', signature: 'x', asset: 'SOL', amountRaw: '1', recipient: keys.user }, null]) {
      assert.throws(() => parsePairedApproval(value), JSON.stringify(value));
    }
  });
});

describe('guardian approval with vault layers', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const keys = pairedKeys();
  const respond = (status: number, json: unknown, headers: Record<string, string> = {}, bodies: unknown[] = []) => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    }) as typeof fetch;
    return bodies;
  };

  it('sends evidence only when it is given', async () => {
    const bodies = respond(200, { status: 'already-approved' });
    await requestGuardianApproval('token', keys.multisig, '3');
    await requestGuardianApproval('token', keys.multisig, '3', { challengeId: 'q3Jt0eS3h0d8a5bVt9k1JQ', device: { keyId: 'k', payload: 'p', signature: 's' } });
    assert.deepEqual(bodies, [
      { multisig: keys.multisig, transactionIndex: '3' },
      { multisig: keys.multisig, transactionIndex: '3', layers: { challengeId: 'q3Jt0eS3h0d8a5bVt9k1JQ', device: { keyId: 'k', payload: 'p', signature: 's' } } },
    ]);
  });

  it('carries what is required, what failed and when to retry, only for the codes that define them', async () => {
    respond(403, { error: 'Verify your protection layers.', code: 'layers-required', required: [{ id: 'biometrics', evidence: 'passkey' }, { id: 'mfa', evidence: 'server' }] });
    const required = await requestGuardianApproval('token', keys.multisig, '3').catch(error => error);
    assert.ok(required instanceof PairedVaultApiError);
    assert.deepEqual([required.status, required.code, required.message], [403, 'layers-required', 'Verify your protection layers.']);
    assert.deepEqual(required.required?.map(item => item.id), ['biometrics', 'mfa']);
    assert.equal(required.layers, null);
    respond(429, { error: 'Locked.', code: 'locked' }, { 'Retry-After': '900' });
    assert.equal((await requestGuardianApproval('token', keys.multisig, '3').catch(error => error)).retryAfterSeconds, 900);
    respond(403, { error: 'Denied.', code: 'denied', required: [{ id: 'mfa', evidence: 'server' }] });
    const denied = await requestGuardianApproval('token', keys.multisig, '3').catch(error => error);
    assert.deepEqual([denied.code, denied.required, denied.layers, denied.retryAfterSeconds], ['denied', null, null, null]);
    respond(503, ['not', 'an', 'object']);
    assert.equal((await requestGuardianApproval('token', keys.multisig, '3').catch(error => error)).code, 'unavailable');
  });
});
