// Planet scene harness (docs/UI_ARGUS_PARITY.md 10.2), Area D. Browser-only: never imported by
// the application or the production build. The vault API is answered by tests/parity/routes/vault.ts;
// nothing here signs, reaches Privy or runs a real passkey, Bluetooth or location ceremony.
//
//   ?scene=verify      VerificationSequence driven by real startReleaseApproval / requestGuardianApproval
//                      calls against the mocked routes (profile `approve`), with a fake LayerPlatform.
//                      &drive=collecting      readings reported through the container's hooks (appearance until 8.7)
//                      &drive=device-problem  the real geolocation collector fails on this device (consent)
//   ?scene=activation  ActivationSequence  &step=rules|confirm|progress|failed|pending|passkey|done  &sol=met|unknown|zero
//   ?scene=deposit     DepositPanel        &step=form|review  &blocked=1
//   ?scene=still       the vault planet alone, every station on, no text (source of vault-still.webp)
//   ?scene=planet      the vault planet with its rail or chips  &stations=on,off,... (landing order)
//   &surface=sidepanel  as the Chrome side panel     &webgl=0  WebGL contexts return null
// Sets <html data-parity-ready="1"> once rendered and fonts are loaded.
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SOLANA_NETWORK, explorerTxUrl } from '../../src/solares/networks';
import { collectGeo } from '../../src/solares/layers/collectors';
import { beginReleaseLayers, startReleaseApproval, type ReleaseOnDevice } from '../../src/solares/layers/flow';
import { useVaultLayers } from '../../src/solares/layers/useVaultLayers';
import { FakeNativeError, fakePlatform } from '../../src/solares/layers/testPlatform';
import { LAYER_IDS } from '../../src/solares/layers/types';
import { fetchPairedConfig, requestGuardianApproval, type PairedGuardianConfig } from '../../src/solares/vaults/pairedApi';
import { layerGate } from '../../src/solares/layers/gate';
import { ToastProvider } from '../../src/solares/ui';
import { STATION_VISUALS, stationLabel, type StationVisual } from '../../src/solares/verification/stationState';
import { VaultPlanet } from '../../src/solares/verification/VaultPlanet';
import { VerificationSequence, type ReleaseProgress } from '../../src/solares/verification/VerificationSequence';
import { ActivationSequence, type ActivationProgress } from '../../src/solares/verification/ActivationSequence';
import { DepositPanel } from '../../src/solares/verification/DepositPanel';
import { PARITY_KEYS } from './keys';
import { PARITY_VAULT } from './routes/vault-chain';
import '../../src/index.css';
// Every rule in extension.css is scoped to html[data-surface=...], so it is inert unless the panel surface is set.
import '../../src/extension/extension.css';

declare global {
  interface Window { __parityCalls: string[] }
}
window.__parityCalls = [];
const record = (call: string) => { window.__parityCalls.push(call); };

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'verify';
const sidePanel = params.get('surface') === 'sidepanel';
if (sidePanel) document.documentElement.dataset.surface = 'sidepanel';
if (params.get('webgl') === '0') {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') return null;
    return (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
  } as typeof HTMLCanvasElement.prototype.getContext;
}

const getToken = async () => 'parity-token';
const RELEASE = { index: '12', amount: '0.25', asset: 'SOL' as const, recipientLabel: 'This wallet', recipient: PARITY_KEYS.user };
// The release as this device reads it from Solana (PairedSolanaVault's releaseOnDevice).
const readOnDevice = async (): Promise<ReleaseOnDevice> => ({ asset: 'SOL', amountRaw: '250000000', recipient: PARITY_KEYS.user });
const explorerUrl = (signature: string) => explorerTxUrl(SOLANA_NETWORK, signature, { solanaCluster: 'mainnet-beta' });
const never = <T,>() => new Promise<T>(() => undefined);

function platformFor(drive: string) {
  return fakePlatform({
    capabilities: sidePanel
      ? { surface: 'extension', passkey: 'browser', geolocation: 'browser', bluetooth: 'web-bluetooth', wifiRadio: false, ceremonyInline: false }
      : {},
    native: drive === 'device-problem' ? { location: async () => { throw new FakeNativeError('location-consent-required'); } } : {},
  }, window.__parityCalls);
}

function VerifyScene() {
  const drive = params.get('drive') ?? '';
  const platform = useMemo(() => platformFor(drive), [drive]);
  const layers = useVaultLayers(PARITY_VAULT.multisig, getToken);
  const [progress, setProgress] = useState<ReleaseProgress>({ step: 'requesting' });
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        // Section 12 steps 1-3, exactly as PairedSolanaVault's completeRelease runs them.
        const started = await startReleaseApproval(getToken, PARITY_VAULT.multisig, RELEASE.index, readOnDevice, platform);
        if (!live) return;
        if (started.kind === 'full-tab') setProgress({ step: 'full-tab' });
        else if (started.kind === 'verify') setProgress({ step: 'layers', challenge: started.challenge });
        else setProgress({ step: 'vote', answer: { kind: 'no-evidence', status: started.approval.status } });
      } catch (failure) {
        if (live) setProgress({ step: 'stopped', at: 'vote', answer: null, reason: 'other', message: failure instanceof Error ? failure.message : 'Failed.' });
      }
    })();
    return () => { live = false; };
  }, [platform]);
  return (
    <VerificationSequence
      release={RELEASE}
      layers={layers.load}
      progress={progress}
      submit={async (challenge, hooks) => {
        if (drive === 'collecting') {
          // Collector order is Bluetooth, location, Wi-Fi radio, passkey: location read, passkey prompt open.
          hooks.onStep('Reading your location'); hooks.onLayer('geolocation', 'collecting'); hooks.onLayer('geolocation', 'collected');
          hooks.onStep('Waiting for your passkey'); hooks.onLayer('biometrics', 'collecting');
          return never();
        }
        if (drive === 'device-problem') { hooks.onStep('Reading your location'); hooks.onLayer('geolocation', 'collecting'); await collectGeo(platform); }
        hooks.onSubmitted();
        return requestGuardianApproval(await getToken(), PARITY_VAULT.multisig, challenge.release.transactionIndex, { challengeId: challenge.challengeId });
      }}
      restart={async () => beginReleaseLayers(await getToken(), PARITY_VAULT.multisig, RELEASE.index, readOnDevice)}
      onApproved={approval => { record(`approved:${approval.status}`); setProgress({ step: 'vote', answer: { kind: 'evidence', status: approval.status } }); }}
      onCancel={() => record('cancel')}
      onClose={() => record('close')}
      onAddDevice={() => record('addDevice')}
      onOpenLocationSettings={() => { record('openLocationSettings'); void platform.native.openLocationSettings(); }}
      onOpenFullTab={async () => { record('openFullTab'); return platform.openWalletTab('#vault'); }}
      onSelectStation={id => record(`station:${id}`)}
      explorerUrl={explorerUrl}
    />
  );
}

function ActivationScene() {
  const step = params.get('step') ?? 'rules';
  const sol = (params.get('sol') ?? 'met') as 'met' | 'unknown' | 'zero';
  const [config, setConfig] = useState<PairedGuardianConfig | null>(null);
  useEffect(() => { void fetchPairedConfig('parity-token').then(setConfig, failure => record(`config:${String(failure)}`)); }, []);
  const registered = step === 'passkey' || step === 'done';
  const layers = useVaultLayers(registered ? PARITY_VAULT.multisig : null, getToken);
  const progress: ActivationProgress = registered ? { stage: 'registered' }
    : step === 'progress' ? { stage: 'registering' }
    : step === 'pending' ? { stage: 'pending', multisig: PARITY_VAULT.multisig }
    : step === 'failed' ? { stage: 'failed', at: 'creating', message: 'Fixture: signing disabled' }
    : { stage: 'idle' };
  if (!config) return null;
  return (
    <ActivationSequence
      config={config}
      cluster="mainnet-beta"
      requirements={{ mfa: true, wallet: true, sol }}
      layers={layers.load}
      progress={progress}
      activate={() => record('activate')}
      finishActivation={() => record('finishActivation')}
      discardAttempt={() => record('discardAttempt')}
      retryLayers={layers.reload}
      addPasskey={async () => { record('addPasskey'); }}
      passkeyHandoff={sidePanel}
      onOpenFullTab={async () => { record('openFullTab'); return true; }}
      onReceive={() => record('receive')}
      onOpenVault={() => record('openVault')}
      onClose={() => record('close')}
      explorerUrl={explorerUrl}
    />
  );
}

function DepositScene() {
  const layers = useVaultLayers(PARITY_VAULT.multisig, getToken);
  const gate = layerGate(layers.load);
  const blocked = params.get('blocked') === '1';
  const step = params.get('step') === 'form' ? 'form' : 'review';
  return (
    <main className="ui-scope planet-page planet-page-narrow">
      <DepositPanel
        depositAddress={PARITY_VAULT.depositAddress}
        from={PARITY_KEYS.user}
        cluster="mainnet-beta"
        balances={{ SOL: 1_250_000_000n, USDC: 42_500_000n }}
        depositBlock={blocked ? gate.depositBlock || 'Checking your vault’s protection layers.' : ''}
        deposit={async () => { throw new Error('Fixture: signing disabled'); }}
        explorerUrl={explorerUrl}
        initial={{ step, amount: step === 'review' ? '0.5' : '' }}
      />
    </main>
  );
}

function PlanetScene({ still }: { still: boolean }) {
  const requested = (params.get('stations') ?? '').split(',').filter((value): value is StationVisual => (STATION_VISUALS as readonly string[]).includes(value));
  const visuals: StationVisual[] = LAYER_IDS.map((_, index) => requested[index] ?? 'on');
  const states = LAYER_IDS.map((id, index) => ({ id, visual: visuals[index], label: stationLabel(id, visuals[index]) }));
  return (
    <main className={`ui-scope ${still ? 'planet-still' : 'planet-page'}`}>
      <VaultPlanet states={states} motion={!still} labels={still ? 'none' : 'auto'} size="hero" />
    </main>
  );
}

/** Static copy of src/extension/sidepanel.tsx's bar (that file mounts its own root, so it is not imported). */
function SidePanelBarReplica() {
  return (
    <div className="extension-panel-bar" data-parity-ignore="">
      <span className="extension-panel-bar-label">Side panel</span>
      <button type="button" className="extension-panel-bar-button" onClick={() => record('openFullTab')}>
        Open in full tab <span aria-hidden="true">↗</span>
      </button>
    </div>
  );
}

const HARNESS_CSS = `
  html, body { margin: 0; background: #08090b; }
  .planet-page { box-sizing: border-box; min-height: 100dvh; padding: 24px; background: var(--ink-1); color: var(--fg); font: 400 13px/1.5 var(--font-ui); }
  .planet-page-narrow { display: grid; justify-items: center; align-content: start; }
  .planet-page-narrow > * { width: min(100%, 560px); }
  .planet-still { width: 1600px; height: 900px; background: var(--ink-0); }
  .planet-still .vseq-planet-stage { aspect-ratio: auto; width: 1600px; height: 900px; border-radius: 0; }
  @media (max-width: 640px) { .planet-page { padding: 16px; } }
`;

function Scene() {
  if (scene === 'activation') return <ActivationScene />;
  if (scene === 'deposit') return <DepositScene />;
  if (scene === 'still' || scene === 'planet') return <PlanetScene still={scene === 'still'} />;
  return <VerifyScene />;
}

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <style>{HARNESS_CSS}</style>
    {sidePanel && <SidePanelBarReplica />}
    {scene !== 'still' && scene !== 'planet' && scene !== 'deposit' && <main className="ui-scope planet-page" aria-label="Wallet (harness backdrop)" />}
    <Scene />
  </ToastProvider>,
);
requestAnimationFrame(() => {
  void document.fonts.ready.then(() => requestAnimationFrame(() => { document.documentElement.dataset.parityReady = '1'; }));
});
