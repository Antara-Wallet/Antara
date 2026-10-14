/**
 * Area D parity scenarios (docs/UI_ARGUS_PARITY.md 6.6, 6.12-6.15, 7, 10.3).
 *
 * Two kinds:
 * - Wallet screen, Vault side, through the shell harness and tests/parity/routes/vault.ts. Phase 1
 *   leaves PairedSolanaVault, WalletVault and protection/** unedited (owned by the layers workflow
 *   until its gate), so these capture today's vault screens against the mocked vault: run them
 *   with PARITY_RUN=before. Screens that only exist after the gated step (the Protection status
 *   planet) wait for their markup and are "not present before".
 * - New screens (verification, activation, deposit) on tests/parity/planet.html. They do not
 *   exist before the build, so a before run records them as not present.
 *
 * `vault-no-pin` is not captured: the parity build pins the fixture guardian, and no-pin is a
 * build without one. vaults/summary.test.ts covers it.
 */
import type { ParityScenario, StepApi, SurfaceId } from '../types';

/** Wallet, Vault and Verification also run at 1440×900 and in the 420px panel (10.3). */
const VAULT_SURFACES: readonly SurfaceId[] = ['desktop', 'desktop-wide', 'mobile', 'panel-360', 'panel-420'];
/**
 * Layer ceremonies never run in the side panel (it hands off to a full tab, 5.2), so the evidence
 * states are captured where they can happen; the panel gets verify-full-tab and verify-approved-no-new-check.
 */
const CEREMONY_SURFACES: readonly SurfaceId[] = ['desktop', 'desktop-wide', 'mobile'];
const PLANET = '/tests/parity/planet.html';
/** Mocked refusals the browser logs as failed resources: 403 layers-required / layer-failed, 429 locked. */
const REFUSALS = [/status of 40[39]\b/, /status of 429\b/];

/** A screen built in this phase: absent from a before run. */
async function newScreen({ run, page, expectPresent }: StepApi) {
  if (run === 'before') await expectPresent(page.locator('[data-parity-never-present]'), 'new screen (planet harness)', 1);
}
/** Waits for the vault discovery (config, account, chain verification, layers) to settle on the Vault side. */
async function vaultSettled({ page }: StepApi) {
  await page.waitForFunction(() => !/Finding your vault|Checking your vault’s protection/.test(document.querySelector('#wallet-account-panel')?.textContent ?? ''), null, { timeout: 20_000 }).catch(() => undefined);
}
const vault = (id: string, profile: string, title: string, extra: Partial<ParityScenario> = {}): ParityScenario => ({
  id, area: 'D', screen: '6.6', title, argus: ['argus-ext-popup-42-vault-sim-vault-mode.png', 'argus-pwa-desktop-view-vault.png'],
  surfaces: VAULT_SURFACES, hash: 'vault', profile: { vault: profile },
  steps: async api => { await vaultSettled(api); },
  ...extra,
});
const verify = (id: string, title: string, params: Record<string, string>, extra: Partial<ParityScenario> = {}): ParityScenario => ({
  id, area: 'D', screen: '6.14', title,
  argus: ['argus-ext-popup-30-txflow-1-geo.png', 'argus-ext-popup-30-txflow-4-approval.png', 'argus-ext-popup-31-alllayers-6-done.png'],
  surfaces: CEREMONY_SURFACES, path: PLANET, params: { scene: 'verify', ...params }, allowConsole: REFUSALS,
  ...extra,
});
/** Clicks "Verify and approve" once the challenge has arrived. */
const verifyAndApprove = (after?: (api: StepApi) => Promise<void>) => async (api: StepApi) => {
  await newScreen(api);
  await api.click(['Verify and approve'], { timeout: 15_000 });
  // The pointer would otherwise rest on the next primary button and capture its hover colour.
  await api.page.mouse.move(1, 1);
  await after?.(api);
};
const activation = (id: string, step: string, title: string, argus: string[], extra: Partial<ParityScenario> = {}): ParityScenario => ({
  id, area: 'D', screen: '6.12', title, argus, path: PLANET, params: { scene: 'activation', step },
  profile: { vault: step === 'done' ? 'active' : 'passkey-needed' },
  steps: async api => {
    await newScreen(api);
    await api.expectPresent(api.page.getByRole('dialog', { name: 'Create your vault' }), 'activation sheet', 10_000);
  },
  ...extra,
});

export const entries: readonly ParityScenario[] = [
  // ---- Wallet screen, Vault side (today's screens against the mocked vault) ----
  vault('vault-signed-out', 'active', 'Vault side, signed out: "Your wallet. Its own vault." and Sign in', { state: 'signed-out', steps: undefined }),
  vault('vault-not-provisioned', 'not-provisioned', 'Guardian not switched on (503): exact title, no layer status'),
  vault('vault-mfa', 'mfa-missing', 'Account without Privy MFA (legacy mfaEnrolled: false is ignored, no wallet MFA): Create your vault is offered'),
  vault('vault-activate', 'activate', 'No vault yet: "Create your vault" hero, live SOL requirement and Create vault',
    { argus: ['argus-ext-popup-42-vault-sim-vault-mode.png', 'argus-pwa-desktop-view-vault.png', 'argus-ext-popup-20-vault-rules.png'] }),
  vault('vault-passkey-needed', 'passkey-needed', 'Vault verified and registered, no passkey: deposits and releases wait'),
  vault('vault-active', 'active', 'Active vault: verified balances, layers ready, deposit and release forms'),
  vault('vault-layers-unavailable', 'layers-unavailable', 'Layers 500: protection status unavailable, nothing On or Off'),
  vault('vault-locked', 'locked', 'Layers 429 locked: checks paused, nothing On or Off', { truth: { stationsUnknown: true }, allowConsole: REFUSALS }),
  vault('vault-evm-readonly', 'active', 'Vault side on Ethereum: read-only, no deposit or activation controls', {
    steps: async ({ page }) => { await page.getByLabel('Vault network').selectOption('ethereum'); },
  }),
  vault('release-review', 'active', 'Release form, review step: amount and the full recipient address', {
    screen: '6.14',
    argus: ['argus-ext-popup-46-vault-sim-send-select.png', 'argus-ext-popup-47-vault-sim-send-details.png', 'argus-ext-popup-48-vault-sim-send-confirm.png'],
    steps: async api => {
      // Deposit and Release share one card (Vault actions); Release is its second tab.
      await api.click(['Release'], { role: 'tab', timeout: 20_000 });
      const form = api.page.locator('.pv-form').filter({ hasText: 'Release to your wallet' });
      await api.expectPresent(form, 'release form', 20_000);
      await form.getByLabel('Amount').fill('0.25');
      await api.click(['Release with ANTARA approval']);
      await api.expectPresent(api.page.getByText('Review this release'), 'release review');
    },
  }),
  vault('vault-layers-active', 'active', 'Vault protection layers (vault settings), active vault', {
    screen: '6.15', surfaces: ['desktop', 'mobile', 'panel-360'],
    argus: ['argus-ext-popup-45-vault-sim-edit-account-full.png', 'argus-pwa-desktop-view-security.png'],
    steps: async api => {
      await api.expectPresent(api.page.getByRole('region', { name: 'Vault actions' }), 'verified vault', 20_000);
      await api.click(['Vault settings']);
      await api.expectPresent(api.page.getByRole('region', { name: 'Vault settings' }), 'vault settings');
    },
  }),
  vault('vault-layers-pending-removal', 'pending-removal', 'Vault protection layers with Safe Zones turning off and a pending passkey', {
    screen: '6.15', surfaces: ['desktop', 'mobile', 'panel-360'],
    argus: ['argus-ext-popup-45-vault-sim-edit-account-full.png'],
    steps: async api => {
      await api.expectPresent(api.page.getByRole('region', { name: 'Vault actions' }), 'verified vault', 20_000);
      await api.click(['Vault settings']);
      await api.expectPresent(api.page.getByRole('region', { name: 'Vault settings' }), 'vault settings');
    },
  }),
  {
    id: 'protection-overview-active', area: 'D', screen: '6.15', title: 'Protection overview with the status planet (active vault)',
    argus: ['argus-pwa-desktop-view-security.png', 'argus-tutorial-07-security-layers.png'], hash: 'protection', profile: { vault: 'active' },
    // The status planet lands with the gated protection/** step.
    steps: async ({ page, expectPresent }) => { await expectPresent(page.locator('.vseq-planet'), 'protection status planet', 15_000); },
  },
  {
    id: 'protection-overview-unavailable', area: 'D', screen: '6.15', title: 'Protection overview, layers unavailable: unknown stations, one line',
    argus: ['argus-pwa-desktop-view-security.png'], hash: 'protection', profile: { vault: 'layers-unavailable' }, truth: { stationsUnknown: true, vaultRegion: 'main' },
    steps: async ({ page, expectPresent }) => { await expectPresent(page.locator('.vseq-planet'), 'protection status planet', 15_000); },
  },

  // ---- Activation (6.12), planet harness ----
  activation('activation-rules', 'rules', 'Activation step 1: the vault’s fixed rules and live requirements',
    ['argus-ext-popup-20-vault-rules-full.png']),
  activation('activation-confirm', 'rules', 'Activation step 2: claims, fee line and the required acknowledgement',
    ['argus-ext-popup-21-activation-disclosure-full.png'], {
      steps: async api => {
        await newScreen(api);
        await api.click(['Continue'], { timeout: 10_000 });
        await api.expectPresent(api.page.getByText('I understand that if I lose access to my ANTARA login'), 'acknowledgement');
      },
    }),
  activation('activation-progress', 'progress', 'Activation step 3: one line per awaited call (registering)',
    ['argus-ext-popup-22-activation-loading-a.png', 'argus-ext-popup-22-activation-loading-c.png']),
  activation('activation-passkey', 'passkey', 'Activation step 4: add a passkey; MFA and Limits lit from the server',
    ['argus-ext-popup-22-activation-loading-e.png']),
  activation('activation-done', 'done', 'Activation complete: the server reports a passkey in force',
    ['argus-ext-popup-22-activation-loading-e.png']),

  // ---- Deposit (6.13) ----
  {
    id: 'deposit-review', area: 'D', screen: '6.13', title: 'Vault deposit review: amount, your wallet, the verified deposit address in full',
    argus: ['argus-ext-popup-15-receive-qr-full.png'], path: PLANET, params: { scene: 'deposit', step: 'review' }, profile: { vault: 'active' },
    steps: newScreen,
  },

  // ---- Verification sequence (6.14, 7) ----
  verify('verify-required', 'Verification, step 2: required stations before anything is read', {}, {
    profile: { vault: 'active', approve: 'approved' }, truth: { noPassed: true, noFailed: true },
    steps: async api => { await newScreen(api); await api.expectPresent(api.page.getByRole('button', { name: 'Verify and approve' }), 'challenge', 15_000); },
  }),
  verify('verify-collecting', 'Verification: location read on this device (Ready to send), passkey prompt open', { drive: 'collecting' }, {
    profile: { vault: 'active', approve: 'approved' }, truth: { noPassed: true, noFailed: true },
    steps: verifyAndApprove(async ({ page, expectPresent }) => { await expectPresent(page.locator('[data-station-state="collecting"]'), 'collecting station'); }),
  }),
  verify('verify-checking', 'Verification: evidence sent, ANTARA is checking (no answer yet)', {}, {
    profile: { vault: 'active', approve: 'hang' }, truth: { noPassed: true, noFailed: true },
    steps: verifyAndApprove(async ({ page, expectPresent }) => { await expectPresent(page.locator('[data-station-state="checking"]'), 'checking station'); }),
  }),
  verify('verify-passed', 'Verification: ANTARA approved this release; every required station Passed at once', {}, {
    profile: { vault: 'active', approve: 'approved' },
    steps: verifyAndApprove(async ({ page, expectPresent }) => { await expectPresent(page.getByText('ANTARA approved this release. Every layer you turned on passed.'), 'approval'); }),
  }),
  verify('verify-failed-geolocation', 'Verification: layer-failed, Safe Zones Failed with the server’s reason', {}, {
    profile: { vault: 'active', approve: 'layer-failed' },
    steps: verifyAndApprove(async ({ page, expectPresent }) => { await expectPresent(page.getByText('ANTARA did not approve this release.'), 'refusal'); }),
  }),
  verify('verify-device-problem', 'Verification: location consent missing on this device; nothing sent, nothing Failed', { drive: 'device-problem' }, {
    profile: { vault: 'active', approve: 'approved' }, truth: { noPassed: true, noFailed: true },
    steps: verifyAndApprove(async ({ page, expectPresent }) => { await expectPresent(page.getByText(/^Nothing was sent\./), 'device problem'); }),
  }),
  verify('verify-approved-no-new-check', 'Verification: approved without a new layer check; no station Passed', {}, {
    surfaces: VAULT_SURFACES, profile: { vault: 'active', approve: 'no-evidence' }, truth: { noPassed: true },
    steps: async api => { await newScreen(api); await api.expectPresent(api.page.getByText('ANTARA approved this release without a new layer check.'), 'approval without evidence', 15_000); },
  }),
  verify('verify-full-tab', 'Side panel: the ceremonies continue in a full tab; overview stations', {}, {
    surfaces: ['panel-360', 'panel-420'], profile: { vault: 'active', approve: 'approved' }, truth: { noPassed: true, noFailed: true },
    steps: async api => { await newScreen(api); await api.expectPresent(api.page.getByRole('button', { name: 'Approve in a full tab' }), 'full-tab hand-off', 15_000); },
  }),
  verify('verify-webgl-off', 'Without WebGL: vault-still.webp and the six chips with the same states', {}, {
    webgl: false, profile: { vault: 'active', approve: 'approved' }, truth: { webglFallback: true, noPassed: true, noFailed: true },
    // three.js logs the refused context before the sculpture falls back to the still.
    allowConsole: [...REFUSALS, /Error creating WebGL context/],
    steps: async api => { await newScreen(api); await api.expectPresent(api.page.getByRole('button', { name: 'Verify and approve' }), 'challenge', 15_000); },
  }),
  verify('verify-motion', 'Motion allowed: the live planet with the required pulse (desktop only)', {}, {
    surfaces: ['desktop'], reducedMotion: 'no-preference', profile: { vault: 'active', approve: 'approved' }, truth: { noPassed: true, noFailed: true },
    steps: async api => { await newScreen(api); await api.expectPresent(api.page.locator('canvas[data-motion="running"]'), 'running planet', 15_000); },
  }),
];
