import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEDGER_RETENTION_MS, VAULT_STORE_FILE, VAULT_STORE_MARKER, VaultStoreError, createVaultStore, initialiseVaultStoreAtBoot, vaultStoreOptions, vaultStorePath,
  type LedgerEntry, type PairedVaultRecord, type ReleaseAuthorization,
} from './vaultStore.js';
import { newWallet, pairedKeys } from '../../../src/solares/paired/testFixtures';
import { randomId, randomToken } from './layers/codec.js';
import { emptyLayerConfig } from './layers/policy.js';
import type { VaultLayerConfig } from './layers/types.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'antara-vaults-'));
  const file = join(dir, VAULT_STORE_FILE);
  return { dir, file, store: createVaultStore(file), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function record(privyUserId = 'did:privy:alice'): PairedVaultRecord {
  const keys = pairedKeys();
  return { privyUserId, user: keys.user, multisig: keys.multisig, guardian: keys.guardian, vault: keys.vault, createdAt: '2026-10-12T00:00:00.000Z' };
}
function entry(vault: PairedVaultRecord, transactionIndex = '1', amountRaw = '1000000', approvedAt = '2026-10-12T00:00:00.000Z'): LedgerEntry {
  return { multisig: vault.multisig, transactionIndex, privyUserId: vault.privyUserId, asset: 'USDC', amountRaw, recipient: vault.user, approvedAt };
}
const SIG = '5'.repeat(88);

describe('paired vault store', () => {
  it('starts empty, registers idempotently and refuses a different binding', () => {
    const { store, cleanup } = tempStore();
    try {
      assert.equal(store.getVault(pairedKeys().multisig), null);
      assert.deepEqual(store.ledger(), []);
      const vault = record();
      assert.equal(store.registerVault(vault).created, true);
      assert.equal(store.registerVault({ ...vault, createdAt: '2026-10-13T00:00:00.000Z' }).created, false);
      assert.deepEqual(store.getVault(vault.multisig), vault);
      assert.deepEqual(store.vaultsForUser('did:privy:alice'), [vault]);
      assert.throws(() => store.registerVault({ ...vault, privyUserId: 'did:privy:mallory' }), (error: unknown) => error instanceof VaultStoreError && error.code === 'conflict');
      assert.throws(() => store.registerVault({ ...vault, user: newWallet() }), /another account/);
      assert.throws(() => store.registerVault({ ...vault, multisig: 'not-base58!' }), /invalid/);
    } finally { cleanup(); }
  });

  it('records each (multisig, index) approval once and rejects a conflicting one', () => {
    const { store, cleanup } = tempStore();
    try {
      const vault = record();
      assert.equal(store.recordApproval(entry(vault)).created, true);
      assert.equal(store.recordApproval(entry(vault)).created, false);
      assert.equal(store.ledger().length, 1);
      const signedAt = Date.parse('2026-10-12T00:00:30.000Z');
      const signed = store.recordApproval({ ...entry(vault), signature: SIG }, signedAt);
      assert.equal(signed.created, false); assert.equal(signed.entry.signature, SIG);
      assert.equal(store.ledgerEntry(vault.multisig, '1')?.signature, SIG);
      assert.equal(store.ledgerEntry(vault.multisig, '1')?.signedAt, new Date(signedAt).toISOString(), 'the signing time drives the pending window');
      assert.equal(store.recordApproval({ ...entry(vault), signature: SIG }, signedAt + 5_000).entry.signedAt, new Date(signedAt).toISOString(), 'the same signature keeps its time');
      const resigned = store.recordApproval({ ...entry(vault), signature: '6'.repeat(88), signedAt: '2026-10-12T00:02:00.000Z' });
      assert.equal(resigned.entry.signedAt, '2026-10-12T00:02:00.000Z');
      assert.equal(resigned.entry.approvedAt, entry(vault).approvedAt, 'a re-signature never moves the reservation time');
      assert.throws(() => store.recordApproval(entry(vault, '1', '2000000')), (error: unknown) => error instanceof VaultStoreError && error.code === 'conflict');
      assert.throws(() => store.recordApproval({ ...entry(vault), recipient: newWallet() }), /different approval/);
      assert.throws(() => store.recordApproval({ ...entry(vault, '2'), amountRaw: '0' }), /invalid/);
      assert.throws(() => store.recordApproval({ ...entry(vault, '2'), asset: 'ETH' as never }), /invalid/);
      assert.equal(store.recordApproval(entry(vault, '2')).created, true);
      assert.equal(store.ledger().length, 2);
    } finally { cleanup(); }
  });

  it('fails closed on corrupt, unreadable or structurally unexpected storage', () => {
    const { file, store, cleanup } = tempStore();
    try {
      const vault = record();
      store.registerVault(vault);
      store.recordApproval(entry(vault));
      const good = JSON.parse(readFileSync(file, 'utf8'));
      const corrupt = [
        '{broken', 'null', '[]', JSON.stringify({ ...good, version: 3 }), JSON.stringify({ ...good, version: 1 }), JSON.stringify({ ...good, extra: {} }),
        JSON.stringify({ ...good, layers: [] }), JSON.stringify({ version: 2, vaults: good.vaults, ledger: good.ledger }),
        JSON.stringify({ ...good, ledger: [] }),
        JSON.stringify({ ...good, ledger: { [`${vault.multisig}:1`]: { ...good.ledger[`${vault.multisig}:1`], amountRaw: '-5' } } }),
        JSON.stringify({ ...good, ledger: { [`${vault.multisig}:9`]: good.ledger[`${vault.multisig}:1`] } }),
        JSON.stringify({ ...good, vaults: { [vault.multisig]: { ...vault, user: 42 } } }),
        JSON.stringify({ ...good, ledger: { [`${vault.multisig}:1`]: { ...good.ledger[`${vault.multisig}:1`], signedAt: '2026-10-12T00:00:00.000Z' } } }),
      ];
      for (const value of corrupt) {
        writeFileSync(file, value);
        assert.throws(() => store.ledger(), VaultStoreError, value.slice(0, 40));
        assert.throws(() => store.getVault(vault.multisig), VaultStoreError);
        assert.throws(() => store.recordApproval(entry(vault, '3')), VaultStoreError);
        assert.throws(() => store.registerVault(record()), VaultStoreError);
      }
    } finally { cleanup(); }
  });

  it('reads a version 1 document as a store without layers and writes version 2', () => {
    const { file, store, cleanup } = tempStore();
    try {
      const vault = record();
      writeFileSync(file, JSON.stringify({ version: 1, vaults: { [vault.multisig]: vault }, ledger: { [`${vault.multisig}:1`]: entry(vault) } }));
      assert.equal(store.layerConfig(vault.multisig), null);
      assert.equal(store.ledger().length, 1);
      store.recordApproval(entry(vault, '2'));
      const written = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(written.version, 2); assert.deepEqual(written.layers, {});
      assert.deepEqual(Object.keys(written).sort(), ['layers', 'ledger', 'vaults', 'version']);
    } finally { cleanup(); }
  });

  it('stores protection layers per registered vault, optimistically and fully validated', () => {
    const { file, store, cleanup } = tempStore();
    try {
      const vault = record();
      const config: VaultLayerConfig = {
        ...emptyLayerConfig(randomToken(32), '2026-10-13T00:00:00.000Z'), version: 1,
        geolocation: { zones: [{ id: randomId('zone'), label: 'Home', lat: 48.85, lng: 2.35, radiusM: 500, addedAt: '2026-10-13T00:00:00.000Z' }] },
      };
      assert.throws(() => store.writeLayerConfig(vault.multisig, null, config), (error: unknown) => error instanceof VaultStoreError && error.code === 'conflict', 'the vault must be registered');
      store.registerVault(vault);
      assert.deepEqual(store.writeLayerConfig(vault.multisig, null, config), config);
      assert.deepEqual(store.layerConfig(vault.multisig), config, 'round trip');
      // Optimistic concurrency: the caller must name the version it read.
      assert.throws(() => store.writeLayerConfig(vault.multisig, null, { ...config, version: 2 }), (error: unknown) => error instanceof VaultStoreError && error.code === 'conflict');
      assert.throws(() => store.writeLayerConfig(vault.multisig, 7, { ...config, version: 8 }), /changed in the meantime/);
      assert.throws(() => store.writeLayerConfig(vault.multisig, 1, { ...config, version: 0 }), /invalid/);
      store.writeLayerConfig(vault.multisig, 1, { ...config, version: 2 });
      assert.equal(store.layerConfig(vault.multisig)?.version, 2);
      // Never an empty list for a layer that is on, and every field is checked on read.
      assert.throws(() => store.writeLayerConfig(vault.multisig, 2, { ...config, version: 3, geolocation: { zones: [] } }), /invalid/);
      const good = JSON.parse(readFileSync(file, 'utf8'));
      const layers = good.layers[vault.multisig];
      for (const [name, value] of [
        ['empty zones', { ...layers, geolocation: { zones: [] } }], ['unknown key', { ...layers, voice: true }], ['NaN radius', { ...layers, geolocation: { zones: [{ ...layers.geolocation.zones[0], radiusM: 'NaN' }] } }],
        ['missing user handle', { ...layers, webauthnUserId: undefined }], ['duplicate device', { ...layers, devices: [1, 1] }],
      ] as const) {
        writeFileSync(file, JSON.stringify({ ...good, layers: { [vault.multisig]: value } }));
        assert.throws(() => store.layerConfig(vault.multisig), VaultStoreError, name);
        assert.throws(() => store.ledger(), VaultStoreError, `${name}: the whole store refuses`);
      }
      writeFileSync(file, JSON.stringify({ ...good, layers: { [pairedKeys().multisig]: layers } }));
      assert.throws(() => store.ledger(), /protection-layer configuration/, 'layers for an unregistered vault');
      writeFileSync(file, JSON.stringify(good));
      assert.equal(store.layerConfig(vault.multisig)?.version, 2);
    } finally { cleanup(); }
  });

  it('reserves a vote only with a release authorization, re-checks the vault limits there and records the layers that passed', () => {
    const { file, cleanup } = tempStore();
    // The guardian and the layer service open separate instances on one file; a grant made through one is consumed through the other.
    const store = createVaultStore(file, { requireReleaseAuthorization: true });
    const guardianStore = createVaultStore(file, { requireReleaseAuthorization: true });
    try {
      const vault = record();
      store.registerVault(vault);
      const now = Date.parse('2026-10-12T00:00:00.000Z');
      const pass = { challengeId: randomToken(16), configVersion: 3, passedAt: '2026-10-12T00:00:00.000Z', enforced: ['biometrics', 'mfa', 'limits'] as Array<'biometrics' | 'mfa' | 'limits'> };
      const limits = { perReleaseRaw: { SOL: '500000000', USDC: '2000000' }, perDayRaw: { SOL: '2000000000', USDC: '3000000' } };
      const grant = (index = '1', over: Partial<ReleaseAuthorization> = {}) =>
        store.authorizeRelease(vault.multisig, index, { privyUserId: vault.privyUserId, pass, limits, layerVersion: null, expiresAt: now + 120_000, ...over });
      const refused = (value: LedgerEntry, pattern: RegExp = /not passed the vault's protection layers/) =>
        assert.throws(() => guardianStore.recordApproval(value, now), (error: unknown) => error instanceof VaultStoreError && error.code === 'conflict' && pattern.test(error.message), pattern.source);
      // No grant, another account's, or an expired one: nothing is reserved, and every grant is used once.
      refused(entry(vault));
      grant('1', { privyUserId: 'did:privy:mallory' }); refused(entry(vault));
      grant('1', { expiresAt: now }); refused(entry(vault));
      assert.equal(store.ledger().length, 0);
      grant();
      const reserved = guardianStore.recordApproval(entry(vault), now);
      assert.equal(reserved.created, true); assert.deepEqual(reserved.entry.layers, pass);
      assert.deepEqual(store.ledgerEntry(vault.multisig, '1')?.layers, pass, 'the layers that passed are recorded on the reservation');
      refused(entry(vault), /not passed/);
      // Recording the guardian's signature follows the vote: no grant needed, and the record stays.
      guardianStore.recordApproval({ ...entry(vault), signature: SIG }, now + 1_000);
      assert.deepEqual(store.ledgerEntry(vault.multisig, '1')?.layers, pass);
      // Re-reserving the signed entry (a retry) needs a grant again.
      refused(store.ledgerEntry(vault.multisig, '1')!);
      grant('1', { pass: null });
      assert.equal(guardianStore.recordApproval(store.ledgerEntry(vault.multisig, '1')!, now).created, false);
      assert.deepEqual(store.ledgerEntry(vault.multisig, '1')?.layers, pass);
      // The caps the user set, checked against the ledger in the reservation itself: 1 USDC is used of 3 per 24 hours, at most 2 per release.
      grant('2'); refused(entry(vault, '2', '2500000'), /over the limits you set for this vault/);
      grant('2'); refused(entry(vault, '2', '2000001'), /over the limits you set for this vault/);
      grant('2'); assert.equal(guardianStore.recordApproval(entry(vault, '2', '2000000'), now).created, true);
      grant('3'); refused(entry(vault, '3', '100000'), /over the limits you set for this vault/);
      // A layer configuration written after the grant refuses the reservation.
      grant('4', { limits: { ...limits, perDayRaw: { SOL: '2000000000', USDC: '9000000' } } });
      store.writeLayerConfig(vault.multisig, null, { ...emptyLayerConfig(randomToken(32), '2026-10-13T00:00:00.000Z'), version: 1 });
      refused(entry(vault, '4', '100000'), /changed in the meantime/);
      grant('4', { layerVersion: 1, limits: { ...limits, perDayRaw: { SOL: '2000000000', USDC: '9000000' } } });
      assert.equal(guardianStore.recordApproval(entry(vault, '4', '100000'), now).created, true);
      // No cap set (null, the default since 2026-10-13): any amount is reserved.
      grant('7', { layerVersion: 1, limits: { perReleaseRaw: { SOL: null, USDC: null }, perDayRaw: { SOL: null, USDC: null } } });
      assert.equal(guardianStore.recordApproval(entry(vault, '7', '900000000000'), now).created, true);
      // Malformed grants and records are refused.
      for (const over of [{ privyUserId: '' }, { limits: { ...limits, perDayRaw: { SOL: '-1', USDC: '1' } } }, { layerVersion: 0 }, { expiresAt: NaN }, { pass: { ...pass, enforced: ['voice' as never] } }]) {
        assert.throws(() => grant('5', over as Partial<ReleaseAuthorization>), /invalid/, JSON.stringify(over));
      }
      assert.throws(() => store.authorizeRelease('not-base58!', '1', { privyUserId: vault.privyUserId, pass, limits, layerVersion: null, expiresAt: now }), /invalid/);
      assert.throws(() => guardianStore.recordApproval({ ...entry(vault, '6'), layers: { ...pass, configVersion: 0 } }), /invalid/);
      // The server's stores always require it.
      assert.equal(vaultStoreOptions({}).requireReleaseAuthorization, true);
      assert.equal(vaultStoreOptions({ NODE_ENV: 'production' }).requireReleaseAuthorization, true);
    } finally { cleanup(); }
  });

  it('prunes entries older than the retention window and leaves no staging files', () => {
    const { dir, store, cleanup } = tempStore();
    try {
      const vault = record();
      const now = Date.parse('2026-10-12T12:00:00.000Z');
      store.recordApproval(entry(vault, '1', '1', new Date(now - LEDGER_RETENTION_MS - 1).toISOString()), now);
      store.recordApproval(entry(vault, '2', '1', new Date(now - 1000).toISOString()), now);
      store.recordApproval(entry(vault, '3', '1', new Date(now).toISOString()), now);
      assert.deepEqual(store.ledger().map(item => item.transactionIndex).sort(), ['2', '3']);
      assert.deepEqual(readdirSync(dir).sort(), [VAULT_STORE_MARKER, VAULT_STORE_FILE].sort());
    } finally { cleanup(); }
  });

  it('refuses a missing document once initialised, and an uninitialised disk in production', () => {
    const { dir, file, store, cleanup } = tempStore();
    try {
      // Development: a missing document is a fresh install until the first write records the marker.
      assert.deepEqual(store.ledger(), []);
      store.registerVault(record());
      assert.ok(existsSync(join(dir, VAULT_STORE_MARKER)));
      rmSync(file);
      for (const read of [() => store.ledger(), () => store.getVault(pairedKeys().multisig), () => store.vaultsForUser('did:privy:alice')]) {
        assert.throws(read, (error: unknown) => error instanceof VaultStoreError && /data file is missing/.test(error.message));
      }
      assert.throws(() => store.registerVault(record()), /data file is missing/);
      assert.throws(() => store.recordApproval(entry(record())), /data file is missing/);
    } finally { cleanup(); }

    const fresh = tempStore();
    try {
      const production = createVaultStore(fresh.file, vaultStoreOptions({ NODE_ENV: 'production', DATA_DIR: fresh.dir }));
      assert.throws(() => production.ledger(), (error: unknown) => error instanceof VaultStoreError && error.code === 'configuration' && /ANTARA_VAULT_STORE_INIT=1/.test(error.message));
      assert.throws(() => production.registerVault(record()), /not initialised/);
      assert.equal(existsSync(join(fresh.dir, VAULT_STORE_MARKER)), false, 'nothing is written while refusing');
      // A deliberate fresh install writes the marker at start-up; afterwards the flag can be removed.
      createVaultStore(fresh.file, vaultStoreOptions({ NODE_ENV: 'production', ANTARA_VAULT_STORE_INIT: '1' }));
      assert.ok(existsSync(join(fresh.dir, VAULT_STORE_MARKER)));
      assert.ok(existsSync(fresh.file));
      const restarted = createVaultStore(fresh.file, vaultStoreOptions({ NODE_ENV: 'production' }));
      assert.deepEqual(restarted.ledger(), [], 'the flag is not needed after the first start');
      rmSync(fresh.file);
      assert.throws(() => restarted.ledger(), /data file is missing/, 'an initialised store whose document vanished still refuses');
      createVaultStore(fresh.file, vaultStoreOptions({ NODE_ENV: 'production', ANTARA_VAULT_STORE_INIT: '1' }));
      assert.throws(() => restarted.ledger(), /data file is missing/, 'a leftover INIT flag never re-initialises a disk that had data');
    } finally { fresh.cleanup(); }

    const initialised = tempStore();
    try {
      const first = createVaultStore(initialised.file, vaultStoreOptions({ NODE_ENV: 'production', ANTARA_VAULT_STORE_INIT: '1' }));
      first.registerVault(record());
      const later = createVaultStore(initialised.file, vaultStoreOptions({ NODE_ENV: 'production' }));
      assert.equal(later.vaultsForUser('did:privy:alice').length, 1);
    } finally { initialised.cleanup(); }
    assert.deepEqual(vaultStoreOptions({}), { requireInitialised: false, initialise: false, requireReleaseAuthorization: true });
    assert.deepEqual(vaultStoreOptions({ NODE_ENV: 'production', ANTARA_VAULT_STORE_INIT: 'yes' }), { requireInitialised: true, initialise: false, requireReleaseAuthorization: true });
  });

  it('serialises locked sections for the same file across store instances', async () => {
    const { file, store, cleanup } = tempStore();
    try {
      const other = createVaultStore(file);
      const events: string[] = [];
      const section = (name: string, delay: number) => async () => { events.push(`${name}:start`); await new Promise(resolve => setTimeout(resolve, delay)); events.push(`${name}:end`); return name; };
      const failing = store.withLock(() => { throw new Error('boom'); });
      const results = await Promise.all([store.withLock(section('a', 20)), other.withLock(section('b', 1)), store.withLock(section('c', 1))]);
      await assert.rejects(failing, /boom/);
      assert.deepEqual(results, ['a', 'b', 'c']);
      assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    } finally { cleanup(); }
  });

  it('initialises at server start without any guardian setting, and reports refusals by name only', () => {
    const disk = mkdtempSync(join(tmpdir(), 'antara-boot-'));
    try {
      const production = { NODE_ENV: 'production', DATA_DIR: disk };
      // An empty disk without the flag refuses and writes nothing.
      const refused = initialiseVaultStoreAtBoot(production);
      assert.equal(refused.outcome, 'refused'); assert.match(refused.reason!, /not initialised/);
      assert.doesNotMatch(refused.reason!, new RegExp(disk.replace(/[\\.]/g, '.')));
      assert.deepEqual(readdirSync(disk), []);
      // The deliberate first start writes the marker and an empty store, with no guardian variable set.
      assert.deepEqual(initialiseVaultStoreAtBoot({ ...production, ANTARA_VAULT_STORE_INIT: '1' }), { outcome: 'initialised' });
      assert.ok(existsSync(join(disk, VAULT_STORE_MARKER))); assert.ok(existsSync(join(disk, VAULT_STORE_FILE)));
      // Later starts, with or without the flag, only read.
      assert.deepEqual(initialiseVaultStoreAtBoot(production), { outcome: 'ready' });
      assert.deepEqual(initialiseVaultStoreAtBoot({ ...production, ANTARA_VAULT_STORE_INIT: '1' }), { outcome: 'ready' });
      // A lost document is reported, and a leftover flag does not re-initialise it.
      rmSync(join(disk, VAULT_STORE_FILE));
      for (const env of [production, { ...production, ANTARA_VAULT_STORE_INIT: '1' }]) {
        const lost = initialiseVaultStoreAtBoot(env);
        assert.equal(lost.outcome, 'refused'); assert.match(lost.reason!, /data file is missing/);
      }
      assert.equal(existsSync(join(disk, VAULT_STORE_FILE)), false);
      const noDisk = initialiseVaultStoreAtBoot({ NODE_ENV: 'production' });
      assert.equal(noDisk.outcome, 'refused'); assert.match(noDisk.reason!, /DATA_DIR/);
    } finally { rmSync(disk, { recursive: true, force: true }); }
  });

  it('requires an explicit DATA_DIR in production', () => {
    assert.throws(() => vaultStorePath({ NODE_ENV: 'production' }), (error: unknown) => error instanceof VaultStoreError && error.code === 'configuration');
    assert.equal(vaultStorePath({ NODE_ENV: 'production', DATA_DIR: join(tmpdir(), 'disk') }), join(tmpdir(), 'disk', VAULT_STORE_FILE));
    assert.match(vaultStorePath({}), /paired-vaults-solana\.json$/);
  });
});
