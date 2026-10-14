// Verification sequence container (docs/UI_ARGUS_PARITY.md 6.14, 7.2). It owns only the
// presentation state of step 2 (which layer this device is reading, whether the evidence
// was sent, ANTARA's answer) and maps it to stations with stationState.ts.
//
// It never calls the vault functions (propose, wait for the vote, execute): PairedSolanaVault
// stays their only caller and reports where it is through `progress`. Step 2 runs through the
// injected `submit`, which PairedSolanaVault builds from layers/flow.ts submitReleaseApproval:
//
//   submit={hooks => submitReleaseApproval(getToken, challenge, { ...layerContext,
//     onStep: label => { hooks.onStep(label); if (label === REQUESTING_APPROVAL) hooks.onSubmitted(); },
//     onLayer: hooks.onLayer })}            // onLayer: the 8.7 callback, after the layers gate
//
// Stations turn Passed only for an `approved` answer to that evidence; an answer to the
// request without evidence never produces a Passed station, and a problem on this device
// never produces a Failed one (Failed is reserved for the server's answer).
import { useEffect, useMemo, useRef, useState } from 'react';
import { LAYER_NAMES, SURFACE_NOTES } from '../layers/claims';
import { LayerCollectionError, type CollectionAction } from '../layers/collectors';
import type { VaultLayersLoad } from '../layers/gate';
import { TOTP_CODE, needsTotpCode } from '../layers/flow';
import { TotpCodeField, lockedMessage } from '../layers/LayerApproval';
import { LAYER_IDS, type LayerId, type LayerResult, type ReleaseChallenge } from '../layers/types';
import { PairedVaultApiError, type PairedApproval } from '../vaults/pairedApi';
import { stationStates, type ReleaseResult, type StationPhase } from './stationState';
import { VerificationSequenceView, type ReleaseCardData, type SequenceAction, type SequenceStatus } from './VerificationSequenceView';

/** The busy label layers/flow.ts reports just before it sends the evidence. */
export const REQUESTING_APPROVAL = 'Requesting ANTARA’s approval';

/** How step 2 ended. `evidence` answers carried this device's readings; `no-evidence` answered the first request. */
export interface LayerAnswer { kind: 'evidence' | 'no-evidence'; status: PairedApproval['status'] }

/** Where the vault flow is, as PairedSolanaVault reports it. */
export type ReleaseProgress =
  /** Step 1: the wallet signs the proposal. */
  | { step: 'propose' }
  /** Step 2 begins: ANTARA is asked without evidence (startReleaseApproval). */
  | { step: 'requesting' }
  /** Step 2: ANTARA needs these layers for this release. */
  | { step: 'layers'; challenge: ReleaseChallenge }
  /** Extension side panel: the ceremonies continue in a full tab. */
  | { step: 'full-tab' }
  /** Step 3 and 4, and the finished release. */
  | { step: 'vote' | 'execute'; answer: LayerAnswer | null }
  | { step: 'done'; answer: LayerAnswer | null; signature: string }
  /** Stopped after step 2 with the vault flow's own message (existing copy in PairedSolanaVault). */
  | { step: 'stopped'; at: 'propose' | 'vote' | 'execute'; answer: LayerAnswer | null; message: string;
    reason: 'vote-timeout' | 'rejected' | 'transaction' | 'other'; signature?: string };

export interface SubmitHooks {
  /** Progress for the status line ("Reading your location"). */
  onStep: (label: string) => void;
  /** 8.7: called around each collector on this device. */
  onLayer: (id: LayerId, phase: 'collecting' | 'collected') => void;
  /** Every reading succeeded and the evidence is being sent. */
  onSubmitted: () => void;
  /** The code typed for the vault authenticator when the challenge asks for one (MFA layer), else null. */
  totpCode: string | null;
}

export interface VerificationSequenceProps {
  release: ReleaseCardData;
  /** GET /solana/layers for this vault (the overview visuals). */
  layers: VaultLayersLoad;
  progress: ReleaseProgress;
  /** Collects this device's evidence for `progress.challenge` and asks ANTARA to vote with it. */
  submit: (challenge: ReleaseChallenge, hooks: SubmitHooks) => Promise<PairedApproval>;
  /** Begins a new challenge for the same release (beginReleaseLayers). */
  restart: () => Promise<ReleaseChallenge>;
  /** ANTARA answered the evidence; PairedSolanaVault continues with the vote and the execution. */
  onApproved: (approval: PairedApproval, challenge: ReleaseChallenge) => void;
  /** "Not now": the release stays saved. */
  onCancel: () => void;
  /** Closes the finished or stopped sequence. */
  onClose: () => void;
  /** "Continue release" after the vote did not reach the chain in time (safe to repeat). */
  onContinue?: () => void;
  /** "Hide" for a release that was rejected, cancelled or replaced. */
  onHide?: () => void;
  onAddDevice?: () => void;
  onAddPasskey?: () => void;
  onOpenLocationSettings?: () => void;
  /** Opens the wallet in a full tab (side panel); resolves false when Chrome did not open it. */
  onOpenFullTab?: () => Promise<boolean>;
  onSelectStation?: (id: LayerId) => void;
  /** Explorer link for a signature. */
  explorerUrl: (signature: string) => string;
  /** Throws when the account or selected wallet changed since the release started. */
  assertCurrent?: () => void;
  motion?: boolean;
}

interface Attempt {
  challenge: ReleaseChallenge;
  collecting: LayerId | null;
  collected: LayerId[];
  submitted: boolean;
  result: ReleaseResult;
  /** The server has seen this challenge; only a new begin can retry. */
  spent: boolean;
}
interface Problem { message: string; action: CollectionAction | null }

const freshAttempt = (challenge: ReleaseChallenge): Attempt => ({ challenge, collecting: null, collected: [], submitted: false, result: null, spent: false });
const message = (failure: unknown, fallback: string) => failure instanceof Error && failure.message ? failure.message : fallback;
const PROBLEM_ACTIONS: Record<CollectionAction, string> = {
  'add-device': 'Set up this device',
  'open-location-settings': 'Open Windows location settings',
  'open-full-tab': 'Open in a full tab',
  'add-passkey': 'Add a passkey',
};

/** Status sentence for how step 2 ended (6.14, exact). */
export function answerSentence(answer: LayerAnswer): string {
  if (answer.status === 'pending') return 'ANTARA’s vote was already sent. Waiting for it on-chain.';
  if (answer.status === 'already-approved') return 'ANTARA already approved this release.';
  return answer.kind === 'evidence' ? 'ANTARA approved this release. Every layer you turned on passed.' : 'ANTARA approved this release without a new layer check.';
}

/** Station result for an answer: Passed only for `approved` to this device's evidence. */
export function resultFor(answer: LayerAnswer | null): ReleaseResult {
  if (!answer) return null;
  return answer.kind === 'evidence' && answer.status === 'approved' ? { kind: 'approved-with-evidence' } : { kind: 'approved-no-new-check' };
}

/** Names of the layers a challenge requires, in landing order: "Biometrics, Wi-Fi and Limits". */
export function requiredSentence(challenge: ReleaseChallenge): string {
  const names = LAYER_IDS.filter(id => challenge.required.some(item => item.id === id)).map(id => LAYER_NAMES[id]);
  if (!names.length) return 'ANTARA asked for no layer reading on this device.';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `This release needs ${list}. Nothing is sent until every check on this device succeeds.`;
}

export function VerificationSequence(props: VerificationSequenceProps) {
  const { progress, layers, release } = props;
  const [attempt, setAttempt] = useState<Attempt | null>(progress.step === 'layers' ? freshAttempt(progress.challenge) : null);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [note, setNote] = useState('');
  const [failures, setFailures] = useState<LayerResult[] | null>(null);
  const [restarted, setRestarted] = useState(false);
  const [handoffProblem, setHandoffProblem] = useState('');
  const [evidenceAnswer, setEvidenceAnswer] = useState<LayerAnswer | null>(null);
  // The vault authenticator code (single use): typed per attempt and cleared after it is sent.
  const [code, setCode] = useState('');
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  // A new challenge from the vault flow starts a new attempt.
  const challengeId = progress.step === 'layers' ? progress.challenge.challengeId : null;
  useEffect(() => {
    if (progress.step !== 'layers') return;
    setAttempt(current => current && current.challenge.challengeId === progress.challenge.challengeId ? current : freshAttempt(progress.challenge));
  }, [challengeId]);

  const answer: LayerAnswer | null = 'answer' in progress ? progress.answer ?? evidenceAnswer : evidenceAnswer;

  async function verify() {
    if (!attempt || busy) return;
    setProblem(null); setFailures(null); setNote('');
    if (attempt.spent) {
      // A challenge is single use: start a new one for the same release.
      setBusy('Starting a new check');
      try {
        const next = await props.restart();
        if (live.current) { setAttempt(freshAttempt(next)); setNote('Started a new check. Verify again to continue.'); }
      } catch (failure) {
        if (live.current) setProblem({ message: message(failure, 'This release could not be checked again.'), action: failure instanceof LayerCollectionError ? failure.action : null });
      } finally { if (live.current) setBusy(''); }
      return;
    }
    const challenge = attempt.challenge;
    const totpCode = needsTotpCode(challenge) ? code : null;
    setCode('');
    setBusy('Verifying your protection layers');
    setAttempt(current => current && { ...current, collecting: null, collected: [], submitted: false, result: null });
    try {
      props.assertCurrent?.();
      const approval = await props.submit(challenge, {
        onStep: label => {
          if (!live.current) return;
          setBusy(label);
          if (label === REQUESTING_APPROVAL) setAttempt(current => current && { ...current, collecting: null, submitted: true });
        },
        onLayer: (id, phase) => {
          if (!live.current) return;
          setAttempt(current => current && (phase === 'collecting'
            ? { ...current, collecting: id }
            : { ...current, collecting: current.collecting === id ? null : current.collecting, collected: current.collected.includes(id) ? current.collected : [...current.collected, id] }));
        },
        onSubmitted: () => { if (live.current) setAttempt(current => current && { ...current, collecting: null, submitted: true }); },
        totpCode,
      });
      props.assertCurrent?.();
      if (!live.current) return;
      const evidence: LayerAnswer = { kind: 'evidence', status: approval.status };
      setEvidenceAnswer(evidence);
      setAttempt(current => current && { ...current, submitted: true, spent: true, result: resultFor(evidence) });
      props.onApproved(approval, challenge);
    } catch (failure) {
      if (!live.current) return;
      if (failure instanceof PairedVaultApiError) {
        if (failure.code === 'layer-failed') {
          const results = failure.layers ?? [];
          setFailures(results);
          setAttempt(current => current && { ...current, submitted: true, spent: true, collecting: null, result: { kind: 'failed', results } });
        } else if ((failure.code === 'challenge-stale' || failure.code === 'challenge-invalid') && !restarted) {
          setRestarted(true);
          try {
            const next = await props.restart();
            if (live.current) { setAttempt(freshAttempt(next)); setNote('Something changed since this check started (the release, your layers or the time limit). Check the details and verify again.'); }
          } catch (restartFailure) {
            if (live.current) { setAttempt(current => current && { ...current, spent: true, submitted: false }); setProblem({ message: message(restartFailure, 'This release could not be checked again.'), action: null }); }
          }
        } else {
          setAttempt(current => current && { ...current, spent: true, submitted: false, collecting: null });
          setProblem({ message: failure.code === 'locked' ? lockedMessage(failure) : failure.message, action: null });
        }
      } else if (failure instanceof LayerCollectionError) {
        // Nothing was sent: the layer being read (and this attempt's readings) return to Required.
        setAttempt(current => current && { ...current, collecting: null, collected: [], submitted: false });
        setProblem({ message: failure.message, action: failure.action });
      } else {
        setAttempt(current => current && { ...current, collecting: null, collected: [], submitted: false });
        setProblem({ message: message(failure, 'This release could not be verified. Nothing was approved.'), action: null });
      }
    } finally { if (live.current) setBusy(''); }
  }

  async function openFullTab() {
    setHandoffProblem('');
    try {
      const opened = await props.onOpenFullTab?.();
      if (opened === false && live.current) setHandoffProblem('Open ANTARA in a full tab from the Chrome toolbar, then continue this release.');
    } catch { if (live.current) setHandoffProblem('Chrome did not open a new tab.'); }
  }

  // ---- Stations ----
  const phase: StationPhase = useMemo(() => {
    if (progress.step === 'layers' && attempt) {
      return { kind: 'release', layers, required: attempt.challenge.required, collecting: attempt.collecting, collected: attempt.collected, submitted: attempt.submitted, result: attempt.result };
    }
    if (progress.step === 'vote' || progress.step === 'execute' || progress.step === 'done' || progress.step === 'stopped') {
      // The planet stays as step 2 left it: Passed only after an approval of this device's evidence.
      return { kind: 'release', layers, required: attempt?.challenge.required ?? [], collecting: null, collected: [], submitted: true, result: resultFor(answer) ?? { kind: 'approved-no-new-check' } };
    }
    return { kind: 'overview', layers };
  }, [progress, attempt, layers, answer]);
  const states = stationStates(phase);

  // ---- Step, status and actions ----
  const stepIndex = { propose: 0, requesting: 1, layers: 1, 'full-tab': 1, vote: 2, execute: 3, done: 4, stopped: progress.step === 'stopped' ? { propose: 0, vote: 2, execute: 3 }[progress.at] : 0 }[progress.step];
  const noNewCheck = answer?.kind === 'no-evidence' || (answer?.kind === 'evidence' && answer.status !== 'approved');
  let status: SequenceStatus | null = null;
  const actions: SequenceAction[] = [];
  let link: { href: string; label: string } | null = null;
  let closable = true;

  switch (progress.step) {
    case 'propose':
      closable = false;
      status = { text: 'Waiting for your wallet to sign the release proposal.' };
      break;
    case 'requesting':
      closable = false;
      status = { text: `${REQUESTING_APPROVAL}…` };
      break;
    case 'layers': {
      const result = attempt?.result;
      if (result?.kind === 'approved-with-evidence' || result?.kind === 'approved-no-new-check') {
        // Answered: PairedSolanaVault moves on to the vote.
        closable = false;
        status = evidenceAnswer ? { text: answerSentence(evidenceAnswer), tone: 'ok' } : null;
        break;
      }
      if (busy) {
        closable = false;
        status = { text: attempt?.submitted ? 'ANTARA is checking…' : `${busy}…` };
      } else if (result?.kind === 'failed') {
        const failed = (failures ?? []).filter(item => !item.ok);
        status = {
          text: 'ANTARA did not approve this release.', tone: 'danger',
          reasons: failed.map(item => ({ id: item.id, layer: LAYER_NAMES[item.id], reason: item.reason || 'This layer did not pass.' })),
        };
      } else if (problem) {
        status = { text: attempt?.spent ? problem.message : `Nothing was sent. ${problem.message}`, tone: attempt?.spent ? 'danger' : 'warn' };
      } else if (attempt) {
        status = { text: note || requiredSentence(attempt.challenge) };
      }
      const spent = !!attempt?.spent;
      const codeMissing = !spent && !!attempt && needsTotpCode(attempt.challenge) && !TOTP_CODE.test(code);
      actions.push({ label: spent ? 'Start again' : 'Verify and approve', busyLabel: spent ? 'Starting a new check…' : 'Verifying…', busy: !!busy, disabled: !attempt || codeMissing, onClick: () => void verify() });
      if (problem?.action) {
        const action = problem.action;
        const handler = action === 'add-device' ? props.onAddDevice : action === 'add-passkey' ? props.onAddPasskey
          : action === 'open-location-settings' ? props.onOpenLocationSettings : () => void openFullTab();
        if (handler) actions.push({ label: PROBLEM_ACTIONS[action], kind: 'secondary', disabled: !!busy, onClick: handler });
      }
      actions.push({ label: 'Not now', kind: 'secondary', disabled: !!busy, onClick: props.onCancel });
      break;
    }
    case 'full-tab':
      status = { text: handoffProblem || `${SURFACE_NOTES.fullTab} Your release is saved; choose “Continue release” there.`, tone: handoffProblem ? 'warn' : 'neutral' };
      actions.push({ label: 'Approve in a full tab', onClick: () => void openFullTab() }, { label: 'Not now', kind: 'secondary', onClick: props.onCancel });
      break;
    case 'vote':
    case 'execute':
      closable = false;
      status = answer ? { text: answerSentence(answer), tone: 'ok' } : { text: STEP_TEXT[progress.step] };
      break;
    case 'done':
      status = { text: 'Release executed on-chain.', tone: 'ok' };
      link = { href: props.explorerUrl(progress.signature), label: 'View transaction ↗' };
      actions.push({ label: 'Done', onClick: props.onClose });
      break;
    case 'stopped':
      status = { text: progress.message, tone: progress.reason === 'vote-timeout' ? 'warn' : 'danger' };
      if (progress.signature) link = { href: props.explorerUrl(progress.signature), label: 'View transaction ↗' };
      if (progress.reason === 'vote-timeout' && props.onContinue) actions.push({ label: 'Continue release', onClick: props.onContinue });
      if (progress.reason === 'rejected' && props.onHide) actions.push({ label: 'Hide', kind: 'secondary', onClick: props.onHide });
      actions.push({ label: 'Close', kind: actions.length ? 'secondary' : 'primary', onClick: props.onClose });
      break;
  }
  const cancel = progress.step === 'layers' || progress.step === 'full-tab' ? props.onCancel : props.onClose;
  const codeField = progress.step === 'layers' && attempt && !attempt.spent && !attempt.result && needsTotpCode(attempt.challenge)
    ? <TotpCodeField value={code} onChange={setCode} disabled={!!busy} /> : null;
  return (
    <VerificationSequenceView
      step={stepIndex}
      noNewCheck={noNewCheck}
      states={states}
      release={release}
      status={status}
      actions={actions}
      link={link}
      busy={!closable || !!busy}
      onClose={cancel}
      onSelectStation={props.onSelectStation}
      motion={props.motion}
    >{codeField}</VerificationSequenceView>
  );
}

const STEP_TEXT = { vote: 'Waiting for ANTARA’s vote on-chain', execute: 'Your wallet executes the release.' } as const;
