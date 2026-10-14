// The vault's protection (docs/VAULT_LAYERS.md section 12), rebuilt simple (owner feedback 2026-10-13):
// one list row per layer with one action, and one focused sheet per layer. "Turn on" runs a short guided
// flow that handles every prerequisite itself: when this device must be trusted first, that is a step of
// the same flow (never a separate error), then the browser or Windows permission, then the passkey.
// Status appears only after GET /solana/layers answered 200 and passed the strict parser; every change
// still goes through the server's challenge, its rules and a passkey (setup.ts, flow.ts).
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Icon, Sheet } from '../ui';
import { parseAmount } from '../vaults/validation';
import { cancelChange } from './api';
import { CHECKED_BY, LAYER_NAMES, SURFACE_NOTES, checkedByLines } from './claims';
import type { LayerPlatform } from './collectors';
import {
  DEVICE_NAMES, FORM_LAYER, FORM_LEAD, KIND_SHORT, MANAGE_LEAD, SETUP_FORM, SHEET_COPY, TURN_OFF_LINE, defaultName, doneTitle, formTitle, setupTitle, type LayerFormKind,
} from './copy';
import { loadDeviceKey, type DeviceKeyStorage } from './deviceKey';
import { TOTP_CODE, checkTrustedBluetooth, needsTotpCode, readingsFor, type LayerContext } from './flow';
import { passkeyEnrolled, type VaultLayersLoad } from './gate';
import { TotpCodeField } from './LayerApproval';
import { LayerList } from './LayerList';
import { defaultDeviceKeyStorage, defaultLayerPlatform } from './platform';
import { itemLine, layerRows, protectionHeadline, shortWhen, type LayerRowModel } from './rows';
import { looksUnmasked } from './schema';
import {
  BLUETOOTH_OTHER_APP, canContinue, completeChange, flowProblem, pauseFor, planSteps, prepareChange, readsFromDevice, trustJob, trustThisDevice,
  type ChangeJob, type Draft, type FlowDeps, type FlowProblem, type FlowStep, type Pause, type Prepared, type StepKey,
} from './setup';
import {
  isOptionalLayer,
  type ChangeChallenge, type ChangeOp, type ChangeResult, type DisableableLayerId, type LayerId, type LayerItem, type LayerView, type OptionalLayerId,
  type PendingChangeNotice, type PendingChangeView, type VaultLayersView,
} from './types';
import { LayerIcon } from '../verification/layerIcons';
import '../ui/ui.css';
import './layers.css';

export type { LayerFormKind } from './copy';
/** Opens a sheet from elsewhere: a form ("Trust this device" from a release, "Add a passkey" from activation) or a layer's row action. */
export type LayerRequest = { id: number } & ({ form: LayerFormKind; layer?: undefined } | { layer: LayerId; form?: undefined });

const DECIMALS = { SOL: 9, USDC: 6 } as const;
const RADII = [250, 500, 1000, 5000, 25000];
const radiusText = (radius: number) => radius < 1000 ? `${radius} m` : `${radius / 1000} km`;
/** The otpauth:// URI an authenticator app reads (RFC 6238: SHA-1, 6 digits, 30 seconds), built here from the secret only. */
export function otpauthUri(secret: string, multisig: string): string {
  const label = encodeURIComponent(`ANTARA:Vault ${multisig.slice(0, 6)}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=ANTARA&algorithm=SHA1&digits=6&period=30`;
}
const groupKey = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();
/** A limit field: empty is no limit; anything else must be a positive amount. */
function capField(text: string, asset: 'SOL' | 'USDC', what: string): bigint | null {
  if (!text) return null;
  try { return parseAmount(text, DECIMALS[asset]); } catch { throw new Error(`Enter the ${asset} ${what} limit as a positive amount, or leave it empty for no limit.`); }
}
/** Exact decimal text for a raw amount, so a form never rounds a limit it was prefilled with. */
export function exactDecimal(value: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / unit}${fraction ? `.${fraction}` : ''}`;
}
/** What a pending change does, from fixed text only (the summary may quote a user-chosen label). */
function pendingKindText(change: PendingChangeNotice) {
  if (change.class === 'loosen') return 'Loosens protection';
  return change.waived?.length ? `Recovery · waives ${change.waived.map(id => LAYER_NAMES[id]).join(', ')}` : 'Recovery';
}
const pendingTitle = (change: PendingChangeView) => change.label ? `${change.summary} “${change.label}”` : change.summary;
function itemStateText(item: { state: LayerItem['state']; effectiveAt: number | null }) {
  if (item.state === 'pending-addition') return `Takes effect ${shortWhen(item.effectiveAt!)}`;
  if (item.state === 'pending-removal') return `Removal takes effect ${shortWhen(item.effectiveAt!)}`;
  return '';
}
const removeOp = (layer: LayerId, item: LayerItem): ChangeOp | null => {
  if (layer === 'biometrics' && item.type === 'passkey') return { type: 'passkey.remove', credentialId: item.id };
  if (layer === 'geolocation' && item.type === 'zone') return { type: 'geolocation.remove-zone', zoneId: item.id };
  if (layer === 'bluetooth' && item.type === 'bluetooth') return { type: 'bluetooth.remove-device', deviceId: item.id };
  if (layer === 'wifi' && item.type === 'radio') return { type: 'wifi.remove-radio', radioId: item.id };
  if (layer === 'wifi' && item.type === 'network') return { type: 'wifi.remove-network', networkId: item.id };
  return null;
};
/** Optional layers whose evidence a change asks for: the ones a user could waive if they can no longer satisfy them. */
const waivableIn = (challenge: ChangeChallenge, waived: OptionalLayerId[]) =>
  [...new Set(challenge.required.map(item => item.id))].filter((id): id is OptionalLayerId => isOptionalLayer(id) && !waived.includes(id));
const activePasskeys = (layer: LayerView) => layer.items.filter(item => item.type === 'passkey' && item.state === 'active').length;
const isSynced = (item: Pick<LayerItem, 'type' | 'detail'>) => item.type === 'passkey' && /^Synced passkey/i.test(item.detail.trim());
/** "Turn off Wi-Fi" → "turn off Wi-Fi", to name a change inside a sentence. */
const inSentence = (title: string) => title.charAt(0).toLowerCase() + title.slice(1);

const CONTINUE_LABEL: Record<Pause, string> = {
  recovery: 'Confirm', 'mfa-setup': 'Turn on MFA', code: 'Continue', 'choose-bluetooth': 'Use this device', 'choose-wifi': 'Use this network',
  'bluetooth-trusted': 'Find your trusted device', 'bluetooth-chooser': 'Choose your device',
};
const STEP_STATE_TEXT: Record<FlowStep['state'], string> = { waiting: 'Waiting', active: 'In progress', done: 'Done', failed: 'Stopped' };
/** What Continue still needs, said in one line next to it (never a disabled button). */
function missingFor(draft: Draft, pause: Pause): string {
  if (needsTotpCode(draft.challenge) && !TOTP_CODE.test(draft.totpCode)) return SHEET_COPY.needCode;
  if (pause === 'choose-bluetooth') return SHEET_COPY.needBluetooth;
  if (pause === 'choose-wifi') return SHEET_COPY.needWifi;
  return '';
}

interface Done { title: string; text: string }
type Screen =
  | { name: 'form'; kind: LayerFormKind; values: Record<string, string>; error: string }
  | { name: 'manage'; values: Record<string, string>; error: string }
  | { name: 'confirm'; text: string; button: string; job: ChangeJob; done: Done }
  | { name: 'flow' };
interface SheetState { layer: LayerId | 'devices'; title: string; screen: Screen }
interface FlowState {
  title: string;
  /** What the user asked for, and what runs after it (a change waiting for this device to be trusted). */
  job: ChangeJob;
  then: ChangeJob | null;
  done: Done;
  /** The vault's first passkey: this device is trusted right after it, in the same flow. */
  firstPasskey: boolean;
  steps: FlowStep[];
  status: 'working' | 'paused' | 'done' | 'failed';
  progress: string;
  prepared: Prepared | null;
  pause: Pause | null;
  /** What Continue still needs, shown after a click on it. */
  need: string;
  problem: (FlowProblem & { forTrust: boolean }) | null;
  result: Done | null;
}

export interface VaultLayersProps {
  multisig: string;
  privyUserId: string;
  getToken: () => Promise<string>;
  /** GET /solana/layers, loaded by the vault (useVaultLayers) so the vault and this panel never disagree. */
  load: VaultLayersLoad;
  reload: () => void;
  platform?: LayerPlatform;
  keys?: DeviceKeyStorage;
  /** Throws when the wallet session changed since the view loaded. */
  assertCurrent?: () => void;
  request?: LayerRequest | null;
  /** The "2 of 6 layers on" line above the list. Off where the page already shows it (Protection). */
  showSummary?: boolean;
}

export function VaultLayers({ multisig, privyUserId, getToken, load, reload, platform: injected, keys: injectedKeys, assertCurrent, request, showSummary = true }: VaultLayersProps) {
  const platform = useMemo(() => injected ?? defaultLayerPlatform(), [injected]);
  const keys = useMemo(() => injectedKeys ?? defaultDeviceKeyStorage(), [injectedKeys]);
  const capabilities = platform.capabilities();
  const surface = capabilities.surface;
  const inline = capabilities.ceremonyInline;
  const [localKey, setLocalKey] = useState<{ keyId: string | null; problem: string }>({ keyId: null, problem: '' });
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [cancelling, setCancelling] = useState('');
  const [notice, setNotice] = useState('');
  const [listProblem, setListProblem] = useState('');
  const sheetKey = `vl${useId().replace(/:/g, '')}`;
  const busyRef = useRef(false);
  /** Which change is running: a passkey prompt then belongs to the trust step or to the change itself. */
  const phaseRef = useRef<'trust' | 'main'>('main');
  const failingRef = useRef<ChangeJob['kind']>('change');

  useEffect(() => {
    let live = true;
    loadDeviceKey(keys, privyUserId, multisig)
      .then(key => { if (live) setLocalKey({ keyId: key?.keyId ?? null, problem: '' }); })
      .catch(failure => { if (live) setLocalKey({ keyId: null, problem: failure instanceof Error ? failure.message : 'This device cannot keep a trusted device key.' }); });
    return () => { live = false; };
  }, [keys, privyUserId, multisig, load.status === 'ready' ? load.view.configVersion : -1]);

  const view: VaultLayersView | null = load.status === 'ready' ? load.view : null;
  // The flow runs across renders: it reads the latest answer, never the one from the render that started it.
  const viewRef = useRef(view);
  viewRef.current = view;
  const enabled = (view?.layers ?? []).filter(layer => isOptionalLayer(layer.id) && layer.status !== 'not-enrolled').map(layer => layer.id as OptionalLayerId);
  const passkeyFirst = view !== null && !passkeyEnrolled(view);
  const layerOf = (id: LayerId) => view?.layers.find(layer => layer.id === id) ?? null;
  const isOn = (id: LayerId) => { const layer = layerOf(id); return !!layer && layer.status !== 'not-enrolled'; };
  const thisDeviceTrusted = !!view && !!localKey.keyId && view.devices.some(device => device.keyId === localKey.keyId && device.surface === surface && device.state === 'active');
  const rows = layerRows(view, { capabilities, inline });

  // ---- Flow progress -------------------------------------------------------------------------
  const patchFlow = (update: (current: FlowState) => FlowState) => setFlow(current => current ? update(current) : current);
  const mark = (key: StepKey, state: FlowStep['state']) => patchFlow(current => ({ ...current, steps: current.steps.map(step => step.key === key ? { ...step, state } : step) }));
  const markDone = (key: StepKey) => patchFlow(current => ({ ...current, steps: current.steps.map(step => step.key === key && step.state !== 'failed' ? { ...step, state: 'done' } : step) }));
  const context: LayerContext = {
    platform, keys, privyUserId, multisig,
    onStep: label => {
      patchFlow(current => ({ ...current, progress: label }));
      if (label === 'Creating your passkey' && phaseRef.current === 'main') mark('confirm', 'active');
    },
    onLayer: (id, phase) => {
      if (phaseRef.current === 'trust') { mark('trust', 'active'); return; }
      if (id === 'biometrics') { if (phase === 'collecting') { markDone('read'); mark('confirm', 'active'); } return; }
      mark('read', phase === 'collecting' ? 'active' : 'done');
    },
  };
  /** This device's key once a flow trusted it, until the next answer lists it (a hint only: the server's challenge decides). */
  const trustedRef = useRef<string | null>(null);
  const knownDevices = () => {
    const devices = viewRef.current?.devices ?? null;
    const extra = trustedRef.current;
    return devices && extra && !devices.some(device => device.keyId === extra) ? [...devices, { keyId: extra, surface, state: 'active' }] : devices;
  };
  /** `known` false: decide from the server's next answer only (right after this device was trusted, the last view predates it). */
  const deps = (known = true): FlowDeps => ({ token: getToken, context, deviceLabel: DEVICE_NAMES[surface], knownDevices: known ? knownDevices() : null });
  const setupName = setupTitle(surface);
  /** The steps again with "Set up this browser" first (the server said this device must be set up), keeping each step's state. */
  const withTrustStep = (current: FlowState): FlowStep[] => {
    if (current.steps.some(step => step.key === 'trust')) return current.steps;
    const main = current.then ?? current.job;
    return planSteps(main, true, surface).map(step => ({ ...step, state: current.steps.find(item => item.key === step.key)?.state ?? step.state }));
  };

  async function prepareStep(job: ChangeJob, then: ChangeJob | null, known = true): Promise<Prepared> {
    failingRef.current = job.kind;
    const prepared = await prepareChange(job, deps(known));
    // The change reads from this device and the flow sets it up first: that becomes the first step on screen.
    if (prepared.draft?.job.kind === 'trust' && job.kind === 'change') patchFlow(current => ({ ...current, steps: withTrustStep(current) }));
    return { draft: prepared.draft, next: prepared.next ?? then };
  }

  /** Runs prepared changes until one needs the user, the chain is done, or something fails. */
  async function drive(start: { job: ChangeJob; then: ChangeJob | null } | { prepared: Prepared }) {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      assertCurrent?.();
      let resumed = 'prepared' in start;
      let prepared = 'prepared' in start ? start.prepared : await prepareStep(start.job, start.then);
      let trustedOnce = false;
      for (;;) {
        assertCurrent?.();
        const draft = prepared.draft;
        if (draft) {
          const trusting = draft.job.kind === 'trust';
          // This device is trusted at most once per flow; asking again would mean the server did not keep it.
          if (trusting && trustedOnce) throw new Error('This device could not be set up for this vault. Nothing else was changed.');
          failingRef.current = draft.job.kind;
          phaseRef.current = trusting ? 'trust' : 'main';
          if (trusting) mark('trust', 'active');
          if (!resumed) {
            const pause = pauseFor(draft, platform);
            if (pause) {
              const waiting = prepared;
              if (!trusting && pause !== 'recovery' && pause !== 'code') mark('read', 'active');
              patchFlow(current => ({ ...current, status: 'paused', prepared: waiting, pause, progress: '', need: '' }));
              return;
            }
          }
          resumed = false;
          const result = await completeChange(draft, deps());
          assertCurrent?.();
          if (trusting) {
            trustedOnce = true; markDone('trust');
            if (draft.candidate) { trustedRef.current = draft.candidate.keyId; setLocalKey({ keyId: draft.candidate.keyId, problem: '' }); }
            reload();
          }
          if (result.status === 'pending' || !prepared.next) { await finished(result, draft.job); return; }
        } else if (!prepared.next) { await finished(null, null); return; }
        const next: ChangeJob = prepared.next!;
        patchFlow(current => ({ ...current, progress: SHEET_COPY.working }));
        prepared = await prepareStep(next, null, !trustedOnce);
      }
    } catch (failure) {
      const problem = flowProblem(failure, enabled);
      const forTrust = failingRef.current === 'trust' || (failure instanceof Error && BLUETOOTH_OTHER_APP.test(failure.message));
      patchFlow(current => ({
        ...current, status: 'failed', progress: '', pause: null, prepared: null, problem: { ...problem, forTrust },
        steps: current.steps.map(step => step.state === 'active' ? { ...step, state: 'failed' } : step),
      }));
    } finally { busyRef.current = false; }
  }

  /** The chain is over: say what changed, in plain words. */
  async function finished(result: ChangeResult | null, job: ChangeJob | null) {
    reload();
    let note = '';
    // The vault's first passkey: trust this device in the same flow, so layers that read from it later only need their own prompt.
    if (result?.status === 'applied' && job?.kind === 'change' && job.op.type === 'passkey.add' && flowRef.current?.firstPasskey) {
      phaseRef.current = 'trust';
      patchFlow(current => ({ ...current, progress: `${setupName}: confirm with your passkey again` }));
      try {
        mark('trust', 'active');
        const trusted = await trustThisDevice(deps());
        markDone('trust');
        const key = await loadDeviceKey(keys, privyUserId, multisig).catch(() => null);
        if (key) { trustedRef.current = key.keyId; setLocalKey({ keyId: key.keyId, problem: '' }); }
        note = trusted || key ? SHEET_COPY.trustedAfterPasskey : '';
        reload();
      } catch {
        // Never fatal: the passkey is in force. The device is trusted later, inside the first layer that needs it.
        patchFlow(current => ({ ...current, steps: current.steps.filter(step => step.key !== 'trust') }));
        note = SHEET_COPY.trustLater;
      }
    }
    patchFlow(current => {
      const done = result?.status === 'pending'
        ? { title: 'Scheduled', text: `${job?.kind === 'trust' ? setupName : job?.title ?? current.title} takes effect ${shortWhen(result.change.effectiveAt)}. You can cancel it until then under Pending changes.` }
        : { ...current.done, text: [current.done.text, note].filter(Boolean).join(' ') };
      return { ...current, status: 'done', progress: '', pause: null, prepared: null, steps: current.steps.map(step => ({ ...step, state: 'done' as const })), result: done };
    });
  }
  const flowRef = useRef<FlowState | null>(null);
  flowRef.current = flow;

  /** Starts a change from one click. Every prerequisite is part of the same flow. */
  function launch(job: ChangeJob, then: ChangeJob | null, title: string, done: Done, firstPasskey = false) {
    if (busyRef.current) return;
    const main = then ?? job;
    const predicted = main.kind === 'change' && readsFromDevice(main.op) && !thisDeviceTrusted;
    let steps = planSteps(main, predicted || (job.kind === 'trust' && main !== job), surface);
    if (firstPasskey) steps = [...steps, firstPasskeyTrustStep()];
    setNotice('');
    setSheet(current => current ? { ...current, title, screen: { name: 'flow' } } : { layer: 'devices', title, screen: { name: 'flow' } });
    setFlow({ title, job, then, done, firstPasskey, steps, status: 'working', progress: SHEET_COPY.working, prepared: null, pause: null, need: '', problem: null, result: null });
    void drive({ job, then });
  }
  /** After the vault's first passkey, this device is set up in the same flow: its own (second) passkey prompt. */
  const firstPasskeyTrustStep = (): FlowStep => ({ key: 'trust', label: setupName, hint: 'Confirm with your passkey again', state: 'waiting' });
  const change = (op: ChangeOp, title: string, done: Done, firstPasskey = false) => launch({ kind: 'change', op, title, waive: [] }, null, title, done, firstPasskey);

  function resume() {
    const current = flowRef.current;
    const draft = current?.prepared?.draft;
    if (!current || !draft || !current.pause || busyRef.current) return;
    // Continue is never a dead button: when something is still missing, one line next to it says what.
    if (!canContinue(draft, current.pause)) { patchFlow(value => ({ ...value, need: missingFor(draft, current.pause!) })); return; }
    if (current.pause === 'bluetooth-trusted') {
      // Chrome needs one click per chooser: find a trusted device first; the next click chooses the new one.
      busyRef.current = true;
      patchFlow(value => ({ ...value, status: 'working', progress: 'Checking your Bluetooth device' }));
      void checkTrustedBluetooth(draft.challenge, context).then(matched => {
        patchFlow(value => value.prepared?.draft ? { ...value, status: 'paused', progress: '', pause: 'bluetooth-chooser', prepared: { ...value.prepared, draft: { ...value.prepared.draft, bluetoothMatched: matched } } } : value);
      }, failure => {
        patchFlow(value => ({ ...value, status: 'failed', progress: '', problem: { ...flowProblem(failure, enabled), forTrust: false }, steps: value.steps.map(step => step.state === 'active' ? { ...step, state: 'failed' } : step) }));
      }).finally(() => { busyRef.current = false; });
      return;
    }
    if (current.pause === 'recovery') {
      // Confirmed: anything else only the user can give (a code, a Bluetooth click) still waits for them.
      const confirmed = { ...draft, confirmed: true };
      const next = pauseFor(confirmed, platform);
      if (next) { patchFlow(value => value.prepared ? { ...value, pause: next, prepared: { ...value.prepared, draft: confirmed } } : value); return; }
      patchFlow(value => ({ ...value, status: 'working', pause: null, progress: 'Verifying' }));
      void drive({ prepared: { ...current.prepared!, draft: confirmed } });
      return;
    }
    if (current.pause === 'mfa-setup') markDone('read');
    patchFlow(value => ({ ...value, status: 'working', pause: null, progress: 'Verifying' }));
    void drive({ prepared: current.prepared! });
  }
  const updateDraft = (update: Partial<NonNullable<Prepared['draft']>>) =>
    patchFlow(value => value.prepared?.draft ? { ...value, need: '', prepared: { ...value.prepared, draft: { ...value.prepared.draft, ...update } } } : value);
  /** Starts the same change again from the beginning (a fresh challenge; this device's trust is checked again). */
  function retry() {
    const current = flowRef.current;
    if (current) launch(current.job, current.then, current.title, current.done, current.firstPasskey);
  }
  /** Waiving a layer that cannot be used here turns the change into a 7-day recovery. `forTrust`: the waiver belongs to trusting this device. */
  function waive(id: OptionalLayerId, forTrust: boolean) {
    const current = flowRef.current;
    if (!current) return;
    const add = (job: ChangeJob): ChangeJob => ({ ...job, waive: [...new Set([...job.waive, id])] });
    if (forTrust) {
      const trust = current.job.kind === 'trust' ? current.job : current.then?.kind === 'trust' ? current.then : trustJob();
      const main = current.job.kind === 'change' ? current.job : current.then?.kind === 'change' ? current.then : null;
      launch(add(trust), main, current.title, current.done);
    } else {
      const main = current.job.kind === 'change' ? current.job : current.then ?? current.job;
      launch(add(main), null, current.title, current.done);
    }
  }

  // ---- Sheets ----------------------------------------------------------------------------------
  const closeSheet = () => { if (busyRef.current) return; setSheet(null); setFlow(null); };
  function formDefaults(kind: LayerFormKind): Record<string, string> {
    if (kind === 'geolocation.add-zone') return { label: defaultName(kind, surface), radius: '500', center: 'current' };
    if (kind !== 'limits.set') return { label: defaultName(kind, surface) };
    const limits = layerOf('limits')?.limits;
    const text = (value: bigint | null | undefined, decimals: number) => value === null || value === undefined ? '' : exactDecimal(value, decimals);
    return { releaseSOL: text(limits?.perRelease.SOL, 9), daySOL: text(limits?.perDay.SOL, 9), releaseUSDC: text(limits?.perRelease.USDC, 6), dayUSDC: text(limits?.perDay.USDC, 6) };
  }
  function openForm(requested: LayerFormKind) {
    if (!view) return;
    // Before the vault has a passkey in force the server accepts only a passkey, so that is what opens.
    const kind = passkeyFirst && requested !== 'passkey.add' ? 'passkey.add' : requested;
    const layer = FORM_LAYER[kind];
    setFlow(null); setNotice('');
    if (kind === 'limits.set' && isOn('limits')) { openManage('limits'); return; }
    setSheet({ layer, title: titleFor(kind), screen: { name: 'form', kind, values: formDefaults(kind), error: '' } });
  }
  /** A form's title and button: setting this device up is named for this app ("Set up this browser"). */
  const titleFor = (kind: LayerFormKind) => kind === 'device.add' ? setupName : formTitle(kind, FORM_LAYER[kind] !== 'devices' && isOn(FORM_LAYER[kind] as LayerId));
  function openManage(id: LayerId) {
    setFlow(null); setNotice('');
    setSheet({ layer: id, title: LAYER_NAMES[id], screen: { name: 'manage', values: id === 'limits' ? formDefaults('limits.set') : {}, error: '' } });
  }
  function openRow(row: LayerRowModel) {
    if (!row.action) return;
    if (row.action.kind === 'setup') openForm(SETUP_FORM[row.id]); else openManage(row.id);
  }
  function confirm(layer: LayerId | 'devices', title: string, text: string, button: string, job: ChangeJob, done: Done) {
    setFlow(null);
    setSheet({ layer, title, screen: { name: 'confirm', text, button, job, done } });
  }
  useEffect(() => {
    if (!request || !view || !inline) return;
    if (request.form) { openForm(request.form); return; }
    const row = rows.find(item => item.id === request.layer);
    if (row?.action) openRow(row);
    else if (passkeyFirst) openForm('passkey.add');
  }, [request?.id, !!view]); // eslint-disable-line react-hooks/exhaustive-deps

  function cancel(changeId: string, summary: string) {
    if (cancelling) return;
    setCancelling(changeId); setListProblem(''); setNotice('');
    void (async () => {
      try {
        assertCurrent?.();
        await cancelChange(await getToken(), multisig, changeId);
        setNotice(`Cancelled: ${summary}.`);
        reload();
      } catch (failure) { setListProblem(flowProblem(failure, enabled).message); }
      finally { setCancelling(''); }
    })();
  }

  const field = (name: string) => ({
    value: sheet && (sheet.screen.name === 'form' || sheet.screen.name === 'manage') ? sheet.screen.values[name] ?? '' : '',
    onChange: (event: { target: { value: string } }) => setSheet(current => current && (current.screen.name === 'form' || current.screen.name === 'manage')
      ? { ...current, screen: { ...current.screen, values: { ...current.screen.values, [name]: event.target.value }, error: '' } } : current),
  });
  const formError = (error: string) => setSheet(current => current && (current.screen.name === 'form' || current.screen.name === 'manage') ? { ...current, screen: { ...current.screen, error } } : current);

  /** Validates a form and starts its change. */
  function submit(kind: LayerFormKind, values: Record<string, string>) {
    if (!view) return;
    const label = (values.label ?? '').trim();
    const on = (id: LayerId) => isOn(id);
    try {
      if (kind !== 'limits.set' && kind !== 'device.add' && (!label || label.length > 40)) throw new Error('Give it a name of 1 to 40 characters.');
      // Names are shown unmasked, so they must not carry what ANTARA never shows (an address, an identifier or coordinates).
      if (kind !== 'limits.set' && kind !== 'device.add' && looksUnmasked(label)) throw new Error('Use a name without an IP address, device ID or coordinates.');
      switch (kind) {
        case 'device.add': launch(trustJob(), null, setupName, { title: doneTitle('trusted', ''), text: 'It can now report your location, Wi-Fi name and Bluetooth for this vault.' }); return;
        case 'passkey.add':
          change({ type: 'passkey.add', label }, formTitle(kind, on('biometrics')), { title: on('biometrics') ? doneTitle('added', label) : 'Your passkey is added', text: 'Releases need your fingerprint, face or PIN.' }, passkeyFirst);
          return;
        case 'bluetooth.add-device':
          change({ type: 'bluetooth.add-device', label }, formTitle(kind, on('bluetooth')), on('bluetooth') ? { title: doneTitle('added', label), text: 'Releases accept this device too.' } : { title: doneTitle('on', 'Bluetooth'), text: `Releases now need ${label}. Distance isn’t measured.` });
          return;
        case 'wifi.add-radio': change({ type: 'wifi.add-radio', label }, formTitle(kind, true), { title: doneTitle('added', label), text: 'This computer’s Wi-Fi is saved for this vault.' }); return;
        case 'mfa.add': change({ type: 'mfa.add', label }, formTitle(kind, false), { title: doneTitle('on', 'MFA'), text: 'Releases now need a code from your authenticator app.' }); return;
        case 'wifi.add-network': {
          const cidr = (values.cidr ?? '').trim();
          if (cidr && (cidr.length > 64 || !/^[0-9a-fA-F:.]+(?:\/\d{1,3})?$/.test(cidr))) throw new Error('Enter an IP address or range such as 203.0.113.0/24, or leave it empty.');
          change(cidr ? { type: 'wifi.add-network', label, cidr } : { type: 'wifi.add-network', label }, formTitle(kind, on('wifi')),
            on('wifi') ? { title: doneTitle('added', label), text: 'Releases accept this network too.' } : { title: doneTitle('on', 'Wi-Fi'), text: `Releases now need to come from ${label}’s internet address.` });
          return;
        }
        case 'geolocation.add-zone': {
          const radiusM = Number(values.radius);
          if (!RADII.includes(radiusM)) throw new Error('Choose a radius.');
          const done = on('geolocation') ? { title: doneTitle('added', label), text: `Releases also accept a location reported inside ${label} (${radiusText(radiusM)}).` }
            : { title: doneTitle('on', 'Safe Zones'), text: `Releases now need a location your device reports inside ${label} (${radiusText(radiusM)}).` };
          if (values.center === 'coordinates') {
            const lat = Number(values.lat), lng = Number(values.lng);
            if (!values.lat?.trim() || !values.lng?.trim() || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error('Enter a latitude between -90 and 90 and a longitude between -180 and 180.');
            change({ type: 'geolocation.add-zone', label, radiusM, center: { lat, lng } }, formTitle(kind, on('geolocation')), done);
          } else change({ type: 'geolocation.add-zone', label, radiusM, center: 'current' }, formTitle(kind, on('geolocation')), done);
          return;
        }
        case 'limits.set': {
          // Optional limits the user sets (owner decision 2026-10-13): any positive amount, no server ceiling or minimum.
          const parsed: { perReleaseRaw: { SOL: string | null; USDC: string | null }; perDayRaw: { SOL: string | null; USDC: string | null } } = { perReleaseRaw: { SOL: null, USDC: null }, perDayRaw: { SOL: null, USDC: null } };
          for (const asset of ['SOL', 'USDC'] as const) {
            const release = capField((values[`release${asset}`] ?? '').trim(), asset, 'per-release');
            const day = capField((values[`day${asset}`] ?? '').trim(), asset, 'daily');
            if (release !== null && day !== null && release > day) throw new Error(`The ${asset} per-release limit cannot be above its daily limit.`);
            parsed.perReleaseRaw[asset] = release === null ? null : release.toString();
            parsed.perDayRaw[asset] = day === null ? null : day.toString();
          }
          if (![parsed.perReleaseRaw.SOL, parsed.perReleaseRaw.USDC, parsed.perDayRaw.SOL, parsed.perDayRaw.USDC].some(value => value !== null)) {
            throw new Error(on('limits') ? 'Enter at least one limit, or turn Limits off to remove them all.' : 'Enter at least one limit.');
          }
          change({ type: 'limits.set', ...parsed }, formTitle(kind, on('limits')), { title: on('limits') ? 'Your limits are saved' : doneTitle('on', 'Limits'), text: 'Releases above your limits are refused.' });
          return;
        }
      }
    } catch (failure) { formError(failure instanceof Error ? failure.message : 'Check the details and try again.'); }
  }

  // ---- Rendering -------------------------------------------------------------------------------
  // Each sheet is its body plus a pinned footer with the main action (UX review 2026-10-13: the button never floats
  // mid-sheet or scrolls away). Forms submit from the footer through the button's `form` attribute.
  const formId = `${sheetKey}-form`;
  type Rendered = { body: ReactNode; footer: ReactNode };
  const nothing: Rendered = { body: null, footer: null };

  /** "How ANTARA checks this": the kind in plain words, the exact section 14.1 lines, and the details the sheet keeps short. */
  const howDetails = (id: LayerId | 'devices', extra: { setsUpDevice?: boolean; items?: readonly LayerItem[] } = {}) => {
    const layer = id === 'devices' ? null : layerOf(id);
    const lines = id === 'devices' ? [] : checkedByLines({ id, status: 'enrolled', mode: layer?.mode ?? 'network' }, surface);
    const items = extra.items ?? [];
    // Section 14.1 lines describe a layer that is on; for one being turned on they say how it will be checked, so they say so.
    const off = id !== 'devices' && (!layer || layer.status === 'not-enrolled');
    return <details className="vl-how">
      <summary>{SHEET_COPY.how}</summary>
      {off && <p className="vl-how-kind">{SHEET_COPY.onceOn}</p>}
      {(layer?.kinds ?? []).map(kind => <p key={kind} className="vl-how-kind">{KIND_SHORT[kind]}</p>)}
      {lines.map(line => <p key={line}>{line}</p>)}
      {id === 'biometrics' && items.some(isSynced) && <p>{CHECKED_BY.biometricsSynced}</p>}
      {id === 'biometrics' && <p>{SURFACE_NOTES.passkeyPhone}</p>}
      {(extra.setsUpDevice || id === 'devices') && <p>{CHECKED_BY.trustedDevices}</p>}
      {items.filter(item => item.detail).map(item => <p key={item.id} className="vl-how-item">{item.label}: {item.detail}</p>)}
    </details>;
  };

  /** Steps a form's change will take, shown before anything starts. */
  function previewSteps(kind: LayerFormKind, values: Record<string, string>): FlowStep[] {
    if (kind === 'device.add') return planSteps(trustJob(), true, surface);
    const op: ChangeOp | null = kind === 'geolocation.add-zone' ? { type: kind, label: '', radiusM: 500, center: values.center === 'coordinates' ? { lat: 0, lng: 0 } : 'current' }
      : kind === 'bluetooth.add-device' || kind === 'wifi.add-radio' || kind === 'mfa.add' || kind === 'passkey.add' ? { type: kind, label: '' } : null;
    const job: ChangeJob = { kind: 'change', op: op ?? { type: 'wifi.add-network', label: '' }, title: '', waive: [] };
    const steps = planSteps(job, !!op && readsFromDevice(op) && !thisDeviceTrusted, surface);
    return passkeyFirst && kind === 'passkey.add' ? [...steps, firstPasskeyTrustStep()] : steps;
  }
  const stepList = (steps: FlowStep[], label: string, preview = false) => <ol className={preview ? 'vl-steps vl-steps-preview' : 'vl-steps'} aria-label={label}>
    {steps.map((step, index) => <li key={step.key} data-state={step.state}>
      <span className="vl-step-mark" aria-hidden="true">{step.state === 'done' ? <Icon name="check" size={13} /> : step.state === 'failed' ? '!' : index + 1}</span>
      <span className="vl-step-text"><strong>{step.label}</strong><small>{step.hint}</small></span>
      {step.state !== 'waiting' && <span className="ui-visually-hidden"> ({STEP_STATE_TEXT[step.state]})</span>}
    </li>)}
  </ol>;
  /** A waiver names the change it belongs to: setting this device up, or the change the user asked for. */
  const waiveLabel = (id: OptionalLayerId, forTrust: boolean, main: string) => `Waive ${LAYER_NAMES[id]} to ${inSentence(forTrust ? setupName : main)} (7 days)`;

  function renderForm(screen: Extract<Screen, { name: 'form' }>, title: string): Rendered {
    const { kind, values } = screen;
    const layer = FORM_LAYER[kind];
    const named = kind !== 'limits.set' && kind !== 'device.add';
    const nameFirst = kind === 'geolocation.add-zone' || kind === 'wifi.add-network' || kind === 'bluetooth.add-device' || kind === 'wifi.add-radio';
    const nameField = <label className="vl-field">Name<input {...field('label')} maxLength={40} required /></label>;
    const steps = previewSteps(kind, values);
    // One step needs no list: a single line says what the device will ask.
    const oneStep = kind === 'passkey.add' && isOn('biometrics') ? 'You’ll confirm with your passkey, then create the new one.' : SHEET_COPY.oneStep;
    const body = <form id={formId} className="vl-sheet-body" aria-label={title} onSubmit={event => { event.preventDefault(); submit(kind, values); }}>
      <p className="vl-lead">{FORM_LEAD[kind]}</p>
      {kind === 'passkey.add' && passkeyFirst && <p className="vl-note">{SURFACE_NOTES.passkeyFirstOtherApp}</p>}
      {named && nameFirst && nameField}
      {kind === 'geolocation.add-zone' && <label className="vl-field">Size<select {...field('radius')}>{RADII.map(radius => <option key={radius} value={radius}>{radiusText(radius)} around {values.center === 'coordinates' ? 'that point' : 'you'}</option>)}</select></label>}
      {kind === 'limits.set' && capFields()}
      {(kind === 'geolocation.add-zone' || kind === 'wifi.add-network' || (named && !nameFirst)) && <details className="vl-more">
        <summary>{SHEET_COPY.more}</summary>
        {named && !nameFirst && nameField}
        {kind === 'geolocation.add-zone' && <>
          <fieldset className="vl-choice"><legend>Center</legend>
            <label><input type="radio" name="vl-center" checked={values.center !== 'coordinates'} onChange={() => field('center').onChange({ target: { value: 'current' } })} />Where I am now</label>
            <label><input type="radio" name="vl-center" checked={values.center === 'coordinates'} onChange={() => field('center').onChange({ target: { value: 'coordinates' } })} />Coordinates I enter</label>
          </fieldset>
          {values.center === 'coordinates' && <div className="vl-split"><label className="vl-field">Latitude<input {...field('lat')} inputMode="decimal" /></label><label className="vl-field">Longitude<input {...field('lng')} inputMode="decimal" /></label></div>}
          <p className="vl-note">Your location must be accurate to half the size or better. A bigger place is easier to pass, and weaker.</p>
        </>}
        {kind === 'wifi.add-network' && <label className="vl-field">Address range<input {...field('cidr')} placeholder="Empty: the network you’re on now" /></label>}
        {kind === 'passkey.add' && <p className="vl-note">{SURFACE_NOTES.passkeyGooglePasswordManager}</p>}
      </details>}
      {kind === 'bluetooth.add-device' && capabilities.surface === 'desktop' && <p className="vl-note">{SURFACE_NOTES.bluetoothDesktopClassic}</p>}
      {steps.length > 1 ? stepList(steps, SHEET_COPY.nextSteps, true) : <p className="vl-note vl-one-step">{oneStep}</p>}
      {screen.error && <p className="vl-form-error" role="alert">{screen.error}</p>}
      {howDetails(layer, { setsUpDevice: steps.some(step => step.key === 'trust') })}
    </form>;
    return { body, footer: <button type="submit" form={formId} className="ui-btn-primary">{title}</button> };
  }

  function capFields() {
    return <div className="vl-caps">
      {(['SOL', 'USDC'] as const).flatMap(asset => [
        <label key={`r${asset}`} className="vl-field">{asset} per release<input {...field(`release${asset}`)} inputMode="decimal" placeholder="No limit" /></label>,
        <label key={`d${asset}`} className="vl-field">{asset} per day<input {...field(`day${asset}`)} inputMode="decimal" placeholder="No limit" /></label>,
      ])}
    </div>;
  }

  function renderManage(id: LayerId, screen: Extract<Screen, { name: 'manage' }>): Rendered {
    const layer = layerOf(id);
    if (!layer) return nothing;
    const name = LAYER_NAMES[id];
    const lastPasskey = id === 'biometrics' && activePasskeys(layer) <= 1;
    const busy = !!cancelling;
    const items = layer.items;
    const addKind: LayerFormKind | null = id === 'biometrics' ? 'passkey.add' : id === 'geolocation' ? 'geolocation.add-zone' : id === 'wifi' ? 'wifi.add-network' : id === 'bluetooth' ? 'bluetooth.add-device' : null;
    const canAdd = addKind && !(id === 'geolocation' && capabilities.geolocation === 'none') && !(id === 'bluetooth' && capabilities.bluetooth === 'none') && !(id === 'biometrics' && capabilities.passkey === 'none');
    const turnOff = id !== 'biometrics' && layer.status === 'enrolled' ? () => confirm(id, `Turn off ${name}?`, TURN_OFF_LINE[id], `Turn off ${name}`,
      { kind: 'change', op: { type: 'layer.disable', layer: id as DisableableLayerId }, title: `Turn off ${name}`, waive: [] }, { title: doneTitle('off', name), text: TURN_OFF_LINE[id] }) : null;
    const body = <div className="vl-sheet-body">
      <p className="vl-lead">{layer.status === 'pending-removal' && layer.effectiveAt !== null ? `${name} turns off ${shortWhen(layer.effectiveAt)}. Until then it still applies.` : MANAGE_LEAD[id]}</p>
      {layer.status === 'pending-removal' && layer.changeId && <div className="vl-sheet-actions"><button type="button" className="ui-btn" disabled={busy} onClick={() => cancel(layer.changeId!, `turning off ${name}`)}>Keep {name} on</button></div>}
      {id === 'limits' ? <form id={formId} className="vl-sheet-body" aria-label="Your limits" onSubmit={event => { event.preventDefault(); submit('limits.set', screen.values); }}>
        {capFields()}
        {screen.error && <p className="vl-form-error" role="alert">{screen.error}</p>}
      </form> : items.length > 0 && <ul className="vl-items" aria-label={`${name} settings`}>
        {items.map(item => {
          const op = removeOp(id, item);
          const line = item.state === 'active' ? itemLine(item) : itemStateText(item);
          return <li key={item.id} data-state={item.state}>
            <span className="vl-item-main"><strong>{item.label}</strong>{line && <small className={item.state === 'active' ? undefined : 'vl-item-pending'}>{line}</small>}</span>
            <span className="vl-item-actions">
              {item.state !== 'active' ? item.changeId && <button type="button" className="vl-link" disabled={busy} onClick={() => cancel(item.changeId!, item.label)} aria-label={`Cancel the pending change for ${item.label}`}>Cancel</button>
                : <>
                  {id === 'wifi' && item.type === 'radio' && capabilities.wifiRadio && <button type="button" className="vl-link" onClick={() => change({ type: 'wifi.add-bssid', radioId: item.id }, `Add this access point to ${item.label}`, { title: 'Access point added', text: `${item.label} accepts this access point too.` })}>Add this access point</button>}
                  {op && !(lastPasskey && id === 'biometrics') && <button type="button" className="vl-link" onClick={() => confirm(id, `Remove ${item.label}?`, `${name} will no longer accept ${item.label}.`, 'Remove', { kind: 'change', op, title: `Remove ${item.label}`, waive: [] }, { title: doneTitle('removed', item.label), text: '' })} aria-label={`Remove ${item.label}`}>Remove</button>}
                </>}
            </span>
          </li>;
        })}
      </ul>}
      {lastPasskey && <p className="vl-note">{SHEET_COPY.lastPasskey}</p>}
      {id === 'biometrics' && items.some(isSynced) && <p className="vl-note">{CHECKED_BY.biometricsSynced}</p>}
      {id === 'wifi' && <p className="vl-note">{!view?.network.observed ? 'ANTARA can’t see a public internet address for this connection right now.' : view.network.trusted ? 'You’re on one of these networks now.' : 'You’re not on one of these networks now.'}</p>}
      {id === 'wifi' && layer.status !== 'not-enrolled' && capabilities.wifiRadio && <div className="vl-sheet-actions">
        <button type="button" className="ui-btn-text" onClick={() => openForm('wifi.add-radio')}>Also check the Wi-Fi name</button>
        {layer.mode === 'network' && items.some(item => item.type === 'radio' && item.state === 'active') && <button type="button" className="ui-btn-text" onClick={() => change({ type: 'wifi.set-mode', mode: 'network+radio' }, 'Require the Wi-Fi name', { title: 'Saved', text: 'Releases from this computer also need the Wi-Fi name.' })}>Require the Wi-Fi name</button>}
        {layer.mode === 'network+radio' && <button type="button" className="ui-btn-text" onClick={() => change({ type: 'wifi.set-mode', mode: 'network' }, 'Stop requiring the Wi-Fi name', { title: 'Saved', text: 'Releases no longer need the Wi-Fi name.' })}>Stop requiring the Wi-Fi name</button>}
      </div>}
      {howDetails(id, { items })}
    </div>;
    const footer = id === 'limits' || canAdd || turnOff ? <>
      {turnOff && <button type="button" className="ui-btn-text vl-off" onClick={turnOff}>Turn off {name}</button>}
      {id === 'limits' ? <button type="submit" form={formId} className="ui-btn-primary">Save limits</button>
        : canAdd && addKind && <button type="button" className="ui-btn" onClick={() => openForm(addKind)}><Icon name="plus" size={15} />{formTitle(addKind, true)}</button>}
    </> : null;
    return { body, footer };
  }

  function renderConfirm(screen: Extract<Screen, { name: 'confirm' }>, title: string): Rendered {
    return {
      body: <div className="vl-sheet-body">
        {screen.text && <p className="vl-lead">{screen.text}</p>}
        <p className="vl-note">{SHEET_COPY.confirmNote}</p>
      </div>,
      footer: <>
        <button type="button" className="ui-btn" onClick={() => sheet && sheet.layer !== 'devices' ? openManage(sheet.layer) : closeSheet()}>Keep it</button>
        <button type="button" className="ui-btn-primary" onClick={() => launch(screen.job, null, title.replace(/\?$/, ''), screen.done)}>{screen.button}</button>
      </>,
    };
  }

  function renderPause(current: FlowState, draft: Draft, pause: Pause): Rendered {
    const { challenge } = draft;
    const needsCode = needsTotpCode(challenge);
    // Turning a layer on never offers a waiver while it waits for the user: nothing needs recovering (UX review 2026-10-13).
    const canWaive = challenge.class === 'tighten' ? [] : waivableIn(challenge, draft.job.waive).filter(id => enabled.includes(id));
    const matching = readingsFor(challenge).bluetooth === 'match';
    // A change that waits says which change it is and what it waives (security review 2026-10-13).
    const changeName = draft.job.kind === 'trust' ? setupName : draft.job.title;
    const waived = draft.job.waive.map(id => LAYER_NAMES[id]);
    const body = <form id={formId} className="vl-pause" onSubmit={event => { event.preventDefault(); resume(); }}>
      {pause === 'recovery' && <div className="vl-wait">
        <p className="vl-timing">{changeName}{waived.length ? ` · waives ${waived.join(', ')}` : ''}</p>
        <p className="vl-note">{challenge.effectiveAt !== null ? `Takes effect ${shortWhen(challenge.effectiveAt)}. You can cancel it until then.` : 'Takes effect immediately.'}</p>
        {challenge.class === 'recovery' && <p className="vl-note">{SURFACE_NOTES.recovery}</p>}
      </div>}
      {challenge.capture.totp && <div className="vl-totp-setup">
        <p className="vl-note">{CHECKED_BY.mfaSetup}</p>
        <div className="vl-totp-qr"><QRCodeSVG value={otpauthUri(challenge.capture.totp.secret, multisig)} size={168} level="M" marginSize={2} title="Authenticator setup code" /></div>
        <p className="vl-totp-key">Key <code aria-label="Authenticator setup key">{groupKey(challenge.capture.totp.secret)}</code></p>
      </div>}
      {draft.wifi && draft.wifi.length !== 1 && (draft.wifi.length
        ? <label className="vl-field">Wi-Fi network<select value={draft.wifiConnection} onChange={event => updateDraft({ wifiConnection: event.target.value })}>{draft.wifi.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select></label>
        : <p className="vl-note">This computer isn’t connected to Wi-Fi.</p>)}
      {draft.bluetooth !== null && (draft.bluetooth.length
        ? <label className="vl-field">Bluetooth device<select value={draft.bluetoothDevice} onChange={event => updateDraft({ bluetoothDevice: event.target.value })}>{draft.bluetooth.map(item => <option key={item.identifier} value={item.identifier}>{item.name || 'Unnamed device'} · ••{item.identifier.slice(-4)}</option>)}</select></label>
        : <p className="vl-note">No new classic Bluetooth device is connected to this computer. Connect it in Windows Bluetooth settings, then try again.</p>)}
      {pause === 'bluetooth-trusted' && <p className="vl-note">Bluetooth is on, so Chrome needs two steps: first find a device you already trust, then choose the new one.</p>}
      {pause === 'bluetooth-chooser' && <p className="vl-note">{draft.bluetoothMatched ? 'Trusted device found. Now choose the new one.' : matching ? 'Chrome will ask for your trusted Bluetooth device.' : 'Chrome will list the Bluetooth devices nearby. Pick the one you keep with you.'}</p>}
      {needsCode && <TotpCodeField value={draft.totpCode} onChange={totpCode => updateDraft({ totpCode })} />}
      {current.need && <p className="vl-form-error" role="alert">{current.need}</p>}
      {canWaive.length > 0 && pause !== 'recovery' && <details className="vl-recovery">
        <summary>{SHEET_COPY.recoveryAsk}</summary>
        <p className="vl-note">{SURFACE_NOTES.recovery}</p>
        <div className="vl-sheet-actions">{canWaive.map(id => <button key={id} type="button" className="ui-btn" onClick={() => waive(id, draft.job.kind === 'trust')}>{waiveLabel(id, draft.job.kind === 'trust', draft.job.title)}</button>)}</div>
      </details>}
    </form>;
    const label = pause === 'bluetooth-chooser' && matching ? 'Check your Bluetooth device' : CONTINUE_LABEL[pause];
    return { body, footer: <button type="submit" form={formId} className="ui-btn-primary">{label}</button> };
  }

  function renderFlow(current: FlowState): Rendered {
    const problem = current.problem;
    const draft = current.prepared?.draft ?? null;
    const paused = current.status === 'paused' && draft && current.pause ? renderPause(current, draft, current.pause) : null;
    const main = current.job.kind === 'change' ? current.job : current.then?.kind === 'change' ? current.then : null;
    const mainTitle = main?.title ?? current.title;
    // The change itself needs a reading from this device: setting it up is the user's choice, then the change continues.
    const setUp = current.status === 'failed' && problem?.action === 'add-device' && current.job.kind === 'change';
    const body = <div className="vl-sheet-body vl-flow" data-status={current.status}>
      {current.status !== 'done' && stepList(current.steps, 'Steps')}
      {current.status === 'working' && <p className="vl-progress" role="status">{current.progress || SHEET_COPY.working}…</p>}
      {paused?.body}
      {current.status === 'failed' && problem && <div className="vl-problem" role="alert">
        <p className="vl-problem-title">{setUp ? SHEET_COPY.setUpFirst : SHEET_COPY.stuck}</p>
        <p>{problem.message}</p>
        {setUp && <p className="vl-note">{CHECKED_BY.trustedDevices}</p>}
        {problem.waivable.length > 0 && <details className="vl-recovery" open={BLUETOOTH_OTHER_APP.test(problem.message) || undefined}>
          <summary>{SHEET_COPY.recoveryAsk}</summary>
          <p className="vl-note">{SURFACE_NOTES.recovery}</p>
          <div className="vl-sheet-actions">{problem.waivable.map(id => <button key={id} type="button" className="ui-btn" onClick={() => waive(id, problem.forTrust)}>{waiveLabel(id, problem.forTrust, mainTitle)}</button>)}</div>
        </details>}
      </div>}
      {current.status === 'done' && current.result && <div className="vl-done" role="status">
        <span className="vl-done-mark" aria-hidden="true"><Icon name="check" size={22} /></span>
        <h3>{current.result.title}</h3>
        {current.result.text && <p>{current.result.text}</p>}
      </div>}
    </div>;
    let footer: ReactNode = null;
    if (paused) footer = paused.footer;
    else if (current.status === 'done') footer = <button type="button" className="ui-btn-primary" onClick={closeSheet}>{SHEET_COPY.close}</button>;
    else if (current.status === 'failed' && problem) footer = <>
      {problem.action === 'add-passkey' && <button type="button" className="ui-btn" onClick={() => openForm('passkey.add')}>Add a passkey</button>}
      {problem.action === 'open-location-settings' && <button type="button" className="ui-btn" onClick={() => void platform.native.openLocationSettings().catch(() => undefined)}>Open Windows location settings</button>}
      {problem.action === 'open-full-tab' && <button type="button" className="ui-btn" onClick={() => void platform.openWalletTab('#vault')}>{SHEET_COPY.openFullTab}</button>}
      {setUp
        ? <button type="button" className="ui-btn-primary" onClick={() => launch(trustJob(), main, current.title, current.done)}>{setupName}</button>
        : <button type="button" className="ui-btn-primary" onClick={() => retry()}>{SHEET_COPY.retry}</button>}
    </>;
    return { body, footer };
  }

  function renderSheet(current: SheetState): Rendered {
    if (!inline) return {
      body: <div className="vl-sheet-body"><p className="vl-lead">{SURFACE_NOTES.fullTab}</p></div>,
      footer: <button type="button" className="ui-btn-primary" onClick={() => void platform.openWalletTab('#vault')}>{SHEET_COPY.openFullTab}</button>,
    };
    switch (current.screen.name) {
      case 'form': return renderForm(current.screen, current.title);
      case 'manage': return current.layer === 'devices' ? nothing : renderManage(current.layer, current.screen);
      case 'confirm': return renderConfirm(current.screen, current.title);
      case 'flow': return flow ? renderFlow(flow) : nothing;
    }
  }

  const headline = view ? protectionHeadline(view) : null;
  const sheetIcon = sheet && sheet.layer !== 'devices' ? <span className="vl-sheet-icon" aria-hidden="true"><LayerIcon id={sheet.layer} size={17} /></span> : undefined;
  const rendered = sheet ? renderSheet(sheet) : nothing;
  // Each screen gets its own footer buttons. Without the key React reuses a button across screens, so the click that
  // opens a form (a type="button") would turn into that form's submit button before the click finished, and submit it.
  const footerKey = sheet ? `${sheet.screen.name}|${sheet.title}|${flow?.status ?? ''}|${flow?.pause ?? ''}` : '';
  const footer = rendered.footer ? <Fragment key={footerKey}>{rendered.footer}</Fragment> : null;

  return <section className="vl" aria-labelledby="vl-title">
    <header className="vl-head">
      <h3 id="vl-title">Protection layers</h3>
      {showSummary && headline && <p className="vl-summary"><strong>{headline.title}.</strong>{headline.text ? ` ${headline.text}` : ''}</p>}
    </header>
    {(load.status === 'loading' || load.status === 'idle') && <p className="vl-progress" role="status">Checking your protection…</p>}
    {load.status === 'unavailable' && <div className="vl-unavailable" role="note">
      <p>{load.message} No layer status is shown.</p>
      <button type="button" className="ui-btn" onClick={reload}>Try again</button>
    </div>}
    {load.status === 'unavailable' && !!load.pending?.length && <section className="vl-section" aria-labelledby="vl-pending">
      <h4 id="vl-pending" tabIndex={-1}>{SHEET_COPY.pendingTitle}</h4>
      <ul className="vl-items" aria-label="Pending changes list">{load.pending.map(change => <li key={change.id} data-class={change.class}>
        <span className="vl-item-main"><strong>A protection change is pending</strong><small>{pendingKindText(change)} · takes effect {shortWhen(change.effectiveAt)}</small></span>
        <span className="vl-item-actions"><button type="button" className="vl-link" disabled={!!cancelling} onClick={() => cancel(change.id, 'the pending protection change')} aria-label={`Cancel the protection change that takes effect ${shortWhen(change.effectiveAt)}`}>Cancel</button></span>
      </li>)}</ul>
      <p className="vl-note">{CHECKED_BY.notifications}</p>
    </section>}
    {view && <>
      {!inline && <div className="vl-handoff" role="note"><p>{SHEET_COPY.fullTab}</p><button type="button" className="ui-btn" onClick={() => void platform.openWalletTab('#vault')}>{SHEET_COPY.openFullTab}</button></div>}
      <LayerList rows={rows} onOpen={openRow} />

      {view.pending.length > 0 && <section className="vl-section" aria-labelledby="vl-pending">
        <h4 id="vl-pending" tabIndex={-1}>{SHEET_COPY.pendingTitle}</h4>
        <ul className="vl-items" aria-label="Pending changes list">{view.pending.map(change => <li key={change.id} data-class={change.class}>
          <span className="vl-item-main"><strong>{pendingTitle(change)}</strong><small>{pendingKindText(change)} · takes effect {shortWhen(change.effectiveAt)}</small></span>
          <span className="vl-item-actions"><button type="button" className="vl-link" disabled={!!cancelling} onClick={() => cancel(change.id, pendingTitle(change))} aria-label={`Cancel: ${pendingTitle(change)}`}>Cancel</button></span>
        </li>)}</ul>
        <p className="vl-note">{CHECKED_BY.notifications}</p>
      </section>}
    </>}
    {listProblem && <p className="vl-form-error" role="alert">{listProblem}</p>}
    {notice && <p className="vl-notice" role="status">{notice}</p>}
    {view && <div className="vl-folds">
      {/* Devices appear once one is set up; before that, the flows that need one set it up themselves. */}
      {view.devices.length > 0 && <details className="vl-fold">
        <summary>{SHEET_COPY.devicesTitle} · {view.devices.length}</summary>
        <section aria-label={SHEET_COPY.devicesTitle}>
          <p className="vl-note">{SHEET_COPY.devicesLead}</p>
          <ul className="vl-items">{view.devices.map(device => <li key={device.keyId} data-state={device.state}>
            <span className="vl-item-main"><strong>{device.label}{device.keyId === localKey.keyId ? ' · this device' : ''}</strong><small>{DEVICE_NAMES[device.surface]}{itemStateText(device) ? ` · ${itemStateText(device)}` : ''}</small></span>
            <span className="vl-item-actions">{device.state !== 'active' ? device.changeId && <button type="button" className="vl-link" disabled={!!cancelling} onClick={() => cancel(device.changeId!, device.label)} aria-label={`Cancel the pending change for ${device.label}`}>Cancel</button>
              : inline && <button type="button" className="vl-link" onClick={() => confirm('devices', `Remove ${device.label}?`, 'It will no longer report your location, Wi-Fi name or Bluetooth for this vault.', 'Remove',
                { kind: 'change', op: { type: 'device.remove', keyId: device.keyId }, title: `Remove ${device.label}`, waive: [] }, { title: doneTitle('removed', device.label), text: '' })} aria-label={`Remove ${device.label}`}>Remove</button>}</span>
          </li>)}</ul>
          {localKey.problem && <p className="vl-note">{localKey.problem}</p>}
          <p className="vl-note">{CHECKED_BY.trustedDevices}</p>
        </section>
      </details>}
      <details className="vl-fold">
        <summary>{SHEET_COPY.howAll}</summary>
        <p className="vl-note">{CHECKED_BY.all}</p>
        <p className="vl-note">{CHECKED_BY.changes}</p>
        <p className="vl-note">{CHECKED_BY.sessionRecovery}</p>
        <p className="vl-note">{CHECKED_BY.notifications}</p>
      </details>
    </div>}

    {sheet && <Sheet title={sheet.title} onClose={closeSheet} busy={flow?.status === 'working'} closeLabel="Close" className="vl-sheet" headerStart={sheetIcon} footer={footer}>
      {rendered.body}
    </Sheet>}
  </section>;
}

export default VaultLayers;
