/**
 * Vault summary (docs/UI_ARGUS_PARITY.md 8.2): one discovery per selected Solana wallet,
 * read by the shell, the account sheet, Receive and Settings. It is derived from the same
 * calls PairedSolanaVault makes (config, account, on-chain verification, protection layers).
 *
 * `active` needs all three: a registration bound to this build's guardian, the vault read and
 * verified on Solana (verifyPairedSolanaVault) and matching that registration, and a ready layer
 * gate (a passkey in force; owner decision in layers/gate.ts). Anything less is `registered`,
 * `not-activated`, `unavailable` or `loading`: never a guess.
 *
 * Phase 1: PairedSolanaVault still discovers on its own (two reads per vault view). After the
 * layers gate it reads this provider instead.
 */
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSolaresWallet } from '../wallet/context';
import { assertWalletSession } from '../wallet/session';
import { layerGate, type LayerGate, type VaultLayersLoad } from '../layers/gate';
import { useVaultLayers } from '../layers/useVaultLayers';
import {
  PAIRED_GUARDIAN_SOLANA, PairedVaultApiError, fetchPairedConfig,
  type PairedAccount, type PairedGuardianConfig, type PairedVaultRegistration,
} from './pairedApi';
import { isLinkedHere } from '../wallet/linkRecovery';
import { readLinkedPairedAccount } from './linkedAccount';
import { resumablePairedVault } from './pendingVault';
import type { PairedSolanaVault } from './solana';

export type PairedVaultSummary =
  | { state: 'signed-out' | 'loading' | 'no-pin' | 'not-provisioned' }
  | { state: 'unavailable'; message: string }
  | {
    state: 'not-activated'; reason: 'activate' | 'pending' | 'mfa' | 'wallet' | 'previous';
    /**
     * Only with reason `wallet`: the selected wallet IS the account's ANTARA (embedded) wallet, as the
     * server lists it, but the server will not pair it (delegated signing, …). The server's reason.
     * Absent means another wallet is selected, and "use your ANTARA wallet" is the right advice.
     */
    problem?: string;
  }
  /** Verified on-chain and registered, but the layer gate is not ready: still checking, unreadable, or no passkey yet. */
  | { state: 'registered'; stage: 'checking' | 'unavailable' | 'activate-passkey'; multisig: string; depositAddress: string; layers: VaultLayersLoad }
  | { state: 'active'; multisig: string; depositAddress: string; gate: LayerGate; layers: VaultLayersLoad; releaseBlock: string };

/** What the discovery read, before the layers. Mirrors PairedSolanaVault's setup. */
export type PairedVaultDiscovery =
  | { status: 'loading' }
  | { status: 'no-pin' }
  | { status: 'not-provisioned' }
  | { status: 'error'; message: string }
  | {
    status: 'ready'; config: PairedGuardianConfig; account: PairedAccount; registration: PairedVaultRegistration | null; previous: PairedVaultRegistration | null;
    /** Only a vault verifyPairedSolanaVault returned for this registration; null otherwise. */
    vault: Pick<PairedSolanaVault, 'address' | 'depositAddress' | 'user' | 'guardian'> | null;
  };

export interface SummaryInput {
  /** The wallet provider is set up (a Privy app id). */
  configured: boolean;
  authenticated: boolean;
  /** The wallet provider has finished loading. */
  ready: boolean;
  /** The selected Solana wallet, or null. */
  owner: string | null;
  /** This build pins a guardian. */
  pinned: boolean;
  discovery: PairedVaultDiscovery;
  layers: VaultLayersLoad;
  /** A device-local resume key for a creation that was not registered (solares.paired-vault.pending.v1:*). */
  pending: string;
}

/** Pure mapping, unit-tested. Order follows PairedSolanaVault's state machine. */
export function summarizePairedVault(input: SummaryInput): PairedVaultSummary {
  if (!input.configured || !input.authenticated) return { state: 'signed-out' };
  if (!input.pinned) return { state: 'no-pin' };
  if (!input.ready) return { state: 'loading' };
  if (!input.owner) return { state: 'unavailable', message: 'Select your ANTARA Solana wallet to see its vault.' };
  const { discovery } = input;
  if (discovery.status === 'loading') return { state: 'loading' };
  if (discovery.status === 'no-pin') return { state: 'no-pin' };
  if (discovery.status === 'not-provisioned') return { state: 'not-provisioned' };
  if (discovery.status === 'error') return { state: 'unavailable', message: discovery.message };
  const { registration, vault, account, previous, config } = discovery;
  if (registration) {
    // The registration is only a pointer: without the chain's answer for exactly this vault, nothing is claimed.
    if (!vault || vault.address !== registration.multisig || vault.depositAddress !== registration.vault || vault.user !== input.owner ||
      vault.guardian !== config.guardian || registration.user !== input.owner || registration.guardian !== config.guardian) {
      return { state: 'unavailable', message: 'Your registered vault does not match the chain. Nothing is shown.' };
    }
    // A layer answer for another vault never counts for this one.
    const layers: VaultLayersLoad = input.layers.status === 'ready' && input.layers.view.multisig !== vault.address ? { status: 'loading' } : input.layers;
    const gate = layerGate(layers);
    if (gate.stage !== 'ready') return { state: 'registered', stage: gate.stage, multisig: vault.address, depositAddress: vault.depositAddress, layers };
    const ownerWallet = account.wallets.find(item => item.address === input.owner) ?? null;
    // The existing pause reasons (PairedSolanaVault): ANTARA votes on no release for a wallet that is no longer a valid pair.
    // `account.mfaEnrolled` is ignored: no account (Privy) MFA is required since 2026-10-13; MFA is the vault's own layer.
    const releaseBlock = !ownerWallet ? 'Releases are paused: this wallet is no longer linked to your ANTARA account, so ANTARA will not approve releases from this vault.'
      : ownerWallet.pairProblem ? `Releases are paused: ${ownerWallet.pairProblem}` : gate.releaseBlock;
    return { state: 'active', multisig: vault.address, depositAddress: vault.depositAddress, gate, layers, releaseBlock };
  }
  if (previous) return { state: 'not-activated', reason: 'previous' };
  const ownerWallet = account.wallets.find(item => item.address === input.owner) ?? null;
  if (!ownerWallet || ownerWallet.pairProblem) {
    const problem = antaraWalletProblem(ownerWallet);
    return problem ? { state: 'not-activated', reason: 'wallet', problem } : { state: 'not-activated', reason: 'wallet' };
  }
  // This device's resume key, or an unregistered vault the server found on Solana for this wallet (pendingVault.ts).
  return { state: 'not-activated', reason: resumablePairedVault(input.pending, account, input.owner, config.guardian) ? 'pending' : 'activate' };
}

/**
 * Why the selected wallet cannot pair a vault although it is the account's ANTARA wallet (the
 * server lists it as embedded), or null when it is another wallet (or pairs fine). Shared by the
 * summary and PairedSolanaVault so every screen says the same thing.
 */
export function antaraWalletProblem(ownerWallet: Pick<PairedAccount['wallets'][number], 'embedded' | 'pairProblem'> | null | undefined): string | null {
  return ownerWallet?.embedded && ownerWallet.pairProblem ? ownerWallet.pairProblem : null;
}

/** The resume key PairedSolanaVault writes before the creation is signed. */
export const pendingVaultKey = (privyUserId: string, owner: string) => `solares.paired-vault.pending.v1:${privyUserId}:${owner}`;
const readPending = (key: string | null) => { try { return key ? localStorage.getItem(key) || '' : ''; } catch { return ''; } };

/** `reloadLayers` re-reads only the protection layers (after a layer change), keeping the vault on screen. */
export type SummaryValue = PairedVaultSummary & { reload: () => void; reloadLayers: () => void };
const LOADING: SummaryValue = { state: 'loading', reload: () => {}, reloadLayers: () => {} };
const SummaryContext = createContext<SummaryValue | null>(null);

/** Mounted once by the shell around the whole app. */
export function PairedVaultSummaryProvider({ children }: { children: ReactNode }) {
  const wallet = useSolaresWallet();
  const owner = wallet.authenticated ? wallet.addresses.solana : null;
  const canRead = wallet.configured && wallet.authenticated && wallet.ready && !!owner && !!PAIRED_GUARDIAN_SOLANA;
  const [discovery, setDiscovery] = useState<PairedVaultDiscovery>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!canRead || !owner) { setDiscovery({ status: 'loading' }); return; }
    const controller = new AbortController();
    const session = wallet.getSession();
    setDiscovery({ status: 'loading' });
    const assertCurrent = () => {
      if (controller.signal.aborted) throw new Error('Vault view changed.');
      assertWalletSession(session, wallet.getSession());
    };
    void (async () => {
      try {
        const token = await wallet.getAccessToken();
        assertCurrent();
        if (!token) throw new Error('Sign in again to check your vault.');
        let config: PairedGuardianConfig;
        try { config = await fetchPairedConfig(token, controller.signal); }
        catch (failure) {
          if (failure instanceof PairedVaultApiError && failure.code === 'not-provisioned') { assertCurrent(); setDiscovery({ status: 'not-provisioned' }); return; }
          throw failure;
        }
        // Asked again while the server does not yet list a wallet this client sees linked (linkedAccount.ts).
        const account = await readLinkedPairedAccount({
          owner, linkedHere: isLinkedHere(wallet.linkedWallets, 'solana', owner), firstToken: token, signal: controller.signal, assertCurrent,
          token: async () => { const fresh = await wallet.getAccessToken(); assertCurrent(); if (!fresh) throw new Error('Sign in again to check your vault.'); return fresh; },
        });
        const mine = account.vaults.filter(item => item.user === owner);
        const registration = mine.find(item => item.guardian === config.guardian) ?? null;
        const previous = registration ? null : mine.find(item => item.guardian !== config.guardian) ?? null;
        let vault: PairedSolanaVault | null = null;
        if (registration) {
          // Loaded on demand: the chain read pulls in the Squads client.
          const { verifyPairedSolanaVault } = await import('./solana');
          vault = await verifyPairedSolanaVault(registration.multisig, owner, config.guardian);
          assertCurrent();
        }
        setDiscovery({ status: 'ready', config, account, registration, previous, vault });
      } catch (failure) {
        if (!controller.signal.aborted) setDiscovery({ status: 'error', message: failure instanceof Error && failure.message ? failure.message : 'Your vault could not be checked. Please try again.' });
      }
    })();
    return () => controller.abort();
    // Keyed by account, selected wallet and the account's linked wallets (a newly linked one re-runs it);
    // callback identity changes from balance refreshes must not restart it.
  }, [owner, canRead, wallet.userId, wallet.linkedWallets, attempt]);

  const vaultAddress = discovery.status === 'ready' && discovery.vault ? discovery.vault.address : null;
  const getToken = useCallback(async () => {
    const value = await wallet.getAccessToken();
    if (!value) throw new Error('Sign in again to continue.');
    return value;
  }, [wallet]);
  const layers = useVaultLayers(vaultAddress, getToken);
  const pending = readPending(wallet.userId && owner ? pendingVaultKey(wallet.userId, owner) : null);
  const reload = useCallback(() => { setAttempt(value => value + 1); layers.reload(); }, [layers.reload]);

  const value = useMemo<SummaryValue>(() => ({
    ...summarizePairedVault({
      configured: wallet.configured, authenticated: wallet.authenticated, ready: wallet.ready, owner, pinned: !!PAIRED_GUARDIAN_SOLANA,
      discovery: canRead ? discovery : { status: 'loading' }, layers: layers.load, pending,
    }),
    reload, reloadLayers: layers.reload,
  }), [wallet.configured, wallet.authenticated, wallet.ready, owner, canRead, discovery, layers.load, pending, reload, layers.reload]);
  return createElement(SummaryContext.Provider, { value }, children);
}

/** The selected Solana wallet's vault. Outside the provider it is `loading`, so nothing claims a vault state. */
export function usePairedVaultSummary(): SummaryValue {
  return useContext(SummaryContext) ?? LOADING;
}

/** Short text for the account sheet's Vault row and Settings (6.3, 6.16), from the summary only. */
export function summaryChip(summary: PairedVaultSummary): { tone: 'neutral' | 'ok' | 'warn' | 'danger'; label: string } {
  const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-5)}`;
  switch (summary.state) {
    case 'active': return summary.releaseBlock ? { tone: 'warn', label: 'Active · releases paused' } : { tone: 'ok', label: `Active · ${short(summary.multisig)}` };
    case 'registered': return summary.stage === 'activate-passkey' ? { tone: 'warn', label: 'Add a passkey to finish' }
      : summary.stage === 'checking' ? { tone: 'neutral', label: 'Checking…' } : { tone: 'danger', label: 'Status unavailable' };
    case 'not-activated': return summary.reason !== 'wallet' ? { tone: 'neutral', label: 'Not activated' }
      : summary.problem ? { tone: 'neutral', label: 'Not available for this wallet' } : { tone: 'neutral', label: 'Use your ANTARA wallet for the vault' };
    case 'no-pin': case 'not-provisioned': return { tone: 'neutral', label: 'Not available' };
    case 'unavailable': return { tone: 'danger', label: 'Status unavailable' };
    case 'loading': return { tone: 'neutral', label: 'Checking…' };
    case 'signed-out': return { tone: 'neutral', label: 'Sign in to view your vault' };
  }
}
