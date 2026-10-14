import { VersionedTransaction, type Connection } from '@solana/web3.js';

const NOT_SIGNED = 'No signature was requested.';
/**
 * One calm sentence for a simulation Solana rejected, from its error and logs. Paired vaults have no
 * time lock, so no message mentions a delay. Never includes raw RPC text.
 */
export function simulationFailureMessage(err: unknown, logs?: readonly string[] | null): string {
  let text: string;
  try { text = `${JSON.stringify(err ?? null)}\n${(logs ?? []).join('\n')}`; } catch { text = ''; }
  if (/InsufficientFundsForRent/.test(text)) return `Solana keeps an account only while it holds a small minimum of SOL, and this would leave one below it. Check the amount. ${NOT_SIGNED}`;
  if (/InsufficientFundsForFee/.test(text)) return `This wallet doesn’t have enough SOL for the network fee. ${NOT_SIGNED}`;
  if (/insufficient lamports/i.test(text)) return `There isn’t enough SOL for this transaction and its network fee. Refresh and check the balances. ${NOT_SIGNED}`;
  if (/InvalidAccountData|invalid account data/i.test(text)) return `A token account this transaction needs is missing. If you’re moving USDC, check that this wallet holds USDC on Solana. ${NOT_SIGNED}`;
  if (/Error: insufficient funds/i.test(text)) return `There isn’t enough USDC for this transfer. Refresh and check the balances. ${NOT_SIGNED}`;
  return `The vault transaction failed its on-chain simulation. Refresh the vault and check its balance and approvals. ${NOT_SIGNED}`;
}

/** Simulate the exact message before opening a wallet; simulation never signs or broadcasts. */
export async function sendSimulatedVaultTransaction(
  connection: Pick<Connection, 'simulateTransaction'>,
  transaction: VersionedTransaction,
  send: (bytes: Uint8Array) => Promise<string>,
): Promise<string> {
  const bytes = transaction.serialize();
  const simulation = await connection.simulateTransaction(VersionedTransaction.deserialize(bytes), {
    commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: false,
  });
  if (simulation.value.err !== null) throw new Error(simulationFailureMessage(simulation.value.err, simulation.value.logs));
  return send(bytes);
}
