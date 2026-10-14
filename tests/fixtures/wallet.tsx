// Browser-only test harness. Not imported by the application or production build.
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import DesktopWallet from '../../src/solares/DesktopWallet';
import { WalletContext, disconnectedWallet } from '../../src/solares/wallet/context';
import { canonicalBalance } from '../../src/solares/wallet/balances';
import { byKey, isNetworkKey } from '../../src/solares/networks';
import type { WalletBalance } from '../../src/solares/wallet/types';
import '../../src/index.css';

const first = '0x1111111111111111111111111111111111111111';
const second = '0x2222222222222222222222222222222222222222';
// Registry assets with exact decimals: Circle USDC (6) on Solana, Ethereum and Base,
// Binance-Peg USDC (18) on BNB Smart Chain and USDG (6) on Robinhood Chain.
// Every network loads by default. `?failed=<chain>` omits that network and reports it, as the live provider does.
// `?balances=owner` is the owner's production wallet of 2026-10-13: 0.09833392 SOL and 0 USDC on Solana only.
// USD prices are not part of the harness: the page reads /api/solares/wallet/prices, which the specs mock.
const failed = new URLSearchParams(location.search).get('failed');
const ownerBalances = new URLSearchParams(location.search).get('balances') === 'owner';
const balances: WalletBalance[] = (ownerBalances ? [
  canonicalBalance('solana', 98_333_920n, true),
  canonicalBalance('solana', 0n, false),
] : [
  canonicalBalance('solana', 9_000_000n, false),
  canonicalBalance('ethereum', 25_000_000n, false),
  canonicalBalance('bsc', 250_000_000_000_000_000n, true),
  canonicalBalance('bsc', 1_500_000_000_000_000_000n, false),
  canonicalBalance('robinhood', 2_500_000n, false),
  canonicalBalance('base', 0n, false),
]).filter(balance => balance.chain !== failed);
const balancesError = failed && isNetworkKey(failed) ? `Live balances unavailable on ${byKey(failed).name}. Check your RPC connections.` : null;
// `?wallets=owner`: the owner's account as Privy reports it: the embedded Solana wallet (standard wallet name
// "Privy"), a connected Phantom, and the embedded EVM wallet (client type "privy"). `?export=disabled` makes the
// export call fail the way a turned-off Privy setting would. Export calls are recorded on window.__fixtureExports.
const params = new URLSearchParams(location.search);
const ownerWallets = params.get('wallets') === 'owner';
// A valid base58 Solana wallet (fixed seed, never funded), so the paired-vault states past the no-pin screen are reachable.
const SOLANA_ANTARA = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const PHANTOM = 'EMX22GqsGJbZAMr3uE6g6yZ7EjZz8Y1tMRu2CnZny5tD';
const EVM_ANTARA = '0x7e6cb1a2c3d4e5f60718293a4b5c6d7e8f9f9805';
const fixtureExports: string[] = [];
(window as unknown as { __fixtureExports: string[] }).__fixtureExports = fixtureExports;
async function exportWallet(chain: 'solana' | 'ethereum', target: string) {
  fixtureExports.push(`${chain}:${target}`);
  if (params.get('export') === 'disabled') throw new Error('Key export is disabled for this app');
}
function Harness() {
  const [address, setAddress] = useState(ownerWallets ? EVM_ANTARA : first);
  const [solanaAddress, setSolanaAddress] = useState(SOLANA_ANTARA);
  const [authenticated, setAuthenticated] = useState(true);
  const addresses = { ethereum: address, solana: ownerWallets ? solanaAddress : SOLANA_ANTARA };
  const session = useRef({ authenticated, userId: 'fixture-user', addresses });
  session.current = { authenticated, userId: 'fixture-user', addresses };
  return <WalletContext.Provider value={{
    ...disconnectedWallet, configured: true, ready: true, authenticated, userId: authenticated ? 'fixture-user' : null, addresses,
    getSession: () => session.current, getAccessToken: async () => 'fixture-token', logout: async () => setAuthenticated(false),
    evmSigners: ownerWallets ? [{ address: EVM_ANTARA, name: 'privy', embedded: true }] : [{ address: first, name: 'Wallet one' }, { address: second, name: 'Wallet two' }],
    selectEvmSigner: setAddress,
    solanaSigners: ownerWallets ? [{ address: SOLANA_ANTARA, name: 'Privy', embedded: true }, { address: PHANTOM, name: 'Phantom' }] : [{ address: addresses.solana, name: 'Solana wallet' }],
    ...(ownerWallets ? { selectSolanaSigner: setSolanaAddress } : {}),
    exportWallet,
    balances, balancesError,
    // Counts Retry presses so the specs can prove "Couldn't load · Retry" calls the balance refresh.
    refetchBalances: async () => { const counter = window as unknown as { __fixtureRefetches?: number }; counter.__fixtureRefetches = (counter.__fixtureRefetches ?? 0) + 1; },
  }}><DesktopWallet /></WalletContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
