// Verification sequence, presentation only (docs/UI_ARGUS_PARITY.md 6.14; ARGUS S21 overlay
// structure). Props in, markup out: no state of its own beyond the Sheet, no operation, no
// network. VerificationSequence.tsx decides every value from the vault flow's progress and
// ANTARA's answers; the parity planet harness renders this view with fixture props.
//
// Layout: a full-screen sheet. Wide: the planet with its leader-line rail on the left, the
// steps, release card, status line and actions on the right. Narrow: one column with the
// chips grid under the planet.
import type { ReactNode } from 'react';
import { ExternalLink } from '../../platform/ExternalLink';
import { CHECKED_BY } from '../layers/claims';
import type { LayerId } from '../layers/types';
import { AddressText, ButtonLabel, Sheet, Stepper } from '../ui';
import type { StationItem } from './StationChips';
import { VaultPlanet } from './VaultPlanet';
import './verification.css';

export const VERIFICATION_STEPS = ['Propose', 'Verify layers', 'ANTARA’s vote', 'Execute'] as const;
/** What each step does, shown under the stepper (6.14, exact). */
export const STEP_NOTES = [
  'Your wallet signs the release proposal.',
  'ANTARA checks every layer you turned on for this release.',
  'Waiting for ANTARA’s vote on-chain',
  'Your wallet executes the release.',
] as const;
export const NO_NEW_CHECK_NOTE = 'No new layer check requested';

export interface ReleaseCardData {
  /** Squads transaction index. */
  index: string;
  /** Formatted amount, e.g. "0.25". */
  amount: string;
  asset: 'SOL' | 'USDC';
  /** "This wallet", "ANTARA wallet" or "Linked wallet". */
  recipientLabel: string;
  recipient: string;
}

export interface SequenceStatus {
  text: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'danger';
  /** Per-layer reasons from a layer-failed answer (server text). */
  reasons?: readonly { id: LayerId; layer: string; reason: string }[];
}

export interface SequenceAction {
  label: string;
  onClick: () => void;
  kind?: 'primary' | 'secondary';
  disabled?: boolean;
  /** Shows `busyLabel` in place of `label`, keeping the width. */
  busy?: boolean;
  busyLabel?: string;
}

export interface VerificationSequenceViewProps {
  /** 0 Propose · 1 Verify layers · 2 ANTARA's vote · 3 Execute · 4 done. */
  step: number;
  /** Step 2 was decided without a new layer check (an answer to the request without evidence). */
  noNewCheck?: boolean;
  states: readonly StationItem[];
  release: ReleaseCardData;
  /** The aria-live status line. */
  status: SequenceStatus | null;
  actions: readonly SequenceAction[];
  /** "View transaction ↗". */
  link?: { href: string; label: string } | null;
  /** Blocks every way of closing while an operation runs. */
  busy: boolean;
  onClose: () => void;
  onSelectStation?: (id: LayerId) => void;
  /** The in-app "Celestial motion" switch. */
  motion?: boolean;
  /** Extra content under the actions (for example a pending-change warning). */
  children?: ReactNode;
}

export function VerificationSequenceView({
  step, noNewCheck = false, states, release, status, actions, link, busy, onClose, onSelectStation, motion = true, children,
}: VerificationSequenceViewProps) {
  const current = Math.max(0, Math.min(step, VERIFICATION_STEPS.length));
  const note = current >= VERIFICATION_STEPS.length ? null : current === 1 && noNewCheck ? NO_NEW_CHECK_NOTE : STEP_NOTES[current];
  return (
    <Sheet
      title="Security verification"
      onClose={onClose}
      busy={busy}
      closeLabel="Close verification"
      size="large"
      fullScreenNarrow
      className="vseq-sheet vseq-fullscreen"
      headerStart={<p className="ui-eyebrow vseq-eyebrow">Vault release</p>}
    >
      <div className="vseq-layout" data-step={current}>
        <div className="vseq-steps">
          <Stepper steps={VERIFICATION_STEPS} current={current} label="Release steps" />
          {note && <p className="vseq-step-note">{note}</p>}
          {noNewCheck && current > 1 && <p className="vseq-step-note vseq-step-note-muted">Step 2 · {NO_NEW_CHECK_NOTE}</p>}
        </div>
        <div className="vseq-visual">
          <VaultPlanet states={states} onSelect={onSelectStation} motion={motion} size="hero" />
        </div>
        <div className="vseq-status" role="status" aria-live="polite" data-tone={status?.tone ?? 'neutral'}>
          {status && <>
            <p>{status.text}</p>
            {!!status.reasons?.length && <ul className="vseq-reasons">
              {status.reasons.map(item => <li key={item.id}><strong>{item.layer}</strong> {item.reason}</li>)}
            </ul>}
          </>}
        </div>
        <section className="ui-card vseq-release" aria-label="Release">
          <p className="ui-eyebrow">Releasing</p>
          <p className="vseq-release-amount"><span className="vseq-release-value">{release.amount}</span> <span className="vseq-release-asset">{release.asset}</span></p>
          <p className="vseq-release-to">to {release.recipientLabel} · <AddressText address={release.recipient} form="short" /></p>
          <p className="vseq-release-index">Release #{release.index}</p>
        </section>
        <div className="vseq-actions">
          {actions.map(action => (
            <button key={action.label} type="button" className={action.kind === 'secondary' ? 'ui-btn' : 'ui-btn-primary'}
              disabled={action.disabled || action.busy} aria-busy={action.busy || undefined} onClick={action.onClick}>
              {action.busyLabel ? <ButtonLabel busy={!!action.busy} label={action.label} busyLabel={action.busyLabel} /> : action.label}
            </button>
          ))}
          {link && <ExternalLink className="ui-btn-text vseq-link" href={link.href}>{link.label}</ExternalLink>}
        </div>
        {children && <div className="vseq-extra">{children}</div>}
        <p className="vseq-footnote">{CHECKED_BY.all}</p>
      </div>
    </Sheet>
  );
}
