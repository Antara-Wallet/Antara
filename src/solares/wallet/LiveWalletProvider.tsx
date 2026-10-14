import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PrivyProvider, addRpcUrlOverrideToChain, usePrivy, useUser, useWallets as useEthereumWallets, useMfaEnrollment } from '@privy-io/react-auth';
import { toSolanaWalletConnectors, useWallets as useSolanaWallets, useSignTransaction, useSignAndSendTransaction } from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions, getBase58Decoder } from '@solana/kit';
import { Connection } from '@solana/web3.js';
import type { EIP1193Provider } from 'viem';
import { SUPPORTED_EVM_NETWORKS, byKey } from '../networks';
import { VIEM_CHAINS } from '../evmChains';
import { WalletContext, disconnectedWallet } from './context';
import { API_URL, EVM_CHAIN_IDS, PRIVY_APP_ID, PRIVY_CLIENT_ID, SOLANA_CHAIN, SOLANA_CLUSTER, SOLANA_RPC_URL, SOLANA_WS_URL, browserRpcUrl } from './config';
import { resolveEvmRpcUrls } from './evmRpc';
import type { WalletBalance, WalletChain, WalletSession } from './types';
import { assertWalletSession, guardEvmProvider } from './session';
import { assertSolanaCluster } from './solanaNetwork';
import { completeSignedTransaction, sendThroughWallet, signAndBroadcastSolanaTransaction, walletCanSignOnly } from './solanaSend';
import { parseBalanceSnapshot, sameBalanceSession } from './balances';
import {
  WALLET_NOT_CONFIRMED_MESSAGE, WalletNotLinkedError, assertTokenForUser, isLinkedHere, linkedWalletsKey, linkedWalletsOf,
  retryUntilLinked, unlinkedSelectionMessage, walletNotLinked, type LinkedChain,
} from './linkRecovery';
import { useWalletExport } from './useWalletExport';
import { embeddedWalletsOf, evmSigner, isEmbeddedAddress, isEmbeddedEvmWallet, solanaSigner } from './walletIdentity';

const solanaConnectors = toSolanaWalletConnectors();
// Ethereum, BNB Smart Chain, Robinhood Chain and Base in registry order. Privy's
// embedded wallet uses the pinned public RPC (or a public VITE_ override), never
// viem's third-party defaults. Arbitrum and Polygon are not supported.
// A malformed override keeps Privy uninitialized and shows the error; it never falls back to a default.
const evmRpc = resolveEvmRpcUrls(browserRpcUrl);
const evmChains = evmRpc.ok ? evmRpc.urls.map(({ key, url }) => addRpcUrlOverrideToChain(VIEM_CHAINS[key], url)) : [];
const defaultEvmChain = evmChains[0];
export default function LiveWalletProvider({ children }: { children: ReactNode }) {
  if (!evmRpc.ok) return <WalletContext.Provider value={{ ...disconnectedWallet, configured: false, ready: true, configError: evmRpc.error }}>{children}</WalletContext.Provider>;
  // clientId selects this build's Privy app client (web, desktop or extension) when one is configured.
  return <PrivyProvider appId={PRIVY_APP_ID} clientId={PRIVY_CLIENT_ID || undefined} config={{
    appearance: { theme: 'dark', accentColor: '#78c8ff', walletChainType: 'ethereum-and-solana' },
    // Enable these same methods in Privy. Email OTP needs no OAuth return bridge.
    loginMethods: ['email', 'wallet'],
    embeddedWallets: { ethereum: { createOnLogin: 'all-users' }, solana: { createOnLogin: 'all-users' } },
    externalWallets: { solana: { connectors: solanaConnectors } },
    // Solana is ANTARA's primary network; this only sets the EVM wallet's starting chain.
    supportedChains: evmChains, defaultChain: defaultEvmChain,
    solana: { rpcs: { [SOLANA_CHAIN]: { rpc: createSolanaRpc(SOLANA_RPC_URL), rpcSubscriptions: createSolanaRpcSubscriptions(SOLANA_WS_URL) } } },
  }}><WalletBridge>{children}</WalletBridge></PrivyProvider>;
}

function WalletBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout, getAccessToken, connectWallet } = usePrivy();
  const { showMfaEnrollmentModal } = useMfaEnrollment();
  const { wallets: solanaWallets, ready: solanaReady } = useSolanaWallets();
  const { wallets: ethereumWallets, ready: ethereumReady } = useEthereumWallets();
  const { signTransaction } = useSignTransaction();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const [selectedSolana, setSelectedSolana] = useState('');
  const [selectedEvm, setSelectedEvm] = useState('');
  const { refreshUser } = useUser();
  // The account's own embedded wallets, from Privy's linked accounts only (walletIdentity.ts): the
  // "ANTARA wallet", the default selection and the only wallets Privy's key export opens for.
  const embedded = embeddedWalletsOf(user?.linkedAccounts);
  // The wallets Privy links to this account: what the API server checks (linkRecovery.ts). Stable
  // while the set is unchanged; a change re-runs balances and the vault reads keyed on it.
  const linkedKey = linkedWalletsKey(linkedWalletsOf(user?.linkedAccounts));
  const linkedWallets = useMemo(() => linkedWalletsOf(user?.linkedAccounts), [linkedKey]);
  // A connected wallet that is not linked is never the default: the server refuses every read for it.
  const solana = solanaWallets.find(w => w.address === selectedSolana) ?? solanaWallets.find(w => isEmbeddedAddress(embedded, 'solana', w.address))
    ?? solanaWallets.find(w => isLinkedHere(linkedWallets, 'solana', w.address)) ?? solanaWallets[0];
  const ethereum = ethereumWallets.find(w => w.address === selectedEvm) ?? ethereumWallets.find(w => isEmbeddedEvmWallet(w, embedded))
    ?? ethereumWallets.find(w => isLinkedHere(linkedWallets, 'ethereum', w.address)) ?? ethereumWallets[0];
  const solanaAddress = authenticated ? solana?.address || null : null;
  const ethereumAddress = authenticated ? ethereum?.address || null : null;
  const walletsReady = ready && solanaReady && ethereumReady;
  const session: WalletSession = { authenticated, userId: user?.id || null, addresses: { solana: solanaAddress, ethereum: ethereumAddress } };
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const assertCurrent = () => assertWalletSession(session, sessionRef.current);
  const getSession = useCallback(() => ({ ...sessionRef.current, addresses: { ...sessionRef.current.addresses } }), []);
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balancesError, setBalancesError] = useState<string | null>(null);
  const requestId = useRef(0);
  const balanceRequest = useRef<AbortController | null>(null);
  const userId = user?.id || null;
  // Privy's getAccessToken() returns whatever token this origin holds, including one another tab
  // or window signed in with, and never compares it to this tab's user (linkRecovery.ts). Every
  // ANTARA request takes its token from here, so a token for another account is never sent.
  const [sessionChanged, setSessionChanged] = useState(false);
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const getSessionToken = useCallback(async () => {
    const token = await getAccessToken();
    try { assertTokenForUser(token, userIdRef.current); }
    catch (error) { setSessionChanged(true); throw error; }
    if (token) setSessionChanged(false);
    return token;
  }, [getAccessToken]);
  useEffect(() => { setSessionChanged(false); }, [userId]);
  // Re-reads this tab's Privy user, but never with another account's token: that would silently
  // switch the account this tab shows.
  const syncUser = useCallback(async () => {
    try { if (await getSessionToken()) await refreshUser(); } catch { /* the next read reports it */ }
  }, [getSessionToken, refreshUser]);
  // "Sign in again": sign the mismatched session out, then open Privy's sign-in once signed out.
  const [signInPending, setSignInPending] = useState(false);
  useEffect(() => { if (signInPending && ready && !authenticated) { setSignInPending(false); login(); } }, [signInPending, ready, authenticated, login]);
  const refetchBalances = useCallback(async () => {
    const snapshot: WalletSession = { authenticated, userId, addresses: { solana: solanaAddress, ethereum: ethereumAddress } };
    // A completed operation may retain an earlier render's callback after a
    // wallet switch. It must not abort or clear the new wallet's request.
    if (!sameBalanceSession(snapshot, sessionRef.current)) return;
    const currentRequest = ++requestId.current;
    balanceRequest.current?.abort();
    if (!authenticated || !userId || (!solanaAddress && !ethereumAddress)) { setBalances([]); setBalancesLoading(false); setBalancesError(null); return; }
    const controller = new AbortController();
    balanceRequest.current = controller;
    const canCommit = () => currentRequest === requestId.current && sameBalanceSession(snapshot, sessionRef.current);
    setBalancesLoading(true); setBalancesError(null);
    // Only wallets Privy links to this account are asked for: the server refuses any other, and
    // one refused wallet would hide every balance. A skipped selection is named, never shown as zero.
    const requested = {
      solana: isLinkedHere(linkedWallets, 'solana', solanaAddress) ? solanaAddress : null,
      ethereum: isLinkedHere(linkedWallets, 'ethereum', ethereumAddress) ? ethereumAddress : null,
    };
    // Until Privy lists the account's own wallets, the default can briefly be a connected one: that is
    // still loading, not an unlinked selection, and this runs again when the wallets are ready.
    const skipped: LinkedChain[] = walletsReady ? (['solana', 'ethereum'] as const).filter(chain => (chain === 'solana' ? solanaAddress : ethereumAddress) && !requested[chain]) : [];
    // This client's account may be behind Privy's (a wallet linked elsewhere): bring it up to date once.
    if (skipped.length) void syncUser();
    try {
      if (!requested.solana && !requested.ethereum) {
        if (!skipped.length) return;
        throw new Error(unlinkedSelectionMessage(skipped[0]));
      }
      // A wallet Privy created a moment ago may not be in the server's read yet: asked again at 1.5 s, 4 s and 10 s.
      const result = await retryUntilLinked(async () => {
        const token = await getSessionToken();
        controller.signal.throwIfAborted();
        assertWalletSession(snapshot, sessionRef.current);
        if (!token) throw new Error('Sign in to read your balances.');
        const params = new URLSearchParams();
        if (requested.solana) params.set('solana', requested.solana);
        if (requested.ethereum) params.set('ethereum', requested.ethereum);
        const response = await fetch(`${API_URL}/api/solares/wallet/balances?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]) });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw walletNotLinked(response.status, body) ?? new Error(typeof body?.error === 'string' && body.error ? body.error : 'Balances are unavailable.');
        return body;
      }, { signal: controller.signal, retryable: outcome => !outcome.ok && outcome.error instanceof WalletNotLinkedError });
      if (!canCommit()) return;
      assertWalletSession(snapshot, sessionRef.current);
      // Registry order: Solana first, then every supported EVM network.
      const chains: WalletChain[] = requested.solana ? ['solana'] : [];
      if (requested.ethereum) chains.push(...SUPPORTED_EVM_NETWORKS.map(network => network.key));
      const validated = parseBalanceSnapshot(result, chains, SOLANA_CLUSTER);
      setBalances(validated.balances);
      const notes = [
        ...skipped.map(unlinkedSelectionMessage),
        ...(validated.failures.length ? [`Live balances unavailable on ${validated.failures.map(chain => byKey(chain).name).join(', ')}. Check your RPC connections.`] : []),
      ];
      if (notes.length) setBalancesError(notes.join(' '));
    } catch (error) {
      if (!canCommit()) return;
      // Still refused after every retry: the two disagree for real. Bring this client's account up to
      // date with Privy; if its wallets change, balances run again for the wallets it really has.
      if (error instanceof WalletNotLinkedError) void syncUser();
      setBalances([]);
      setBalancesError(error instanceof WalletNotLinkedError ? WALLET_NOT_CONFIRMED_MESSAGE : error instanceof Error ? error.message : 'Balances are unavailable.');
    } finally { if (canCommit()) setBalancesLoading(false); }
  }, [authenticated, userId, solanaAddress, ethereumAddress, linkedWallets, walletsReady, getSessionToken, syncUser]);
  useEffect(() => { setBalances([]); void refetchBalances(); return () => { requestId.current++; balanceRequest.current?.abort(); }; }, [refetchBalances]);

  const getEvmProvider = async (chainId: number): Promise<EIP1193Provider> => {
    assertCurrent();
    if (!authenticated || !ethereum) throw new Error('Connect an EVM wallet first.');
    if (!EVM_CHAIN_IDS.includes(chainId as typeof EVM_CHAIN_IDS[number])) throw new Error('Unsupported EVM chain.');
    await ethereum.switchChain(chainId);
    assertCurrent();
    const provider = await ethereum.getEthereumProvider();
    return guardEvmProvider(provider as EIP1193Provider, chainId, ethereum.address, assertCurrent);
  };
  // The account's Privy embedded wallets are the "ANTARA wallet" (walletIdentity), and the only
  // wallets Privy's secure key export opens for (useWalletExport), only with this tab's own token.
  const solanaSigners = solanaWallets.map(w => solanaSigner(w, embedded));
  const evmSigners = ethereumWallets.map(w => evmSigner(w, embedded));
  const exportWallet = useWalletExport({ authenticated, sessionChanged, getSessionToken, embedded });
  const signOut = async () => {
    sessionRef.current = { ...sessionRef.current, authenticated: false };
    requestId.current++; balanceRequest.current?.abort(); setBalances([]); setBalancesError(null); setBalancesLoading(false); setSessionChanged(false);
    await logout();
  };
  return <WalletContext.Provider value={{
    configured: true, ready: ready && solanaReady && ethereumReady, authenticated, userId: user?.id || null,
    addresses: { solana: solanaAddress, ethereum: ethereumAddress }, login: () => login(), logout: signOut,
    connectWallet: () => connectWallet(), enrollMfa: showMfaEnrollmentModal, getAccessToken: getSessionToken, getSession,
    sessionChanged, linkedWallets,
    signInAgain: () => { setSignInPending(true); void signOut().catch(() => setSignInPending(false)); },
    balances, balancesLoading, balancesError, refetchBalances, getEvmProvider,
    signSolanaTransaction: async transaction => {
      assertCurrent();
      if (!authenticated || !solana) throw new Error('Connect a Solana wallet first.');
      await assertSolanaCluster(new Connection(SOLANA_RPC_URL), SOLANA_CLUSTER);
      assertCurrent();
      const result = await signTransaction({ transaction, wallet: solana, chain: SOLANA_CHAIN, options: { uiOptions: { showWalletUIs: true } } });
      // The exact requested message, fully signed (a bare signature is placed in this wallet's slot).
      return completeSignedTransaction(transaction, result.signedTransaction, solana.address).bytes;
    },
    sendSolanaTransaction: async transaction => {
      assertCurrent();
      if (!authenticated || !solana) throw new Error('Connect a Solana wallet first.');
      const owner = solana;
      const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
      await assertSolanaCluster(connection, SOLANA_CLUSTER);
      assertCurrent();
      // Sign only, broadcast once through ANTARA's RPC and return the signature at once
      // (solanaSend.ts); callers confirm by HTTP polling (solanaConfirm.ts). Privy's own send
      // waits on a websocket that timed out after broadcasting and lost the signature.
      if (walletCanSignOnly(owner)) {
        return signAndBroadcastSolanaTransaction(transaction, {
          signer: owner.address, rpc: connection, beforeBroadcast: assertCurrent,
          sign: async bytes => (await signTransaction({ transaction: bytes, wallet: owner, chain: SOLANA_CHAIN, options: { uiOptions: { showWalletUIs: true } } })).signedTransaction,
        });
      }
      // A wallet that can only sign and send itself: its own send, without Privy's confirmation wait.
      return sendThroughWallet(async () => getBase58Decoder().decode((await signAndSendTransaction({
        transaction, wallet: owner, chain: SOLANA_CHAIN, options: { skipSimulation: false, optimisticBroadcast: true, uiOptions: { showWalletUIs: true } },
      })).signature));
    },
    solanaSigners,
    selectSolanaSigner: address => {
      if (!solanaWallets.some(wallet => wallet.address === address)) throw new Error('Connect this Solana owner first.');
      sessionRef.current = { ...sessionRef.current, addresses: { ...sessionRef.current.addresses, solana: address } };
      setSelectedSolana(address);
    },
    evmSigners,
    selectEvmSigner: address => {
      if (!ethereumWallets.some(wallet => wallet.address === address)) throw new Error('Connect this EVM owner first.');
      sessionRef.current = { ...sessionRef.current, addresses: { ...sessionRef.current.addresses, ethereum: address } };
      setSelectedEvm(address);
    },
    exportWallet,
  }}>{children}</WalletContext.Provider>;
}
