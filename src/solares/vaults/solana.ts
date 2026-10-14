import * as multisig from '@sqds/multisig';
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction, type AddressLookupTableAccount } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, getAccount, type Account } from '@solana/spl-token';
import { getBase58Decoder } from '@solana/kit';
import { SOLANA_RPC_URL, SOLANA_WS_URL, SOLANA_CLUSTER, USDC_SOLANA } from '../wallet/config';
import { DEFAULT_SQUADS_TIME_LOCK_SECONDS, PAIRED_PERMISSIONS, assertSameOwners, assertReviewedVaultPolicy, parseAmount, validatePairedVault, validateVaultPolicy } from './validation';
import { assertSolanaCluster } from '../wallet/solanaNetwork';
import { preserveVaultTransaction, settleSolanaVaultTransaction } from './transaction';
import { sendSimulatedVaultTransaction } from './preflight';
import { VaultAmountError, readSolanaRentMinimum, solDepositProblem, solRecipientProblem, solReleaseProblem, usdcDepositProblem } from './vaultAmounts';
import { PAIRED_GUARDIAN_SOLANA } from './pairedApi';
import {
  decodePairedMultisig, decodePairedProposal, decodeReleaseIntent, pairedMultisigMembers, pairedVaultAddresses, parseTransactionIndex, spendingLimitFilters,
  type PairedMultisigState, type ProposalStatusKind, type RawSolanaAccount,
} from '../paired/solanaDecode';

export const SQUADS_PROGRAM = new PublicKey('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
export interface SolanaVault { kind: 'squads'; address: string; depositAddress: string; cluster: string; owners: string[]; threshold: number; timeLockSeconds: number; observedAt: string; nativeBalance: string; usdcBalance: string | null }
export interface SolanaProposal { index: string; status: string; approvals: string[]; threshold: number; executableAt: number | null; recipient: string; amount: string; asset: 'SOL' | 'USDC'; raw: string; stale: boolean }
export interface SolanaSigner { address: string; send: (bytes: Uint8Array) => Promise<string> }
export function solanaConnection() { return new Connection(SOLANA_RPC_URL, { commitment: 'confirmed', wsEndpoint: SOLANA_WS_URL }); }
export function assertCanonicalUsdcDestination(address: PublicKey, destination: Pick<Account, 'mint' | 'owner' | 'delegate' | 'delegatedAmount' | 'closeAuthority'>) {
  const mint = new PublicKey(USDC_SOLANA);
  if (!destination.mint.equals(mint) || !address.equals(getAssociatedTokenAddressSync(mint, destination.owner, true))) throw new Error('Withdrawals must use the recipient’s canonical USDC associated token account.');
  if (destination.delegate || destination.delegatedAmount !== 0n || destination.closeAuthority) throw new Error('The recipient token account has delegated or custom close authority. Use an unencumbered associated token account.');
}
function publicSigner(address: string) {
  const key = new PublicKey(address);
  if (!PublicKey.isOnCurve(key)) throw new Error('Owners must be independently controlled signing wallets, not program addresses.');
  return key;
}
/** A release must leave the vault: reject its own multisig and deposit addresses, as the Safe path does. */
export function assertReleaseRecipient(recipient: string, vault: Pick<SolanaVault, 'address' | 'depositAddress'>) {
  const key = new PublicKey(recipient);
  if (key.equals(new PublicKey(vault.depositAddress)) || key.equals(new PublicKey(vault.address))) throw new Error('The recipient must be outside this vault.');
}
async function sendInstructions(signer: SolanaSigner, instructions: TransactionInstruction[], additionalSigners: Keypair[] = [], lookupTables: AddressLookupTableAccount[] = []) {
  const connection = solanaConnection();
  await assertSolanaCluster(connection, SOLANA_CLUSTER);
  const lifetime = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({ payerKey: publicSigner(signer.address), recentBlockhash: lifetime.blockhash, instructions }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(message);
  if (additionalSigners.length) tx.sign(additionalSigners);
  // Confirmed by HTTP polling (wallet/solanaConfirm.ts), never websockets; the signature survives every outcome.
  return settleSolanaVaultTransaction(connection, lifetime, () => sendSimulatedVaultTransaction(connection, tx, signer.send));
}

export async function verifySolanaVault(address: string, userAddress: string): Promise<SolanaVault> {
  const connection = solanaConnection();
  await assertSolanaCluster(connection, SOLANA_CLUSTER);
  const key = new PublicKey(address);
  const account = await connection.getAccountInfo(key, 'confirmed');
  if (!account || !account.owner.equals(SQUADS_PROGRAM)) throw new Error('This address is not a deployed Squads v4 multisig on the selected cluster.');
  const [state] = multisig.accounts.Multisig.fromAccountInfo(account);
  if (!multisig.getMultisigPda({ createKey: state.createKey })[0].equals(key)) throw new Error('Invalid multisig account derivation.');
  if (!state.configAuthority.equals(PublicKey.default)) throw new Error('This vault has an administrator that can override multisig configuration.');
  const owners = state.members.map(member => member.key.toBase58());
  validateVaultPolicy({ owners, userAddress, chain: 'solana', threshold: state.threshold, timeLockSeconds: state.timeLock });
  for (const member of state.members) {
    publicSigner(member.key.toBase58());
    if (![multisig.types.Permission.Initiate, multisig.types.Permission.Vote, multisig.types.Permission.Execute].every(permission => multisig.types.Permissions.has(member.permissions, permission))) throw new Error('ANTARA requires every owner to have initiate, vote, and execute permission so the displayed owners can complete the withdrawal flow.');
  }
  // Spending limits can bypass per-transaction quorum. Reject such vaults in this conservative release.
  const delegated = await connection.getProgramAccounts(SQUADS_PROGRAM, { filters: [
    { memcmp: { offset: 0, bytes: getBase58Decoder().decode(new Uint8Array(multisig.accounts.spendingLimitDiscriminator)) } },
    { memcmp: { offset: 8, bytes: key.toBase58() } },
  ], dataSlice: { offset: 0, length: 8 } });
  if (delegated.length) throw new Error('This vault has delegated spending limits. Remove them before attaching it as a quorum-only ANTARA vault.');
  const deposit = multisig.getVaultPda({ multisigPda: key, index: 0 })[0];
  const native = await connection.getBalance(deposit, 'confirmed');
  if (!Number.isSafeInteger(native)) throw new Error('RPC returned an imprecise SOL balance.');
  let usdcBalance: string | null = null;
  if (SOLANA_CLUSTER !== 'devnet') {
    const tokenAddress = getAssociatedTokenAddressSync(new PublicKey(USDC_SOLANA), deposit, true);
    const token = await connection.getAccountInfo(tokenAddress);
    usdcBalance = token ? (await connection.getTokenAccountBalance(tokenAddress)).value.amount : '0';
  }
  return { kind: 'squads', address: key.toBase58(), depositAddress: deposit.toBase58(), cluster: SOLANA_CLUSTER, owners, threshold: state.threshold, timeLockSeconds: state.timeLock, observedAt: new Date().toISOString(), nativeBalance: native.toString(), usdcBalance };
}

export async function createSolanaVault(signer: SolanaSigner, ownerAddresses: string[], threshold: number, timeLockSeconds: number = DEFAULT_SQUADS_TIME_LOCK_SECONDS) {
  const policy = validateVaultPolicy({ owners: ownerAddresses, threshold, timeLockSeconds, userAddress: signer.address, chain: 'solana' });
  const creator = publicSigner(signer.address);
  const members = policy.owners.map(address => ({ key: publicSigner(address), permissions: multisig.types.Permissions.all() }));
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const config = await multisig.accounts.ProgramConfig.fromAccountAddress(solanaConnection(), multisig.getProgramConfigPda({})[0]);
  const signature = await sendInstructions(signer, [multisig.instructions.multisigCreateV2({ treasury: config.treasury, creator, multisigPda, configAuthority: null, threshold, members, timeLock: timeLockSeconds, createKey: createKey.publicKey, rentCollector: creator, memo: 'ANTARA / Aegis vault' })], [createKey]);
  return preserveVaultTransaction(signature, async () => {
    const vault = await verifySolanaVault(multisigPda.toBase58(), signer.address);
    assertSameOwners(vault.owners, policy.owners, 'solana');
    if (vault.threshold !== threshold || vault.timeLockSeconds !== timeLockSeconds) throw new Error('Deployed vault configuration differs from your request.');
    return { vault, signature };
  }, true);
}

export async function depositSolanaVault(signer: SolanaSigner, reviewedVault: SolanaVault, asset: 'SOL' | 'USDC', amount: string) {
  const vault = await verifySolanaVault(reviewedVault.address, signer.address);
  assertReviewedVaultPolicy(vault, reviewedVault);
  const from = publicSigner(signer.address), raw = parseAmount(amount, asset === 'SOL' ? 9 : 6);
  await assertDepositFits(solanaConnection(), from, BigInt(vault.nativeBalance), asset, raw);
  return sendInstructions(signer, depositInstructions(from, new PublicKey(vault.depositAddress), asset, raw));
}
/** Solana's rent-exempt minimum for the vault's deposit address, read live (lamports). */
export const vaultRentMinimum = (): Promise<bigint> => readSolanaRentMinimum(solanaConnection());
/**
 * Refuses, before anything is built or signed, a deposit Solana would reject: a SOL deposit that leaves the
 * vault's deposit address below the live rent-exempt minimum, or USDC this wallet does not hold.
 */
export async function assertDepositFits(connection: Pick<Connection, 'getMinimumBalanceForRentExemption' | 'getAccountInfo' | 'getTokenAccountBalance'>, from: PublicKey, vaultLamports: bigint, asset: 'SOL' | 'USDC', raw: bigint) {
  if (asset === 'SOL') {
    const problem = solDepositProblem(vaultLamports, raw, await readSolanaRentMinimum(connection));
    if (problem) throw new VaultAmountError(problem);
    return;
  }
  if (SOLANA_CLUSTER === 'devnet') throw new Error('USDC transfers are available on mainnet only. Use SOL on devnet.');
  const source = getAssociatedTokenAddressSync(new PublicKey(USDC_SOLANA), from);
  const account = await connection.getAccountInfo(source, 'confirmed');
  const held = account && account.owner.equals(TOKEN_PROGRAM_ID) ? BigInt((await connection.getTokenAccountBalance(source, 'confirmed')).value.amount) : null;
  const problem = usdcDepositProblem(held, raw);
  if (problem) throw new VaultAmountError(problem);
}
/** Refuses a SOL release that would leave the vault, or credit an empty recipient, below Solana's live minimum. */
export async function assertSolReleaseFits(connection: Pick<Connection, 'getMinimumBalanceForRentExemption' | 'getBalance'>, vaultLamports: bigint, raw: bigint, recipient: PublicKey) {
  const [minimum, recipientLamports] = await Promise.all([readSolanaRentMinimum(connection), connection.getBalance(recipient, 'confirmed')]);
  if (!Number.isSafeInteger(recipientLamports)) throw new Error('RPC returned an imprecise SOL balance.');
  const problem = solReleaseProblem(vaultLamports, raw, minimum) ?? solRecipientProblem(BigInt(recipientLamports), raw, minimum);
  if (problem) throw new VaultAmountError(problem);
}
/** SOL transfer, or the vault's canonical USDC account (created if needed) plus a TransferChecked into it. */
function depositInstructions(from: PublicKey, to: PublicKey, asset: 'SOL' | 'USDC', raw: bigint): TransactionInstruction[] {
  if (asset === 'SOL') return [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: raw })];
  if (SOLANA_CLUSTER === 'devnet') throw new Error('USDC transfers are available on mainnet only. Use SOL on devnet.');
  const mint = new PublicKey(USDC_SOLANA), destination = getAssociatedTokenAddressSync(mint, to, true);
  return [createAssociatedTokenAccountIdempotentInstruction(from, destination, to, mint), createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, from), mint, destination, from, raw, 6)];
}

export async function proposeSolanaRelease(signer: SolanaSigner, reviewedVault: SolanaVault, recipient: string, asset: 'SOL' | 'USDC', amount: string) {
  const verified = await verifySolanaVault(reviewedVault.address, signer.address);
  assertReviewedVaultPolicy(verified, reviewedVault);
  assertReleaseRecipient(recipient, verified);
  const connection = solanaConnection(), key = new PublicKey(reviewedVault.address), creator = publicSigner(signer.address), destinationOwner = publicSigner(recipient);
  const vault = new PublicKey(verified.depositAddress);
  const raw = parseAmount(amount, asset === 'SOL' ? 9 : 6);
  if (raw > BigInt(asset === 'SOL' ? verified.nativeBalance : verified.usdcBalance || '0')) throw new Error('The vault has insufficient balance.');
  if (asset === 'SOL') await assertSolReleaseFits(connection, BigInt(verified.nativeBalance), raw, destinationOwner);
  const before: TransactionInstruction[] = [];
  let transfer: TransactionInstruction;
  if (asset === 'SOL') transfer = SystemProgram.transfer({ fromPubkey: vault, toPubkey: destinationOwner, lamports: raw });
  else {
    if (SOLANA_CLUSTER === 'devnet') throw new Error('USDC releases are available on mainnet only.');
    const mint = new PublicKey(USDC_SOLANA), destination = getAssociatedTokenAddressSync(mint, destinationOwner);
    before.push(createAssociatedTokenAccountIdempotentInstruction(creator, destination, destinationOwner, mint));
    transfer = createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, vault, true), mint, destination, vault, raw, 6);
  }
  const state = await multisig.accounts.Multisig.fromAccountAddress(connection, key);
  const index = BigInt(state.transactionIndex.toString()) + 1n;
  const message = new TransactionMessage({ payerKey: vault, recentBlockhash: (await connection.getLatestBlockhash()).blockhash, instructions: [transfer] });
  const signature = await sendInstructions(signer, [...before,
    multisig.instructions.vaultTransactionCreate({ multisigPda: key, transactionIndex: index, creator, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message, memo: 'ANTARA / bounded release' }),
    multisig.instructions.proposalCreate({ multisigPda: key, transactionIndex: index, creator, isDraft: false }),
    multisig.instructions.proposalApprove({ multisigPda: key, transactionIndex: index, member: creator }),
  ]);
  return { index: index.toString(), signature };
}

/** Inspect the canonical stored instruction, never a caller-supplied withdrawal label. */
export async function readSolanaProposal(reviewedVault: SolanaVault, indexInput: string, userAddress: string): Promise<SolanaProposal> {
  if (!/^[1-9]\d*$/.test(indexInput)) throw new Error('Enter a positive proposal index.');
  const verified = await verifySolanaVault(reviewedVault.address, userAddress);
  assertReviewedVaultPolicy(verified, reviewedVault);
  const connection = solanaConnection(), key = new PublicKey(reviewedVault.address), index = BigInt(indexInput);
  const [proposal, tx, state] = await Promise.all([
    multisig.accounts.Proposal.fromAccountAddress(connection, multisig.getProposalPda({ multisigPda: key, transactionIndex: index })[0]),
    multisig.accounts.VaultTransaction.fromAccountAddress(connection, multisig.getTransactionPda({ multisigPda: key, index })[0]),
    multisig.accounts.Multisig.fromAccountAddress(connection, key),
  ]);
  if (!tx.multisig.equals(key) || !proposal.multisig.equals(key) || tx.vaultIndex !== 0 || tx.ephemeralSignerBumps.length || tx.message.instructions.length !== 1 || tx.message.addressTableLookups.length) throw new Error('This proposal is not a supported direct ANTARA withdrawal. Inspect it in Squads.');
  const instruction = tx.message.instructions[0], data = instruction.data;
  const program = tx.message.accountKeys[instruction.programIdIndex];
  const keys = [...instruction.accountIndexes].map(i => tx.message.accountKeys[i]);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let asset: 'SOL' | 'USDC', recipient: string, amount: bigint;
  if (program.equals(SystemProgram.programId) && data.length === 12 && view.getUint32(0, true) === 2 && keys.length === 2 && keys[0].toBase58() === verified.depositAddress) {
    asset = 'SOL'; recipient = keys[1].toBase58(); amount = view.getBigUint64(4, true);
  } else if (program.equals(TOKEN_PROGRAM_ID) && data.length === 10 && data[0] === 12 && data[9] === 6 && keys.length === 4 && keys[1].toBase58() === USDC_SOLANA && keys[3].toBase58() === verified.depositAddress) {
    if (!keys[0].equals(getAssociatedTokenAddressSync(new PublicKey(USDC_SOLANA), new PublicKey(verified.depositAddress), true))) throw new Error('Unexpected vault token source.');
    const destination = await getAccount(connection, keys[2]);
    assertCanonicalUsdcDestination(keys[2], destination);
    asset = 'USDC'; recipient = destination.owner.toBase58(); amount = view.getBigUint64(1, true);
  } else throw new Error('Unsupported proposal instruction. No approval or execution was requested.');
  if (amount <= 0n) throw new Error('Invalid withdrawal amount.');
  assertReleaseRecipient(recipient, verified);
  const decimals = asset === 'SOL' ? 9 : 6;
  const digits = amount.toString().padStart(decimals + 1, '0');
  return { index: indexInput, status: proposal.status.__kind, approvals: proposal.approved.map(key => key.toBase58()), threshold: verified.threshold,
    executableAt: proposal.status.__kind === 'Approved' ? Number(proposal.status.timestamp.toString()) * 1000 + verified.timeLockSeconds * 1000 : null,
    recipient, amount: `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`, asset, raw: amount.toString(), stale: index <= BigInt(state.staleTransactionIndex.toString()) };
}
export async function approveSolanaRelease(signer: SolanaSigner, reviewedVault: SolanaVault, index: string) {
  const proposal = await readSolanaProposal(reviewedVault, index, signer.address);
  if (proposal.stale || proposal.status !== 'Active') throw new Error('This proposal is no longer open for approvals.');
  if (proposal.approvals.includes(signer.address)) throw new Error('This owner has already approved.');
  return sendInstructions(signer, [multisig.instructions.proposalApprove({ multisigPda: new PublicKey(reviewedVault.address), transactionIndex: BigInt(index), member: publicSigner(signer.address) })]);
}
export async function executeSolanaRelease(signer: SolanaSigner, reviewedVault: SolanaVault, index: string) {
  const proposal = await readSolanaProposal(reviewedVault, index, signer.address);
  if (proposal.stale || proposal.status !== 'Approved' || proposal.executableAt === null || Date.now() < proposal.executableAt) throw new Error('The proposal requires its owner quorum and full on-chain delay before execution.');
  const { instruction, lookupTableAccounts } = await multisig.instructions.vaultTransactionExecute({ connection: solanaConnection(), multisigPda: new PublicKey(reviewedVault.address), transactionIndex: BigInt(index), member: publicSigner(signer.address) });
  return sendInstructions(signer, [instruction], [], lookupTableAccounts);
}

// ---------------------------------------------------------------------------
// Paired vaults: Squads {U:7, G:2}, threshold 2, co-signed by the ANTARA guardian.
// These never use verifySolanaVault/validateVaultPolicy, which stay strict for
// independent-owner vaults. Every action re-reads the vault and refuses any
// guardian other than the one pinned in this build.
// ---------------------------------------------------------------------------
export const PAIRED_VAULT_MEMO = 'ANTARA paired vault v1';
export interface PairedSolanaVault {
  kind: 'squads-paired'; address: string; depositAddress: string; user: string; guardian: string; cluster: string;
  threshold: number; timeLockSeconds: number; transactionIndex: string; staleTransactionIndex: string;
  observedAt: string; nativeBalance: string; usdcBalance: string | null;
}
export interface PairedSolanaProposal {
  index: string; status: ProposalStatusKind; approvals: string[]; userApproved: boolean; guardianApproved: boolean; stale: boolean;
  asset: 'SOL' | 'USDC'; amountRaw: string; recipient: string;
}
/**
 * The caps the user set for this vault (optional Limits layer), checked first so a release
 * the guardian would refuse is not proposed (and paid for). null means no cap, the default:
 * there is no server-wide cap or minimum. Other refusals (for example a changed account
 * between proposing and the vote) can still leave a proposal unapproved.
 */
export interface PairedReleaseBounds { perRelease: bigint | null; remainingToday: bigint | null }
const rawAccount = (address: string, account: { owner: PublicKey; data: Uint8Array } | null): RawSolanaAccount | null =>
  account && { address, owner: account.owner.toBase58(), data: account.data };
/** Refuses before any network read when this build pins no guardian, or a different one. */
function assertGuardianPin(guardian: string) {
  if (!PAIRED_GUARDIAN_SOLANA) throw new Error('This build has no pinned ANTARA guardian, so paired vaults are unavailable. Nothing was created or approved.');
  if (guardian !== PAIRED_GUARDIAN_SOLANA) throw new Error('The ANTARA guardian does not match the one pinned in this build. Nothing was created or approved.');
}
function assertPinnedPaired(state: Pick<PairedMultisigState, 'user' | 'guardian' | 'threshold' | 'timeLockSeconds'>) {
  validatePairedVault({
    members: [{ address: state.user, permissions: PAIRED_PERMISSIONS.user }, { address: state.guardian, permissions: PAIRED_PERMISSIONS.guardian }],
    threshold: state.threshold, timeLockSeconds: state.timeLockSeconds, configAuthority: null,
    userAddress: state.user, guardian: state.guardian, pinnedGuardian: PAIRED_GUARDIAN_SOLANA,
  });
}
async function readPairedState(connection: Connection, address: string, userAddress: string, guardian: string) {
  const key = new PublicKey(address);
  const [account, limits] = await Promise.all([
    connection.getAccountInfo(key, 'confirmed'),
    connection.getProgramAccounts(SQUADS_PROGRAM, { commitment: 'confirmed', filters: spendingLimitFilters(address), dataSlice: { offset: 0, length: 0 } }),
  ]);
  // Exact members {U:7, G:2}, threshold 2, no config authority, no spending limits, PDA derivation: see solanaDecode.
  const state = decodePairedMultisig(rawAccount(address, account), { guardian, user: userAddress, spendingLimitCount: limits.length });
  assertPinnedPaired(state);
  return state;
}
/** Refuses a release recipient that this device has not itself confirmed as one of your wallets. */
export function assertOwnRecipient(recipient: string, allowedRecipients: readonly string[]) {
  if (!recipient || !allowedRecipients.includes(recipient)) {
    throw new Error('This recipient is not one of the wallets this device knows to be yours. Nothing was proposed, signed or executed.');
  }
}
function assertSamePairedVault(current: PairedSolanaVault, reviewed: PairedSolanaVault) {
  if (current.address !== reviewed.address || current.depositAddress !== reviewed.depositAddress || current.user !== reviewed.user ||
    current.guardian !== reviewed.guardian || current.cluster !== reviewed.cluster) {
    throw new Error('The vault changed after it was verified. Refresh the vault before continuing.');
  }
}

/** Reads and verifies a paired vault on-chain (guardian must equal the build pin) with its SOL and USDC balances. */
export async function verifyPairedSolanaVault(address: string, userAddress: string, guardian = PAIRED_GUARDIAN_SOLANA): Promise<PairedSolanaVault> {
  assertGuardianPin(guardian);
  const connection = solanaConnection();
  await assertSolanaCluster(connection, SOLANA_CLUSTER);
  const state = await readPairedState(connection, address, userAddress, guardian);
  const deposit = new PublicKey(state.vault);
  const native = await connection.getBalance(deposit, 'confirmed');
  if (!Number.isSafeInteger(native)) throw new Error('RPC returned an imprecise SOL balance.');
  let usdcBalance: string | null = null;
  if (SOLANA_CLUSTER !== 'devnet') {
    const tokenAddress = getAssociatedTokenAddressSync(new PublicKey(USDC_SOLANA), deposit, true);
    const token = await connection.getAccountInfo(tokenAddress, 'confirmed');
    usdcBalance = token ? (await connection.getTokenAccountBalance(tokenAddress, 'confirmed')).value.amount : '0';
  }
  return {
    kind: 'squads-paired', address: state.address, depositAddress: state.vault, user: state.user, guardian: state.guardian, cluster: SOLANA_CLUSTER,
    threshold: state.threshold, timeLockSeconds: state.timeLockSeconds, transactionIndex: state.transactionIndex.toString(),
    staleTransactionIndex: state.staleTransactionIndex.toString(), observedAt: new Date().toISOString(), nativeBalance: native.toString(), usdcBalance,
  };
}

/**
 * Creates a paired vault: random createKey (never derived from your key, so the
 * address cannot be pre-claimed), members U:7 and G:2 (vote only), threshold 2,
 * time lock 0, no config authority, rent back to U. `onPrepared` receives the
 * multisig address before you sign, so activation can be resumed if the
 * confirmation or registration step is interrupted.
 */
export async function createPairedSolanaVault(signer: SolanaSigner, guardian: string, onPrepared?: (multisig: string) => void) {
  validatePairedVault({
    members: [{ address: signer.address, permissions: PAIRED_PERMISSIONS.user }, { address: guardian, permissions: PAIRED_PERMISSIONS.guardian }],
    threshold: 2, timeLockSeconds: 0, configAuthority: null, userAddress: signer.address, guardian, pinnedGuardian: PAIRED_GUARDIAN_SOLANA,
  });
  const config = await multisig.accounts.ProgramConfig.fromAccountAddress(solanaConnection(), multisig.getProgramConfigPda({})[0]);
  const { instruction, multisig: address, createKey } = buildPairedCreateInstruction(signer.address, guardian, config.treasury);
  onPrepared?.(address);
  const signature = await sendInstructions(signer, [instruction], [createKey]);
  return preserveVaultTransaction(signature, async () => ({ vault: await verifyPairedSolanaVault(address, signer.address, guardian), signature }), true);
}
/**
 * The exact `multisigCreateV2` of a paired vault: members U:7 and G:2, threshold 2,
 * time lock 0, no config authority, rent back to U and memo PAIRED_VAULT_MEMO, with a
 * fresh random createKey (never derived from your key, so the address cannot be
 * pre-claimed; it must co-sign the creation). No network access, so tests can decode
 * every field. `createKey` is a parameter for tests only.
 */
export function buildPairedCreateInstruction(creator: string, guardian: string, treasury: PublicKey, createKey: Keypair = Keypair.generate()) {
  const user = publicSigner(creator);
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const instruction = multisig.instructions.multisigCreateV2({
    treasury, creator: user, multisigPda, configAuthority: null, threshold: 2,
    members: pairedMultisigMembers(creator, guardian), timeLock: 0, createKey: createKey.publicKey, rentCollector: user, memo: PAIRED_VAULT_MEMO,
  });
  return { instruction, multisig: multisigPda.toBase58(), createKey };
}

export async function depositPairedSolanaVault(signer: SolanaSigner, reviewed: PairedSolanaVault, asset: 'SOL' | 'USDC', amount: string) {
  const vault = await verifyPairedSolanaVault(reviewed.address, signer.address, reviewed.guardian);
  assertSamePairedVault(vault, reviewed);
  const from = publicSigner(signer.address), raw = parseAmount(amount, asset === 'SOL' ? 9 : 6);
  // A first SOL deposit below Solana's live minimum, or USDC this wallet does not hold, is refused before signing.
  await assertDepositFits(solanaConnection(), from, BigInt(vault.nativeBalance), asset, raw);
  return sendInstructions(signer, depositInstructions(from, new PublicKey(vault.depositAddress), asset, raw));
}

/**
 * Proposes one release from the vault and casts your vote, in one transaction:
 * vaultTransactionCreate (exactly one SOL or USDC transfer), proposalCreate and
 * proposalApprove(U). A USDC recipient's canonical token account is created in
 * the outer transaction, never inside the vault transaction.
 *
 * `allowedRecipients` are the wallets this device itself knows to be yours (never
 * a list taken only from the ANTARA server); any other recipient is refused before
 * anything is read or signed.
 */
export async function proposePairedSolanaRelease(signer: SolanaSigner, reviewed: PairedSolanaVault, recipient: string, asset: 'SOL' | 'USDC', amount: string, allowedRecipients: readonly string[], bounds?: PairedReleaseBounds) {
  assertOwnRecipient(recipient, allowedRecipients);
  const vault = await verifyPairedSolanaVault(reviewed.address, signer.address, reviewed.guardian);
  assertSamePairedVault(vault, reviewed);
  assertReleaseRecipient(recipient, vault);
  if (recipient === vault.guardian) throw new Error('Vault releases cannot pay the ANTARA guardian.');
  const creator = publicSigner(signer.address), destinationOwner = publicSigner(recipient), key = new PublicKey(vault.address), deposit = new PublicKey(vault.depositAddress);
  const raw = parseAmount(amount, asset === 'SOL' ? 9 : 6);
  if (bounds) {
    if (bounds.perRelease !== null && raw > bounds.perRelease) throw new Error('This release exceeds the per-release limit you set for this vault.');
    if (bounds.remainingToday !== null && raw > bounds.remainingToday) throw new Error('This release exceeds what remains of the daily limit you set for this vault.');
  }
  if (raw > BigInt(asset === 'SOL' ? vault.nativeBalance : vault.usdcBalance || '0')) throw new Error('The vault has insufficient balance.');
  // The whole balance, or enough left for Solana's live minimum: dust would pass both votes and then fail at execution.
  if (asset === 'SOL') await assertSolReleaseFits(solanaConnection(), BigInt(vault.nativeBalance), raw, destinationOwner);
  const before: TransactionInstruction[] = [];
  let transfer: TransactionInstruction;
  if (asset === 'SOL') transfer = SystemProgram.transfer({ fromPubkey: deposit, toPubkey: destinationOwner, lamports: raw });
  else {
    if (SOLANA_CLUSTER === 'devnet') throw new Error('USDC releases are available on mainnet only.');
    const mint = new PublicKey(USDC_SOLANA), destination = getAssociatedTokenAddressSync(mint, destinationOwner);
    before.push(createAssociatedTokenAccountIdempotentInstruction(creator, destination, destinationOwner, mint));
    transfer = createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, deposit, true), mint, destination, deposit, raw, 6);
  }
  const connection = solanaConnection();
  const index = BigInt(vault.transactionIndex) + 1n;
  const message = new TransactionMessage({ payerKey: deposit, recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash, instructions: [transfer] });
  const signature = await sendInstructions(signer, [...before,
    multisig.instructions.vaultTransactionCreate({ multisigPda: key, transactionIndex: index, creator, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message, memo: 'ANTARA paired release' }),
    multisig.instructions.proposalCreate({ multisigPda: key, transactionIndex: index, creator, isDraft: false }),
    multisig.instructions.proposalApprove({ multisigPda: key, transactionIndex: index, member: creator }),
  ]);
  return { index: index.toString(), signature };
}

/** Decodes a stored proposal with the same code the guardian uses; `recipients` are the wallets a USDC release may pay. */
export async function readPairedSolanaProposal(reviewed: PairedSolanaVault, indexInput: string, userAddress: string, recipients: string[]): Promise<PairedSolanaProposal> {
  assertGuardianPin(reviewed.guardian);
  const index = parseTransactionIndex(indexInput);
  const connection = solanaConnection();
  await assertSolanaCluster(connection, SOLANA_CLUSTER);
  const addresses = pairedVaultAddresses(reviewed.address, index);
  const [state, [proposal, transaction]] = await Promise.all([
    readPairedState(connection, reviewed.address, userAddress, reviewed.guardian),
    connection.getMultipleAccountsInfo([new PublicKey(addresses.proposal!), new PublicKey(addresses.transaction!)], 'confirmed'),
  ]);
  if (state.vault !== reviewed.depositAddress) throw new Error('The vault changed after it was verified. Refresh the vault before continuing.');
  const votes = decodePairedProposal(rawAccount(addresses.proposal!, proposal), state, index);
  const intent = decodeReleaseIntent(rawAccount(addresses.transaction!, transaction), state, index, { recipientCandidates: [...new Set([userAddress, ...recipients])] });
  return {
    index: index.toString(), status: votes.status, approvals: votes.approved, userApproved: votes.approved.includes(state.user),
    guardianApproved: votes.approved.includes(state.guardian), stale: index <= state.staleTransactionIndex,
    asset: intent.asset, amountRaw: intent.amountRaw.toString(), recipient: intent.recipient,
  };
}

/** Polls the chain until the guardian's vote has landed (bounded). Safe to repeat. */
export async function waitForPairedApproval(reviewed: PairedSolanaVault, index: string, userAddress: string, recipients: string[], options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 75_000);
  for (;;) {
    options.signal?.throwIfAborted();
    const proposal = await readPairedSolanaProposal(reviewed, index, userAddress, recipients);
    if (proposal.status === 'Executed') return proposal;
    if (proposal.status === 'Rejected' || proposal.status === 'Cancelled' || proposal.stale) throw new Error('This release was rejected, cancelled or replaced. Start a new release.');
    if (proposal.status === 'Approved' && proposal.userApproved && proposal.guardianApproved) return proposal;
    if (Date.now() >= deadline) throw new Error('ANTARA’s approval has not reached the chain yet. Check again shortly; retrying does not approve twice.');
    await new Promise(resolve => setTimeout(resolve, options.intervalMs ?? 2_500));
  }
}

/**
 * Executes a release only you can execute, after both your vote and the guardian's
 * are on-chain, and only when it pays one of `recipients` (wallets this device knows
 * to be yours) or your own wallet.
 */
export async function executePairedSolanaRelease(signer: SolanaSigner, reviewed: PairedSolanaVault, index: string, recipients: string[]) {
  const proposal = await readPairedSolanaProposal(reviewed, index, signer.address, recipients);
  if (proposal.stale || proposal.status !== 'Approved' || !proposal.userApproved || !proposal.guardianApproved) {
    throw new Error('This release needs both your approval and the ANTARA guardian’s before it can be executed.');
  }
  assertOwnRecipient(proposal.recipient, [signer.address, ...recipients]);
  const { instruction, lookupTableAccounts } = await multisig.instructions.vaultTransactionExecute({ connection: solanaConnection(), multisigPda: new PublicKey(reviewed.address), transactionIndex: BigInt(proposal.index), member: publicSigner(signer.address) });
  return sendInstructions(signer, [instruction], [], lookupTableAccounts);
}
