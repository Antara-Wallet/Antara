/**
 * The account read behind every paired-vault view (summary.ts, PairedSolanaVault.tsx), with the
 * same recovery as balances (wallet/linkRecovery.ts). The server answers with the wallets Privy
 * links to the token's account; when that list does not include the selected wallet although this
 * client's Privy user does, the two disagree: either Privy has not propagated a wallet it just
 * created, or this tab's token belongs to another account (refused earlier, by the token check in
 * getAccessToken). The first is asked again (1.5 s, 4 s, 10 s); if they still disagree the view
 * is "unavailable" with a reason, never "use your ANTARA wallet" for the wallet that is one.
 *
 * A selected wallet this client does not see as linked is answered from the first read as it is,
 * so the vault view keeps saying why it cannot pair (external or unlinked wallet).
 */
import { LINK_RETRY_DELAYS_MS, WALLET_NOT_CONFIRMED_MESSAGE, retryUntilLinked } from '../wallet/linkRecovery';
import { fetchPairedAccount, type PairedAccount } from './pairedApi';

export interface LinkedAccountRead {
  /** The selected Solana wallet the vault view is for. */
  owner: string;
  /** This client's Privy user lists `owner` as a linked wallet. */
  linkedHere: boolean;
  /** The token for the first read; later reads ask `token` again so an expired one is refreshed. */
  firstToken: string;
  token: () => Promise<string>;
  signal: AbortSignal;
  /** Runs after each read; throws when the view changed (account or selected wallet). */
  assertCurrent?: () => void;
  fetchAccount?: (token: string, signal: AbortSignal) => Promise<PairedAccount>;
  delays?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function readLinkedPairedAccount(input: LinkedAccountRead): Promise<PairedAccount> {
  const fetchAccount = input.fetchAccount ?? fetchPairedAccount;
  const listed = (account: PairedAccount) => account.wallets.some(item => item.address === input.owner);
  const account = await retryUntilLinked(async attempt => {
    const token = attempt === 0 ? input.firstToken : await input.token();
    const value = await fetchAccount(token, input.signal);
    input.assertCurrent?.();
    return value;
  }, {
    retryable: outcome => outcome.ok && input.linkedHere && !listed(outcome.value),
    delays: input.delays ?? LINK_RETRY_DELAYS_MS, signal: input.signal, sleep: input.sleep,
  });
  if (input.linkedHere && !listed(account)) throw new Error(WALLET_NOT_CONFIRMED_MESSAGE);
  return account;
}
