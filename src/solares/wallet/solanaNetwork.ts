// Read from the public Solana mainnet-beta and devnet RPC getGenesisHash methods.
export const SOLANA_GENESIS = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
} as const;
export async function assertSolanaCluster(connection: { getGenesisHash(): Promise<string> }, cluster: keyof typeof SOLANA_GENESIS = 'mainnet-beta'): Promise<void> {
  if (await connection.getGenesisHash() !== SOLANA_GENESIS[cluster]) throw new Error(`Solana RPC is not on ${cluster}. Correct your RPC configuration before continuing.`);
}
