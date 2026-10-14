/**
 * The protection list as plain rows (owner feedback 2026-10-13: "simple for the user"). Pure, so the
 * rules are tested without React. A row says a layer is on only when GET /solana/layers reports it
 * enrolled; with no answer a row only describes the layer. Copy is short and plain: no internal
 * terms, no badges, never a dash placeholder.
 */
import { formatAmount } from '../relay/model';
import { LAYER_NAMES } from './claims';
import { passkeyEnrolled } from './gate';
import type { LayerCapabilities, LayerId, LayerItem, LayerLimitsView, LayerView, VaultLayersView } from './types';

/** The required layer first, then the optional ones. */
export const ROW_ORDER: readonly LayerId[] = ['biometrics', 'geolocation', 'wifi', 'bluetooth', 'mfa', 'limits'];

/**
 * What each layer does, in a few plain words (one line at 420 px). It describes the layer only; it never says the layer
 * is on, and it keeps section 14.2: a location your device reports (no geofence guarantee), the internet address the
 * request comes from (no "Wi-Fi verified"), a device you keep with you (no proximity claim).
 */
export const LAYER_PURPOSE: Readonly<Record<LayerId, string>> = Object.freeze({
  biometrics: 'Fingerprint, face or PIN',
  geolocation: 'Device location in places you pick',
  wifi: 'An internet address you trust',
  bluetooth: 'A device you keep with you',
  mfa: '6-digit code from an app',
  limits: 'A max per release or per day',
});

export type RowTone = 'on' | 'off' | 'warn';
export interface LayerRowModel {
  id: LayerId;
  name: string;
  /** Pill: null when the server's answer is not known (nothing is claimed then). */
  pill: { tone: RowTone; label: string } | null;
  /** One short line: what the layer does, or what is set while it is on. */
  line: string;
  /** The one action, or null. Never a disabled button: `note` says why there is none. */
  action: { kind: 'setup' | 'manage'; label: string } | null;
  /** A muted reason when the row has no action here. */
  note: string | null;
}
export interface RowContext {
  capabilities: Pick<LayerCapabilities, 'surface' | 'passkey' | 'geolocation' | 'bluetooth'>;
  /** False in the extension side panel: changes continue in a full tab, so rows carry no action. */
  inline: boolean;
}

const DECIMALS = { SOL: 9, USDC: 6 } as const;
export const shortWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const amount = (value: bigint, asset: 'SOL' | 'USDC') => `${formatAmount(value.toString(), DECIMALS[asset])} ${asset}`;

/** "Home", "Home and Office", "Home and 2 more". */
export function namesText(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} more`;
}

/** The limits the user set, as one line: "0.5 SOL per release · 2 SOL per day · 200 USDC per day". */
export function capsText(limits: LayerLimitsView | null): string {
  if (!limits) return 'No limits set';
  const parts: string[] = [];
  for (const asset of ['SOL', 'USDC'] as const) {
    const once = limits.perRelease[asset], day = limits.perDay[asset];
    if (once !== null) parts.push(`${amount(once, asset)} per release`);
    if (day !== null) parts.push(`${amount(day, asset)} per day`);
  }
  return parts.length ? parts.join(' · ') : 'No limits set';
}

/** A safe zone's size from the server's detail ("Radius 250 m"), or ''. */
export const zoneSize = (item: Pick<LayerItem, 'detail'>) => /^Radius\s+(\d[\d.,]*\s?k?m)$/i.exec(item.detail.trim())?.[1] ?? '';

/** What is set while a layer is on, in a few words. */
export function setLine(layer: LayerView): string {
  const active = layer.items.filter(item => item.state !== 'pending-addition');
  const waiting = layer.items.filter(item => item.state === 'pending-addition').length;
  const extra = waiting ? ` · ${waiting} waiting` : '';
  switch (layer.id) {
    case 'biometrics': {
      const passkeys = active.filter(item => item.type === 'passkey');
      return `${passkeys.length === 1 ? passkeys[0].label : `${passkeys.length} passkeys`}${extra}`;
    }
    case 'geolocation': {
      const size = active.length === 1 ? zoneSize(active[0]) : '';
      return `${namesText(active.map(item => item.label))}${size ? ` · ${size}` : ''}${extra}`;
    }
    case 'wifi': {
      const networks = active.filter(item => item.type === 'network');
      return `${namesText(networks.map(item => item.label)) || 'Trusted network'}${layer.mode === 'network+radio' ? ' · Wi-Fi name checked' : ''}${extra}`;
    }
    case 'limits': return capsText(layer.limits);
    default: return `${namesText(active.map(item => item.label))}${extra}`;
  }
}

/** Why a layer cannot be set up on this surface, or null. */
export function unavailableHere(id: LayerId, capabilities: RowContext['capabilities']): string | null {
  const desktop = capabilities.surface === 'desktop';
  if (id === 'biometrics' && capabilities.passkey === 'none') return desktop ? 'Passkeys need Windows on this app' : 'Passkeys aren’t available in this browser';
  if (id === 'geolocation' && capabilities.geolocation === 'none') return desktop ? 'Location needs Windows on this app' : 'Location isn’t available in this browser';
  if (id === 'bluetooth' && capabilities.bluetooth === 'none') return desktop ? 'Bluetooth needs Windows on this app' : 'Available in Chrome or the desktop app';
  return null;
}

/** One row per layer, in ROW_ORDER. `view` null: the server's answer is not known, so rows only describe. */
export function layerRows(view: VaultLayersView | null, context: RowContext): LayerRowModel[] {
  const passkeyFirst = view !== null && !passkeyEnrolled(view);
  return ROW_ORDER.map(id => {
    const base = { id, name: LAYER_NAMES[id] };
    const layer = view?.layers.find(item => item.id === id);
    if (!view || !layer) return { ...base, pill: null, line: LAYER_PURPOSE[id], action: null, note: null };
    const act = (kind: 'setup' | 'manage', label: string) => context.inline ? { kind, label } : null;

    if (layer.status === 'pending-removal') {
      return { ...base, pill: { tone: 'warn' as const, label: 'Turning off' }, line: layer.effectiveAt !== null ? `Turns off ${shortWhen(layer.effectiveAt)}` : setLine(layer), action: act('manage', 'Manage'), note: null };
    }
    if (layer.status === 'enrolled') {
      return { ...base, pill: { tone: 'on' as const, label: id === 'biometrics' ? 'On · Required' : 'On' }, line: setLine(layer), action: act('manage', 'Manage'), note: null };
    }
    if (id === 'biometrics') {
      const waiting = layer.items.filter(item => item.type === 'passkey' && item.state === 'pending-addition' && item.effectiveAt !== null).map(item => item.effectiveAt!);
      if (waiting.length) return { ...base, pill: { tone: 'warn' as const, label: 'Waiting' }, line: `Your first passkey takes effect ${shortWhen(Math.min(...waiting))}`, action: act('manage', 'Review'), note: null };
      const unavailable = unavailableHere(id, context.capabilities);
      return { ...base, pill: { tone: 'warn' as const, label: 'Required' }, line: LAYER_PURPOSE[id], action: unavailable ? null : act('setup', 'Add a passkey'), note: unavailable };
    }
    const off = { tone: 'off' as const, label: 'Off' };
    if (passkeyFirst) return { ...base, pill: off, line: LAYER_PURPOSE[id], action: null, note: 'Add a passkey first' };
    const unavailable = unavailableHere(id, context.capabilities);
    return { ...base, pill: off, line: LAYER_PURPOSE[id], action: unavailable ? null : act('setup', 'Turn on'), note: unavailable };
  });
}

/** Layers the server reports on (a layer turning off still counts until it is off). */
export const layersOn = (view: VaultLayersView) => ROW_ORDER.filter(id => view.layers.some(layer => layer.id === id && layer.status !== 'not-enrolled'));

/**
 * The summary above the list, from the server's answer only: "2 of 6 layers on". The rows say what each layer needs,
 * so there is no second sentence listing them (UX review 2026-10-13); only a vault without a passkey gets one.
 */
export function protectionHeadline(view: VaultLayersView): { title: string; text: string } {
  const on = layersOn(view);
  const title = `${on.length} of 6 layers on`;
  if (!passkeyEnrolled(view)) return { title, text: 'Add a passkey to finish setting up your vault.' };
  return { title, text: '' };
}

/** "Added Oct 13, 2026": the date only, for an item's line in its Manage sheet. */
export const addedOn = (ms: number) => `Added ${new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' })}`;

/**
 * One short line for an item in its layer's Manage sheet: when it was added, plus a zone's size and whether a passkey is
 * synced (section 14.1 keeps that warning). The server's raw detail (an address range, the app it came from) stays under
 * "How ANTARA checks this".
 */
export function itemLine(item: Pick<LayerItem, 'type' | 'detail' | 'since'>): string {
  const parts: string[] = [];
  if (item.type === 'zone' && zoneSize(item)) parts.push(zoneSize(item));
  if (item.type === 'passkey' && /^Synced passkey/i.test(item.detail.trim())) parts.push('Synced passkey');
  if (item.since !== null) parts.push(parts.length ? addedOn(item.since).replace(/^Added/, 'added') : addedOn(item.since));
  return parts.join(' · ');
}
