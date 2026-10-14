/**
 * Server state → planet stations (docs/UI_ARGUS_PARITY.md 7.2). Pure: no React, no
 * network. A station shows a status only from GET /solana/layers (overview,
 * activation) or from ANTARA's answer to this exact release; anything unknown stays
 * `unknown`, which renders as neutral metal with no text.
 *
 * Per-layer explanations stay in layers/claims.ts. This module holds only the short
 * status labels of 7.2, and stationState.test.ts runs every label it can produce
 * against NEVER_CLAIM.
 */
import type { VaultLayersLoad } from '../layers/gate';
import { LAYER_IDS, type LayerId, type LayerRequirement, type LayerResult, type LayerView } from '../layers/types';
import type { StationVisual } from '../landing/AntaraSculpture';

export type { StationVisual };

/** Every visual, for tests and the planet harness. */
export const STATION_VISUALS: readonly StationVisual[] = [
  'unknown', 'off', 'on', 'required', 'collecting', 'collected', 'checking', 'passed', 'failed', 'pending-removal',
];

/** How the release's layer step ended, as far as this screen may say. */
export type ReleaseResult =
  | null
  /** 'approved' answering submitReleaseApproval: the server evaluated the evidence for this release. */
  | { kind: 'approved-with-evidence' }
  /**
   * 'approved', 'pending' or 'already-approved' answering the request without evidence, or 'pending' /
   * 'already-approved' after evidence. The client cannot tell whether layers were checked for it.
   */
  | { kind: 'approved-no-new-check' }
  /** 403 layer-failed: one entry per layer the server evaluated. */
  | { kind: 'failed'; results: LayerResult[] };

export type StationPhase =
  /** Vault side, Protection. */
  | { kind: 'overview'; layers: VaultLayersLoad }
  | { kind: 'activation'; layers: VaultLayersLoad }
  | {
    kind: 'release';
    layers: VaultLayersLoad;
    /** `challenge.required` of the release challenge; [] when no challenge was issued. */
    required: LayerRequirement[];
    /** The layer this device is reading now (8.7 callback), or null. */
    collecting: LayerId | null;
    /** Layers this device has read for the current attempt. */
    collected: LayerId[];
    /** The evidence was sent and ANTARA has not answered yet. */
    submitted: boolean;
    result: ReleaseResult;
  };

const layerOf = (layers: VaultLayersLoad, id: LayerId): LayerView | undefined =>
  layers.status === 'ready' ? layers.view.layers.find(layer => layer.id === id) : undefined;

/**
 * Rule 2: the overview visual from the server's layer status. MFA is ANTARA's own vault authenticator since 2026-10-13:
 * optional like the other layers, so "not enrolled" is simply Off (no Privy MFA pauses anything).
 */
function overviewVisual(layer: LayerView | undefined): StationVisual {
  if (!layer) return 'unknown';
  if (layer.status === 'enrolled') return 'on';
  if (layer.status === 'pending-removal') return 'pending-removal';
  return 'off';
}

/**
 * Server-evidence layers (Wi-Fi network, Limits) are never read on this device, and the MFA code is typed, not read, so
 * they stay `required` until submit.
 */
const readOnDevice = (required: LayerRequirement[], id: LayerId) => required.some(item => item.id === id && item.evidence !== 'server' && item.evidence !== 'totp');

/** Length 6, LAYER_IDS (landing) order. */
export function stationVisuals(phase: StationPhase): StationVisual[] {
  // Rule 1: nothing is known without a successful layer read for this vault.
  if (phase.layers.status !== 'ready') return LAYER_IDS.map(() => 'unknown');
  const overview = LAYER_IDS.map(id => overviewVisual(layerOf(phase.layers, id)));
  if (phase.kind !== 'release') return overview;
  const { required, collecting, collected, submitted, result } = phase;
  // Rule 3: a result without new evidence keeps the overview; it never yields `passed`.
  if (result?.kind === 'approved-no-new-check') return overview;
  return LAYER_IDS.map((id, index): StationVisual => {
    if (!required.some(item => item.id === id)) return overview[index];
    if (result?.kind === 'approved-with-evidence') return 'passed';
    if (result?.kind === 'failed') {
      const answer = result.results.find(item => item.id === id);
      return !answer ? 'required' : answer.ok ? 'passed' : 'failed';
    }
    if (submitted) return 'checking';
    if (collecting === id) return 'collecting';
    if (collected.includes(id) && readOnDevice(required, id)) return 'collected';
    return 'required';
  });
}

const date = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Extra context a label needs: the server's reason for a failed layer, or "Not checked" for a required layer the answer left out. */
export interface LabelContext { reason?: string | null; notChecked?: boolean; wifiRadio?: boolean }

/** The short status of one station (7.2 rule 4, exact). `unknown` has no text. */
export function stationLabel(id: LayerId, visual: StationVisual, layer?: LayerView, context: LabelContext = {}): string {
  switch (visual) {
    case 'unknown': return '';
    case 'off': return 'Off';
    case 'on': return 'On';
    case 'pending-removal': return layer?.effectiveAt != null ? `Turning off ${date(layer.effectiveAt)}` : 'Turning off';
    case 'required': return context.notChecked ? 'Not checked' : 'Required';
    case 'collecting': return 'Reading on this device…';
    case 'collected': return 'Ready to send';
    case 'checking': return 'ANTARA is checking…';
    case 'passed':
      // MFA: ANTARA checked the authenticator code sent with this release. Wi-Fi in network mode observes only the public address.
      if (id === 'mfa') return 'Passed · code checked';
      if (id === 'wifi' && !(context.wifiRadio ?? layer?.mode === 'network+radio')) return 'Passed · network check';
      return 'Passed';
    case 'failed':
      return context.reason?.trim() || 'Did not pass';
  }
}

/** Labels for all six stations of a phase, with the visuals they describe. */
export function stationStates(phase: StationPhase): { id: LayerId; visual: StationVisual; label: string }[] {
  const visuals = stationVisuals(phase);
  const results = phase.kind === 'release' && phase.result?.kind === 'failed' ? phase.result.results : [];
  const required = phase.kind === 'release' ? phase.required : [];
  return LAYER_IDS.map((id, index) => {
    const visual = visuals[index];
    const answer = results.find(item => item.id === id);
    const isRequired = required.some(item => item.id === id);
    const context: LabelContext = {
      reason: visual === 'failed' && answer ? answer.reason : null,
      notChecked: phase.kind === 'release' && phase.result?.kind === 'failed' && isRequired && !answer,
      wifiRadio: id === 'wifi' && isRequired ? required.some(item => item.id === 'wifi' && item.reading === 'wifi') : undefined,
    };
    return { id, visual, label: stationLabel(id, visual, layerOf(phase.layers, id), context) };
  });
}

/** Overview of a vault's layers in one call (Vault side chips, Protection). */
export const overviewStations = (layers: VaultLayersLoad) => stationStates({ kind: 'overview', layers });
