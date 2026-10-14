// Vault activation, presentation only (docs/UI_ARGUS_PARITY.md 6.12; ARGUS rules → disclosure
// → progress). Props in, markup out. ActivationSequence.tsx derives every value from
// PairedSolanaVault's progress and the server's answers; the parity planet harness renders
// this view with fixture props.
//
// 1 Rules (read-only: ANTARA's rules are fixed by policy) · 2 Confirm · 3 Create · 4 Passkey,
// then "Your vault is active." only once the server reports a passkey in force.
import { useEffect, useRef } from 'react';
import { ExternalLink } from '../../platform/ExternalLink';
import { CHECKED_BY, PAIRED_VAULT_CLAIMS, SURFACE_NOTES } from '../layers/claims';
import { ButtonLabel, Icon, MEDIA, Sheet, StatusChip, Stepper, type ChipTone } from '../ui';
import type { StationItem } from './StationChips';
import { VaultPlanet } from './VaultPlanet';
import type { SequenceAction, SequenceStatus } from './VerificationSequenceView';
import './verification.css';

export const ACTIVATION_STEPS = ['Rules', 'Confirm', 'Create', 'Passkey'] as const;
export const ACTIVATION_HEADINGS = ['Your vault’s rules', 'Confirm and create', 'Creating your vault', 'Add a passkey to finish activating'] as const;
/** The sheet's title, matching the "Create vault" button that opens it. */
export const ACTIVATION_TITLE = 'Create your vault';
/** One line per awaited call (6.12 step 3, exact). */
export const CREATION_LINES = [
  'Creating your vault · approve in your wallet. ANTARA then confirms and verifies it on Solana.',
  'Registering your vault with ANTARA',
  'Reading your vault and its protection layers',
] as const;
/** Step 4, in plain words: what the passkey does, and that the device asks twice (the passkey, then setting this device up). */
export const PASSKEY_STEP_TEXT = 'Your fingerprint, face or PIN approves every release. ANTARA never receives biometric data.';
export const PASSKEY_STEP_NOTE = 'Your device will ask twice. That’s expected.';
export const ACKNOWLEDGEMENT = 'I understand that if I lose access to my ANTARA login, funds in this vault cannot be released.';
export const FEE_LINE = 'You sign and pay the on-chain account rent and the Squads program fee. Your wallet shows the exact amount before you sign.';
export const NEEDS_SOL = 'Your Solana wallet needs SOL to pay the vault’s account rent and network fee.';
/** NEEDS_SOL with the live amount (vaults/creationCost.ts). */
export const needsSol = (cost?: string) => cost ? `Add SOL to create your vault: your Solana wallet needs ${cost} for the vault’s account rent and network fee.` : NEEDS_SOL;

export interface ActivationRules {
  /** The guardian pinned in this build. */
  guardian: string;
  /** What the vault holds: USDC is mainnet only. */
  assets: 'SOL' | 'SOL and USDC';
}
/**
 * Live checks for step 1. `sol`: 'unknown' never blocks; 'zero' is a known zero balance and 'short' a known balance
 * below the live creation cost (vaults/creationCost.ts); both block. `cost` is that cost as text ("about 0.0024 SOL").
 * `mfa` is ignored: since 2026-10-13 no account (Privy) MFA is required; the vault authenticator is an optional
 * protection layer set up later.
 */
export interface ActivationRequirements { mfa?: boolean; wallet: boolean; sol: 'met' | 'unknown' | 'zero' | 'short'; cost?: string }
export type LineState = 'waiting' | 'active' | 'done' | 'failed';

export interface ActivationSequenceViewProps {
  /** 0 Rules · 1 Confirm · 2 Create · 3 Passkey · 4 active. */
  step: number;
  states: readonly StationItem[];
  rules: ActivationRules;
  requirements: ActivationRequirements;
  acknowledged: boolean;
  onAcknowledge: (next: boolean) => void;
  /** Step 3: one state per CREATION_LINES entry. */
  lines: readonly LineState[];
  /** Step 4: the side panel hands the passkey ceremony to a full tab. */
  passkeyHandoff?: boolean;
  status: SequenceStatus | null;
  actions: readonly SequenceAction[];
  link?: { href: string; label: string } | null;
  busy: boolean;
  /** Under "Your vault is active." when this device could not be trusted right after the passkey (never an error). */
  doneNote?: string;
  onClose: () => void;
}

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-5)}`;
const REQUIREMENT: Record<'met' | 'missing' | 'unknown', { tone: ChipTone; label: string }> = {
  met: { tone: 'ok', label: 'Ready' },
  missing: { tone: 'danger', label: 'Missing' },
  unknown: { tone: 'neutral', label: 'Balance unavailable' },
};
const LINE_MARK: Record<LineState, string> = { waiting: 'Waiting', active: 'In progress', done: 'Done', failed: 'Stopped' };

function Rules({ rules, requirements }: Pick<ActivationSequenceViewProps, 'rules' | 'requirements'>) {
  const checks = [
    { label: 'Your ANTARA Solana wallet', state: requirements.wallet ? 'met' : 'missing' },
    { label: requirements.cost ? `SOL in that wallet for rent and fees (${requirements.cost})` : 'SOL in that wallet for rent and fees', state: requirements.sol === 'met' ? 'met' : requirements.sol === 'zero' || requirements.sol === 'short' ? 'missing' : 'unknown' },
  ] as const;
  return <>
    <ul className="vseq-act-rules">
      <li><Icon name="shield" size={17} />2 approvals for every release: your wallet and ANTARA’s guardian.</li>
      <li><Icon name="vault" size={17} />ANTARA’s guardian can only vote. It cannot start or execute a transfer.</li>
      <li><Icon name="release" size={17} />Releases of {rules.assets} go only to your own wallets linked to your account.</li>
      <li><Icon name="lock" size={17} /><span>No caps unless you set them: Limits is optional, and you can set your own caps per release or per day after activation.</span></li>
      <li><Icon name="check" size={17} />No time lock: your wallet can execute a release as soon as both approvals are on-chain.</li>
      <li><Icon name="lock" size={17} /><span>Guardian <span className="ui-mono" title={rules.guardian}>{short(rules.guardian)}</span>, pinned in this build and checked on-chain.</span></li>
    </ul>
    <h4 className="ui-eyebrow vseq-act-subheading">Requirements</h4>
    <ul className="vseq-act-checks">
      {checks.map(check => <li key={check.label}><span>{check.label}</span><StatusChip tone={REQUIREMENT[check.state].tone} label={REQUIREMENT[check.state].label} /></li>)}
    </ul>
  </>;
}

export function ActivationSequenceView({
  step, states, rules, requirements, acknowledged, onAcknowledge, lines, passkeyHandoff = false, status, actions, link, busy, doneNote, onClose,
}: ActivationSequenceViewProps) {
  const current = Math.max(0, Math.min(step, ACTIVATION_STEPS.length));
  const done = current >= ACTIVATION_STEPS.length;
  const layout = useRef<HTMLDivElement>(null);
  // Each step starts at its top, not where the previous step's button was.
  useEffect(() => { layout.current?.closest('.ui-sheet-body')?.scrollTo({ top: 0 }); }, [current]);
  return (
    <Sheet title={ACTIVATION_TITLE} onClose={onClose} busy={busy} closeLabel="Close activation" size="large" fullScreenNarrow className="vseq-sheet vseq-act-sheet"
      headerStart={<p className="ui-eyebrow vseq-eyebrow">Solana vault</p>}>
      <div className="vseq-act-layout" data-step={current} ref={layout}>
        <Stepper steps={ACTIVATION_STEPS} current={current} label="Activation steps" />
        {done ? (
          <div className="vseq-act-done">
            <picture>
              <source media="(max-width: 640px)" srcSet={MEDIA.orbitPortrait} />
              <img className="vseq-act-done-art" src={MEDIA.orbitWide} alt="" />
            </picture>
            <h3 className="vseq-act-heading">Your vault is active.</h3>
            <p className="vseq-act-text">Releases need your approval and ANTARA’s. ANTARA approves only releases to your own wallets, within any caps you set.</p>
            {doneNote && <p className="vseq-act-text vseq-act-muted">{doneNote}</p>}
          </div>
        ) : <>
          {/* Before the vault exists there is no server state to show: a small still planet, no station list. */}
          {/* Station chips only while the vault is being created; at the passkey step every layer is still off, so six "Off" chips add nothing. */}
          <VaultPlanet states={states} motion={false} size="compact" labels={current === 2 ? 'chips' : 'none'} className={current < 2 ? 'vseq-act-planet-small' : undefined} />
          <h3 className="vseq-act-heading">{ACTIVATION_HEADINGS[current]}</h3>
          {current === 0 && <Rules rules={rules} requirements={requirements} />}
          {current === 1 && <>
            <ul className="vseq-act-claims">{PAIRED_VAULT_CLAIMS.map(claim => <li key={claim}>{claim}</li>)}</ul>
            <p className="vseq-act-fee">{requirements.cost ? `You sign and pay ${requirements.cost} for the vault account’s rent and the network fee. Your wallet shows the exact amount before you sign.` : FEE_LINE}</p>
            {(requirements.sol === 'zero' || requirements.sol === 'short') && <p className="ui-alert" data-tone="warn" role="note">{needsSol(requirements.cost)}</p>}
            <label className="vseq-act-ack">
              <input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => onAcknowledge(event.target.checked)} />
              <span>{ACKNOWLEDGEMENT}</span>
            </label>
          </>}
          {current === 2 && <ol className="vseq-act-lines" aria-label="Activation progress">
            {CREATION_LINES.map((line, index) => {
              const state = lines[index] ?? 'waiting';
              return <li key={line} data-state={state}>
                <span className="vseq-act-line-mark" aria-hidden="true">{state === 'done' ? <Icon name="check" size={14} /> : state === 'failed' ? <Icon name="close" size={14} /> : index + 1}</span>
                <span className="vseq-act-line-text">{line}</span>
                <span className="vseq-act-line-state">{LINE_MARK[state]}</span>
              </li>;
            })}
          </ol>}
          {current === 3 && <>
            <p className="vseq-act-text">{PASSKEY_STEP_TEXT}</p>
            <p className="vseq-act-text vseq-act-muted">{passkeyHandoff ? SURFACE_NOTES.fullTab : PASSKEY_STEP_NOTE}</p>
            {/* The second prompt sets this device up for the vault's layers; its exact limits (section 14.1) are one tap away. */}
            {!passkeyHandoff && <details className="vseq-act-how">
              <summary>How ANTARA checks this</summary>
              <p>{CHECKED_BY.biometrics}</p>
              <p>The second prompt sets up this device for layers like Safe Zones.</p>
              <p>{CHECKED_BY.trustedDevices}</p>
            </details>}
          </>}
        </>}
        <div className="vseq-status" role="status" aria-live="polite" data-tone={status?.tone ?? 'neutral'}>{status && <p>{status.text}</p>}</div>
        <div className="vseq-actions vseq-act-actions">
          {actions.map(action => (
            <button key={action.label} type="button" className={action.kind === 'secondary' ? 'ui-btn' : 'ui-btn-primary'}
              disabled={action.disabled || action.busy} aria-busy={action.busy || undefined} onClick={action.onClick}
              title={action.label === 'Discard this attempt' ? 'Only if the creation transaction never confirmed' : undefined}>
              {action.busyLabel ? <ButtonLabel busy={!!action.busy} label={action.label} busyLabel={action.busyLabel} /> : action.label}
            </button>
          ))}
          {link && <ExternalLink className="ui-btn-text vseq-link" href={link.href}>{link.label}</ExternalLink>}
        </div>
      </div>
    </Sheet>
  );
}
