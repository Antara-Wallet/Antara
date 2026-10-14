// Protection (docs/UI_ARGUS_PARITY.md 6.15), rebuilt simple (owner feedback 2026-10-13): one slim summary strip (where
// the vault stands, a six-segment meter and at most one next step), then the protection list itself, in the first
// viewport: one row per layer with one action, and each layer's set-up or settings in a sheet, right here
// (layers/VaultLayers.tsx). The status planet is a small thumbnail in the strip on wide windows only. Nothing here says
// a layer is on unless the server reports it; before a vault exists the rows only describe the layers.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LayerPlatform } from '../layers/collectors';
import type { DeviceKeyStorage } from '../layers/deviceKey';
import { LayerList } from '../layers/LayerList';
import { layerRows, protectionHeadline } from '../layers/rows';
import type { LayerId } from '../layers/types';
import { VaultLayers, type LayerRequest } from '../layers/VaultLayers';
import { Icon } from '../ui';
import { usePairedVaultSummary, type SummaryValue } from '../vaults/summary';
import { requestVaultIntent } from '../vaults/vaultIntent';
import { useSolaresWallet } from '../wallet';
import { assertWalletSession } from '../wallet/session';
import { overviewStations, stationStates } from '../verification/stationState';
import { VaultPlanet } from '../verification/VaultPlanet';
import '../layers/layers.css';
import './protection.css';

export interface ProtectionScreenProps {
  configured: boolean;
  ready: boolean;
  authenticated: boolean;
  onConnect: () => void;
  onVaults: () => void;
  /** Unused and optional: there is no wallet MFA (owner decision 2026-10-13); MFA is the vault authenticator in the list. */
  onMfa?: () => void;
  /** Unused since layers are managed on this page; kept for callers that still pass it. */
  onLayers?: (layer?: LayerId) => void;
}

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-5)}`;
/** The planet thumbnail only where there is room beside the summary (and no WebGL work below it). */
const WIDE_QUERY = '(min-width: 1280px)';
function useWide() {
  const [wide, setWide] = useState(() => typeof matchMedia === 'function' && matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia(WIDE_QUERY);
    const update = () => setWide(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return wide;
}

export function ProtectionScreen(props: ProtectionScreenProps) {
  const summary = usePairedVaultSummary();
  const wallet = useSolaresWallet();
  // A layer change belongs to the account and wallet that were showing when the page opened.
  const session = useRef(wallet.getSession());
  const owner = wallet.authenticated ? wallet.addresses.solana : null;
  const sessionKey = `${wallet.userId ?? ''}:${owner ?? ''}`;
  const seen = useRef(sessionKey);
  if (seen.current !== sessionKey) { seen.current = sessionKey; session.current = wallet.getSession(); }
  const getToken = async () => {
    const token = await wallet.getAccessToken();
    if (!token) throw new Error('Sign in again to continue.');
    return token;
  };
  return <ProtectionView {...props} summary={summary}
    layersAccess={wallet.userId ? { privyUserId: wallet.userId, getToken, assertCurrent: () => assertWalletSession(session.current, wallet.getSession()) } : null} />;
}

export interface ProtectionViewProps extends ProtectionScreenProps {
  summary: SummaryValue;
  /** Who may change this vault's layers here; null before sign-in. */
  layersAccess: { privyUserId: string; getToken: () => Promise<string>; assertCurrent?: () => void } | null;
  /** Test harnesses inject the device seams; the app uses the real ones. */
  platform?: LayerPlatform;
  keys?: DeviceKeyStorage;
  /** Off in harnesses without WebGL screenshots in mind. */
  planet?: boolean;
}

/** The Protection page from a vault summary. Presentation and the layer sheets only: the summary decides every state. */
export function ProtectionView({ configured, ready, authenticated, onConnect, onVaults, summary, layersAccess, platform, keys, planet = true }: ProtectionViewProps) {
  const [request, setRequest] = useState<LayerRequest | null>(null);
  const wide = useWide();
  const hasVault = summary.state === 'active' || summary.state === 'registered';
  const layers = hasVault ? summary.layers : null;
  const view = layers?.status === 'ready' ? layers.view : null;
  const states = view && layers ? overviewStations(layers) : stationStates({ kind: 'overview', layers: { status: 'idle' } });
  const multisig = hasVault ? summary.multisig : null;
  const canCreate = summary.state === 'not-activated' && (summary.reason === 'activate' || summary.reason === 'pending' || summary.reason === 'mfa');
  const canSignIn = configured && ready && !authenticated;
  const describeRows = useMemo(() => layerRows(null, { capabilities: { surface: 'web', passkey: 'none', geolocation: 'none', bluetooth: 'none' }, inline: false }), []);

  const open = (next: Omit<LayerRequest, 'id'>) => setRequest({ ...next, id: Date.now() } as LayerRequest);
  const createVault = () => { requestVaultIntent({ kind: 'create' }); onVaults(); };

  // One summary of where the vault stands, and its next step.
  let title: string, text: string, tone: 'neutral' | 'ok' | 'warn' | 'danger' = 'neutral';
  let action: { label: string; run: () => void; icon?: 'plus' | 'lock' | 'shield' | 'refresh' } | null = null;
  if (!authenticated) {
    title = 'Sign in to protect your vault'; text = 'Your vault and its protection belong to your ANTARA account.';
    if (canSignIn) action = { label: 'Sign in', run: onConnect };
  } else switch (summary.state) {
    case 'loading': title = 'Checking your vault…'; text = 'Reading your vault and its protection.'; break;
    case 'no-pin': title = 'Vault protection isn’t available in this build'; text = 'This copy of ANTARA was built without a pinned guardian, so it will not create or use a paired vault. Your wallet works normally.'; break;
    case 'not-provisioned': title = 'Vault protection isn’t switched on yet'; text = 'ANTARA’s vault guardian is not switched on for this server. Your wallet works normally.'; break;
    case 'unavailable': title = 'Protection status unavailable'; text = summary.message; tone = 'danger'; action = { label: 'Try again', run: summary.reload, icon: 'refresh' }; break;
    case 'not-activated':
      // The ANTARA wallet the server will not pair says why; only another selected wallet is told to use the ANTARA wallet.
      if (summary.reason === 'wallet' && summary.problem) { title = 'Vault not available for this wallet'; text = summary.problem; action = { label: 'Open your vault', run: onVaults }; }
      else if (summary.reason === 'wallet') { title = 'Use your ANTARA wallet for the vault'; text = 'Paired vaults are created only for the embedded Solana wallet linked to your account.'; action = { label: 'Open your vault', run: onVaults }; }
      else if (summary.reason === 'previous') { title = 'Your vault uses a previous ANTARA guardian'; text = 'Releases from it are paused. Open your vault for details.'; action = { label: 'Open your vault', run: onVaults }; }
      else if (summary.reason === 'pending') { title = 'Finish creating your vault'; text = 'A vault creation was started on this device but not registered. Finish it, then turn on the layers you want.'; action = { label: 'Finish creating', run: createVault, icon: 'plus' }; }
      else { title = 'Create a vault first'; text = 'Layers protect the funds in your vault. Create it, add a passkey, then turn on what you want.'; action = { label: 'Create vault', run: createVault, icon: 'plus' }; }
      break;
    case 'registered':
      if (summary.stage === 'activate-passkey') { title = 'Add a passkey to finish'; text = 'Your vault is created. A passkey approves every release and opens the other layers.'; tone = 'warn'; action = { label: 'Add a passkey', run: () => open({ form: 'passkey.add' }), icon: 'lock' }; }
      else if (summary.stage === 'unavailable') { title = 'We couldn’t check your vault’s protection'; text = 'Deposits and releases are paused until your layers can be read.'; tone = 'danger'; }
      else { title = 'Checking your vault’s protection'; text = 'Reading your protection from ANTARA.'; }
      break;
    case 'active': {
      const headline = view ? protectionHeadline(view) : null;
      title = headline?.title ?? 'Checking your vault’s protection'; tone = summary.releaseBlock ? 'warn' : 'ok';
      text = summary.releaseBlock || headline?.text || '';
      break;
    }
    default: title = 'Checking your vault…'; text = '';
  }
  const listNote = !authenticated ? 'Sign in to turn on your layers.'
    : canCreate ? 'Create a vault first. Layers are set per vault.' : 'Layers are set per vault.';
  const meter = (summary.state === 'active' || summary.state === 'registered') && view;

  return <section className="antara-protection antara-protection-screen" aria-labelledby="antara-protection-title">
    <header className="protection-page-heading"><h2 id="antara-protection-title">Protect your vault</h2><p>Turn on what you want. ANTARA checks each layer before it approves a release.</p></header>

    {/* One slim strip: where the vault stands and its one next step. The list right below is the detail. */}
    <section className="pscreen-strip ui-card" data-tone={tone} data-planet={authenticated && planet && wide ? true : undefined} aria-labelledby="pscreen-summary-title">
      {authenticated && planet && wide && <div className="pscreen-thumb" aria-hidden="true">
        {/* Decorative here: each row of the list carries its layer's state. */}
        <VaultPlanet states={states} motion labels="none" size="hero" />
      </div>}
      <div className="pscreen-strip-text">
        <p className="pscreen-eyebrow">{multisig && view ? `Vault ${short(multisig)} · Solana` : 'Your vault'}</p>
        <h3 id="pscreen-summary-title">{title}</h3>
        {meter && <div className="pscreen-meter" aria-hidden="true">{(['biometrics', 'geolocation', 'wifi', 'bluetooth', 'mfa', 'limits'] as const).map(id => <span key={id} data-on={view.layers.find(layer => layer.id === id && layer.status !== 'not-enrolled') ? true : undefined} />)}</div>}
        {text && <p className="pscreen-line" role="status">{text}</p>}
      </div>
      {action && <button type="button" className="ui-btn-primary pscreen-cta" onClick={action.run}>{action.icon && <Icon name={action.icon} size={16} />}{action.label}</button>}
    </section>

    {authenticated && multisig && layers && layersAccess ? <div className="pscreen-panel">
      <VaultLayers multisig={multisig} privyUserId={layersAccess.privyUserId} getToken={layersAccess.getToken} assertCurrent={layersAccess.assertCurrent}
        load={layers} reload={summary.reloadLayers} platform={platform} keys={keys} request={request} showSummary={false} />
    </div> : <section className="pscreen-layers" aria-labelledby="pscreen-layers-title">
      <header className="pscreen-layers-head"><h3 id="pscreen-layers-title">Protection layers</h3><p>{listNote}</p></header>
      <LayerList rows={describeRows} label="Protection layers you can turn on" />
    </section>}

    <p className="antara-protection-footnote">Protection applies to funds in your vault. Your spending wallet has no layers and never asks for a code.</p>
  </section>;
}

export default ProtectionScreen;
