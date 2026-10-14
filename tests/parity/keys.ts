/**
 * Fixed fixture keys for the parity harness (docs/UI_ARGUS_PARITY.md 10.2). Shared by the
 * Playwright config (Node), the route modules (Node) and the browser harness, so the
 * harness's Solana wallet, the pinned guardian and the mocked vault accounts agree.
 *
 * Each key is `Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey.toBase58()`.
 * They are written out as constants because the Playwright config loader cannot load
 * @solana/web3.js; tests/parity/setup.ts re-derives every one with node:crypto before
 * a run and stops the run on a mismatch. Seeds are fixed and public: these keys never
 * hold funds and never sign anything.
 *
 * `pairedKeys()` in src/solares/paired/testFixtures.ts is random on every call, so
 * routes/vault.ts (Area D) builds its PairedFixtureKeys from these instead:
 *   const createKey = new PublicKey(PARITY_KEYS.createKey);
 *   const multisigPda = multisig.getMultisigPda({ createKey })[0];
 *   keys = { user: PARITY_KEYS.user, guardian: PARITY_KEYS.guardian, createKey: PARITY_KEYS.createKey,
 *            multisig: multisigPda.toBase58(), vault: multisig.getVaultPda({ multisigPda, index: 0 })[0].toBase58() }
 */

/** Seed byte per role. */
export const PARITY_SEEDS = Object.freeze({ user: 1, recipient: 2, createKey: 3, guardian: 7 });

export const PARITY_KEYS = Object.freeze({
  /** Seed 1. The harness's signed-in Solana wallet (also the layers workflow's fixture wallet). */
  user: 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',
  /** Seed 2. An unrelated Solana address for recipients and recents. */
  recipient: '9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu',
  /** Seed 3. Squads create key of the fixture vault. */
  createKey: 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse',
  /** Seed 7. The guardian pinned into the parity build as VITE_ANTARA_GUARDIAN_SOLANA. */
  guardian: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB',
});

/** Same value the spec computes in the config: Keypair.fromSeed(fill(7)).publicKey.toBase58(). */
export const PARITY_GUARDIAN_SOLANA = PARITY_KEYS.guardian;

/** The harness's two EVM wallets, in signer order. Never funded; checksum-neutral digits. */
export const PARITY_EVM_WALLETS = Object.freeze([
  { address: '0x1111111111111111111111111111111111111111', name: 'Wallet one' },
  { address: '0x2222222222222222222222222222222222222222', name: 'Wallet two' },
]);

/** The harness's Privy user id. Per-user storage keys use it (for example `solares:transfers:<id>`). */
export const PARITY_USER_ID = 'parity-user';
