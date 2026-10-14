// Vault activation container (docs/UI_ARGUS_PARITY.md 6.12). It owns only the reader's place
// in steps 1-2 and the acknowledgement checkbox. Everything after "Create vault" comes
// from PairedSolanaVault through `progress` and `layers`, and every operation is a prop:
// PairedSolanaVault stays the only caller of createPairedSolanaVault and registerPairedVault,
// keeps the pending resume key (written before signing) and its session checks.
//
// The vault counts as active only when GET /solana/layers reports a passkey in force
// (layerGate stage 'ready'); stations light only from that answer.
import { useState } from 'react';
import { SHEET_COPY } from '../layers/copy';
import { layerGate, type VaultLayersLoad } from '../layers/gate';
import { stationStates } from './stationState';
import { ActivationSequenceView, CREATION_LINES, type ActivationRequirements, type ActivationRules, type LineState } from './ActivationSequenceView';
import type { SequenceAction, SequenceStatus } from './VerificationSequenceView';

/** Where PairedSolanaVault is after "Create vault". */
export type ActivationProgress =
  /** Nothing started on this device. */
  | { stage: 'idle' }
  /** A creation was started (resume key present) but not registered. */
  | { stage: 'pending'; multisig: string }
  /** One awaited call each: createPairedSolanaVault, registerPairedVault, then the reload. */
  | { stage: 'creating' | 'registering' | 'reading' }
  | { stage: 'failed'; at: 'creating' | 'registering' | 'reading'; message: string; notice?: string; signature?: string }
  /** Verified on-chain and registered: the layer answer decides the passkey step. */
  | { stage: 'registered' };

export interface ActivationSequenceProps {
  config: { guardian: string };
  requirements: ActivationRequirements;
  /** USDC is mainnet only. */
  cluster: 'mainnet-beta' | 'devnet';
  layers: VaultLayersLoad;
  progress: ActivationProgress;
  /** PairedSolanaVault.activate: create (your wallet signs), register, reload. */
  activate: () => void;
  /** PairedSolanaVault.finishActivation: verify the pending vault on-chain, then register. */
  finishActivation: () => void;
  /**
   * Forget the pending attempt ("Only if the creation transaction never confirmed"). Passed only while Solana reports
   * no account at the pending address; absent otherwise, and `discardNote` says why.
   */
  discardAttempt?: () => void;
  discardNote?: string;
  /** Read the layers again after a failed read. */
  retryLayers: () => void;
  /**
   * The layers module's passkey.add enrollment, then trusting this device in the same flow (PairedSolanaVault.addFirstPasskey).
   * Reports each step's label; resolves once the server answered, with whether this device is trusted now.
   */
  addPasskey: (onStep?: (label: string) => void) => Promise<{ trusted: boolean } | void>;
  /** layerCapabilities().ceremonyInline === false: the side panel hands the passkey to a full tab. */
  passkeyHandoff: boolean;
  onOpenFullTab?: () => Promise<boolean>;
  onReceive: () => void;
  onOpenVault: () => void;
  /** After activation: open the vault's protection layers (step 3 of the vault's set-up). */
  onChooseLayers?: () => void;
  onClose: () => void;
  explorerUrl: (signature: string) => string;
}

/**
 * Step 1's rules. Owner decision 2026-10-13: the server sets no release cap, so none is shown here; Limits is an
 * optional layer with caps the user sets after activation. USDC is held on mainnet only.
 */
export function activationRules(config: { guardian: string }, cluster: 'mainnet-beta' | 'devnet'): ActivationRules {
  return { guardian: config.guardian, assets: cluster === 'devnet' ? 'SOL' : 'SOL and USDC' };
}

/** The step-3 line states for a progress value. */
export function creationLines(progress: ActivationProgress, layers: VaultLayersLoad): LineState[] {
  const order = ['creating', 'registering', 'reading'] as const;
  if (progress.stage === 'creating' || progress.stage === 'registering' || progress.stage === 'reading') {
    const at = order.indexOf(progress.stage);
    return order.map((_, index) => index < at ? 'done' : index === at ? 'active' : 'waiting');
  }
  if (progress.stage === 'failed') {
    const at = order.indexOf(progress.at);
    return order.map((_, index) => index < at ? 'done' : index === at ? 'failed' : 'waiting');
  }
  if (progress.stage === 'registered') {
    const gate = layerGate(layers);
    return ['done', 'done', gate.stage === 'checking' ? 'active' : gate.stage === 'unavailable' ? 'failed' : 'done'];
  }
  return ['waiting', 'waiting', 'waiting'];
}

export function ActivationSequence(props: ActivationSequenceProps) {
  const { progress, layers, requirements } = props;
  const [step, setStep] = useState<0 | 1>(0);
  const [acknowledged, setAcknowledged] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyProblem, setPasskeyProblem] = useState('');
  const [passkeyStep, setPasskeyStep] = useState('');
  const [trustNote, setTrustNote] = useState('');
  const gate = layerGate(layers);

  const started = progress.stage !== 'idle';
  const current = progress.stage === 'registered'
    ? gate.stage === 'ready' ? 4 : gate.stage === 'activate-passkey' ? 3 : 2
    : started ? 2 : step;
  const lines = creationLines(progress, layers);
  const states = stationStates({ kind: 'activation', layers: progress.stage === 'registered' ? layers : { status: 'idle' } });
  const working = progress.stage === 'creating' || progress.stage === 'registering' || progress.stage === 'reading' || passkeyBusy
    || (progress.stage === 'registered' && gate.stage === 'checking');

  let status: SequenceStatus | null = null;
  let link: { href: string; label: string } | null = null;
  const actions: SequenceAction[] = [];
  const blocked = requirements.sol === 'zero' || requirements.sol === 'short';
  const discard: SequenceAction[] = props.discardAttempt ? [{ label: 'Discard this attempt', kind: 'secondary', onClick: props.discardAttempt }] : [];
  const kept = !props.discardAttempt && props.discardNote ? ` ${props.discardNote}` : '';

  if (current === 0) {
    actions.push({ label: 'Continue', onClick: () => setStep(1), disabled: !requirements.wallet });
  } else if (current === 1) {
    actions.push({ label: 'Create vault', onClick: props.activate, disabled: !acknowledged || blocked });
    if (blocked) actions.push({ label: 'Receive SOL', kind: 'secondary', onClick: props.onReceive });
    actions.push({ label: 'Back', kind: 'secondary', onClick: () => setStep(0) });
  } else if (current === 2) {
    if (progress.stage === 'pending') {
      status = { text: `A vault creation for this wallet (${progress.multisig.slice(0, 6)}…${progress.multisig.slice(-5)}) was started but not registered. Finish activation to verify it on-chain and register it.${kept}`, tone: 'warn' };
      actions.push({ label: 'Finish activation', onClick: props.finishActivation }, ...discard);
    } else if (progress.stage === 'failed') {
      // Red only for an on-chain revert; an unconfirmed or unreachable state is a warning, not a failure.
      status = { text: `${progress.notice ? `${progress.message} ${progress.notice}` : progress.message}${progress.at === 'reading' ? '' : kept}`, tone: progress.notice && /reverted/i.test(progress.notice) ? 'danger' : 'warn' };
      if (progress.signature) link = { href: props.explorerUrl(progress.signature), label: 'View transaction ↗' };
      // Never an automatic retry: Finish activation verifies on-chain first.
      if (progress.at === 'reading') actions.push({ label: 'Try again', onClick: props.retryLayers });
      else actions.push({ label: 'Finish activation', onClick: props.finishActivation }, ...discard);
    } else if (progress.stage === 'registered' && gate.stage === 'unavailable') {
      status = { text: layers.status === 'unavailable' ? layers.message : 'Protection layers cannot be shown right now.', tone: 'danger' };
      actions.push({ label: 'Try again', onClick: props.retryLayers });
    } else {
      const active = lines.indexOf('active');
      status = { text: active >= 0 ? `${CREATION_LINES[active]}…` : 'Working…' };
    }
  } else if (current === 3) {
    if (gate.firstPasskeyAt !== null) status = { text: gate.depositBlock, tone: 'warn' };
    else if (passkeyProblem) status = { text: passkeyProblem, tone: 'danger' };
    else if (passkeyBusy && passkeyStep) status = { text: `${passkeyStep}…` };
    if (props.passkeyHandoff) {
      actions.push({ label: 'Open in a full tab', onClick: () => {
        setPasskeyProblem('');
        void props.onOpenFullTab?.().then(opened => { if (opened === false) setPasskeyProblem('Open ANTARA in a full tab from the Chrome toolbar, then add your passkey.'); })
          .catch(() => setPasskeyProblem('Chrome did not open a new tab.'));
      } });
    } else if (gate.firstPasskeyAt === null) {
      actions.push({ label: 'Add a passkey', busyLabel: 'Waiting for your passkey…', busy: passkeyBusy, onClick: () => {
        setPasskeyBusy(true); setPasskeyProblem(''); setPasskeyStep(''); setTrustNote('');
        props.addPasskey(setPasskeyStep).then(result => { if (result && !result.trusted) setTrustNote(SHEET_COPY.trustLater); })
          .catch(failure => setPasskeyProblem(failure instanceof Error && failure.message ? failure.message : 'The passkey could not be added. Nothing was changed.'))
          .finally(() => { setPasskeyBusy(false); setPasskeyStep(''); });
      } });
    }
  } else {
    if (props.onChooseLayers) actions.push({ label: 'Choose your layers', onClick: props.onChooseLayers }, { label: 'Open your vault', kind: 'secondary', onClick: props.onOpenVault });
    else actions.push({ label: 'Open your vault', onClick: props.onOpenVault });
  }

  return (
    <ActivationSequenceView
      step={current}
      states={states}
      rules={activationRules(props.config, props.cluster)}
      requirements={requirements}
      acknowledged={acknowledged}
      onAcknowledge={setAcknowledged}
      lines={lines}
      passkeyHandoff={props.passkeyHandoff}
      status={status}
      actions={actions}
      link={link}
      busy={working}
      doneNote={trustNote}
      onClose={props.onClose}
    />
  );
}
