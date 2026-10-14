/**
 * A paired vault creation that was started but never registered: which one to resume, and whether "Discard this
 * attempt" may be offered.
 *
 * The resume key on this device (solares.paired-vault.pending.v1:*) comes first; otherwise the vault the server found
 * on Solana for this wallet (GET /solana/account `unregistered`, guardian.ts), so every app offers "Finish activation"
 * instead of a second vault. Either is only a pointer: Finish activation verifies the vault on-chain before it registers.
 *
 * Discarding only forgets this device's key, so it is offered only when Solana answers that no account exists at that
 * address (the creation never landed), checked again when the button is pressed. A vault that exists is never
 * discarded: the only pointer to it would be lost here, and it stays yours on-chain.
 */
import { assertSolanaCluster, type SOLANA_GENESIS } from '../wallet/solanaNetwork';
import type { PairedAccount } from './pairedApi';

export interface ResumableVault { multisig: string; source: 'device' | 'chain' }
/** Where the pending vault's account stands on Solana, as this client last read it. */
export type PendingChainState = 'checking' | 'missing' | 'exists' | 'unknown';

export function resumablePairedVault(local: string, account: Pick<PairedAccount, 'unregistered'> | null, owner: string | null, guardian: string | null): ResumableVault | null {
  if (local) return { multisig: local, source: 'device' };
  if (!account || !owner || !guardian) return null;
  const found = account.unregistered?.find(item => item.user === owner && item.guardian === guardian);
  return found ? { multisig: found.multisig, source: 'chain' } : null;
}

export const PENDING_EXISTS_NOTE = 'This vault exists on Solana, so this attempt can’t be discarded. Finish activation registers it with ANTARA.';
export const PENDING_UNKNOWN_NOTE = 'ANTARA couldn’t check Solana for this vault just now, so the attempt is kept. Try again in a moment.';

/** Discard is offered only for this device's own key whose account Solana reports missing; otherwise the note says why not. */
export function pendingDiscard(resumable: ResumableVault | null, chain: { multisig: string; state: PendingChainState } | null): { discardable: boolean; note: string } {
  if (!resumable) return { discardable: false, note: '' };
  const state: PendingChainState = chain?.multisig === resumable.multisig ? chain.state : 'checking';
  if (resumable.source === 'device' && state === 'missing') return { discardable: true, note: '' };
  if (resumable.source === 'chain' || state === 'exists') return { discardable: false, note: PENDING_EXISTS_NOTE };
  if (state === 'unknown') return { discardable: false, note: PENDING_UNKNOWN_NOTE };
  return { discardable: false, note: '' };
}

export interface PendingAccountReader {
  getGenesisHash(): Promise<string>;
  /** getAccountInfo(address) at confirmed commitment is not null. */
  accountExists(address: string): Promise<boolean>;
}
/** Whether an account exists at `address` on `cluster`. Throws when the RPC is unreachable or on another cluster. */
export async function readPendingAccountState(address: string, reader: PendingAccountReader, cluster: keyof typeof SOLANA_GENESIS): Promise<'missing' | 'exists'> {
  await assertSolanaCluster(reader, cluster);
  return await reader.accountExists(address) ? 'exists' : 'missing';
}
/** The app's Solana RPC as a reader. Loaded on demand, like the other chain reads (summary.ts). */
export async function chainPendingReader(): Promise<PendingAccountReader> {
  const [{ solanaConnection }, { PublicKey }] = await Promise.all([import('./solana'), import('@solana/web3.js')]);
  const connection = solanaConnection();
  return {
    getGenesisHash: () => connection.getGenesisHash(),
    accountExists: async address => (await connection.getAccountInfo(new PublicKey(address), 'confirmed')) !== null,
  };
}
