import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSolaresWallet } from '../wallet';
import { SOLANA_CLUSTER } from '../wallet/config';
import { assertWalletSession } from '../wallet/session';
import { SOLANA_NETWORK, explorerAddressUrl, explorerTxUrl } from '../networks';
import { formatAmount } from '../relay/model';
import { TokenLogo } from '../TokenLogo';
import { ExternalLink } from '../../platform/ExternalLink';
import {
  PAIRED_GUARDIAN_SOLANA, PairedVaultApiError, fetchPairedConfig, fetchPairedUsage, hasPairedCap, pairedReleaseBounds, registerPairedVault,
  type PairedAccount, type PairedApproval, type PairedAsset, type PairedGuardianConfig, type PairedUsage, type PairedVaultRegistration,
} from './pairedApi';
import { isLinkedHere } from '../wallet/linkRecovery';
import { readLinkedPairedAccount } from './linkedAccount';
import { antaraWalletProblem } from './summary';
import {
  createPairedSolanaVault, depositPairedSolanaVault, executePairedSolanaRelease, proposePairedSolanaRelease, readPairedSolanaProposal,
  vaultRentMinimum, verifyPairedSolanaVault, waitForPairedApproval, type PairedSolanaProposal, type PairedSolanaVault,
} from './solana';
import { PRIVATE_RELEASE_PROBLEM, VaultAmountError, exactAmount, releaseAmountProblem } from './vaultAmounts';
import { VaultTransactionError } from './transaction';
import { PAIRED_VAULT_CLAIMS, SURFACE_NOTES } from '../layers/claims';
import { beginLayerChange, beginReleaseLayers, finishLayerChange, startReleaseApproval, submitReleaseApproval, type ReleaseOnDevice } from '../layers/flow';
import { layerGate, pendingNotices } from '../layers/gate';
import { PendingChangeAlert, revealPendingChanges } from '../layers/PendingChangeAlert';
import { defaultDeviceKeyStorage, defaultLayerPlatform } from '../layers/platform';
import type { LayerId } from '../layers/types';
import { useVaultLayers } from '../layers/useVaultLayers';
import { VaultLayers, type LayerFormKind, type LayerRequest } from '../layers/VaultLayers';
import { DEVICE_NAMES, setupTitle } from '../layers/copy';
import { trustThisDevice } from '../layers/setup';
import { ActivationSequence, type ActivationProgress } from '../verification/ActivationSequence';
import { DepositPanel, parseDepositAmount, transactionNotice, type DepositAsset } from '../verification/DepositPanel';
import { friendlyError } from '../ui/friendlyError';
import { REQUESTING_APPROVAL, VerificationSequence, type LayerAnswer, type ReleaseProgress } from '../verification/VerificationSequence';
import type { ReleaseCardData } from '../verification/VerificationSequenceView';
import { VAULT_ACTIVITY_EVENT, recordVaultActivity, vaultActivity, type VaultActivityRecord } from './vaultActivity';
import { AddressText, Icon } from '../ui';
import { CREATION_COST_FALLBACK, creationCostDetail, creationFunding, readVaultCreationCost, roundedSol, type VaultCreationCost } from './creationCost';
import { peekVaultIntent, takeVaultIntent } from './vaultIntent';
import { chainPendingReader, pendingDiscard, readPendingAccountState, resumablePairedVault, type PendingChainState } from './pendingVault';
import { CreateVaultHero, VaultActionRow, VaultBalanceCard, VaultClaimsCard, VaultLayersPreview, VaultProtectionCard, VaultStateCard, type FundingView, type VaultAction, type VaultCardValue } from './VaultCards';
import { usePrices } from '../wallet/usePrices';
import { vaultValue } from './vaultValue';
import './vaults.css';

type Setup =
  | { status: 'loading' }
  | { status: 'no-pin' }
  | { status: 'not-provisioned' }
  | { status: 'error'; message: string }
  | { status: 'ready'; config: PairedGuardianConfig; account: PairedAccount; registration: PairedVaultRegistration | null; previous: PairedVaultRegistration | null; vault: PairedSolanaVault | null; usage: PairedUsage | null };
/** The release shown in the verification sequence (docs/UI_ARGUS_PARITY.md 6.14). */
type ReleaseView = { index: string; card: ReleaseCardData; progress: ReleaseProgress };
const DECIMALS: Record<PairedAsset, number> = { SOL: 9, USDC: 6 };
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-5)}`;
const amount = (raw: bigint | string, asset: PairedAsset) => `${formatAmount(raw.toString(), DECIMALS[asset])} ${asset}`;
const read = (key: string | null) => { try { return key ? localStorage.getItem(key) || '' : ''; } catch { return ''; } };
const write = (key: string | null, value: string) => { try { if (key) { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } } catch { /* A local convenience only; the chain and the API are authoritative. */ } };
const message = (failure: unknown, fallback: string) => failure instanceof Error && failure.message ? friendlyError(failure.message, fallback) : fallback;
const activityId = () => `va_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/**
 * The spending wallet's balance in raw units, or null when it is not known (never read as zero).
 * A network whose read failed is left out of `balances` (wallet/balances.ts), so a missing entry is unknown
 * and a present one was read, even while another network reports an error.
 */
function walletRaw(balances: { chain: string; symbol: string; isNative: boolean; raw: string }[], loading: boolean, asset: PairedAsset): bigint | null {
  if (loading) return null;
  const entry = balances.find(item => item.chain === 'solana' && (asset === 'SOL' ? item.isNative : !item.isNative && item.symbol === 'USDC'));
  try { return entry ? BigInt(entry.raw) : null; } catch { return null; }
}
/** How a stopped release reads in the sequence (the vault flow's own messages, solana.ts). */
const stopReason = (failure: unknown): Extract<ReleaseProgress, { step: 'stopped' }>['reason'] =>
  failure instanceof VaultTransactionError ? 'transaction'
    : /has not reached the chain yet/.test(message(failure, '')) ? 'vote-timeout'
    : /rejected, cancelled or replaced/.test(message(failure, '')) ? 'rejected' : 'other';

/** Honest claims for paired Solana vaults (docs/GUARDIAN.md, docs/SECURITY.md), shared with the layer UI (layers/claims.ts). */
const CLAIMS = PAIRED_VAULT_CLAIMS;

/** Shell hand-offs read by the Vault side (5.4): `#vaultdeposit` focuses Deposit, `#vaultlayers` opens the layers. */
type PanelRequest = '' | 'vaultdeposit' | 'vaultlayers';
function hashPanel(): PanelRequest {
  try { const hash = window.location.hash.slice(1); return hash === 'vaultdeposit' || hash === 'vaultlayers' ? hash : ''; } catch { return ''; }
}
/** Scrolls a vault panel into view and focuses its first enabled control. */
function focusPanel(selector: string) {
  window.setTimeout(() => {
    const panel = document.querySelector<HTMLElement>(selector);
    if (!panel) return;
    panel.scrollIntoView({ block: 'start' });
    (panel.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), button:not([disabled])') ?? panel).focus();
  }, 0);
}
const ACTIVITY_LABEL: Record<VaultActivityRecord['kind'], string> = { deposit: 'Deposit', release: 'Release', activation: 'Vault activated' };

/** This vault's records on this device (8.5), newest first, refreshed when a record is saved. */
function useVaultRecords(privyUserId: string | null, multisig: string | null): VaultActivityRecord[] {
  const [records, setRecords] = useState<VaultActivityRecord[]>([]);
  useEffect(() => {
    const update = () => setRecords(privyUserId && multisig ? vaultActivity(privyUserId).filter(record => record.multisig === multisig) : []);
    update();
    window.addEventListener(VAULT_ACTIVITY_EVENT, update);
    window.addEventListener('storage', update);
    return () => { window.removeEventListener(VAULT_ACTIVITY_EVENT, update); window.removeEventListener('storage', update); };
  }, [privyUserId, multisig]);
  return records;
}

export function PairedSolanaVault({ privacy, onPrivacy, onSignIn, onWallet, onSettings, onReceive, onFundWallet }: {
  privacy: boolean; onPrivacy: () => void; onSignIn: () => void; onWallet: () => void; onSettings: () => void;
  /** The Receive sheet (vault side) for deposits from any other wallet; the wallet screen when absent. */
  onReceive?: () => void;
  /** Receive into the spending wallet (wallet side), to add the SOL a vault creation needs. Defaults to `#receive`. */
  onFundWallet?: () => void;
}) {
  const wallet = useSolaresWallet();
  const owner = wallet.authenticated ? wallet.addresses.solana : null;
  const canRead = wallet.configured && wallet.authenticated && wallet.ready && !!owner;
  const [setup, setSetup] = useState<Setup>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [settings, setSettings] = useState(false);
  const [moveTab, setMoveTab] = useState<'deposit' | 'release'>('deposit');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [signature, setSignature] = useState('');
  const [releaseAsset, setReleaseAsset] = useState<PairedAsset>('SOL');
  const [releaseAmount, setReleaseAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  // The release the user is reviewing before the propose signature; inputs are frozen meanwhile.
  const [review, setReview] = useState<{ to: string; asset: PairedAsset; amount: string } | null>(null);
  const [proposal, setProposal] = useState<PairedSolanaProposal | null>(null);
  // The verification sequence (6.14) and the activation sequence (6.12). This component stays the only caller of the vault functions.
  const [releaseView, setReleaseView] = useState<ReleaseView | null>(null);
  const [activationOpen, setActivationOpen] = useState(false);
  const [activation, setActivation] = useState<ActivationProgress>({ stage: 'idle' });
  const releaseViewRef = useRef<ReleaseView | null>(null);
  releaseViewRef.current = releaseView;
  const [layerRequest, setLayerRequest] = useState<LayerRequest | null>(null);
  const layerPlatform = useMemo(() => defaultLayerPlatform(), []);
  const layerKeys = useMemo(() => defaultDeviceKeyStorage(), []);
  const ready = setup.status === 'ready' ? setup : null;
  // The activation sheet outlives the reload after registration, so it keeps the last confirmed config.
  const lastConfig = useRef<PairedGuardianConfig | null>(null);
  if (ready) lastConfig.current = ready.config;
  const vault = canRead && ready ? ready.vault : null;
  // Protection layers are read for the chain-verified vault only. Until they answer, deposits and releases wait here.
  const layers = useVaultLayers(vault?.address ?? null, token);
  const gate = layerGate(layers.load);
  // Pending loosening or recovery changes are shown on the vault itself, not only in settings: there are no notifications (O7).
  const pendingChanges = pendingNotices(layers.load);
  const reviewPending = () => { setSettings(true); revealPendingChanges(); };
  // A layer action belongs to the account and wallet that were showing when it started.
  const layerSession = useRef(wallet.getSession());
  useEffect(() => { layerSession.current = wallet.getSession(); setLayerRequest(null); }, [owner, wallet.userId, vault?.address]);
  // The sequence belongs to one account, wallet and vault. A reload (vault briefly null) keeps it, so "done" stays on screen.
  const sequenceVault = useRef<string | null>(null);
  useEffect(() => { setReleaseView(null); sequenceVault.current = null; }, [owner, wallet.userId]);
  useEffect(() => {
    if (vault?.address && sequenceVault.current && sequenceVault.current !== vault.address) setReleaseView(null);
    if (vault?.address) sequenceVault.current = vault.address;
  }, [vault?.address]);
  // Another account or wallet never sees this one's activation progress.
  useEffect(() => { setActivationOpen(false); setActivation({ stage: 'idle' }); }, [owner, wallet.userId]);
  const assertLayerSession = () => assertWalletSession(layerSession.current, wallet.getSession());
  const openLayerForm = (form: LayerFormKind) => { setSettings(true); setLayerRequest({ form, id: Date.now() }); };
  /** Opens Vault settings at the protection list; with a layer, that layer's sheet (Turn on, or Manage when it is on). */
  const openLayers = (layer?: LayerId) => {
    setSettings(true);
    if (layer) setLayerRequest({ layer, id: Date.now() });
    window.setTimeout(() => (layer && document.querySelector(`.vl [data-layer="${layer}"]`) || document.getElementById('vl-title'))?.scrollIntoView({ block: 'start' }), 0);
  };
  const [panelRequest, setPanelRequest] = useState<PanelRequest>(hashPanel);
  useEffect(() => {
    const update = () => setPanelRequest(hashPanel());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const [assetTab, setAssetTab] = useState<'tokens' | 'activity'>('tokens');
  const records = useVaultRecords(wallet.userId ?? null, vault?.address ?? null);
  // Solana's rent-exempt minimum for the deposit address, read live (vaultAmounts.ts); null until read. The deposit and
  // release builders read it again before anything is signed.
  const [rentMinimum, setRentMinimum] = useState<bigint | null>(null);
  useEffect(() => {
    if (!vault?.address) return;
    let live = true;
    vaultRentMinimum().then(value => { if (live) setRentMinimum(value); }, () => { if (live) setRentMinimum(null); });
    return () => { live = false; };
  }, [vault?.address, attempt]);
  // Device-local resume points. Public addresses only; the chain and the API decide everything.
  const pendingKey = wallet.userId && owner ? `solares.paired-vault.pending.v1:${wallet.userId}:${owner}` : null;
  const proposalKey = wallet.userId && vault ? `solares.paired-vault.proposal.v1:${wallet.userId}:${vault.address}` : null;
  const [pending, setPending] = useState('');
  const [proposalIndex, setProposalIndex] = useState('');
  useEffect(() => { setPending(read(pendingKey)); }, [pendingKey]);
  useEffect(() => { setProposalIndex(read(proposalKey)); setProposal(null); }, [proposalKey]);
  // The creation to resume: this device's key, else an unregistered vault the server found on Solana (pendingVault.ts).
  const resumable = resumablePairedVault(pending, ready?.account ?? null, owner, ready?.config.guardian ?? null);
  const resumeKey = resumable?.multisig ?? '';
  // Whether that vault's account exists on Solana: only a creation that never landed may be discarded.
  const [pendingChain, setPendingChain] = useState<{ multisig: string; state: PendingChainState } | null>(null);
  const checkPendingChain = async (multisig: string): Promise<PendingChainState> => {
    setPendingChain({ multisig, state: 'checking' });
    const state: PendingChainState = await chainPendingReader().then(reader => readPendingAccountState(multisig, reader, SOLANA_CLUSTER === 'devnet' ? 'devnet' : 'mainnet-beta')).catch(() => 'unknown');
    setPendingChain(current => current?.multisig === multisig ? { multisig, state } : current);
    return state;
  };
  useEffect(() => { if (resumeKey) void checkPendingChain(resumeKey); else setPendingChain(null); }, [resumeKey, activation.stage]); // eslint-disable-line react-hooks/exhaustive-deps
  const discard = pendingDiscard(resumable, pendingChain);
  /** "Discard this attempt": asks Solana again first, and forgets the key only when no account exists there. */
  async function discardPending() {
    const multisig = pending;
    if (!multisig || await checkPendingChain(multisig) !== 'missing' || read(pendingKey) !== multisig) return;
    rememberPending(''); setActivation({ stage: 'idle' }); setActivationOpen(false);
  }

  useEffect(() => {
    if (!canRead || !owner) return;
    const controller = new AbortController();
    const session = wallet.getSession();
    setSetup({ status: 'loading' });
    const assertCurrent = () => {
      if (controller.signal.aborted) throw new Error('Vault view changed.');
      assertWalletSession(session, wallet.getSession());
    };
    void (async () => {
      try {
        if (!PAIRED_GUARDIAN_SOLANA) { setSetup({ status: 'no-pin' }); return; }
        const token = await wallet.getAccessToken();
        assertCurrent();
        if (!token) throw new Error('Sign in again to check your vault.');
        let config: PairedGuardianConfig;
        try { config = await fetchPairedConfig(token, controller.signal); }
        catch (failure) {
          if (failure instanceof PairedVaultApiError && failure.code === 'not-provisioned') { assertCurrent(); setSetup({ status: 'not-provisioned' }); return; }
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
        let vault: PairedSolanaVault | null = null, usage: PairedUsage | null = null;
        if (registration) {
          // The registration is only a pointer: the vault is shown only after the chain proves it.
          vault = await verifyPairedSolanaVault(registration.multisig, owner, config.guardian);
          assertCurrent();
          if (vault.depositAddress !== registration.vault) throw new Error('Your registered vault does not match the chain. Nothing is shown.');
          usage = await fetchPairedUsage(token, registration.multisig, controller.signal);
          assertCurrent();
        }
        setSetup({ status: 'ready', config, account, registration, previous, vault, usage });
      } catch (failure) {
        if (!controller.signal.aborted) setSetup({ status: 'error', message: message(failure, 'Your vault could not be checked. Please try again.') });
      }
    })();
    return () => controller.abort();
    // Parent keys this component by account, selected wallet and chain. Callback
    // identity changes caused by balance refreshes must not restart the check.
  }, [owner, canRead, wallet.userId, wallet.linkedWallets, attempt]);

  // Release recipients are bound on this device. The server's list says which wallets are linked to
  // your account (no link-age wait since 2026-10-13); a wallet is offered only if this client also sees
  // it as one of your own Solana wallets (your ANTARA wallet or one connected here), so a compromised
  // server cannot add one.
  const ownWallets = new Set([owner, ...wallet.solanaSigners.map(item => item.address)].filter((address): address is string => !!address));
  const linked = ready ? ready.account.wallets.filter(item => item.address !== ready.config.guardian) : [];
  const recipients = linked.filter(item => ownWallets.has(item.address));
  const unconfirmed = linked.length - recipients.length;
  const recipientAddresses = recipients.map(item => item.address);
  useEffect(() => {
    if (!vault || !owner || !proposalIndex) return;
    let live = true;
    readPairedSolanaProposal(vault, proposalIndex, owner, recipientAddresses)
      .then(result => { if (live) setProposal(result); })
      .catch(failure => { if (live) { setProposal(null); setError(message(failure, 'The saved release could not be read.')); } });
    return () => { live = false; };
  }, [vault?.address, vault?.observedAt, owner, proposalIndex]);

  async function token() {
    const value = await wallet.getAccessToken();
    if (!value) throw new Error('Sign in again to continue.');
    return value;
  }
  const signer = { address: owner || '', send: wallet.sendSolanaTransaction };
  const explorerUrl = (value: string) => explorerTxUrl(SOLANA_NETWORK, value, { solanaCluster: SOLANA_CLUSTER });
  async function run(label: string, operation: () => Promise<void>) {
    if (busy) return;
    const session = wallet.getSession();
    setBusy(label); setError(''); setNotice(''); setSignature('');
    try { await operation(); assertWalletSession(session, wallet.getSession()); }
    catch (failure) {
      // An amount problem can state balances (vaultAmounts.ts): with privacy on, only that the amount can't be released.
      setError(privacy && failure instanceof VaultAmountError ? PRIVATE_RELEASE_PROBLEM : message(failure, 'The vault action could not be completed.'));
      if (failure instanceof VaultTransactionError) {
        setSignature(failure.signature);
        setNotice(failure.outcome === 'reverted' ? 'The transaction reverted on-chain. Nothing moved; network fees may have been charged.'
          : failure.confirmed ? 'The transaction is confirmed, but the result could not be verified yet. Check the explorer before trying again.'
          : 'The transaction was submitted but is not confirmed yet. Check the explorer and do not repeat it.');
      }
    } finally { setBusy(''); }
  }
  const reload = async () => { setAttempt(value => value + 1); await wallet.refetchBalances().catch(() => undefined); };
  const rememberPending = (value: string) => { write(pendingKey, value); setPending(value); };
  const rememberProposal = (value: string) => { write(proposalKey, value); setProposalIndex(value); if (!value) setProposal(null); };

  /** Runs one activation step list, reporting each awaited call to the activation sequence (6.12 step 3). */
  function activationSteps(label: string, steps: (at: (stage: 'creating' | 'registering' | 'reading') => void) => Promise<void>) {
    let stage: 'creating' | 'registering' | 'reading' = 'creating';
    const at = (next: typeof stage) => { stage = next; setActivation({ stage: next }); };
    setActivation({ stage: 'creating' });
    void run(label, async () => {
      try {
        await steps(at);
        setActivation({ stage: 'registered' });
      } catch (failure) {
        const signatureFrom = failure instanceof VaultTransactionError ? failure.signature : undefined;
        setActivation({ stage: 'failed', at: stage, message: message(failure, 'The vault action could not be completed.'),
          ...(failure instanceof VaultTransactionError ? { notice: transactionNotice(failure) } : {}), ...(signatureFrom ? { signature: signatureFrom } : {}) });
        throw failure;
      }
    });
  }
  function activate() {
    if (!ready || !owner) return;
    const config = ready.config;
    activationSteps('Creating your vault', async at => {
      // The pending key is written before signing (rememberPending), so a reload resumes at "Finish activation".
      const created = await createPairedSolanaVault(signer, config.guardian, rememberPending);
      setSignature(created.signature);
      if (wallet.userId) recordVaultActivity(wallet.userId, { id: activityId(), kind: 'activation', multisig: created.vault.address, signature: created.signature, status: 'confirmed', createdAt: new Date().toISOString() });
      at('registering'); setBusy('Registering your vault with ANTARA');
      await registerPairedVault(await token(), created.vault.address);
      rememberPending('');
      at('reading'); setBusy('Reading your vault and its protection layers');
      setNotice('Your vault is created and registered. Add a passkey to finish activating it.');
      await reload();
    });
  }
  function finishActivation() {
    if (!ready || !owner || !resumeKey) return;
    const config = ready.config;
    const multisig = resumeKey;
    activationSteps('Finishing activation', async at => {
      const verified = await verifyPairedSolanaVault(multisig, owner, config.guardian);
      at('registering');
      await registerPairedVault(await token(), verified.address);
      rememberPending('');
      at('reading');
      setNotice('Your vault is created and registered. Add a passkey to finish activating it.');
      await reload();
    });
  }
  /**
   * Activation step 4: the vault's first passkey through the layers module's passkey.add (applies at once only from this
   * app, within its window), then, in the same flow, this device is trusted for the vault (device.add, its own passkey
   * prompt), so the layers that read from this device later only need their own permission and passkey. Trusting is never
   * fatal here: the passkey is already in force, and any layer that needs this device trusts it first.
   */
  async function addFirstPasskey(onStep?: (label: string) => void): Promise<{ trusted: boolean }> {
    if (!vault || !wallet.userId) throw new Error('Your vault is still loading. Try again in a moment.');
    assertLayerSession();
    const surface = layerPlatform.capabilities().surface;
    const context = { platform: layerPlatform, keys: layerKeys, privyUserId: wallet.userId, multisig: vault.address };
    const op = { type: 'passkey.add' as const, label: surface === 'desktop' ? 'Windows Hello' : 'Passkey' };
    onStep?.('Creating your passkey');
    const challenge = await beginLayerChange(await token(), vault.address, op);
    await finishLayerChange(token, op, challenge, context);
    assertLayerSession();
    let trusted = false;
    try {
      onStep?.(`${setupTitle(surface)}: confirm with your passkey again`);
      await trustThisDevice({ token, context, deviceLabel: DEVICE_NAMES[surface] });
      assertLayerSession();
      trusted = true;
    } catch { /* Not fatal: the first layer that reads from this device trusts it first. */ }
    layers.reload();
    return { trusted };
  }
  /** DepositPanel's deposit (6.13): re-verifies the vault on Solana before paying (depositPairedSolanaVault). */
  async function depositInto(asset: DepositAsset, value: string): Promise<string> {
    if (!vault) throw new Error('Your vault is not loaded. Nothing was sent.');
    if (depositBlock) throw new Error(depositBlock);
    const session = wallet.getSession();
    const hash = await depositPairedSolanaVault(signer, vault, asset, value);
    assertWalletSession(session, wallet.getSession());
    if (wallet.userId) recordVaultActivity(wallet.userId, { id: activityId(), kind: 'deposit', multisig: vault.address, asset, amount: value, signature: hash, status: 'confirmed', createdAt: new Date().toISOString() });
    void reload();
    return hash;
  }
  /** The release as this device reads it from Solana now. The server's description of it must match exactly. */
  async function releaseOnDevice(index: string): Promise<ReleaseOnDevice> {
    if (!vault || !owner) throw new Error('Your vault is not loaded. Nothing was approved.');
    const current = await readPairedSolanaProposal(vault, index, owner, recipientAddresses);
    if (current.stale || current.status !== 'Active') throw new Error('This release is no longer waiting for approval. Nothing was approved.');
    return { asset: current.asset, amountRaw: current.amountRaw, recipient: current.recipient };
  }
  /** Moves the open sequence to `progress` (only for the release it shows). */
  const progressTo = (index: string, progress: ReleaseProgress) => setReleaseView(current => current && current.index === index ? { ...current, progress } : current);
  /** Runs a release step; on failure the sequence shows where it stopped, with the vault flow's own message. */
  async function releaseStep(index: string, at: 'propose' | 'vote' | 'execute', answer: LayerAnswer | null, work: () => Promise<void>) {
    try { await work(); }
    catch (failure) {
      progressTo(index, { step: 'stopped', at, answer, message: failure instanceof VaultTransactionError ? `${friendlyError(failure.message)} ${transactionNotice(failure)}` : message(failure, 'The vault action could not be completed.'),
        reason: stopReason(failure), ...(failure instanceof VaultTransactionError && failure.signature ? { signature: failure.signature } : {}) });
      throw failure;
    }
  }
  async function completeRelease(index: string) {
    if (!vault || !owner) return;
    if (releaseBlock) throw new Error(releaseBlock);
    setBusy(REQUESTING_APPROVAL);
    progressTo(index, { step: 'requesting' });
    let started: Awaited<ReturnType<typeof startReleaseApproval>>;
    try { started = await startReleaseApproval(token, vault.address, index, () => releaseOnDevice(index), layerPlatform); }
    catch (failure) { progressTo(index, { step: 'stopped', at: 'vote', answer: null, message: message(failure, 'This release could not be approved.'), reason: stopReason(failure) }); throw failure; }
    // Protection layers: the user verifies in the sequence (Bluetooth and passkeys need a click), or in a full tab.
    if (started.kind === 'full-tab') { progressTo(index, { step: 'full-tab' }); return; }
    if (started.kind === 'verify') { progressTo(index, { step: 'layers', challenge: started.challenge }); return; }
    await finishRelease(index, started.approval, { kind: 'no-evidence', status: started.approval.status });
  }
  /** After ANTARA's approval: wait for its vote on-chain, then execute with your wallet. */
  async function finishRelease(index: string, approval: PairedApproval, answer: LayerAnswer) {
    if (!vault || !owner) return;
    if (approval.status !== 'already-approved') setSignature(approval.signature);
    setBusy('Waiting for ANTARA’s vote on-chain');
    progressTo(index, { step: 'vote', answer });
    let approved: Awaited<ReturnType<typeof waitForPairedApproval>> | null = null;
    await releaseStep(index, 'vote', answer, async () => { approved = await waitForPairedApproval(vault, index, owner, recipientAddresses); });
    if (approved!.status === 'Executed') { rememberProposal(''); setNotice('This release was already executed.'); progressTo(index, { step: 'done', answer, signature: '' }); await reload(); return; }
    setBusy('Executing your release');
    progressTo(index, { step: 'execute', answer });
    let hash = '';
    await releaseStep(index, 'execute', answer, async () => { hash = await executePairedSolanaRelease(signer, vault, index, recipientAddresses); });
    rememberProposal('');
    const shown = releaseViewRef.current?.index === index ? releaseViewRef.current.card : null;
    if (wallet.userId) recordVaultActivity(wallet.userId, { id: activityId(), kind: 'release', multisig: vault.address, index, signature: hash, status: 'confirmed', createdAt: new Date().toISOString(),
      ...(shown ? { asset: shown.asset, amount: shown.amount, recipient: shown.recipient } : {}) });
    setSignature(hash); setNotice('Release executed on-chain.'); setReleaseAmount('');
    progressTo(index, { step: 'done', answer, signature: hash });
    await reload();
  }
  /** Opens the sequence for a saved release and continues it (safe to repeat). */
  function continueRelease(index: string) {
    if (proposal) setReleaseView({ index, progress: { step: 'requesting' }, card: { index, amount: formatAmount(proposal.amountRaw.toString(), DECIMALS[proposal.asset]), asset: proposal.asset, recipientLabel: recipientLabel(proposal.recipient), recipient: proposal.recipient } });
    void run('Continuing your release', () => completeRelease(index));
  }
  /** Called only from the review step, with exactly the recipient, asset and amount the user confirmed. */
  function release(reviewed: { to: string; asset: PairedAsset; amount: string }) {
    if (!vault || !ready?.usage || !reviewed.to || releaseBlock) return;
    const { to, asset, amount: value } = reviewed;
    // Only the caps the user set for this vault (optional Limits layer); null where none applies.
    const bounds = pairedReleaseBounds(ready.usage, asset);
    const card = { amount: value, asset, recipientLabel: recipientLabel(to), recipient: to };
    void run('Proposing your release', async () => {
      setReview(null);
      setReleaseView({ index: '', card: { ...card, index: '…' }, progress: { step: 'propose' } });
      let proposed: Awaited<ReturnType<typeof proposePairedSolanaRelease>>;
      try { proposed = await proposePairedSolanaRelease(signer, vault, to, asset, value, eligibleAddresses, bounds); }
      catch (failure) {
        setReleaseView(current => current && current.index === '' ? { ...current, progress: { step: 'stopped', at: 'propose', answer: null, message: privacy && failure instanceof VaultAmountError ? PRIVATE_RELEASE_PROBLEM : message(failure, 'The release could not be proposed.'), reason: stopReason(failure),
          ...(failure instanceof VaultTransactionError && failure.signature ? { signature: failure.signature } : {}) } } : current);
        throw failure;
      }
      rememberProposal(proposed.index);
      setSignature(proposed.signature);
      setReleaseView({ index: proposed.index, card: { ...card, index: proposed.index }, progress: { step: 'requesting' } });
      await completeRelease(proposed.index);
    });
  }

  const loading = wallet.authenticated && (!wallet.ready || !owner || (canRead && setup.status === 'loading'));
  const ownerWallet = ready && owner ? ready.account.wallets.find(item => item.address === owner) ?? null : null;
  // Every wallet linked to your account and confirmed on this device can receive releases at once.
  const eligible = recipients;
  const eligibleAddresses = eligible.map(item => item.address);
  // Defaults only to this wallet (U). Any other wallet must be picked explicitly.
  const selectedRecipient = eligibleAddresses.includes(recipient) ? recipient : owner && eligibleAddresses.includes(owner) ? owner : '';
  // The amount against the verified vault balance: all of it, or enough left for Solana's live minimum (vaultAmounts.ts).
  const releaseHeld = vault ? BigInt(releaseAsset === 'SOL' ? vault.nativeBalance : vault.usdcBalance ?? '0') : null;
  const releaseRaw = parseDepositAmount(releaseAmount, releaseAsset);
  const releaseProblem = releaseRaw !== null && releaseHeld !== null ? releaseAmountProblem(releaseAsset, releaseRaw, releaseHeld, rentMinimum) : null;
  const recipientLabel = (address: string) => address === owner ? 'This wallet' : recipients.find(item => item.address === address)?.embedded ? 'ANTARA wallet' : 'Linked wallet';
  // ANTARA refuses to vote for a vault whose wallet is no longer a valid U, so nothing is proposed (or paid for) then.
  // No Privy (account) MFA is required (owner decision 2026-10-13); the vault's own authenticator is a protection layer.
  const releaseBlock = !ready || !vault ? ''
    : !ownerWallet ? 'Releases are paused: this wallet is no longer linked to your ANTARA account, so ANTARA will not approve releases from this vault.'
    : ownerWallet.pairProblem ? `Releases are paused: ${ownerWallet.pairProblem}` : gate.releaseBlock;
  // Deposits wait until the vault is fully activated, which needs a passkey (owner decision).
  const depositBlock = vault ? gate.depositBlock : '';
  const actionsReady = !!vault && !!ready?.usage;
  const openMove = (tab: 'deposit' | 'release') => {
    setSettings(false); setMoveTab(tab);
    focusPanel(tab === 'deposit' ? '.wallet-vault [aria-label="Deposit into your vault"]' : '.wallet-vault .pv-release');
  };
  const openDeposit = () => openMove('deposit');
  const openRelease = () => openMove('release');
  // A shell hand-off waits until its panel exists (the vault and its caps, if any, are read first).
  useEffect(() => {
    if (panelRequest === 'vaultlayers' && vault) { setPanelRequest(''); openLayers(); }
    if (panelRequest === 'vaultdeposit' && actionsReady) { setPanelRequest(''); openDeposit(); }
  }, [panelRequest, vault?.address, actionsReady]); // eslint-disable-line react-hooks/exhaustive-deps
  const usdc = vault?.usdcBalance ?? null;
  const vaultState = gate.stage === 'activate-passkey' ? 'passkey' : gate.stage === 'unavailable' ? 'layers' : gate.stage === 'checking' ? 'checking' : 'active';
  const state = !wallet.authenticated ? 'signed-out' : loading ? 'loading' : setup.status === 'error' ? 'error' : setup.status === 'no-pin' ? 'no-pin'
    : setup.status === 'not-provisioned' ? 'not-provisioned' : !ready ? 'loading' : vault ? vaultState : ready.previous ? 'previous'
    : !ownerWallet || ownerWallet.pairProblem ? 'wallet' : resumeKey ? 'pending' : 'activate';
  // The ANTARA wallet itself that the server will not pair (summary.ts): its reason, never "use your ANTARA wallet".
  const antaraProblem = antaraWalletProblem(ownerWallet);
  const title = {
    'signed-out': 'Your wallet. Its own vault.', loading: 'Finding your vault', error: 'We couldn’t check your vault', 'no-pin': 'Vault protection isn’t available in this build',
    'not-provisioned': 'Vault protection isn’t switched on yet', active: 'Your vault is active', previous: 'Your vault uses a previous ANTARA guardian',
    wallet: antaraProblem ? 'This wallet can’t pair a vault' : 'Use your ANTARA wallet for the vault', pending: 'Finish activating your vault', activate: 'Create your vault',
    passkey: gate.firstPasskeyAt !== null ? 'Your vault’s first passkey is pending' : 'Add a passkey to finish activating', layers: 'We couldn’t check your vault’s protection', checking: 'Checking your vault’s protection',
  }[state];
  const description = {
    'signed-out': 'Sign in to access your wallet and its dedicated vault in one place.',
    loading: 'Checking the vault paired with this wallet on Solana.',
    error: setup.status === 'error' ? setup.message : '',
    'no-pin': 'This copy of ANTARA was built without a pinned guardian, so it will not create or use a paired vault. Your wallet works normally.',
    'not-provisioned': 'ANTARA’s vault guardian is not switched on for this server, so vaults cannot be activated, shown or released here. Your wallet works normally.',
    active: releaseBlock || 'Releases need your approval and ANTARA’s. ANTARA approves only releases to your own wallets, within any caps you set.',
    previous: `Vault ${ready?.previous ? short(ready.previous.multisig) : ''} was paired with a guardian ANTARA no longer uses, so releases from it are paused. Its funds are not shown here.`,
    wallet: antaraProblem ?? 'Select your ANTARA Solana wallet in the account menu. Paired vaults are created only for the embedded wallet linked to your account.',
    pending: `A vault creation for this wallet (${resumeKey ? short(resumeKey) : ''}) was started but not registered. Finish activation to verify it on-chain and register it.`,
    activate: 'Creates a Squads vault that needs two approvals: your wallet and ANTARA’s guardian, which can only vote. You sign and pay the on-chain account rent. Then you add a passkey and choose your protection layers.',
    passkey: gate.firstPasskeyAt !== null ? gate.releaseBlock : `Your vault is created on Solana and registered with ANTARA. ${SURFACE_NOTES.passkeyRequired}`,
    layers: layers.load.status === 'unavailable' ? `${layers.load.message} Deposits and releases are paused here until your protection layers can be checked.` : '',
    checking: 'Reading your protection layers from ANTARA.',
  }[state];

  // What creating a vault costs, read live from Solana while creation is offered (creationCost.ts).
  const solBalance = walletRaw(wallet.balances, wallet.balancesLoading, 'SOL');
  const [cost, setCost] = useState<VaultCreationCost | null | 'loading'>('loading');
  const [costAttempt, setCostAttempt] = useState(0);
  const offersCreation = state === 'activate';
  useEffect(() => {
    if (!offersCreation) return;
    let live = true;
    setCost('loading');
    readVaultCreationCost().then(value => { if (live) setCost(value); }, () => { if (live) setCost(null); });
    return () => { live = false; };
  }, [offersCreation, costAttempt]);
  const fundingState = cost === 'loading' ? 'checking' : creationFunding(cost, solBalance);
  const costText = cost && cost !== 'loading' ? `about ${roundedSol(cost.total)} SOL` : CREATION_COST_FALLBACK;
  const funding: FundingView = fundingState === 'checking' ? { state: 'checking' } : {
    state: fundingState, cost: costText,
    detail: cost && cost !== 'loading' ? creationCostDetail(cost) : null,
    have: solBalance === null ? null : formatAmount(solBalance.toString(), 9),
  };
  const fundWallet = onFundWallet ?? (() => { window.location.hash = 'receive'; });
  const openActivation = () => { setError(''); setActivation({ stage: 'idle' }); setActivationOpen(true); };
  const openPendingActivation = () => { if (resumeKey) { setActivation({ stage: 'pending', multisig: resumeKey }); setActivationOpen(true); } };

  // Hand-offs from the Protection page or the home card (vaultIntent.ts), taken once the vault's state is known.
  useEffect(() => {
    const intent = peekVaultIntent();
    if (!intent || state === 'loading' || state === 'checking') return;
    takeVaultIntent();
    if (intent.kind === 'create') {
      if (state === 'activate' && lastConfig.current) openActivation();
      else if (state === 'pending') openPendingActivation();
      return;
    }
    if (vault) openLayerFor(intent.layer);
  }, [state, vault?.address]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Opens Vault settings at one layer's sheet: its set-up when it is off, its settings when it is on (VaultLayers decides from the server's answer). */
  function openLayerFor(layer: LayerId) {
    if (gate.stage === 'activate-passkey' && gate.firstPasskeyAt === null) { openLayerForm('passkey.add'); return; }
    openLayers(layer);
  }

  // The headline is the vault's total in US dollars at Relay prices (vaultValue.ts); without a price, its largest holding.
  const prices = usePrices(!!vault && !loading);
  const valued = vault && !loading ? vaultValue({ chain: 'solana', native: BigInt(vault.nativeBalance), stablecoin: usdc === null ? null : BigInt(usdc), prices, privacy, cluster: SOLANA_CLUSTER }) : null;
  const placeholderReason = !wallet.authenticated ? 'Sign in to load balances' : loading ? 'Loading your vault balance'
    : state === 'error' ? 'Vault balance unavailable' : valued?.headline.kind === 'pending' ? valued.headline.reason : 'No vault yet';
  const cardValue: VaultCardValue = privacy ? { kind: 'masked' }
    : valued?.headline.kind === 'usd' ? { kind: 'usd', amount: valued.headline.amount, approx: valued.headline.approx, title: valued.title }
    : valued?.headline.kind === 'amount' ? { kind: 'amount', amount: valued.headline.amount, unit: valued.headline.unit }
    : { kind: 'placeholder', unit: 'USD', reason: placeholderReason };
  const valuedMeta = valued ? ['Verified vault balance on Solana', usdc === null ? 'USDC is available on mainnet only' : '', valued.excluded, valued.source].filter(Boolean).join(' · ') : '';
  const cardMeta = vault ? valuedMeta || 'Verified vault balance on Solana'
    : !wallet.authenticated ? 'Sign in to view your vault'
    : loading ? 'Checking your vault…'
    : state === 'error' ? 'Vault balance not verified'
    : state === 'activate' || state === 'pending' ? 'No vault yet · create one below'
    : 'No vault for this wallet';
  const cardFoot = vault ? <span className="vx-foot-line"><span>Vault</span><AddressText address={vault.address} form="short" copy copyLabel="Copy vault account address" />
      <ExternalLink className="vx-foot-link" href={explorerAddressUrl(SOLANA_NETWORK, vault.depositAddress, { solanaCluster: SOLANA_CLUSTER })}>Explorer ↗</ExternalLink></span>
    : owner ? <span className="vx-foot-line"><span>For your wallet</span><AddressText address={owner} form="short" /></span>
    : <span className="vx-foot-line"><span>A dedicated vault for each wallet</span></span>;
  const enrolledCount = layers.load.status === 'ready' ? layers.load.view.layers.filter(layer => layer.status === 'enrolled').length : null;
  const protectionSummary = layers.load.status === 'ready' ? `${enrolledCount} of 6 on. ANTARA checks every layer you turn on before it approves a release.`
    : layers.load.status === 'unavailable' ? 'Protection status unavailable.' : 'Checking your protection layers…';
  const vaultActions: VaultAction[] = [
    { label: 'Deposit', icon: 'deposit', primary: true, onClick: openDeposit, reason: depositBlock || (actionsReady ? '' : 'Reading your vault.') },
    { label: 'Receive', icon: 'down', onClick: onReceive, reason: !onReceive ? 'Receive is not available here.' : depositBlock },
    { label: 'Release', icon: 'release', onClick: openRelease, reason: releaseBlock || (actionsReady ? '' : 'Reading your vault.') },
    { label: 'Layers', icon: 'shield', onClick: () => openLayers() },
  ];
  // A disabled action always says why: the callout explains a missing passkey or unreadable layers; otherwise the note does.
  const callout = state === 'passkey' || state === 'layers' || (state === 'active' && !!releaseBlock);
  const actionNote = callout ? undefined : [...new Set(vaultActions.map(action => action.reason).filter(Boolean))].join(' ') || undefined;

  const balanceCard = (children?: ReactNode) => <VaultBalanceCard label={valued?.label ?? 'Vault · total'} value={cardValue}
    breakdown={valued?.holdingList ?? []} meta={cardMeta} failed={state === 'error'} onRetry={() => setAttempt(attempt + 1)}
    privacy={privacy} onPrivacy={onPrivacy} settingsOpen={settings} onSettings={() => setSettings(!settings)}
    network={{ name: SOLANA_NETWORK.name, logo: 'solana' }} foot={cardFoot} compact={!vault}>{children}</VaultBalanceCard>;

  const statusLines = <>
    {busy && <div className="vx-status pv-status" role="status">{busy}… Follow the wallet confirmation when prompted.</div>}
    {error && !releaseView && !activationOpen && <div className="vx-status pv-status pv-error" role="alert">{error}</div>}
    {notice && <div className="vx-status pv-status" role="status">{notice}{signature && <> <ExternalLink href={explorerTxUrl(SOLANA_NETWORK, signature, { solanaCluster: SOLANA_CLUSTER })}>View transaction ↗</ExternalLink></>}</div>}
  </>;

  const sideWithoutVault = <aside className="vx-side" aria-label="About your vault">
    <VaultLayersPreview note={state === 'activate' || state === 'pending' ? 'You choose them after creating your vault. Only a passkey is required.' : 'Each vault chooses its own layers. Only a passkey is required.'} />
    {(state === 'activate' || state === 'pending' || state === 'wallet' || state === 'previous') && <VaultClaimsCard claims={CLAIMS} />}
  </aside>;

  let body: ReactNode;
  if (settings) {
    body = <section className="vx-settings" aria-label="Vault settings">
      <header className="vx-settings-head">
        <button type="button" className="ui-btn-text vx-back" onClick={() => setSettings(false)}><Icon name="back" size={16} />Back to vault</button>
        <h2>Vault settings</h2>
        <button type="button" className="ui-btn vx-small-btn" onClick={() => setSettings(false)}>Done</button>
      </header>
      <div className="vx-layout">
        <div className="vx-main">
          {vault && wallet.userId ? <div className="vx-layers-wrap"><VaultLayers multisig={vault.address} privyUserId={wallet.userId} getToken={token} load={layers.load} reload={layers.reload}
            platform={layerPlatform} keys={layerKeys} assertCurrent={assertLayerSession} request={layerRequest} /></div>
            : <VaultLayersPreview note="Protection layers are set per vault. Create your vault, add a passkey, then choose the rest here." />}
        </div>
        <aside className="vx-side" aria-label="Vault details">
          <section className="vx-details ui-card" aria-labelledby="vx-details-title">
            <header className="vx-section-head"><div><h3 id="vx-details-title">Vault details</h3></div></header>
            <dl className="vx-dl">
              <div><dt>Your vault wallet</dt><dd>{owner ? <AddressText address={owner} copy copyLabel="Copy wallet address" /> : 'Sign in to see your wallet.'}</dd></div>
              {vault && <div><dt>Vault account</dt><dd><AddressText address={vault.address} copy copyLabel="Copy vault account address" /><small>Squads multisig · 2 of 2 approvals · {vault.timeLockSeconds ? `${vault.timeLockSeconds} second on-chain delay` : 'no on-chain delay'}</small></dd></div>}
              {vault && <div><dt>Deposit address</dt><dd><AddressText address={vault.depositAddress} copy copyLabel="Copy vault deposit address" /></dd></div>}
              {ready && <div><dt>ANTARA guardian</dt><dd><AddressText address={ready.config.guardian} /><small>Pinned in this build and checked on-chain before every action. Policy {ready.config.policyVersion}.</small></dd></div>}
              <div><dt>Vault authenticator (MFA)</dt><dd><small>Optional, for this vault only: turn on MFA in the protection layers, and every release will need a 6-digit code from your authenticator app. Your regular wallet has no MFA.</small></dd></div>
            </dl>
            <button type="button" className="ui-btn vx-small-btn" onClick={onSettings}>Open protection</button>
          </section>
          <VaultClaimsCard claims={CLAIMS} id="vx-settings-claims" />
        </aside>
      </div>
    </section>;
  } else if (vault) {
    body = <div className="vx-layout">
      <div className="vx-main">
        {balanceCard(<VaultActionRow actions={vaultActions} note={actionNote} label="Vault quick actions" />)}
        {statusLines}
        {callout && <VaultStateCard title={state === 'active' ? 'Releases are paused' : title} text={description} tone={state === 'layers' ? 'danger' : 'warn'} icon={state === 'passkey' ? 'lock' : 'shield'}>
          {state === 'passkey' && gate.firstPasskeyAt !== null ? <button type="button" className="ui-btn-primary" onClick={reviewPending}>Review or cancel</button>
            : state === 'passkey' ? <button type="button" className="ui-btn-primary" disabled={!!busy} onClick={() => openLayerForm('passkey.add')}>Add a passkey</button>
            : state === 'layers' ? <button type="button" className="ui-btn-primary" disabled={!!busy} onClick={layers.reload}>Try again</button> : null}
        </VaultStateCard>}
        <PendingChangeAlert pending={pendingChanges} onReview={reviewPending} />
        <VaultProtectionCard layers={layers.load} onSelect={openLayers} onManage={() => openLayers()} summary={protectionSummary} />
        <section className="vx-assets ui-card" aria-label="Vault assets">
          <div className="vx-tabs" role="tablist" aria-label="Vault sections">
            {(['tokens', 'activity'] as const).map(item => <button key={item} id={`pv-tab-${item}`} type="button" role="tab" className="vx-tab" aria-selected={assetTab === item}
              aria-controls={assetTab === item ? 'pv-tabpanel' : undefined} tabIndex={assetTab === item ? 0 : -1}
              onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'tokens' : event.key === 'End' ? 'activity' : assetTab === 'tokens' ? 'activity' : 'tokens'; setAssetTab(next); document.getElementById(`pv-tab-${next}`)?.focus(); }}
              onClick={() => setAssetTab(item)}>{item === 'tokens' ? 'Tokens' : 'Activity'}</button>)}
          </div>
          <div id="pv-tabpanel" role="tabpanel" aria-labelledby={`pv-tab-${assetTab}`}>
            {assetTab === 'activity' ? <VaultActivityList records={records} privacy={privacy} /> : <>
              <ul className="vx-token-list">
                {[{ symbol: 'solana', name: 'Solana', ticker: 'SOL', value: privacy ? '••••••' : amount(vault.nativeBalance, 'SOL'), muted: false },
                  { symbol: SOLANA_NETWORK.funding.symbol, name: 'USD Coin', ticker: SOLANA_NETWORK.funding.label, value: privacy ? '••••••' : usdc === null ? 'Mainnet only' : amount(usdc, 'USDC'), muted: usdc === null }].map(asset =>
                  <li key={asset.ticker}><TokenLogo symbol={asset.symbol} /><span className="vx-token-name"><strong>{asset.name}</strong><small>{asset.ticker} · Solana</small></span><span className="vx-token-amount" data-muted={asset.muted || undefined}>{asset.value}</span></li>)}
              </ul>
              {/* Deposits wait for the passkey (and readable layers), so the address is not offered until then (6.6). */}
              {depositBlock ? <p className="vx-fine pv-note" role="note">{depositBlock}</p>
                : <div className="vx-address-row"><span className="vx-address-label">Verified deposit address</span><AddressText address={vault.depositAddress} form="short" copy copyLabel="Copy vault deposit address" />
                  <ExternalLink className="vx-foot-link" href={explorerAddressUrl(SOLANA_NETWORK, vault.depositAddress, { solanaCluster: SOLANA_CLUSTER })}>Explorer ↗</ExternalLink></div>}
              <p className="vx-fine">Read from Solana at {new Date(vault.observedAt).toLocaleTimeString()}. Only send SOL or Circle USDC on Solana to this address.</p>
            </>}
          </div>
        </section>
      </div>
      <aside className="vx-side" aria-label="Move funds">
        {ready?.usage ? <MoveFunds tab={moveTab} onTab={setMoveTab}
          deposit={owner ? <DepositPanel depositAddress={vault.depositAddress} from={owner} cluster={SOLANA_CLUSTER === 'devnet' ? 'devnet' : 'mainnet-beta'}
            balances={{ SOL: walletRaw(wallet.balances, wallet.balancesLoading, 'SOL'), USDC: walletRaw(wallet.balances, wallet.balancesLoading, 'USDC') }}
            vaultSol={BigInt(vault.nativeBalance)} rentMinimum={rentMinimum}
            depositBlock={depositBlock || (busy ? 'Another vault action is in progress.' : '')} deposit={depositInto} explorerUrl={explorerUrl} privacy={privacy} /> : null}
          release={<div className="pv-form pv-release vx-release" tabIndex={-1} role="group" aria-labelledby="vx-release-title">
            <header className="vx-panel-head"><h3 id="vx-release-title">Release to your wallet</h3><p>Your wallet proposes and approves, ANTARA adds its vote, then your wallet executes. Each step is on-chain.</p></header>
            <div className="vseq-field-row">
              <label className="vseq-field"><span>Asset</span><select value={releaseAsset} disabled={!!busy || !!review} onChange={event => setReleaseAsset(event.target.value as PairedAsset)}><option value="SOL">SOL</option>{SOLANA_CLUSTER !== 'devnet' && <option value="USDC">USDC</option>}</select></label>
              <label className="vseq-field vseq-field-grow"><span>Amount</span><span className="vseq-input-wrap"><input value={releaseAmount} disabled={!!busy || !!review} onChange={event => setReleaseAmount(event.target.value)} inputMode="decimal" placeholder="0.00" autoComplete="off" />
                <button type="button" className="ui-btn-text vseq-max" disabled={!!busy || !!review || !releaseHeld} onClick={() => { if (releaseHeld) setReleaseAmount(exactAmount(releaseHeld, releaseAsset)); }}>Release all</button></span></label>
            </div>
            <label className="vseq-field"><span>Recipient</span><select value={selectedRecipient} disabled={!!busy || !!review || !eligible.length} onChange={event => setRecipient(event.target.value)}>
              {!selectedRecipient && <option value="">{eligible.length ? 'Choose one of your wallets' : 'No wallet can receive releases yet'}</option>}
              {recipients.map(item => <option key={item.address} value={item.address}>{recipientLabel(item.address)} · {short(item.address)}</option>)}
            </select></label>
            {review ? <div className="vx-review pv-proposal" aria-label="Review release"><h3>Review this release</h3>
              <p className="vx-review-amount">{review.amount} {review.asset} · {recipientLabel(review.to)}</p>
              <AddressText address={review.to} />
              <p className="vx-fine">Check the full address. Your wallet will ask you to sign the proposal next.</p>
              <div className="vseq-actions"><button type="button" className="ui-btn-primary" disabled={!!busy || !!releaseBlock} onClick={() => release(review)}>Confirm and sign</button><button type="button" className="ui-btn" disabled={!!busy} onClick={() => setReview(null)}>Cancel</button></div>
            </div>
              : <div className="vseq-actions"><button type="button" className="ui-btn-primary" disabled={!!busy || !!releaseBlock || !!proposalIndex || !releaseAmount.trim() || !selectedRecipient || !!releaseProblem} onClick={() => { setError(''); setReview({ to: selectedRecipient, asset: releaseAsset, amount: releaseAmount.trim() }); }}>Release with ANTARA approval</button></div>}
            {releaseProblem && !review && <p className="ui-alert" role="alert">{privacy ? PRIVATE_RELEASE_PROBLEM : releaseProblem}</p>}
            {releaseBlock && <p className="ui-alert" data-tone="warn" role="note">{releaseBlock}</p>}
            {unconfirmed > 0 && <p className="vx-fine">{unconfirmed === 1 ? '1 linked wallet is' : `${unconfirmed} linked wallets are`} not offered because this device cannot confirm {unconfirmed === 1 ? 'it is' : 'they are'} yours. To release to one, connect it in ANTARA on this device.</p>}
            <p className="vx-fine">Your wallet signs and pays the Solana network fees to propose and execute. A USDC release to a wallet without a USDC account also pays that account’s rent.</p>
          </div>}
          proposal={proposalIndex ? <div className="vx-review pv-proposal" aria-label="Release in progress"><h3>Release #{proposalIndex}</h3>
            {proposal ? <p>{amount(proposal.amountRaw, proposal.asset)} to <AddressText address={proposal.recipient} form="short" /> · {proposal.status}{proposal.userApproved ? ' · your approval recorded' : ''}{proposal.guardianApproved ? ' · ANTARA approval recorded' : ''}{proposal.stale ? ' · replaced' : ''}</p> : <p>Reading this release from Solana…</p>}
            <div className="vseq-actions"><button type="button" className="ui-btn-primary" disabled={!!busy || !!releaseBlock || !proposal || proposal.stale || proposal.status === 'Executed' || !!releaseView} onClick={() => continueRelease(proposalIndex)}>Continue release</button><button type="button" className="ui-btn" disabled={!!busy} onClick={() => rememberProposal('')}>Hide</button></div>
            <p className="vx-fine">Continuing is safe to repeat: ANTARA never approves the same release twice.</p>
          </div> : null}
          limits={hasPairedCap(ready.usage.limits)
            ? <dl className="vx-limits pv-limits" aria-label="Release limits">{(['SOL', 'USDC'] as const).map(asset => <div key={asset}><dt>{asset}</dt><dd>{capLines(ready.usage!, asset)}</dd></div>)}</dl>
            : <p className="vx-fine">No caps. ANTARA sets none; you can set your own under Layers → Limits.</p>} />
          : <section className="vx-move ui-card" aria-label="Vault actions"><p className="vx-fine" role="status">Reading your vault…</p></section>}
      </aside>
    </div>;
  } else if (state === 'activate' || state === 'pending') {
    body = <div className="vx-layout">
      <div className="vx-main">
        {balanceCard()}
        {statusLines}
        <CreateVaultHero pending={state === 'pending' ? resumeKey : null} funding={funding} busy={!!busy}
          onCreate={openActivation} onFinish={openPendingActivation} onDiscard={discard.discardable ? () => void discardPending() : undefined} discardNote={discard.note}
          onAddSol={fundWallet} onCheckAgain={() => { void wallet.refetchBalances().catch(() => undefined); setCostAttempt(value => value + 1); }}
          onHowItWorks={() => setSettings(true)} />
      </div>
      {sideWithoutVault}
    </div>;
  } else {
    const actions = state === 'signed-out' ? <button type="button" className="ui-btn-primary" onClick={onSignIn} disabled={wallet.configured && !wallet.ready}>Sign in</button>
      : state === 'error' || state === 'not-provisioned' ? <button type="button" className="ui-btn-primary" disabled={!!busy} onClick={() => setAttempt(attempt + 1)}>Try again</button>
      : state === 'loading' ? null
      : <button type="button" className="ui-btn" onClick={onWallet}>Back to wallet</button>;
    body = <div className="vx-layout">
      <div className="vx-main">
        {balanceCard()}
        {statusLines}
        <VaultStateCard title={title} text={description} loading={state === 'loading'} tone={state === 'error' ? 'danger' : 'neutral'} icon={state === 'signed-out' ? 'vault' : 'shield'}>{actions}</VaultStateCard>
      </div>
      {sideWithoutVault}
    </div>;
  }

  return <section className="wallet-vault vx" aria-label="Your wallet’s vault" data-state={state}>
    {body}

    {releaseView && sequenceVault.current && wallet.userId && <VerificationSequence key={releaseView.index || 'proposing'} release={releaseView.card} layers={layers.load} progress={releaseView.progress}
      submit={(challenge, hooks) => submitReleaseApproval(token, challenge, {
        platform: layerPlatform, keys: layerKeys, privyUserId: wallet.userId!, multisig: sequenceVault.current!,
        onStep: label => { hooks.onStep(label); if (label === REQUESTING_APPROVAL) hooks.onSubmitted(); }, onLayer: hooks.onLayer, totpCode: hooks.totpCode,
      })}
      restart={async () => beginReleaseLayers(await token(), sequenceVault.current!, releaseView.index, () => releaseOnDevice(releaseView.index))}
      onApproved={approval => { const index = releaseView.index; void run('Continuing your release', () => finishRelease(index, approval, { kind: 'evidence', status: approval.status })); }}
      onCancel={() => setReleaseView(null)}
      onClose={() => setReleaseView(null)}
      onContinue={() => continueRelease(releaseView.index)}
      onHide={() => { rememberProposal(''); setReleaseView(null); }}
      onAddDevice={() => { setReleaseView(null); openLayerForm('device.add'); }}
      onAddPasskey={() => { setReleaseView(null); openLayerForm('passkey.add'); }}
      onOpenLocationSettings={() => void layerPlatform.native.openLocationSettings().catch(() => undefined)}
      onOpenFullTab={() => layerPlatform.openWalletTab('#vault')}
      onSelectStation={id => { setReleaseView(null); openLayers(id); }}
      explorerUrl={explorerUrl} assertCurrent={assertLayerSession} />}

    {activationOpen && lastConfig.current && <ActivationSequence config={{ guardian: lastConfig.current.guardian }}
      requirements={{ wallet: !!ownerWallet && !ownerWallet.pairProblem, sol: fundingState === 'met' ? 'met' : fundingState === 'short' ? 'short' : 'unknown', cost: costText }}
      cluster={SOLANA_CLUSTER === 'devnet' ? 'devnet' : 'mainnet-beta'} layers={vault ? layers.load : { status: 'idle' }} progress={activation}
      activate={activate} finishActivation={finishActivation} discardAttempt={discard.discardable ? () => void discardPending() : undefined} discardNote={discard.note}
      retryLayers={layers.reload} addPasskey={addFirstPasskey} passkeyHandoff={!layerPlatform.capabilities().ceremonyInline}
      onOpenFullTab={() => layerPlatform.openWalletTab('#vault')} onReceive={fundWallet}
      onOpenVault={() => setActivationOpen(false)} onChooseLayers={() => { setActivationOpen(false); openLayers(); }}
      onClose={() => setActivationOpen(false)} explorerUrl={explorerUrl} />}
  </section>;
}

/** One asset's caps as the user set them, with what is left of a daily cap. Owner decision 2026-10-13: no server cap or minimum. */
function capLines(usage: PairedUsage, asset: PairedAsset): ReactNode {
  const { perRelease, remainingToday } = pairedReleaseBounds(usage, asset);
  const day = usage.limits.perDay[asset];
  if (perRelease === null && day === null) return <strong>No cap</strong>;
  return <>
    <strong>{perRelease !== null ? `${amount(perRelease, asset)} per release` : 'No per-release cap'}</strong>
    <small>{day !== null && remainingToday !== null ? `${amount(remainingToday, asset)} of ${amount(day, asset)} left today` : 'No daily cap'}</small>
  </>;
}

/** Deposit and Release side by side in one card: a segmented switch, the active form, the release in progress and the caps you set, if any. */
function MoveFunds({ tab, onTab, deposit, release, proposal, limits }: { tab: 'deposit' | 'release'; onTab: (tab: 'deposit' | 'release') => void; deposit: ReactNode; release: ReactNode; proposal: ReactNode; limits: ReactNode }) {
  return <section className="vx-move ui-card pv-actions" aria-label="Vault actions">
    <div className="vx-seg" role="tablist" aria-label="Move funds">
      {(['deposit', 'release'] as const).map(item => <button key={item} id={`vx-move-${item}`} type="button" role="tab" className="vx-seg-btn" aria-selected={tab === item}
        aria-controls="vx-move-panel" tabIndex={tab === item ? 0 : -1}
        onKeyDown={event => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); const next = tab === 'deposit' ? 'release' : 'deposit'; onTab(next); document.getElementById(`vx-move-${next}`)?.focus(); }}
        onClick={() => onTab(item)}>{item === 'deposit' ? 'Deposit' : 'Release'}</button>)}
    </div>
    <div id="vx-move-panel" role="tabpanel" aria-labelledby={`vx-move-${tab}`} className="vx-move-panel">
      {proposal}
      {tab === 'deposit' ? deposit : release}
    </div>
    <div className="vx-limits-wrap"><h4 className="ui-eyebrow">Your caps · optional</h4>{limits}</div>
  </section>;
}

/** Vault records saved on this device (8.5). Nothing is invented: an empty list says so. */
function VaultActivityList({ records, privacy }: { records: VaultActivityRecord[]; privacy: boolean }) {
  if (!records.length) return <p className="vx-empty">No vault activity on this device yet. Deposits and releases made here appear in this list; the chain remains the record.</p>;
  return <ul className="vx-activity pv-activity">
    {records.map(record => <li key={record.id}>
      <span className="vx-activity-kind">{ACTIVITY_LABEL[record.kind]}{record.index ? ` #${record.index}` : ''}</span>
      {record.amount && record.asset ? <strong>{privacy ? '••••••' : `${record.amount} ${record.asset}`}</strong> : <span />}
      <small>{record.status === 'confirmed' ? 'Confirmed' : 'Submitted'} · {new Date(record.createdAt).toLocaleString()} · <ExternalLink href={explorerTxUrl(SOLANA_NETWORK, record.signature, { solanaCluster: SOLANA_CLUSTER })}>View ↗</ExternalLink></small>
    </li>)}
  </ul>;
}
