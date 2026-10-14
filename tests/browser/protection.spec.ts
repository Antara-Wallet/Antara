// The simple Protection experience (owner feedback 2026-10-13), on the layer fixture with mocked routes:
// one row per layer, one action, and "Turn on" handling every prerequisite in the same sheet.
// Set PROTECTION_SHOTS=<dir> to also save the review screenshots there.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import {
  FIXTURE_DEVICE_KEY, FIXTURE_MULTISIG, FIXTURE_WEBAUTHN_GET, emptyLayersFixture, enrollChallengeFixture, passkeyOnlyFixture,
} from '../../src/solares/layers/testFixtures';

const PAIRED_API = '/api/solares/paired-vault';
const SHOTS = process.env.PROTECTION_SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' }); };
const layerCalls = (page: Page) => page.evaluate(() => (window as unknown as { __layerCalls: string[] }).__layerCalls);
/** keyIdOf (deviceKey.ts): base64url of the first 16 bytes of SHA-256(SPKI DER). */
const keyIdOf = (spki: string) => createHash('sha256').update(Buffer.from(spki, 'base64url')).digest().subarray(0, 16).toString('base64url');
/** Words the main list must never show: the old badges and internal terms. */
const JARGON = /Device-reported|Server-observed|Cryptographic|Not enrolled|Enrolled|Checked on every release|—/;

type Answer = { status: number; json: unknown };
async function mockPairedApi(page: Page, handlers: Record<string, (body: Record<string, unknown>) => Answer>) {
  const seen: { path: string; body: Record<string, unknown> | undefined }[] = [];
  await page.route(url => url.pathname.startsWith(PAIRED_API), async route => {
    const path = new URL(route.request().url()).pathname.slice(PAIRED_API.length);
    const data = route.request().postData();
    const body = data ? JSON.parse(data) as Record<string, unknown> : undefined;
    seen.push({ path, body });
    const answer = handlers[path]?.(body ?? {}) ?? { status: 404, json: { error: 'Not found.' } };
    await route.fulfill({ status: answer.status, json: answer.json });
  });
  return seen;
}

/** A change challenge the client accepts: tightening, the passkey only, bound to the fixture nonce and digest. */
function tighten(devices: { keyId: string; surface: string }[], capture: Record<string, unknown> = {}) {
  const base = enrollChallengeFixture();
  return { ...base, class: 'tighten', effectiveAt: null, required: [{ id: 'biometrics', evidence: 'passkey' }], devices, webauthn: { get: base.webauthn.get, create: null }, capture };
}

/**
 * A vault right after activation (passkey only, no trusted device). The mocked server trusts the device that device.add
 * names and turns Safe Zones on when the zone change finishes. Returns every request and every finished change.
 */
async function freshVault(page: Page) {
  const view = passkeyOnlyFixture();
  let begun = '';
  let candidate = '';
  const active = () => (view.devices as { keyId: string; surface: string; state: string }[]).filter(device => device.state === 'active').map(({ keyId, surface }) => ({ keyId, surface }));
  const seen = await mockPairedApi(page, {
    '/solana/layers': () => ({ status: 200, json: view }),
    '/solana/layers/enroll/begin': body => {
      const op = body.op as { type: string; publicKeySpki?: string };
      begun = op.type;
      if (op.type === 'device.add') { candidate = keyIdOf(op.publicKeySpki!); return { status: 200, json: tighten(active()) }; }
      if (op.type === 'geolocation.add-zone') return { status: 200, json: tighten(active(), { geo: true }) };
      return { status: 409, json: { error: 'Not in this test.', code: 'conflict' } };
    },
    '/solana/layers/enroll/finish': () => {
      view.configVersion = Number(view.configVersion) + 1;
      if (begun === 'device.add') view.devices = [...view.devices, { keyId: candidate, label: 'Web browser', surface: 'web', state: 'active', since: '2026-10-13T10:00:00.000Z' }];
      if (begun === 'geolocation.add-zone') {
        view.layers = view.layers.map(layer => layer.id !== 'geolocation' ? layer : {
          id: 'geolocation', kinds: ['device-reported'], status: 'enrolled', enforced: true,
          items: [{ id: 'zone_home', type: 'zone', label: 'Home', detail: 'Radius 500 m', state: 'active', since: '2026-10-13T10:00:00.000Z' }],
        });
      }
      return { status: 200, json: { status: 'applied', configVersion: view.configVersion } };
    },
  });
  return { seen, view, candidate: () => candidate };
}

const rowOf = (page: Page, id: string) => page.locator(`.vl-row[data-layer="${id}"]`);

test('a fresh vault lists six simple rows: only Biometrics on, one “Turn on” each, no badges or jargon', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshVault(page);
  await page.goto('/tests/fixtures/layers.html?scene=protection');
  const list = page.getByRole('list', { name: 'Your protection layers' });
  await expect(list.locator('.vl-row')).toHaveCount(6);
  expect(await list.locator('.vl-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-layer')))).toEqual(['biometrics', 'geolocation', 'wifi', 'bluetooth', 'mfa', 'limits']);
  await expect(rowOf(page, 'biometrics').locator('.vl-pill')).toHaveText('On · Required');
  await expect(rowOf(page, 'biometrics')).toContainText('Windows Hello');
  await expect(rowOf(page, 'biometrics').getByRole('button')).toHaveText('Manage');
  for (const [id, line] of [['geolocation', 'Device location in places you pick'], ['wifi', 'An internet address you trust'], ['bluetooth', 'A device you keep with you'],
    ['mfa', '6-digit code from an app'], ['limits', 'A max per release or per day']] as const) {
    await expect(rowOf(page, id).locator('.vl-pill')).toHaveText('Off');
    await expect(rowOf(page, id)).toContainText(line);
    const button = rowOf(page, id).getByRole('button');
    await expect(button).toHaveText('Turn on');
    await expect(button).toBeEnabled();
  }
  await expect(page.getByRole('heading', { name: '1 of 6 layers on' })).toBeVisible();
  await expect(page.locator('main, body').first()).not.toContainText(JARGON);
  // No disabled or ghost button anywhere in the list.
  await expect(list.locator('button:disabled')).toHaveCount(0);
  await shot(page, 'protection-list-1440');

  await page.setViewportSize({ width: 420, height: 800 });
  await expect(list.locator('.vl-row')).toHaveCount(6);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const button of await list.getByRole('button').all()) {
    const box = (await button.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(420);
    expect(box.height).toBeGreaterThanOrEqual(36);
  }
  await list.scrollIntoViewIfNeeded();
  await shot(page, 'protection-list-420');
  expect(errors).toEqual([]);
});

test('Turn on Safe Zones from an untrusted device: trusts it, reads the location, confirms, and shows On, with no “not trusted” error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const { seen, candidate } = await freshVault(page);
  await page.goto('/tests/fixtures/layers.html?scene=protection&slow=700&planet=0');
  await rowOf(page, 'geolocation').getByRole('button', { name: 'Turn on: Safe Zones' }).click();
  const sheet = page.getByRole('dialog', { name: 'Turn on Safe Zones' });
  await expect(sheet).toBeVisible();
  // Before anything starts, the sheet says what will happen: this device is trusted inside the same flow.
  await expect(sheet.getByRole('list', { name: 'What happens next' }).locator('li')).toHaveText([/Set up this browser.*Passkey prompt 1 of 2/, /Share your location/, /Confirm with your passkey.*Passkey prompt 2 of 2/]);
  // Turning a layer on offers no waiver, and the main button is pinned in the sheet's footer.
  await expect(sheet.getByText('Can’t use one of these layers?')).toHaveCount(0);
  await expect(sheet.locator('.ui-sheet-footer').getByRole('button', { name: 'Turn on Safe Zones' })).toBeVisible();
  // The honest detail for a layer that is not on yet says so, keeps the spoofing caveat and the device-key limit.
  await sheet.getByText('How ANTARA checks this').click();
  await expect(sheet.locator('.vl-how')).toContainText('Once it’s on:');
  await expect(sheet.locator('.vl-how')).toContainText('A modified device or location spoofing can fake this signal.');
  await expect(sheet.locator('.vl-how')).toContainText('not in secure hardware');
  await expect(sheet.getByLabel('Name')).toHaveValue('Home');
  await shot(page, 'safe-zones-1-form');
  expect(await layerCalls(page)).toEqual([]);

  await sheet.getByRole('button', { name: 'Turn on Safe Zones' }).click();
  const steps = sheet.getByRole('list', { name: 'Steps' }).locator('li');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toHaveAttribute('data-state', 'active');
  await shot(page, 'safe-zones-2-trusting');
  await expect(steps.nth(2)).toHaveAttribute('data-state', 'active');
  await shot(page, 'safe-zones-3-confirming');
  await expect(sheet.getByRole('heading', { name: 'Safe Zones is on' })).toBeVisible();
  await expect(sheet).toContainText('Releases now need a location your device reports inside Home (500 m).');
  await shot(page, 'safe-zones-4-done');

  // One passkey prompt to trust this device, the location once, then the passkey for the zone.
  expect(await layerCalls(page)).toEqual([`passkey:${FIXTURE_WEBAUTHN_GET}`, 'geo', `passkey:${FIXTURE_WEBAUTHN_GET}`]);
  const begins = seen.filter(item => item.path === '/solana/layers/enroll/begin').map(item => (item.body!.op as { type: string }).type);
  expect(begins).toEqual(['device.add', 'geolocation.add-zone']);
  const finishes = seen.filter(item => item.path === '/solana/layers/enroll/finish').map(item => item.body as { device: { keyId: string; payload: string }; passkey: unknown });
  expect(finishes).toHaveLength(2);
  for (const finish of finishes) { expect(finish.device.keyId).toBe(candidate()); expect(finish.passkey).toBeTruthy(); }
  const reading = JSON.parse(Buffer.from(finishes[1].device.payload, 'base64url').toString('utf8'));
  expect(reading.geo).toMatchObject({ lat: 48.8566, lng: 2.3522, source: 'browser-geolocation' });
  expect(reading.surface).toBe('web');
  // Never a separate red "not trusted" box, at any point.
  await expect(page.getByText(/not trusted/i)).toHaveCount(0);
  await expect(page.locator('.vl-alert, .vl-problem')).toHaveCount(0);

  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(rowOf(page, 'geolocation').locator('.vl-pill')).toHaveText('On');
  await expect(rowOf(page, 'geolocation')).toContainText('Home · 500 m');
  await expect(page.getByRole('heading', { name: '2 of 6 layers on' })).toBeVisible();
  await shot(page, 'safe-zones-5-on');

  await rowOf(page, 'geolocation').getByRole('button', { name: 'Manage: Safe Zones' }).click();
  const manage = page.getByRole('dialog', { name: 'Safe Zones' });
  await expect(manage).toContainText('Releases need your device to report a location inside one of these places.');
  await expect(manage.getByRole('list', { name: 'Safe Zones settings' }).locator('li')).toContainText(['Home']);
  await expect(manage.getByRole('button', { name: 'Remove Home' })).toBeVisible();
  await expect(manage.getByRole('button', { name: 'Add a safe zone' })).toBeVisible();
  await expect(manage.getByRole('button', { name: 'Turn off Safe Zones' })).toBeVisible();
  // The honest detail is one tap away, not in the list.
  await manage.getByText('How ANTARA checks this').click();
  await expect(manage).toContainText('A modified device or location spoofing can fake this signal.');
  await shot(page, 'safe-zones-6-manage');
  // Removing still goes through a confirmation and the passkey.
  await manage.getByRole('button', { name: 'Remove Home' }).click();
  await expect(page.getByRole('dialog', { name: 'Remove Home?' })).toContainText('You’ll confirm with your passkey.');
  expect(errors).toEqual([]);
});

test('when the browser refuses location, a calm card offers Try again and the zone is never sent', async ({ page }) => {
  const { seen } = await freshVault(page);
  await page.goto('/tests/fixtures/layers.html?scene=protection&geo=deny&planet=0');
  await rowOf(page, 'geolocation').getByRole('button', { name: 'Turn on: Safe Zones' }).click();
  const sheet = page.getByRole('dialog', { name: 'Turn on Safe Zones' });
  await sheet.getByRole('button', { name: 'Turn on Safe Zones' }).click();
  const problem = sheet.locator('.vl-problem');
  await expect(problem).toContainText('That didn’t finish');
  await expect(problem).toContainText('Location access is blocked for ANTARA.');
  await expect(sheet.getByRole('button', { name: 'Try again' })).toBeVisible();
  // This device was trusted on the way; that step stays done and only the location step stopped.
  const steps = sheet.getByRole('list', { name: 'Steps' }).locator('li');
  await expect(steps.nth(0)).toHaveAttribute('data-state', 'done');
  await expect(steps.nth(1)).toHaveAttribute('data-state', 'failed');
  expect(seen.filter(item => item.path === '/solana/layers/enroll/finish')).toHaveLength(1);
  expect(await layerCalls(page)).toEqual([`passkey:${FIXTURE_WEBAUTHN_GET}`, 'geo']);
  await expect(page.getByText(/not trusted/i)).toHaveCount(0);
  // Try again does not ask to trust the device a second time.
  await sheet.getByRole('button', { name: 'Try again' }).click();
  await expect(sheet.locator('.vl-problem')).toContainText('Location access is blocked');
  expect(seen.filter(item => item.path === '/solana/layers/enroll/begin').map(item => (item.body!.op as { type: string }).type)).toEqual(['device.add', 'geolocation.add-zone', 'geolocation.add-zone']);
});

test('a change that does not read from this browser never sets it up unannounced, and opening a form never submits it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // Safe Zones is on, set up from ANTARA Desktop; this browser is not set up for the vault.
  const view = passkeyOnlyFixture();
  view.devices = [{ keyId: FIXTURE_DEVICE_KEY, label: 'ANTARA Desktop', surface: 'desktop', state: 'active', since: '2026-10-12T10:00:00.000Z' }];
  view.layers = view.layers.map(layer => layer.id !== 'geolocation' ? layer : {
    id: 'geolocation', kinds: ['device-reported'], status: 'enrolled', enforced: true,
    items: [{ id: 'zone_home', type: 'zone', label: 'Home', detail: 'Radius 500 m', state: 'active', since: '2026-10-12T10:00:00.000Z' }],
  });
  let begun = '';
  let candidate = '';
  const devices = () => (view.devices as { keyId: string; surface: string; state: string }[]).filter(device => device.state === 'active').map(({ keyId, surface }) => ({ keyId, surface }));
  const seen = await mockPairedApi(page, {
    '/solana/layers': () => ({ status: 200, json: view }),
    '/solana/layers/enroll/begin': body => {
      const op = body.op as { type: string; publicKeySpki?: string };
      begun = op.type;
      if (op.type !== 'device.add') return { status: 409, json: { error: 'Not in this test.', code: 'conflict' } };
      candidate = keyIdOf(op.publicKeySpki!);
      return { status: 200, json: { ...tighten(devices()), required: [{ id: 'biometrics', evidence: 'passkey' }] } };
    },
    // Turning Safe Zones off loosens protection: the server asks for the passkey and a location from a set-up device.
    '/solana/layers/change/begin': body => {
      begun = (body.op as { type: string }).type;
      // A /change/ challenge carries no capture (nothing new is enrolled).
      const { capture: _none, ...challenge } = tighten(devices());
      return { status: 200, json: { ...challenge, class: 'loosen', required: [{ id: 'biometrics', evidence: 'passkey' }, { id: 'geolocation', evidence: 'device', reading: 'geo' }] } };
    },
    '/solana/layers/enroll/finish': () => {
      if (begun === 'device.add') view.devices = [...view.devices, { keyId: candidate, label: 'Web browser', surface: 'web', state: 'active', since: '2026-10-13T10:00:00.000Z' }];
      view.configVersion = Number(view.configVersion) + 1;
      return { status: 200, json: { status: 'applied', configVersion: view.configVersion } };
    },
    '/solana/layers/change/finish': () => {
      view.layers = view.layers.map(layer => layer.id !== 'geolocation' ? layer : { id: 'geolocation', kinds: ['device-reported'], status: 'not-enrolled', enforced: false, items: [] });
      view.configVersion = Number(view.configVersion) + 1;
      return { status: 200, json: { status: 'applied', configVersion: view.configVersion } };
    },
  });
  const started = () => seen.filter(item => item.path !== '/solana/layers').map(item => `${item.path} ${(item.body?.op as { type?: string } | undefined)?.type ?? ''}`.trim());
  await page.goto('/tests/fixtures/layers.html?scene=protection&planet=0');

  // "Add a safe zone" in Manage only opens its form: nothing starts until the form's own button is pressed.
  await rowOf(page, 'geolocation').getByRole('button', { name: 'Manage: Safe Zones' }).click();
  await page.getByRole('dialog', { name: 'Safe Zones' }).getByRole('button', { name: 'Add a safe zone' }).click();
  const form = page.getByRole('dialog', { name: 'Add a safe zone' });
  await expect(form.getByRole('form', { name: 'Add a safe zone' })).toBeVisible();
  // This form reads from this browser, so it says up front that it sets the browser up (two counted prompts).
  await expect(form.getByRole('list', { name: 'What happens next' }).locator('li').first()).toContainText('Set up this browser');
  expect(started()).toEqual([]);
  await form.getByRole('button', { name: 'Close' }).click();

  // Turning Safe Zones off needs a location from a set-up device, and never announced setting this browser up:
  // it stops before any prompt and offers that as the user's choice.
  await rowOf(page, 'geolocation').getByRole('button', { name: 'Manage: Safe Zones' }).click();
  await page.getByRole('dialog', { name: 'Safe Zones' }).getByRole('button', { name: 'Turn off Safe Zones' }).click();
  await page.getByRole('dialog', { name: 'Turn off Safe Zones?' }).getByRole('button', { name: 'Turn off Safe Zones' }).click();
  const sheet = page.getByRole('dialog', { name: 'Turn off Safe Zones' });
  await expect(sheet.locator('.vl-problem')).toContainText('One step first');
  await expect(sheet.locator('.vl-problem')).toContainText('Set up this browser first. This change needs a reading from it.');
  await expect(sheet.locator('.vl-problem')).toContainText('not in secure hardware');
  expect(await layerCalls(page)).toEqual([]);
  expect(started()).toEqual(['/solana/layers/change/begin layer.disable']);

  // The user's choice: set this browser up, then the change continues (each with its own challenge and passkey).
  await sheet.locator('.ui-sheet-footer').getByRole('button', { name: 'Set up this browser' }).click();
  await expect(sheet.getByRole('heading', { name: 'Safe Zones is off' })).toBeVisible();
  expect(started()).toEqual(['/solana/layers/change/begin layer.disable', '/solana/layers/enroll/begin device.add', '/solana/layers/enroll/finish', '/solana/layers/change/begin layer.disable', '/solana/layers/change/finish']);
  expect(await layerCalls(page)).toEqual([`passkey:${FIXTURE_WEBAUTHN_GET}`, 'geo', `passkey:${FIXTURE_WEBAUTHN_GET}`]);
  expect(errors).toEqual([]);
});

test('turning on MFA never shows a dead button or a waiver: Continue says what is missing', async ({ page }) => {
  const view = passkeyOnlyFixture();
  await mockPairedApi(page, {
    '/solana/layers': () => ({ status: 200, json: view }),
    '/solana/layers/enroll/begin': () => ({ status: 200, json: { ...tighten([]), capture: { totp: { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' } } } }),
  });
  await page.goto('/tests/fixtures/layers.html?scene=protection&planet=0');
  await rowOf(page, 'mfa').getByRole('button', { name: 'Turn on: MFA' }).click();
  const sheet = page.getByRole('dialog', { name: 'Turn on MFA' });
  await sheet.getByRole('button', { name: 'Turn on MFA' }).click();
  await expect(sheet.locator('.vl-totp-qr')).toBeVisible();
  await expect(sheet.getByText('Can’t use one of these layers?')).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: /Waive/ })).toHaveCount(0);
  const turnOn = sheet.locator('.ui-sheet-footer').getByRole('button', { name: 'Turn on MFA' });
  await expect(turnOn).toBeEnabled();
  await turnOn.click();
  await expect(sheet.getByRole('alert')).toHaveText('Enter the 6-digit code from the app.');
  expect(await layerCalls(page)).toEqual([]);
  // Typing clears the line; nothing was sent or prompted.
  await sheet.getByLabel('Code from your vault authenticator app').fill('12');
  await expect(sheet.getByRole('alert')).toHaveCount(0);
  expect(await layerCalls(page)).toEqual([]);
});

test('the sheet and the list fit a 420px window without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await freshVault(page);
  await page.goto('/tests/fixtures/layers.html?scene=protection&planet=0');
  await rowOf(page, 'geolocation').getByRole('button', { name: 'Turn on: Safe Zones' }).click();
  const sheet = page.getByRole('dialog', { name: 'Turn on Safe Zones' });
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(420);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await sheet.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await shot(page, 'safe-zones-form-420');
});

test('activation step 4 adds the passkey and trusts this device in the same step', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  let view: Record<string, unknown> = emptyLayersFixture();
  await mockPairedApi(page, { '/solana/layers': () => ({ status: 200, json: view }) });
  await page.goto('/tests/fixtures/layers.html?scene=activation&slow=600');
  const sheet = page.getByRole('dialog', { name: 'Create your vault' });
  await expect(sheet.getByRole('heading', { name: 'Add a passkey to finish activating' })).toBeVisible();
  await expect(sheet).toContainText('Your fingerprint, face or PIN approves every release.');
  await expect(sheet).toContainText('Your device will ask twice. That’s expected.');
  // The six "Off" chips are gone at this step, and the honest detail is one tap away.
  await expect(sheet.locator('.vseq-chips')).toHaveCount(0);
  await expect(sheet.locator('.vseq-act-how')).toContainText('not in secure hardware');
  await shot(page, 'activation-step4-1440');
  view = passkeyOnlyFixture();
  await sheet.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(sheet.getByRole('status')).toContainText('Set up this browser');
  await expect(sheet.getByRole('heading', { name: 'Your vault is active.' })).toBeVisible();
  expect(await layerCalls(page)).toEqual(['activation:create', 'activation:trust']);
  await page.setViewportSize({ width: 420, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  expect(FIXTURE_MULTISIG).toBeTruthy();
});

test('activation step 4 at 420px', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await mockPairedApi(page, { '/solana/layers': () => ({ status: 200, json: emptyLayersFixture() }) });
  await page.goto('/tests/fixtures/layers.html?scene=activation');
  const sheet = page.getByRole('dialog', { name: 'Create your vault' });
  await expect(sheet.getByRole('heading', { name: 'Add a passkey to finish activating' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'activation-step4-420');
});
