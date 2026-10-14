/**
 * ANTARA paired Solana vault primitives, shared by the client and the API server.
 *
 * A paired vault is a Squads v4 multisig with exactly two members:
 *   U = the user's Privy embedded Solana wallet, permissions Initiate|Vote|Execute (7)
 *   G = ANTARA's guardian (a Privy server wallet), permission Vote only (2)
 * threshold 2, time lock 0, no config authority, vault index 0.
 *
 * Everything here is pure: no RPC, no environment, no React, no Node-only API
 * except the global Buffer (polyfilled by both Vite builds). Callers pass raw
 * account snapshots they read themselves. Every decoder throws
 * PairedVaultDecodeError on anything it does not positively recognise, so a
 * caller that treats any exception as "deny" fails closed.
 *
 * The API server imports this file directly. It must only exchange base58
 * strings, bigint and Uint8Array with server code (never PublicKey objects),
 * because the server package has its own copy of @solana/web3.js.
 */
import bs58 from 'bs58';
import * as multisig from '@sqds/multisig';
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ACCOUNT_SIZE, AccountLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { SOLANA_NETWORK } from '../networks';

export class PairedVaultDecodeError extends Error {
  constructor(message: string) { super(message); this.name = 'PairedVaultDecodeError'; }
}
function fail(message: string): never { throw new PairedVaultDecodeError(message); }

export const SQUADS_PROGRAM_ID = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const SPL_TOKEN_PROGRAM_ID = TOKEN_PROGRAM_ID.toBase58();
/** Circle USDC on Solana mainnet, pinned in the shared network registry. */
export const SOLANA_USDC_MINT = SOLANA_NETWORK.funding.address;
export const SOLANA_USDC_DECIMALS = SOLANA_NETWORK.funding.decimals;
/** Anchor discriminator of Squads v4 `proposal_approve`. */
export const PROPOSAL_APPROVE_DISCRIMINATOR: readonly number[] = Object.freeze([144, 37, 164, 136, 188, 216, 42, 248]);
export const PAIRED_USER_PERMISSIONS = 7;
export const PAIRED_GUARDIAN_PERMISSIONS = 2;
export const PAIRED_THRESHOLD = 2;
export const PAIRED_VAULT_INDEX = 0;
/** Paired vaults execute as soon as both votes land: the time lock must be exactly 0. */
export const PAIRED_TIME_LOCK_SECONDS = 0;
export const PAIRED_POLICY_VERSION = 'antara-paired-solana-v1';
export const SOLANA_GENESIS_HASH = Object.freeze({
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
} as const);
const U64_MAX = (1n << 64n) - 1n;

export type PairedAsset = 'SOL' | 'USDC';
export type ProposalStatusKind = 'Draft' | 'Active' | 'Rejected' | 'Approved' | 'Executing' | 'Executed' | 'Cancelled';
/** A raw account as read from RPC: its address, owning program and data bytes. */
export interface RawSolanaAccount { address: string; owner: string; data: Uint8Array }
export interface PairedMultisigState {
  address: string;
  createKey: string;
  /** U: the member with Initiate|Vote|Execute. */
  user: string;
  /** G: the Vote-only guardian. */
  guardian: string;
  threshold: number;
  timeLockSeconds: number;
  transactionIndex: bigint;
  staleTransactionIndex: bigint;
  /** Vault PDA, index 0: the deposit address. */
  vault: string;
  rentCollector: string | null;
}
export interface PairedProposalState {
  address: string;
  transactionIndex: bigint;
  status: ProposalStatusKind;
  approved: string[];
  rejected: string[];
  cancelled: string[];
}
export interface ReleaseIntent {
  asset: PairedAsset;
  amountRaw: bigint;
  /** The wallet that ends up owning the funds. */
  recipient: string;
  /** The account credited: the recipient itself for SOL, its canonical USDC ATA for USDC. */
  destination: string;
  transactionIndex: bigint;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Parses a canonical base58 32-byte address. */
function key(value: unknown, label: string): PublicKey {
  if (typeof value !== 'string' || !BASE58.test(value)) fail(`${label} is not a Solana address.`);
  let parsed: PublicKey;
  try { parsed = new PublicKey(value); } catch { fail(`${label} is not a Solana address.`); }
  if (parsed.toBase58() !== value) fail(`${label} is not a canonical Solana address.`);
  return parsed;
}
export function isSolanaAddress(value: unknown): value is string {
  try { key(value, 'Address'); return true; } catch { return false; }
}
/** True only for an address that can sign (on the ed25519 curve), never a PDA. */
export function isSolanaWalletAddress(value: unknown): value is string {
  try { return PublicKey.isOnCurve(key(value, 'Address').toBytes()); } catch { return false; }
}
function walletKey(value: unknown, label: string): PublicKey {
  const parsed = key(value, label);
  if (!PublicKey.isOnCurve(parsed.toBytes())) fail(`${label} must be a signing wallet, not a program address.`);
  return parsed;
}
function bigintOf(value: unknown): bigint {
  try { return BigInt(String(value)); } catch { return fail('Account contains an invalid integer.'); }
}
function sameBytes(data: Uint8Array, prefix: readonly number[]) {
  return data.length >= prefix.length && prefix.every((byte, index) => data[index] === byte);
}
function buffer(data: Uint8Array) {
  if (!(data instanceof Uint8Array)) fail('Account data is missing.');
  return Buffer.from(data);
}
function ownedBySquads(account: RawSolanaAccount | null | undefined, label: string): RawSolanaAccount {
  if (!account) fail(`${label} was not found on-chain.`);
  if (account.owner !== SQUADS_PROGRAM_ID) fail(`${label} is not owned by the Squads v4 program.`);
  return account;
}

/** A positive Squads transaction index, accepted only as a canonical decimal string or bigint. */
export function parseTransactionIndex(value: unknown): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) parsed = BigInt(value);
  else return fail('The proposal index must be a positive whole number.');
  if (parsed <= 0n || parsed > U64_MAX) fail('The proposal index is out of range.');
  return parsed;
}

/** Derived addresses of a paired vault and one of its proposals. */
export function pairedVaultAddresses(multisigAddress: string, transactionIndex?: bigint) {
  const multisigPda = key(multisigAddress, 'Multisig');
  const vault = multisig.getVaultPda({ multisigPda, index: PAIRED_VAULT_INDEX })[0].toBase58();
  if (transactionIndex === undefined) return { vault, proposal: null, transaction: null };
  const index = parseTransactionIndex(transactionIndex);
  return {
    vault,
    proposal: multisig.getProposalPda({ multisigPda, transactionIndex: index })[0].toBase58(),
    transaction: multisig.getTransactionPda({ multisigPda, index })[0].toBase58(),
  };
}

/** RPC `getProgramAccounts` filters that find spending limits attached to `multisigAddress`. */
export function spendingLimitFilters(multisigAddress: string) {
  key(multisigAddress, 'Multisig');
  return [
    { memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(multisig.accounts.spendingLimitDiscriminator)) } },
    { memcmp: { offset: 8, bytes: multisigAddress } },
  ];
}

/** Member list for `multisigCreateV2` of a new paired vault. */
export function pairedMultisigMembers(user: string, guardian: string) {
  const u = walletKey(user, 'Your wallet'), g = walletKey(guardian, 'The ANTARA guardian');
  if (u.equals(g)) fail('Your wallet and the guardian must be different.');
  const { Permission, Permissions } = multisig.types;
  return [
    { key: u, permissions: Permissions.fromPermissions([Permission.Initiate, Permission.Vote, Permission.Execute]) },
    { key: g, permissions: Permissions.fromPermissions([Permission.Vote]) },
  ];
}

export interface PairedMultisigExpectation {
  /** The pinned guardian address. */
  guardian: string;
  /** When known, the user wallet that must be U. */
  user?: string;
  /** Number of Squads spending-limit accounts for this multisig, read by the caller over RPC. */
  spendingLimitCount: number | null | undefined;
}

/** Verifies that `account` is exactly an ANTARA paired vault with the pinned guardian. */
export function decodePairedMultisig(account: RawSolanaAccount | null | undefined, expected: PairedMultisigExpectation): PairedMultisigState {
  const raw = ownedBySquads(account, 'The vault');
  const address = key(raw.address, 'Multisig');
  const guardian = walletKey(expected.guardian, 'The ANTARA guardian');
  if (!sameBytes(raw.data, multisig.accounts.multisigDiscriminator)) fail('This account is not a Squads multisig.');
  let state: multisig.accounts.Multisig;
  try { [state] = multisig.accounts.Multisig.deserialize(buffer(raw.data)); } catch { fail('The Squads multisig account could not be decoded.'); }
  if (!multisig.getMultisigPda({ createKey: state.createKey })[0].equals(address)) fail('Invalid multisig account derivation.');
  if (!state.configAuthority.equals(PublicKey.default)) fail('This vault has a configuration authority. Paired vaults must be autonomous.');
  if (state.threshold !== PAIRED_THRESHOLD) fail('Paired vaults require exactly two approvals.');
  // Owner decision: paired vaults have no time lock. Neither the client nor the guardian
  // handles a delayed execution, so a vault with one is refused instead of half-supported.
  if (state.timeLock !== PAIRED_TIME_LOCK_SECONDS) fail('Paired vaults must have no time lock.');
  if (state.members.length !== 2) fail('Paired vaults have exactly two members: your wallet and the ANTARA guardian.');
  const guardianMembers = state.members.filter(member => member.key.equals(guardian));
  if (guardianMembers.length !== 1) fail('The ANTARA guardian is not a member of this vault.');
  if (guardianMembers[0].permissions.mask !== PAIRED_GUARDIAN_PERMISSIONS) fail('The guardian must have vote permission only.');
  const userMember = state.members.find(member => !member.key.equals(guardian))!;
  if (userMember.permissions.mask !== PAIRED_USER_PERMISSIONS) fail('Your wallet must have initiate, vote and execute permission.');
  const user = walletKey(userMember.key.toBase58(), 'The vault owner');
  if (expected.user !== undefined && !user.equals(key(expected.user, 'Your wallet'))) fail('This vault belongs to a different wallet.');
  const rentCollector = state.rentCollector ? new PublicKey(state.rentCollector) : null;
  if (rentCollector && !rentCollector.equals(user)) fail('The vault rent collector must be your wallet.');
  const spendingLimits = expected.spendingLimitCount;
  if (typeof spendingLimits !== 'number' || !Number.isInteger(spendingLimits) || spendingLimits < 0) fail('The spending-limit check did not complete.');
  if (spendingLimits !== 0) fail('This vault has spending limits, which bypass the two-signature rule.');
  const transactionIndex = bigintOf(state.transactionIndex), staleTransactionIndex = bigintOf(state.staleTransactionIndex);
  if (transactionIndex < 0n || staleTransactionIndex < 0n || staleTransactionIndex > transactionIndex || transactionIndex > U64_MAX) fail('The vault indexes are inconsistent.');
  return {
    address: address.toBase58(), createKey: state.createKey.toBase58(), user: user.toBase58(), guardian: guardian.toBase58(),
    threshold: state.threshold, timeLockSeconds: state.timeLock, transactionIndex, staleTransactionIndex,
    vault: multisig.getVaultPda({ multisigPda: address, index: PAIRED_VAULT_INDEX })[0].toBase58(),
    rentCollector: rentCollector?.toBase58() ?? null,
  };
}

export type SquadsTransactionKind = 'vault' | 'config' | 'batch' | 'unknown';
export function squadsTransactionKind(account: RawSolanaAccount | null | undefined): SquadsTransactionKind {
  if (!account || account.owner !== SQUADS_PROGRAM_ID || !(account.data instanceof Uint8Array)) return 'unknown';
  if (sameBytes(account.data, multisig.accounts.vaultTransactionDiscriminator)) return 'vault';
  if (sameBytes(account.data, multisig.accounts.configTransactionDiscriminator)) return 'config';
  if (sameBytes(account.data, multisig.accounts.batchDiscriminator)) return 'batch';
  return 'unknown';
}

const STATUSES: readonly ProposalStatusKind[] = ['Draft', 'Active', 'Rejected', 'Approved', 'Executing', 'Executed', 'Cancelled'];
export function decodePairedProposal(account: RawSolanaAccount | null | undefined, vault: PairedMultisigState, transactionIndex: bigint): PairedProposalState {
  const raw = ownedBySquads(account, 'The proposal');
  const index = parseTransactionIndex(transactionIndex);
  const expected = pairedVaultAddresses(vault.address, index);
  if (raw.address !== expected.proposal) fail('The proposal address does not match this vault and index.');
  if (!sameBytes(raw.data, multisig.accounts.proposalDiscriminator)) fail('This account is not a Squads proposal.');
  let proposal: multisig.accounts.Proposal;
  try { [proposal] = multisig.accounts.Proposal.deserialize(buffer(raw.data)); } catch { fail('The proposal could not be decoded.'); }
  if (proposal.multisig.toBase58() !== vault.address || bigintOf(proposal.transactionIndex) !== index) fail('The proposal belongs to a different vault or index.');
  const status = proposal.status.__kind as ProposalStatusKind;
  if (!STATUSES.includes(status)) fail('The proposal status is not recognised.');
  return {
    address: raw.address, transactionIndex: index, status,
    approved: proposal.approved.map(member => member.toBase58()),
    rejected: proposal.rejected.map(member => member.toBase58()),
    cancelled: proposal.cancelled.map(member => member.toBase58()),
  };
}

export interface ReleaseDecodeOptions {
  /**
   * Wallets a USDC release may pay. A USDC TransferChecked names only a token
   * account, so the recipient is the candidate whose canonical associated token
   * account it is; none matching is a foreign or non-canonical destination.
   */
  recipientCandidates?: readonly string[];
}

/**
 * Decodes the stored vault transaction of a paired vault into the single
 * supported release: a System transfer of SOL from the vault, or an SPL Token
 * TransferChecked of canonical USDC from the vault's ATA to the recipient's
 * canonical ATA. Anything else, including configuration transactions, throws.
 */
export function decodeReleaseIntent(account: RawSolanaAccount | null | undefined, vault: PairedMultisigState, transactionIndex: bigint, options: ReleaseDecodeOptions = {}): ReleaseIntent {
  const raw = ownedBySquads(account, 'The vault transaction');
  const index = parseTransactionIndex(transactionIndex);
  const kind = squadsTransactionKind(raw);
  if (kind === 'config') fail('Configuration changes are never approved by the ANTARA guardian.');
  if (kind !== 'vault') fail('Only single vault transactions can be approved by the ANTARA guardian.');
  const expected = pairedVaultAddresses(vault.address, index);
  if (raw.address !== expected.transaction) fail('The transaction address does not match this vault and index.');
  let tx: multisig.accounts.VaultTransaction;
  try { [tx] = multisig.accounts.VaultTransaction.deserialize(buffer(raw.data)); } catch { fail('The vault transaction could not be decoded.'); }
  if (tx.multisig.toBase58() !== vault.address || bigintOf(tx.index) !== index) fail('The transaction belongs to a different vault or index.');
  if (tx.vaultIndex !== PAIRED_VAULT_INDEX) fail('Releases must come from the vault deposit address (index 0).');
  if (tx.ephemeralSignerBumps.length !== 0) fail('Releases cannot use ephemeral signers.');
  const message = tx.message;
  if (message.addressTableLookups.length !== 0) fail('Releases cannot use address lookup tables.');
  if (message.instructions.length !== 1) fail('A release must contain exactly one transfer instruction.');
  const keys = message.accountKeys.map(account => account.toBase58());
  if (new Set(keys).size !== keys.length) fail('The release message repeats an account.');
  // The vault PDA must be the only signer; nothing else can be authorised by Squads.
  if (message.numSigners !== 1 || message.numWritableSigners !== 1 || keys[0] !== vault.vault) fail('The vault must be the only signer of a release.');
  if (message.numWritableNonSigners > keys.length - 1) fail('The release message header is invalid.');
  const writable = (i: number) => multisig.utils.isStaticWritableIndex(message, i);
  const signer = (i: number) => multisig.utils.isSignerIndex(message, i);
  const instruction = message.instructions[0];
  const accountIndexes = [...instruction.accountIndexes];
  const data = Uint8Array.from(instruction.data);
  if (instruction.programIdIndex >= keys.length || accountIndexes.some(i => i >= keys.length)) fail('The release instruction references a missing account.');
  if (signer(instruction.programIdIndex) || writable(instruction.programIdIndex)) fail('The release program account has invalid flags.');
  const program = keys[instruction.programIdIndex];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const used = (expectedKeys: string[]) => {
    if (keys.length !== expectedKeys.length || !expectedKeys.every(value => keys.includes(value))) fail('The release message contains unexpected accounts.');
  };

  if (program === SYSTEM_PROGRAM_ID) {
    if (data.length !== 12 || view.getUint32(0, true) !== 2 || accountIndexes.length !== 2) fail('Only a plain SOL transfer can be released.');
    const [from, to] = accountIndexes;
    if (keys[from] !== vault.vault || from !== 0) fail('SOL must be released from the vault deposit address.');
    if (signer(to) || !writable(to)) fail('The SOL recipient account has invalid flags.');
    const recipient = walletKey(keys[to], 'The recipient').toBase58();
    if (recipient === vault.vault || recipient === vault.address) fail('The recipient must be outside this vault.');
    if (recipient === vault.guardian) fail('Vault releases cannot pay the ANTARA guardian.');
    used([vault.vault, recipient, SYSTEM_PROGRAM_ID]);
    const amountRaw = view.getBigUint64(4, true);
    if (amountRaw <= 0n) fail('The release amount must be greater than zero.');
    return { asset: 'SOL', amountRaw, recipient, destination: recipient, transactionIndex: index };
  }

  if (program === SPL_TOKEN_PROGRAM_ID) {
    if (data.length !== 10 || data[0] !== 12 || accountIndexes.length !== 4) fail('Only a USDC TransferChecked can be released.');
    if (data[9] !== SOLANA_USDC_DECIMALS) fail('The USDC transfer uses the wrong decimals.');
    const [sourceIndex, mintIndex, destinationIndex, authorityIndex] = accountIndexes;
    const mint = new PublicKey(SOLANA_USDC_MINT), vaultKey = new PublicKey(vault.vault);
    const source = getAssociatedTokenAddressSync(mint, vaultKey, true).toBase58();
    if (keys[mintIndex] !== SOLANA_USDC_MINT) fail('Only canonical USDC can be released.');
    if (keys[sourceIndex] !== source) fail('USDC must be released from the vault’s canonical token account.');
    if (keys[authorityIndex] !== vault.vault || authorityIndex !== 0) fail('The vault must authorise the USDC transfer.');
    if (signer(sourceIndex) || !writable(sourceIndex) || signer(destinationIndex) || !writable(destinationIndex) || signer(mintIndex) || writable(mintIndex)) fail('The USDC transfer accounts have invalid flags.');
    const destination = keys[destinationIndex];
    if (destination === source) fail('The recipient must be outside this vault.');
    const candidates = [...new Set(options.recipientCandidates ?? [])].filter(isSolanaWalletAddress);
    const matches = candidates.filter(candidate => getAssociatedTokenAddressSync(mint, new PublicKey(candidate), false).toBase58() === destination);
    if (matches.length !== 1) fail('The USDC destination is not the canonical USDC account of one of your linked wallets.');
    const recipient = matches[0];
    if (recipient === vault.vault || recipient === vault.address) fail('The recipient must be outside this vault.');
    if (recipient === vault.guardian) fail('Vault releases cannot pay the ANTARA guardian.');
    used([vault.vault, source, destination, SOLANA_USDC_MINT, SPL_TOKEN_PROGRAM_ID]);
    const amountRaw = view.getBigUint64(1, true);
    if (amountRaw <= 0n) fail('The release amount must be greater than zero.');
    return { asset: 'USDC', amountRaw, recipient, destination, transactionIndex: index };
  }
  return fail('Unsupported release instruction. Only SOL and USDC transfers to your own wallet can be approved.');
}

/**
 * Best-effort peek at the token account a stored vault transaction would credit,
 * so an RPC reader knows which account to fetch. Never validates and never
 * throws; the full decode decides.
 */
export function releaseTokenDestination(account: RawSolanaAccount | null | undefined): string | null {
  try {
    if (squadsTransactionKind(account) !== 'vault') return null;
    const [tx] = multisig.accounts.VaultTransaction.deserialize(buffer(account!.data));
    const [instruction] = tx.message.instructions;
    if (tx.message.instructions.length !== 1 || !instruction) return null;
    const program = tx.message.accountKeys[instruction.programIdIndex]?.toBase58();
    const destination = tx.message.accountKeys[instruction.accountIndexes[2]];
    return program === SPL_TOKEN_PROGRAM_ID && instruction.accountIndexes.length === 4 && destination ? destination.toBase58() : null;
  } catch { return null; }
}

/** Verifies the recipient's USDC token account is a plain, unencumbered account it owns. */
export function verifyUsdcDestinationAccount(account: RawSolanaAccount | null | undefined, intent: ReleaseIntent): void {
  if (intent.asset !== 'USDC') return;
  if (!account) fail('The recipient USDC account does not exist yet. Create it before requesting a release.');
  if (account.address !== intent.destination) fail('The recipient USDC account does not match the release.');
  if (account.owner !== SPL_TOKEN_PROGRAM_ID || !(account.data instanceof Uint8Array) || account.data.length !== ACCOUNT_SIZE) fail('The recipient USDC account is not a standard token account.');
  const state = AccountLayout.decode(buffer(account.data));
  if (state.mint.toBase58() !== SOLANA_USDC_MINT || state.owner.toBase58() !== intent.recipient) fail('The recipient USDC account is not owned by your wallet.');
  if (state.state !== 1) fail('The recipient USDC account is frozen or uninitialised.');
  if (state.delegateOption !== 0 || state.closeAuthorityOption !== 0 || state.isNativeOption !== 0) fail('The recipient USDC account has a delegate or custom close authority. Use an unencumbered account.');
}

export interface GuardianApproveRequest { multisig: string; transactionIndex: bigint; guardian: string }
function approveData() {
  // Anchor discriminator + Option<String> memo = None.
  return Uint8Array.from([...PROPOSAL_APPROVE_DISCRIMINATOR, 0]);
}

/**
 * Builds, server-side, the only transaction the guardian ever signs: one Squads
 * `proposal_approve` by member G for (multisig, index), fee payer G, no memo,
 * no compute-budget instruction and no lookup table. Returns unsigned bytes.
 */
export function buildGuardianApproveTransaction(request: GuardianApproveRequest & { recentBlockhash: string }): Uint8Array {
  const multisigPda = key(request.multisig, 'Multisig'), guardian = walletKey(request.guardian, 'The ANTARA guardian');
  const transactionIndex = parseTransactionIndex(request.transactionIndex);
  key(request.recentBlockhash, 'Recent blockhash');
  const instruction = multisig.instructions.proposalApprove({ multisigPda, transactionIndex, member: guardian });
  const message = new TransactionMessage({ payerKey: guardian, recentBlockhash: request.recentBlockhash, instructions: [instruction] }).compileToV0Message();
  return new VersionedTransaction(message).serialize();
}

/** Refuses any transaction other than the exact guardian approval for this request. */
export function assertGuardianApproveTransaction(bytes: Uint8Array, request: GuardianApproveRequest): void {
  const multisigPda = key(request.multisig, 'Multisig').toBase58(), guardian = walletKey(request.guardian, 'The ANTARA guardian').toBase58();
  const index = parseTransactionIndex(request.transactionIndex);
  const proposal = pairedVaultAddresses(multisigPda, index).proposal!;
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(bytes); } catch { fail('The guardian transaction could not be decoded.'); }
  const message = tx.message;
  if (message.version !== 0) fail('The guardian signs only version 0 messages.');
  if (message.addressTableLookups.length !== 0) fail('The guardian never signs with lookup tables.');
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = message.header;
  if (numRequiredSignatures !== 1 || numReadonlySignedAccounts !== 0 || numReadonlyUnsignedAccounts !== 2) fail('The guardian must be the only signer and fee payer.');
  const keys = message.staticAccountKeys.map(account => account.toBase58());
  if (keys.length !== 4 || keys[0] !== guardian || keys[1] !== proposal || !keys.slice(2).includes(multisigPda) || !keys.slice(2).includes(SQUADS_PROGRAM_ID)) fail('The guardian transaction contains unexpected accounts.');
  if (tx.signatures.length !== 1 || tx.signatures[0].some(byte => byte !== 0)) fail('The guardian transaction must be unsigned.');
  if (message.compiledInstructions.length !== 1) fail('The guardian signs exactly one instruction.');
  const [instruction] = message.compiledInstructions;
  if (keys[instruction.programIdIndex] !== SQUADS_PROGRAM_ID) fail('The guardian signs only Squads instructions.');
  const accounts = instruction.accountKeyIndexes.map(i => keys[i]);
  if (accounts.length !== 3 || accounts[0] !== multisigPda || accounts[1] !== guardian || accounts[2] !== proposal) fail('The guardian vote targets the wrong vault, member or proposal.');
  const expected = approveData();
  if (instruction.data.length !== expected.length || !expected.every((byte, i) => instruction.data[i] === byte)) fail('The guardian signs only proposal_approve without a memo.');
}
