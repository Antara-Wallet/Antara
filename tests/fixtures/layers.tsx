// Browser-only harness for the vault protection layer UI. Not imported by the application or production build.
// The API is mocked by Playwright routes; every device API is a fake that records its calls on window.__layerCalls.
//   ?panel=1      acts as the extension side panel        ?key=1   creates this page's trusted device key at load (window.__layerKeyId)
//   ?register=ok  the fake authenticator creates passkeys (default: it cancels)
//   ?geo=deny     the browser refuses location            ?slow=<ms> each fake passkey prompt takes that long
//   ?scene=protection   the Protection page (ProtectionView) over the mocked routes, as the shell shows it
//   ?scene=activation   the vault activation sheet at its passkey step         &planet=0  no WebGL planet
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VaultLayers } from '../../src/solares/layers/VaultLayers';
import { LayerApproval, LayerFullTabHandoff } from '../../src/solares/layers/LayerApproval';
import { beginReleaseLayers, startReleaseApproval, type ReleaseOnDevice } from '../../src/solares/layers/flow';
import { layerGate, pendingNotices } from '../../src/solares/layers/gate';
import { ensureDeviceKey, memoryDeviceKeyStorage } from '../../src/solares/layers/deviceKey';
import { PendingChangeAlert, revealPendingChanges } from '../../src/solares/layers/PendingChangeAlert';
import { useVaultLayers } from '../../src/solares/layers/useVaultLayers';
import { fakePlatform } from '../../src/solares/layers/testPlatform';
import { FIXTURE_MULTISIG, FIXTURE_RECIPIENT, FIXTURE_USER } from '../../src/solares/layers/testFixtures';
import type { ReleaseChallenge } from '../../src/solares/layers/types';
import { ProtectionView } from '../../src/solares/protection/ProtectionScreen';
import type { SummaryValue } from '../../src/solares/vaults/summary';
import { ActivationSequence } from '../../src/solares/verification/ActivationSequence';
import '../../src/index.css';
import '../../src/solares/desktop.css';

declare global { interface Window { __layerCalls: string[]; __layerKeyId?: string } }
window.__layerCalls = [];
const params = new URLSearchParams(location.search);
const sidePanel = params.get('panel') === '1';
const scene = params.get('scene');
const slow = Math.min(Number(params.get('slow') ?? 0) || 0, 10_000);
const record = (name: string) => window.__layerCalls.push(name);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const getToken = async () => 'fixture-token';
const onDevice: ReleaseOnDevice = { asset: 'SOL', amountRaw: '250000000', recipient: FIXTURE_RECIPIENT };
// The same release read the way PairedSolanaVault reads it: on this device, recorded so tests see when it ran.
const readOnDevice = async () => { record('read-proposal'); return onDevice; };
const keys = memoryDeviceKeyStorage();
if (params.get('key') === '1') void ensureDeviceKey(keys, FIXTURE_USER, FIXTURE_MULTISIG, sidePanel ? 'extension' : 'web').then(key => { window.__layerKeyId = key.keyId; });

function useFakePlatform() {
  return useMemo(() => fakePlatform({
    capabilities: { surface: sidePanel ? 'extension' : 'web', passkey: 'browser', geolocation: 'browser', bluetooth: 'web-bluetooth', wifiRadio: false, ceremonyInline: !sidePanel },
    browser: {
      startAuthentication: async options => {
        record(`passkey:${options.challenge}`);
        if (slow) await wait(slow);
        return { id: 'Y3JlZA', rawId: 'Y3JlZA', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' }, clientExtensionResults: {} };
      },
      startRegistration: async options => {
        record(`register:${options.challenge}`);
        if (slow) await wait(slow);
        if (params.get('register') !== 'ok') throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
        return { id: 'bmV3LXBhc3NrZXk', rawId: 'bmV3LXBhc3NrZXk', type: 'public-key', response: { clientDataJSON: 'e30', attestationObject: 'AA', transports: ['internal'] }, clientExtensionResults: {} };
      },
      // The browser's location, as navigator.geolocation answers it (or refuses, with ?geo=deny).
      geolocation: () => ({
        getCurrentPosition: (success, failure) => {
          record('geo');
          if (params.get('geo') === 'deny') { setTimeout(() => failure({ code: 1 }), 0); return; }
          setTimeout(() => success({ coords: { latitude: 48.8566, longitude: 2.3522, accuracy: 25 }, timestamp: Date.now() }), slow ? Math.min(slow, 800) : 0);
        },
      }),
      // Web Bluetooth: the chooser filtered to trusted names finds the trusted phone; the open chooser picks a new device.
      bluetooth: () => ({
        requestDevice: async options => {
          const filtered = 'filters' in options;
          record(filtered ? `bluetooth:${options.filters.map(item => item.name).join(',')}` : 'bluetooth:any');
          return filtered ? { id: 'Zm9vYmFy', name: 'Pixel 9' } : { id: 'bmV3LWRldmljZQ', name: 'Headphones' };
        },
      }),
    },
  }, window.__layerCalls), []);
}

function Harness() {
  const platform = useFakePlatform();
  const layers = useVaultLayers(FIXTURE_MULTISIG, getToken);
  const gate = layerGate(layers.load);
  const [step, setStep] = useState<{ kind: 'verify'; challenge: ReleaseChallenge } | { kind: 'full-tab' } | null>(null);
  const [status, setStatus] = useState('');

  async function continueRelease() {
    setStatus(''); setStep(null);
    try {
      const started = await startReleaseApproval(getToken, FIXTURE_MULTISIG, '12', readOnDevice, platform);
      if (started.kind === 'approved') setStatus(`Approved: ${started.approval.status}`);
      else setStep(started);
    } catch (failure) { setStatus(failure instanceof Error ? failure.message : 'Failed.'); }
  }

  return <main className="ui-scope" style={{ maxWidth: 960, margin: '24px auto', padding: 16, background: '#05070b' }}>
    <section aria-label="Vault gate"><p data-testid="gate-stage">{gate.stage}</p>{gate.releaseBlock && <p data-testid="release-block">{gate.releaseBlock}</p>}</section>
    {/* As on the vault summary in PairedSolanaVault: outside vault settings. */}
    <section aria-label="Vault summary"><PendingChangeAlert pending={pendingNotices(layers.load)} onReview={revealPendingChanges} /></section>
    <section aria-label="Release harness">
      <button type="button" className="desktop-button" onClick={() => void continueRelease()}>Continue release</button>
      {status && <p role="status" data-testid="release-status">{status}</p>}
      {step?.kind === 'verify' && <LayerApproval challenge={step.challenge} context={{ platform, keys, privyUserId: FIXTURE_USER, multisig: FIXTURE_MULTISIG }} getToken={getToken}
        restart={async () => beginReleaseLayers(await getToken(), FIXTURE_MULTISIG, '12', readOnDevice)}
        pending={pendingNotices(layers.load)} onReviewPending={revealPendingChanges}
        onApproved={approval => { setStep(null); setStatus(`Approved: ${approval.status}`); }} onCancel={() => setStep(null)} />}
      {step?.kind === 'full-tab' && <LayerFullTabHandoff platform={platform} onCancel={() => setStep(null)} />}
    </section>
    <VaultLayers multisig={FIXTURE_MULTISIG} privyUserId={FIXTURE_USER} getToken={getToken} load={layers.load} reload={layers.reload} platform={platform} keys={keys} />
  </main>;
}

/** The Protection page as the shell shows it, with the vault summary built from the mocked GET /solana/layers. */
function ProtectionHarness() {
  const platform = useFakePlatform();
  const layers = useVaultLayers(FIXTURE_MULTISIG, getToken);
  const gate = layerGate(layers.load);
  const base = { multisig: FIXTURE_MULTISIG, depositAddress: FIXTURE_RECIPIENT, layers: layers.load, reload: layers.reload, reloadLayers: layers.reload };
  const summary: SummaryValue = gate.stage === 'ready' ? { ...base, state: 'active', gate, releaseBlock: '' } : { ...base, state: 'registered', stage: gate.stage };
  return <div className="desktop-app ui-scope" style={{ minHeight: '100vh', background: 'var(--ink-1)', padding: 'clamp(16px, 3vw, 36px)' }}>
    <ProtectionView configured ready authenticated onConnect={() => undefined} onVaults={() => undefined} summary={summary}
      layersAccess={{ privyUserId: FIXTURE_USER, getToken }} platform={platform} keys={keys} planet={params.get('planet') !== '0'} />
  </div>;
}

/** Vault activation at its passkey step (step 4): the passkey, then this device is trusted in the same step. */
function ActivationHarness() {
  const layers = useVaultLayers(FIXTURE_MULTISIG, getToken);
  return <div className="desktop-app ui-scope" style={{ minHeight: '100vh', background: 'var(--ink-1)' }}>
    <ActivationSequence config={{ guardian: FIXTURE_RECIPIENT }} requirements={{ wallet: true, sol: 'met' }} cluster="mainnet-beta" layers={layers.load} progress={{ stage: 'registered' }}
      activate={() => undefined} finishActivation={() => undefined} discardAttempt={() => undefined} retryLayers={layers.reload} passkeyHandoff={false}
      addPasskey={async onStep => {
        record('activation:create'); onStep?.('Creating your passkey'); await wait(slow || 300);
        record('activation:trust'); onStep?.('Set up this browser: confirm with your passkey again'); await wait(slow || 300);
        layers.reload();
        return { trusted: true };
      }}
      onReceive={() => undefined} onOpenVault={() => undefined} onClose={() => undefined} explorerUrl={signature => `https://explorer.solana.com/tx/${signature}`} />
  </div>;
}

createRoot(document.getElementById('root')!).render(scene === 'protection' ? <ProtectionHarness /> : scene === 'activation' ? <ActivationHarness /> : <Harness />);
