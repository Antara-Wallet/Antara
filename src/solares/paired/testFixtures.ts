/**
 * Test-only builders for real Squads v4 account encodings, produced with the
 * @sqds/multisig serializers exactly as the program stores them. Shared by the
 * client decoder tests and the API server's guardian tests. The boundary uses
 * base58 strings and Uint8Array only (the server has its own @solana/web3.js).
 * Never import this from application code.
 */
import * as multisig from '@sqds/multisig';
import {
  ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction,
} from '@solana/web3.js';
import { ACCOUNT_SIZE, AccountLayout, TOKEN_2022_PROGRAM_ID, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { SOLANA_USDC_MINT, SPL_TOKEN_PROGRAM_ID, SQUADS_PROGRAM_ID, buildGuardianApproveTransaction, type RawSolanaAccount } from './solanaDecode';

export interface PairedFixtureKeys { user: string; guardian: string; createKey: string; multisig: string; vault: string }
export const newWallet = () => Keypair.generate().publicKey.toBase58();
export const recentBlockhash = () => Keypair.generate().publicKey.toBase58();
export function pairedKeys(): PairedFixtureKeys {
  const createKey = Keypair.generate().publicKey;
  const multisigPda = multisig.getMultisigPda({ createKey })[0];
  return {
    user: newWallet(), guardian: newWallet(), createKey: createKey.toBase58(), multisig: multisigPda.toBase58(),
    vault: multisig.getVaultPda({ multisigPda, index: 0 })[0].toBase58(),
  };
}
export function usdcAta(owner: string, mint = SOLANA_USDC_MINT, allowOwnerOffCurve = false) {
  return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), allowOwnerOffCurve).toBase58();
}
/** The USDC associated token account derived under Token-2022: never canonical for Circle USDC. */
export function token2022UsdcAta(owner: string) {
  return getAssociatedTokenAddressSync(new PublicKey(SOLANA_USDC_MINT), new PublicKey(owner), false, TOKEN_2022_PROGRAM_ID).toBase58();
}
const bytes = (value: Buffer) => new Uint8Array(value);

export interface MultisigFixtureOptions {
  members?: ReadonlyArray<{ readonly key: string; readonly mask: number }>;
  threshold?: number;
  timeLock?: number;
  configAuthority?: string;
  transactionIndex?: bigint;
  staleTransactionIndex?: bigint;
  rentCollector?: string | null;
  owner?: string;
  address?: string;
  createKey?: string;
}
export function multisigAccount(keys: PairedFixtureKeys, options: MultisigFixtureOptions = {}): RawSolanaAccount {
  const members = options.members ?? [{ key: keys.user, mask: 7 }, { key: keys.guardian, mask: 2 }];
  const [data] = multisig.accounts.Multisig.fromArgs({
    createKey: new PublicKey(options.createKey ?? keys.createKey),
    configAuthority: new PublicKey(options.configAuthority ?? PublicKey.default.toBase58()),
    threshold: options.threshold ?? 2,
    timeLock: options.timeLock ?? 0,
    transactionIndex: Number(options.transactionIndex ?? 1n),
    staleTransactionIndex: Number(options.staleTransactionIndex ?? 0n),
    rentCollector: options.rentCollector === undefined ? new PublicKey(keys.user) : options.rentCollector === null ? null : new PublicKey(options.rentCollector),
    bump: 255,
    members: members.map(member => ({ key: new PublicKey(member.key), permissions: { mask: member.mask } })),
  }).serialize();
  return { address: options.address ?? keys.multisig, owner: options.owner ?? SQUADS_PROGRAM_ID, data: bytes(data) };
}

export type ProposalStatusFixture = 'Draft' | 'Active' | 'Rejected' | 'Approved' | 'Executing' | 'Executed' | 'Cancelled';
export interface ProposalFixtureOptions {
  index?: bigint; status?: ProposalStatusFixture; approved?: readonly string[]; rejected?: readonly string[]; cancelled?: readonly string[];
  address?: string; owner?: string; multisig?: string;
}
export function proposalAccount(keys: PairedFixtureKeys, options: ProposalFixtureOptions = {}): RawSolanaAccount {
  const index = options.index ?? 1n;
  const kind = options.status ?? 'Active';
  const status = (kind === 'Executing' ? { __kind: kind } : { __kind: kind, timestamp: 1_760_000_000 }) as multisig.generated.ProposalStatus;
  const multisigPda = new PublicKey(options.multisig ?? keys.multisig);
  const [data] = multisig.accounts.Proposal.fromArgs({
    multisig: multisigPda, transactionIndex: Number(index), status, bump: 255,
    approved: (options.approved ?? [keys.user]).map(value => new PublicKey(value)),
    rejected: (options.rejected ?? []).map(value => new PublicKey(value)),
    cancelled: (options.cancelled ?? []).map(value => new PublicKey(value)),
  }).serialize();
  const address = options.address ?? multisig.getProposalPda({ multisigPda: new PublicKey(keys.multisig), transactionIndex: index })[0].toBase58();
  return { address, owner: options.owner ?? SQUADS_PROGRAM_ID, data: bytes(data) };
}

export type ReleaseInstructionFixture =
  | { kind: 'sol'; to: string; lamports: bigint; from?: string }
  | { kind: 'usdc'; to: string; amount: bigint; mint?: string; decimals?: number; destination?: string; source?: string }
  | { kind: 'computeBudget' };
function instructionFor(keys: PairedFixtureKeys, fixture: ReleaseInstructionFixture): TransactionInstruction {
  const vault = new PublicKey(keys.vault);
  if (fixture.kind === 'sol') return SystemProgram.transfer({ fromPubkey: new PublicKey(fixture.from ?? keys.vault), toPubkey: new PublicKey(fixture.to), lamports: fixture.lamports });
  if (fixture.kind === 'computeBudget') return ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
  const mint = new PublicKey(fixture.mint ?? SOLANA_USDC_MINT);
  const source = new PublicKey(fixture.source ?? getAssociatedTokenAddressSync(mint, vault, true).toBase58());
  const destination = new PublicKey(fixture.destination ?? usdcAta(fixture.to, mint.toBase58()));
  return createTransferCheckedInstruction(source, mint, destination, vault, fixture.amount, fixture.decimals ?? 6);
}
/** The compiled Squads message, editable by `mutateMessage` to forge headers or account lists the SDK would never produce. */
export interface MultisigMessageFixture {
  numSigners: number; numWritableSigners: number; numWritableNonSigners: number;
  accountKeys: PublicKey[];
  instructions: Array<{ programIdIndex: number; accountIndexes: number[]; data: number[] }>;
}
export interface VaultTransactionFixtureOptions {
  index?: bigint; instructions: readonly ReleaseInstructionFixture[]; vaultIndex?: number; ephemeralSignerBumps?: readonly number[];
  lookupTables?: number; address?: string; owner?: string;
  mutateMessage?: (message: MultisigMessageFixture) => void;
}
/** A VaultTransaction exactly as `vault_transaction_create` stores it. */
export function vaultTransactionAccount(keys: PairedFixtureKeys, options: VaultTransactionFixtureOptions): RawSolanaAccount {
  const index = options.index ?? 1n;
  const multisigPda = new PublicKey(keys.multisig), vaultPda = new PublicKey(keys.vault);
  const source = new TransactionMessage({ payerKey: vaultPda, recentBlockhash: recentBlockhash(), instructions: options.instructions.map(item => instructionFor(keys, item)) });
  const encoded = multisig.utils.transactionMessageToMultisigTransactionMessageBytes({ message: source, vaultPda });
  const [compiled] = multisig.types.transactionMessageBeet.deserialize(Buffer.from(encoded));
  const lookups = Array.from({ length: options.lookupTables ?? 0 }, () => ({ accountKey: Keypair.generate().publicKey, writableIndexes: Uint8Array.from([0]), readonlyIndexes: new Uint8Array() }));
  const message: MultisigMessageFixture = {
    numSigners: compiled.numSigners, numWritableSigners: compiled.numWritableSigners, numWritableNonSigners: compiled.numWritableNonSigners,
    accountKeys: [...compiled.accountKeys],
    instructions: compiled.instructions.map(ix => ({ programIdIndex: ix.programIdIndex, accountIndexes: [...ix.accountIndexes], data: [...ix.data] })),
  };
  options.mutateMessage?.(message);
  const [data] = multisig.accounts.VaultTransaction.fromArgs({
    multisig: multisigPda, creator: new PublicKey(keys.user), index: Number(index), bump: 255,
    vaultIndex: options.vaultIndex ?? 0, vaultBump: 255, ephemeralSignerBumps: Uint8Array.from(options.ephemeralSignerBumps ?? []),
    message: {
      numSigners: message.numSigners, numWritableSigners: message.numWritableSigners, numWritableNonSigners: message.numWritableNonSigners,
      accountKeys: message.accountKeys,
      instructions: message.instructions.map(ix => ({ programIdIndex: ix.programIdIndex, accountIndexes: Uint8Array.from(ix.accountIndexes), data: Uint8Array.from(ix.data) })),
      addressTableLookups: lookups,
    },
  }).serialize();
  const address = options.address ?? multisig.getTransactionPda({ multisigPda, index })[0].toBase58();
  return { address, owner: options.owner ?? SQUADS_PROGRAM_ID, data: bytes(data) };
}
/** A ConfigTransaction that would lower the threshold to one. */
export function configTransactionAccount(keys: PairedFixtureKeys, index = 1n): RawSolanaAccount {
  const multisigPda = new PublicKey(keys.multisig);
  const [data] = multisig.accounts.ConfigTransaction.fromArgs({
    multisig: multisigPda, creator: new PublicKey(keys.user), index: Number(index), bump: 255,
    actions: [{ __kind: 'ChangeThreshold', newThreshold: 1 }],
  }).serialize();
  return { address: multisig.getTransactionPda({ multisigPda, index })[0].toBase58(), owner: SQUADS_PROGRAM_ID, data: bytes(data) };
}

export interface TokenAccountFixture { address: string; owner: string; mint?: string; delegate?: string; closeAuthority?: string; state?: number; programOwner?: string }
export function tokenAccount(fixture: TokenAccountFixture): RawSolanaAccount {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({
    mint: new PublicKey(fixture.mint ?? SOLANA_USDC_MINT), owner: new PublicKey(fixture.owner), amount: 0n,
    delegateOption: fixture.delegate ? 1 : 0, delegate: new PublicKey(fixture.delegate ?? PublicKey.default.toBase58()),
    state: fixture.state ?? 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
    closeAuthorityOption: fixture.closeAuthority ? 1 : 0, closeAuthority: new PublicKey(fixture.closeAuthority ?? PublicKey.default.toBase58()),
  }, data);
  return { address: fixture.address, owner: fixture.programOwner ?? SPL_TOKEN_PROGRAM_ID, data: bytes(data) };
}
export const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();

/** The genuine guardian approval plus transactions it must refuse, all unsigned unless named otherwise. */
export function guardianTransactionVariants(request: { multisig: string; transactionIndex: bigint; guardian: string; recentBlockhash: string }) {
  const multisigPda = new PublicKey(request.multisig), guardian = new PublicKey(request.guardian);
  const attacker = Keypair.generate().publicKey;
  const v0 = (instructions: TransactionInstruction[], payer = guardian) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: request.recentBlockhash, instructions }).compileToV0Message()).serialize();
  const approve = (overrides: { multisigPda?: PublicKey; transactionIndex?: bigint; member?: PublicKey; memo?: string } = {}) => multisig.instructions.proposalApprove({
    multisigPda: overrides.multisigPda ?? multisigPda, transactionIndex: overrides.transactionIndex ?? request.transactionIndex, member: overrides.member ?? guardian, memo: overrides.memo,
  });
  const valid = buildGuardianApproveTransaction(request);
  const signed = VersionedTransaction.deserialize(valid);
  signed.signatures[0] = new Uint8Array(64).fill(7);
  const legacy = new VersionedTransaction(new TransactionMessage({ payerKey: guardian, recentBlockhash: request.recentBlockhash, instructions: [approve()] }).compileToLegacyMessage()).serialize();
  return {
    valid,
    refused: {
      withMemo: v0([approve({ memo: 'ANTARA' })]),
      otherMember: v0([approve({ member: attacker })]),
      userPaysFee: v0([approve()], attacker),
      computeBudgetPrefix: v0([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }), approve()]),
      secondApprove: v0([approve(), approve({ transactionIndex: request.transactionIndex + 1n })]),
      otherMultisig: v0([approve({ multisigPda: multisig.getMultisigPda({ createKey: Keypair.generate().publicKey })[0] })]),
      otherIndex: v0([approve({ transactionIndex: request.transactionIndex + 1n })]),
      reject: v0([multisig.instructions.proposalReject({ multisigPda, transactionIndex: request.transactionIndex, member: guardian })]),
      cancel: v0([multisig.instructions.proposalCancel({ multisigPda, transactionIndex: request.transactionIndex, member: guardian })]),
      proposalCreate: v0([multisig.instructions.proposalCreate({ multisigPda, transactionIndex: request.transactionIndex, creator: guardian })]),
      systemTransfer: v0([SystemProgram.transfer({ fromPubkey: guardian, toPubkey: attacker, lamports: 1_000_000n })]),
      preSigned: signed.serialize(),
      legacyMessage: legacy,
      garbage: Uint8Array.from({ length: 200 }, (_, i) => (i * 31) % 256),
    } as Record<string, Uint8Array>,
  };
}
