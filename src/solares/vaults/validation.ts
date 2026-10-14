export interface VaultPolicyInput { owners: string[]; threshold: number; userAddress: string; chain: 'solana' | 'evm'; timeLockSeconds?: number }
/**
 * Independent-owner Squads vaults: owner decision 2026-10-13 removed the mandatory on-chain delay, so a time lock of
 * 0 (the default for new vaults) is accepted. An owner may still choose one, up to Squads' 90-day maximum.
 */
export const DEFAULT_SQUADS_TIME_LOCK_SECONDS = 0;
export const MAX_SQUADS_TIME_LOCK_SECONDS = 7_776_000;
export function validateVaultPolicy(input: VaultPolicyInput) {
  const normalize = (value: string) => input.chain === 'evm' ? value.toLowerCase() : value;
  const owners = input.owners.map(value => value.trim());
  if (owners.length < 2 || owners.length > 10) throw new Error('Choose between 2 and 10 independent owners.');
  if (owners.some(value => !value)) throw new Error('Every owner needs a wallet address.');
  if (new Set(owners.map(normalize)).size !== owners.length) throw new Error('Owners must be distinct addresses.');
  if (!owners.map(normalize).includes(normalize(input.userAddress))) throw new Error('The connected wallet must be an owner.');
  if (!Number.isInteger(input.threshold) || input.threshold < 2 || input.threshold > owners.length) throw new Error('The approval threshold must be at least 2 and no greater than the owner count.');
  if (input.chain === 'solana' && (!Number.isInteger(input.timeLockSeconds) || input.timeLockSeconds! < 0 || input.timeLockSeconds! > MAX_SQUADS_TIME_LOCK_SECONDS)) {
    throw new Error('A Solana vault time lock must be a whole number of seconds from 0 (none) to 90 days.');
  }
  return { ...input, owners };
}

/** Squads permission masks of a paired Solana vault: U = Initiate|Vote|Execute, G = Vote only. */
export const PAIRED_PERMISSIONS = Object.freeze({ user: 7, guardian: 2 });
export interface PairedVaultPolicyInput {
  members: Array<{ address: string; permissions: number }>;
  threshold: number;
  timeLockSeconds: number;
  configAuthority: string | null;
  userAddress: string;
  guardian: string;
  /** The guardian pinned in this build (VITE_ANTARA_GUARDIAN_SOLANA). */
  pinnedGuardian: string;
}
/**
 * Paired Solana vaults ({U:7, G:2}, threshold 2, time lock 0, no config authority) have their
 * own validator. validateVaultPolicy is never relaxed for them: independent-owner
 * vaults keep full-permission owners and at least two approvals. Any guardian
 * other than the one pinned in this build is refused.
 */
export function validatePairedVault(input: PairedVaultPolicyInput) {
  const pinned = input.pinnedGuardian.trim();
  if (!pinned) throw new Error('This build has no pinned ANTARA guardian, so paired vaults are unavailable. Nothing was created or approved.');
  if (input.guardian !== pinned) throw new Error('The ANTARA guardian does not match the one pinned in this build. Nothing was created or approved.');
  if (!input.userAddress || input.userAddress === input.guardian) throw new Error('Your wallet and the ANTARA guardian must be different.');
  if (input.configAuthority !== null) throw new Error('Paired vaults must have no configuration authority.');
  if (input.threshold !== 2) throw new Error('Paired vaults require exactly two approvals: your wallet and the ANTARA guardian.');
  // Paired vaults have no time lock (owner decision); a delayed execution is not supported anywhere.
  if (input.timeLockSeconds !== 0) throw new Error('Paired vaults must have no time lock.');
  if (input.members.length !== 2) throw new Error('Paired vaults have exactly two members: your wallet and the ANTARA guardian.');
  const user = input.members.filter(member => member.address === input.userAddress);
  const guardian = input.members.filter(member => member.address === input.guardian);
  if (user.length !== 1 || guardian.length !== 1) throw new Error('Paired vault members must be exactly your wallet and the ANTARA guardian.');
  if (guardian[0].permissions !== PAIRED_PERMISSIONS.guardian) throw new Error('The ANTARA guardian must have vote permission only.');
  if (user[0].permissions !== PAIRED_PERMISSIONS.user) throw new Error('Your wallet must have initiate, vote and execute permission.');
  return input;
}

/** Never round financial inputs through floating point or silently truncate precision. */
export function parseAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) throw new Error('Enter a positive decimal amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`This asset supports at most ${decimals} decimal places.`);
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount <= 0n) throw new Error('The amount must be greater than zero.');
  return amount;
}

export function assertSameOwners(actual: string[], expected: string[], chain: 'solana' | 'evm') {
  const normalize = (items: string[]) => items.map(x => chain === 'evm' ? x.toLowerCase() : x).sort().join('|');
  if (normalize(actual) !== normalize(expected)) throw new Error('The deployed owner set does not match the reviewed vault configuration.');
}

export type ReviewedVaultPolicy = {
  address: string; depositAddress: string; owners: string[]; threshold: number; timeLockSeconds: number;
} & ({ kind: 'safe'; chainId: number; version: string } | { kind: 'squads'; cluster: string });

/** Re-verification must not silently substitute a different policy for the one displayed. */
export function assertReviewedVaultPolicy(current: ReviewedVaultPolicy, reviewed: ReviewedVaultPolicy) {
  const normalize = (value: string) => current.kind === 'safe' ? value.toLowerCase() : value;
  const sameNetwork = current.kind === reviewed.kind && (current.kind === 'safe'
    ? reviewed.kind === 'safe' && current.chainId === reviewed.chainId && current.version === reviewed.version
    : reviewed.kind === 'squads' && current.cluster === reviewed.cluster);
  if (!sameNetwork || normalize(current.address) !== normalize(reviewed.address) || normalize(current.depositAddress) !== normalize(reviewed.depositAddress) ||
      current.threshold !== reviewed.threshold || current.timeLockSeconds !== reviewed.timeLockSeconds ||
      current.owners.map(normalize).sort().join('|') !== reviewed.owners.map(normalize).sort().join('|')) {
    throw new Error('The vault configuration changed after review. Refresh verification and review its owners, threshold, and delay before continuing.');
  }
}
