/**
 * What creating a paired Solana vault costs the user's wallet, read live from Solana the way
 * createPairedSolanaVault (vaults/solana.ts) pays it:
 *
 * - rent for the Squads v4 multisig account it creates (Multisig::size(2) = 198 bytes; the
 *   vault deposit account itself is a PDA with no data and costs nothing to "create"),
 * - the Squads program's `multisigCreationFee` from its ProgramConfig (paid to the treasury),
 * - the base network fee: 5,000 lamports per signature, two signatures (your wallet and the
 *   one-time create key); sendInstructions adds no priority fee,
 * - and the reserve Solana keeps in every funded wallet (rent exemption of a 0-byte account),
 *   because a payer may not be left below it.
 *
 * Nothing here signs or sends. When any part cannot be read the cost is unknown (null) and the
 * UI says "about 0.01–0.02 SOL" instead of guessing a precise number.
 */
import { formatExactAmount } from '../relay/model';

/** Squads v4 Multisig::size(members = 2): 8+32+32+2+4+8+8+1+32+1+4 + 2×33. */
export const PAIRED_MULTISIG_SPACE = 198;
/** Your wallet and the creation's one-time create key. */
export const CREATION_SIGNATURES = 2n;
export const LAMPORTS_PER_SIGNATURE = 5_000n;
/** Shown when the live cost cannot be read. */
export const CREATION_COST_FALLBACK = 'about 0.01–0.02 SOL';

export interface VaultCreationCost {
  /** Rent for the vault's multisig account, in lamports. */
  rent: bigint;
  /** Squads program fee, in lamports (0 when the program charges none). */
  programFee: bigint;
  /** Base network fee, in lamports. */
  networkFee: bigint;
  /** The minimum a funded Solana wallet keeps, in lamports. */
  walletReserve: bigint;
  /** Everything the wallet needs to hold before signing, in lamports. */
  total: bigint;
}

export function vaultCreationCost(parts: { rent: bigint; programFee: bigint; walletReserve: bigint; networkFee?: bigint }): VaultCreationCost {
  const networkFee = parts.networkFee ?? CREATION_SIGNATURES * LAMPORTS_PER_SIGNATURE;
  for (const value of [parts.rent, parts.programFee, parts.walletReserve, networkFee]) {
    if (value < 0n) throw new Error('A vault creation cost cannot be negative.');
  }
  return { rent: parts.rent, programFee: parts.programFee, networkFee, walletReserve: parts.walletReserve, total: parts.rent + parts.programFee + networkFee + parts.walletReserve };
}

/** Rounds lamports up to a multiple of `step` and writes them as SOL, so a figure shown is never below the real one. */
const ceilSol = (lamports: bigint, step: bigint) => formatExactAmount((((lamports + step - 1n) / step) * step).toString(), 9);
/** A part of the cost, rounded up to 0.000001 SOL, e.g. 1_656_080n → "0.001657". */
export const solText = (lamports: bigint) => ceilSol(lamports, 1_000n);

/** The total, rounded up to 0.0001 SOL, e.g. 2_316_320n → "0.0024". */
export const roundedSol = (lamports: bigint) => ceilSol(lamports, 100_000n);

export type CreationFunding =
  /** The wallet's SOL balance is known and covers the cost (or the known fallback range). */
  | 'met'
  /** The wallet's SOL balance is known and below the cost. */
  | 'short'
  /** The balance or the cost is not known: creation is allowed and the wallet shows the real amount before signing. */
  | 'unknown';

/**
 * Whether the wallet can pay. Unknown is never read as short. Without a live cost, only a known
 * zero balance is short (the existing rule), since any real figure would be a guess.
 */
export function creationFunding(cost: VaultCreationCost | null, balance: bigint | null): CreationFunding {
  if (balance === null) return 'unknown';
  if (!cost) return balance === 0n ? 'short' : 'unknown';
  return balance >= cost.total ? 'met' : 'short';
}

/** One line describing what the SOL pays for, from the live parts only. */
export function creationCostDetail(cost: VaultCreationCost): string {
  const fee = cost.programFee > 0n ? `, a ${solText(cost.programFee)} SOL Squads fee` : '';
  return `${solText(cost.rent)} SOL rent for the vault account${fee} and a ${solText(cost.networkFee)} SOL network fee, plus the ${solText(cost.walletReserve)} SOL every Solana wallet keeps.`;
}

/** Reads the live cost from Solana (rent and the Squads program config). Rejects when any part cannot be read. */
export async function readVaultCreationCost(): Promise<VaultCreationCost> {
  const [{ solanaConnection }, multisig] = await Promise.all([import('./solana'), import('@sqds/multisig')]);
  const connection = solanaConnection();
  const [rent, walletReserve, config] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(PAIRED_MULTISIG_SPACE, 'confirmed'),
    connection.getMinimumBalanceForRentExemption(0, 'confirmed'),
    multisig.accounts.ProgramConfig.fromAccountAddress(connection, multisig.getProgramConfigPda({})[0], 'confirmed'),
  ]);
  const fee = BigInt(config.multisigCreationFee.toString());
  if (!Number.isSafeInteger(rent) || !Number.isSafeInteger(walletReserve)) throw new Error('Solana returned an imprecise rent amount.');
  return vaultCreationCost({ rent: BigInt(rent), programFee: fee, walletReserve: BigInt(walletReserve) });
}
