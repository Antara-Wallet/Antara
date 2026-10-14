import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NEVER_CLAIM } from './claims';
import * as copy from './copy';
import { ROW_ORDER, LAYER_PURPOSE, capsText, itemLine, layerRows, namesText, protectionHeadline, setLine, unavailableHere, zoneSize, type RowContext } from './rows';
import { parseVaultLayers } from './schema';
import * as setup from './setup';
import { FIXTURE_MULTISIG, emptyLayersFixture, layersFixture, passkeyOnlyFixture } from './testFixtures';
import { LAYER_IDS } from './types';

const desktop: RowContext = { capabilities: { surface: 'desktop', passkey: 'native', geolocation: 'native', bluetooth: 'native' }, inline: true };
const web: RowContext = { capabilities: { surface: 'web', passkey: 'browser', geolocation: 'browser', bluetooth: 'web-bluetooth' }, inline: true };
const parse = (value: unknown) => parseVaultLayers(value, FIXTURE_MULTISIG);
const byId = (rows: ReturnType<typeof layerRows>) => Object.fromEntries(rows.map(row => [row.id, row]));

/** Every string a module exports, however deeply nested (functions are called with sample arguments where they build copy). */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object' && !(value instanceof RegExp)) return Object.values(value).flatMap(strings);
  return [];
}

describe('protection rows (owner feedback 2026-10-13: one simple row per layer)', () => {
  it('lists all six layers, the required one first, and only describes them without the server’s answer', () => {
    assert.deepEqual([...ROW_ORDER].sort(), [...LAYER_IDS].sort());
    assert.equal(ROW_ORDER[0], 'biometrics');
    const rows = layerRows(null, desktop);
    assert.deepEqual(rows.map(row => row.id), [...ROW_ORDER]);
    for (const row of rows) {
      assert.equal(row.pill, null, row.id);
      assert.equal(row.action, null, row.id);
      assert.equal(row.line, LAYER_PURPOSE[row.id]);
    }
  });

  it('a fresh vault shows only Biometrics on, and one "Turn on" per other layer', () => {
    const rows = byId(layerRows(parse(passkeyOnlyFixture()), desktop));
    assert.deepEqual(rows.biometrics.pill, { tone: 'on', label: 'On · Required' });
    assert.equal(rows.biometrics.line, 'Windows Hello');
    assert.deepEqual(rows.biometrics.action, { kind: 'manage', label: 'Manage' });
    for (const id of ['geolocation', 'wifi', 'bluetooth', 'mfa', 'limits'] as const) {
      assert.deepEqual(rows[id].pill, { tone: 'off', label: 'Off' }, id);
      assert.deepEqual(rows[id].action, { kind: 'setup', label: 'Turn on' }, id);
      assert.equal(rows[id].line, LAYER_PURPOSE[id], id);
      assert.equal(rows[id].note, null, id);
    }
    // The rows say what each layer needs: the headline is the count only.
    assert.deepEqual(protectionHeadline(parse(passkeyOnlyFixture())), { title: '1 of 6 layers on', text: '' });
  });

  it('before the first passkey, only the passkey is offered and the other rows say why, with no dead button', () => {
    const rows = byId(layerRows(parse(emptyLayersFixture()), web));
    assert.deepEqual(rows.biometrics.pill, { tone: 'warn', label: 'Required' });
    assert.deepEqual(rows.biometrics.action, { kind: 'setup', label: 'Add a passkey' });
    for (const id of ['geolocation', 'wifi', 'bluetooth', 'mfa', 'limits'] as const) {
      assert.equal(rows[id].action, null, id);
      assert.equal(rows[id].note, 'Add a passkey first', id);
    }
    assert.equal(protectionHeadline(parse(emptyLayersFixture())).text, 'Add a passkey to finish setting up your vault.');
  });

  it('shows what is set when a layer is on, and a layer turning off as such', () => {
    const view = parse(layersFixture());
    const rows = byId(layerRows(view, web));
    assert.deepEqual(rows.wifi.pill, { tone: 'on', label: 'On' });
    assert.equal(rows.wifi.line, 'Home');
    assert.equal(rows.biometrics.line, 'Windows Hello · 1 waiting');
    assert.deepEqual(rows.geolocation.pill, { tone: 'warn', label: 'Turning off' });
    assert.match(rows.geolocation.line, /^Turns off /);
    assert.equal(rows.mfa.line, 'Phone app');
    assert.equal(rows.limits.line, '0.5 SOL per release · 2 SOL per day · 200 USDC per day');
    assert.deepEqual(rows.bluetooth.action, { kind: 'setup', label: 'Turn on' });
    assert.deepEqual(protectionHeadline(view), { title: '5 of 6 layers on', text: '' });
  });

  it('a layer this app cannot use says so in one muted line instead of a disabled button', () => {
    const none: RowContext = { capabilities: { surface: 'web', passkey: 'browser', geolocation: 'none', bluetooth: 'none' }, inline: true };
    const rows = byId(layerRows(parse(passkeyOnlyFixture()), none));
    assert.equal(rows.bluetooth.action, null);
    assert.equal(rows.bluetooth.note, 'Available in Chrome or the desktop app');
    assert.equal(rows.geolocation.action, null);
    assert.equal(rows.geolocation.note, 'Location isn’t available in this browser');
    assert.equal(unavailableHere('wifi', none.capabilities), null);
    // The extension side panel: changes continue in a full tab, so no row has an action.
    const panel = layerRows(parse(passkeyOnlyFixture()), { ...web, inline: false });
    assert.ok(panel.every(row => row.action === null));
  });

  it('formats names, zone sizes and caps in a few words', () => {
    assert.equal(namesText(['Home']), 'Home');
    assert.equal(namesText(['Home', 'Office']), 'Home and Office');
    assert.equal(namesText(['Home', 'Office', 'Cabin']), 'Home and 2 more');
    assert.equal(zoneSize({ detail: 'Radius 250 m' }), '250 m');
    assert.equal(zoneSize({ detail: 'Radius 5 km' }), '5 km');
    assert.equal(zoneSize({ detail: 'Somewhere' }), '');
    assert.equal(capsText(null), 'No limits set');
    assert.equal(capsText({ perRelease: { SOL: null, USDC: 5_000_000n }, perDay: { SOL: null, USDC: null } }), '5 USDC per release');
    const zones = parse(layersFixture()).layers.find(layer => layer.id === 'geolocation')!;
    assert.equal(setLine(zones), 'Home · 250 m');
  });

  it('a Manage sheet item shows when it was added, a zone’s size and a synced passkey, never the raw detail', () => {
    const since = Date.UTC(2026, 9, 9, 8);
    const added = itemLine({ type: 'network', detail: 'IPv4 203.0.x.x/32', since });
    assert.match(added, /^Added /);
    assert.doesNotMatch(added, /IPv4|203/);
    assert.match(itemLine({ type: 'zone', detail: 'Radius 250 m', since }), /^250 m · added /);
    assert.match(itemLine({ type: 'passkey', detail: 'Synced passkey · added from Web', since }), /^Synced passkey · added /);
    assert.doesNotMatch(itemLine({ type: 'passkey', detail: 'Device-bound passkey · added from ANTARA Desktop', since }), /Device-bound|Desktop/);
    assert.equal(itemLine({ type: 'authenticator', detail: 'Authenticator app', since: null }), '');
  });

  it('each row line fits one short line and makes no geofence, proximity or Wi-Fi claim', () => {
    for (const id of ROW_ORDER) {
      assert.ok(LAYER_PURPOSE[id].length <= 34, `${id}: ${LAYER_PURPOSE[id]}`);
      assert.doesNotMatch(LAYER_PURPOSE[id], /only|nearby|near|Wi-?Fi/i, LAYER_PURPOSE[id]);
    }
  });

  it('the new copy is plain: no dash placeholder, no internal terms, and no claim section 14.2 forbids', () => {
    const view = parse(layersFixture());
    const texts = [
      ...strings(copy), ...strings(LAYER_PURPOSE),
      ...(['passkey.add', 'device.add', 'geolocation.add-zone', 'wifi.add-network', 'wifi.add-radio', 'bluetooth.add-device', 'limits.set', 'mfa.add'] as const)
        .flatMap(kind => [copy.formTitle(kind, true), copy.formTitle(kind, false), copy.defaultName(kind, 'web')]),
      ...(['on', 'added', 'off', 'removed', 'saved', 'trusted'] as const).map(kind => copy.doneTitle(kind, 'Safe Zones')),
      ...[web, desktop].flatMap(context => [...layerRows(view, context), ...layerRows(parse(emptyLayersFixture()), context)].flatMap(row => [row.line, row.note ?? '', row.pill?.label ?? '', row.action?.label ?? ''])),
      protectionHeadline(view).text,
      ...setup.planSteps({ kind: 'change', op: { type: 'geolocation.add-zone', label: 'Home', radiusM: 500, center: 'current' }, title: '', waive: [] }, true, 'web').flatMap(step => [step.label, step.hint]),
      ...setup.planSteps({ kind: 'change', op: { type: 'bluetooth.add-device', label: 'Phone' }, title: '', waive: [] }, false, 'desktop').flatMap(step => [step.label, step.hint]),
      setup.TRUST_TITLE, setup.lockoutMessage(90),
    ].filter(Boolean);
    assert.ok(texts.length > 60);
    for (const text of texts) {
      assert.doesNotMatch(text, /—/, text);
      assert.doesNotMatch(text, /\b(?:enrolled|server-observed|device-reported|cryptographic|ledger|surface)\b/i, text);
      for (const pattern of NEVER_CLAIM) assert.doesNotMatch(text, pattern, text);
    }
  });
});
