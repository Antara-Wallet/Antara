import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksUnmasked, parseCancelResult, parseChangeChallenge, parseChangeResult, parseLayerRefusal, parseLayerRequirements, parsePendingNotices, parseReleaseChallenge,
  parseVaultLayers,
} from './schema';
import {
  FIXTURE_BLUETOOTH_MATCH, FIXTURE_CHALLENGE_ID, FIXTURE_MULTISIG, FIXTURE_RECIPIENT, LABELS_THAT_LOOK_UNMASKED, emptyLayersFixture, enrollChallengeFixture, layersFixture, recoveryPendingFixture,
  releaseChallengeFixture,
} from './testFixtures';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('GET /solana/layers parser', () => {
  it('accepts the section 9.1 example, in landing order, with every state', () => {
    const view = parseVaultLayers(layersFixture(), FIXTURE_MULTISIG);
    assert.deepEqual(view.layers.map(layer => layer.id), ['bluetooth', 'wifi', 'biometrics', 'geolocation', 'mfa', 'limits']);
    assert.deepEqual(view.layers.map(layer => layer.status), ['not-enrolled', 'enrolled', 'enrolled', 'pending-removal', 'enrolled', 'enrolled']);
    assert.equal(view.configVersion, 7);
    assert.equal(view.layers[2].items[1].state, 'pending-addition');
    assert.equal(view.layers[2].items[1].effectiveAt, Date.parse('2026-10-14T09:00:00.000Z'));
    assert.equal(view.layers[3].changeId, 'chg_b2');
    // The caps the user set (Limits is optional): null is "no cap", and nothing about a server ceiling or minimum.
    assert.deepEqual(view.layers[5].limits, { perRelease: { SOL: 500_000_000n, USDC: null }, perDay: { SOL: 2_000_000_000n, USDC: 200_000_000n } });
    assert.deepEqual(view.network, { observed: true, trusted: false });
    assert.equal(view.pending[1].summary, 'Turn off Safe Zones');
  });

  it('accepts a vault with no optional layer, and biometrics enforced before a passkey is added (owner decision)', () => {
    for (const enforced of [true, false]) {
      const view = parseVaultLayers(emptyLayersFixture(enforced), FIXTURE_MULTISIG);
      assert.equal(view.layers[2].status, 'not-enrolled');
      assert.equal(view.layers[2].enforced, enforced);
      // Limits is off by default: not enforced, every cap null.
      assert.deepEqual([view.layers[5].status, view.layers[5].enforced, view.layers[5].limits], ['not-enrolled', false, { perRelease: { SOL: null, USDC: null }, perDay: { SOL: null, USDC: null } }]);
    }
  });

  it('is bound to the vault that was asked for', () => {
    assert.throws(() => parseVaultLayers(layersFixture(), FIXTURE_RECIPIENT), /unexpected layer response/);
    assert.throws(() => parseVaultLayers({ ...layersFixture(), multisig: 'not-base58' }, 'not-base58'), /unexpected layer response/);
  });

  const malformed: [string, (view: ReturnType<typeof layersFixture>) => void][] = [
    ['an unknown layer id', view => { view.layers[0].id = 'voice'; }],
    ['five layers', view => { view.layers.pop(); }],
    ['seven layers', view => { view.layers.push(clone(view.layers[0])); }],
    ['layers out of landing order', view => { [view.layers[0], view.layers[1]] = [view.layers[1], view.layers[0]]; }],
    ['an unknown kind', view => { view.layers[0].kinds = ['hardware-verified']; }],
    ['an overstated kind (Bluetooth as cryptographic)', view => { view.layers[0].kinds = ['cryptographic']; }],
    ['Wi-Fi radio mode without the device-reported badge', view => { view.layers[1].mode = 'network+radio'; }],
    ['an unknown status', view => { view.layers[0].status = 'active'; }],
    ['enforced on a not-enrolled optional layer', view => { view.layers[0].enforced = true; }],
    ['not enforced while enrolled', view => { view.layers[1].enforced = false; }],
    ['enrolled with only pending additions', view => { (view.layers[1].items as Record<string, unknown>[])[0] = { ...(view.layers[1].items as Record<string, unknown>[])[0], state: 'pending-addition', effectiveAt: '2026-10-14T10:00:00.000Z', changeId: 'chg_x' }; }],
    ['pending removal without its change', view => { delete view.layers[3].changeId; }],
    ['a pending item without its effective time', view => { delete (view.layers[2].items as Record<string, unknown>[])[1].effectiveAt; }],
    ['MFA not enforced', view => { view.layers[4].enforced = false; }],
    ['Limits without values', view => { delete view.layers[5].limits; }],
    ['a per-release limit above its daily limit', view => { (view.layers[5].limits as Record<string, unknown>).perReleaseRaw = { SOL: '2000000001', USDC: null }; }],
    ['a zero limit', view => { (view.layers[5].limits as Record<string, unknown>).perReleaseRaw = { SOL: '0', USDC: null }; }],
    ['a server ceiling or minimum in the limits', view => { (view.layers[5].limits as Record<string, unknown>).minimumRaw = { SOL: '1', USDC: '1' }; }],
    ['Limits enrolled without any cap', view => { view.layers[5].limits = { perReleaseRaw: { SOL: null, USDC: null }, perDayRaw: { SOL: null, USDC: null } }; }],
    ['Limits off but carrying a cap', view => { Object.assign(view.layers[5], { status: 'not-enrolled', enforced: false }); }],
    ['Limits on but not enforced', view => { view.layers[5].enforced = false; }],
    ['an unknown field (a zone center)', view => { (view.layers[3].items as Record<string, unknown>[])[0].center = { lat: 1, lng: 2 }; }],
    ['an unknown top-level field', view => { (view as Record<string, unknown>).ip = '203.0.113.7'; }],
    ['a full IPv4 address', view => { (view.layers[1].items as Record<string, unknown>[])[0].detail = 'IPv4 203.0.113.7/32'; }],
    ['a full BSSID', view => { (view.layers[1].items as Record<string, unknown>[])[0].detail = 'AA:BB:CC:DD:3F:A1'; }],
    ['a 12-hex Bluetooth identifier', view => { (view.layers[3].items as Record<string, unknown>[])[0].detail = 'Device 001A7DDA7113'; }],
    ['a coordinate pair', view => { (view.layers[3].items as Record<string, unknown>[])[0].detail = 'Center 48.8566, 2.3522'; }],
    ['a duplicate item id', view => { (view.layers[2].items as Record<string, unknown>[])[1].id = (view.layers[2].items as Record<string, unknown>[])[0].id; }],
    ['a short device key id', view => { view.devices[0].keyId = 'abc'; }],
    ['a recovery change that waives nothing', view => { view.pending[0].class = 'recovery'; }],
    ['a waived MFA layer', view => { view.pending[0].waived = ['mfa']; }],
    ['trusted network reported for an unenrolled Wi-Fi layer', view => { Object.assign(view.layers[1], { status: 'not-enrolled', enforced: false, items: [] }); delete view.layers[1].mode; }],
  ];
  for (const [name, change] of malformed) {
    it(`refuses ${name}`, () => {
      const view = layersFixture();
      change(view);
      assert.throws(() => parseVaultLayers(view, FIXTURE_MULTISIG), /unexpected layer response/);
    });
  }

  it('shows a pending change whose summary quotes a label that looks like an address, identifier or coordinates', () => {
    // A session-only attacker's recovery passkey.add must never hide itself (and its Cancel) behind a crafted label.
    for (const label of LABELS_THAT_LOOK_UNMASKED) {
      assert.equal(looksUnmasked(label), true, label);
      const view = parseVaultLayers(recoveryPendingFixture(label), FIXTURE_MULTISIG);
      const change = view.pending.find(item => item.id === 'chg_r7');
      assert.deepEqual(change && { class: change.class, summary: change.summary, waived: change.waived, effectiveAt: change.effectiveAt },
        { class: 'recovery', summary: `Add passkey "${label}"`, waived: ['biometrics'], effectiveAt: Date.parse('2026-10-20T09:00:00.000Z') }, label);
      assert.equal(view.layers[2].items[1].label, label);
    }
  });

  it('accepts the user label apart from the summary, and still refuses any other unknown pending field', () => {
    const split = layersFixture();
    split.pending[0] = { ...split.pending[0], summary: 'Add passkey', label: 'Backup 10.0.0.1' };
    assert.equal(parseVaultLayers(split, FIXTURE_MULTISIG).pending[0].label, 'Backup 10.0.0.1');
    assert.equal(parseVaultLayers(layersFixture(), FIXTURE_MULTISIG).pending[0].label, null);
    const extra = layersFixture();
    extra.pending[0] = { ...extra.pending[0], ip: '203.0.113.7' };
    assert.throws(() => parseVaultLayers(extra, FIXTURE_MULTISIG), /unexpected layer response/);
    // Server-generated details are still checked.
    const leaky = recoveryPendingFixture('Phone');
    (leaky.layers[1].items as Record<string, unknown>[])[0].detail = 'IPv4 203.0.113.7/32';
    assert.throws(() => parseVaultLayers(leaky, FIXTURE_MULTISIG), /unexpected layer response/);
  });

  it('keeps the pending changes of a view it refuses, without any layer status', () => {
    const leaky = recoveryPendingFixture('Phone');
    (leaky.layers[1].items as Record<string, unknown>[])[0].detail = 'IPv4 203.0.113.7/32';
    assert.deepEqual(parsePendingNotices(leaky, FIXTURE_MULTISIG), [
      { id: 'chg_b2', class: 'loosen', effectiveAt: Date.parse('2026-10-14T10:00:00.000Z'), waived: [] },
      { id: 'chg_r7', class: 'recovery', effectiveAt: Date.parse('2026-10-20T09:00:00.000Z'), waived: ['biometrics'] },
    ]);
    // Bound to the vault asked for; unreadable entries give nothing rather than a guess.
    assert.equal(parsePendingNotices(leaky, FIXTURE_RECIPIENT), null);
    assert.equal(parsePendingNotices({ ...leaky, pending: [{ id: 'x', class: 'loosen', effectiveAt: '2026-10-14T10:00:00.000Z' }] }, FIXTURE_MULTISIG), null);
    assert.equal(parsePendingNotices({ ...leaky, pending: [{ id: 'chg_x', class: 'tighten', effectiveAt: '2026-10-14T10:00:00.000Z' }] }, FIXTURE_MULTISIG), null);
    assert.equal(parsePendingNotices([], FIXTURE_MULTISIG), null);
    // A waived list it cannot read is reported as unknown, not as "waives nothing".
    assert.deepEqual(parsePendingNotices({ multisig: FIXTURE_MULTISIG, pending: [{ id: 'chg_x', class: 'recovery', effectiveAt: '2026-10-14T10:00:00.000Z', waived: ['limits'] }] }, FIXTURE_MULTISIG),
      [{ id: 'chg_x', class: 'recovery', effectiveAt: Date.parse('2026-10-14T10:00:00.000Z'), waived: null }]);
  });

  it('detects unmasked values but allows the documented masks', () => {
    for (const value of ['IPv4 203.0.x.x/32', 'IPv6 2001:db8:1:…/48', 'Wi-Fi name with 1 access point · ••:••:••:••:3F:A1', 'ANTARA Desktop · ID …7113', 'Radius 250 m']) assert.equal(looksUnmasked(value), false, value);
    for (const value of ['203.0.113.7', '2001:db8:1:2:3:4:5:6', 'AA:BB:CC:DD:EE:FF', '001A7DDA7113', '48.8566, 2.3522']) assert.equal(looksUnmasked(value), true, value);
  });
});

describe('challenge and result parsers', () => {
  it('accepts the section 9.2 release challenge, bound to the vault and index asked for', () => {
    const challenge = parseReleaseChallenge(releaseChallengeFixture(), FIXTURE_MULTISIG, '12');
    assert.equal(challenge.challengeId, FIXTURE_CHALLENGE_ID);
    assert.deepEqual(challenge.required.map(item => `${item.id}:${item.evidence}`), ['biometrics:passkey', 'geolocation:device', 'wifi:server', 'bluetooth:device', 'mfa:server', 'limits:server']);
    assert.equal(challenge.required[3].match[0].identifier, FIXTURE_BLUETOOTH_MATCH);
    assert.equal(challenge.webauthn?.userVerification, 'required');
    assert.throws(() => parseReleaseChallenge(releaseChallengeFixture(), FIXTURE_MULTISIG, '13'));
    assert.throws(() => parseReleaseChallenge(releaseChallengeFixture(), FIXTURE_RECIPIENT, '12'));
  });

  it('accepts a challenge without optional layers (webauthn null)', () => {
    const body = releaseChallengeFixture();
    body.required = [{ id: 'mfa', evidence: 'server' }, { id: 'limits', evidence: 'server' }];
    body.webauthn = null;
    assert.deepEqual(parseReleaseChallenge(body, FIXTURE_MULTISIG, '12').required.map(item => item.id), ['mfa', 'limits']);
  });

  const badRelease: [string, (body: ReturnType<typeof releaseChallengeFixture>) => void][] = [
    ['a passkey requirement without request options', body => { body.webauthn = null; }],
    ['request options without user verification', body => { (body.webauthn as Record<string, unknown>).userVerification = 'preferred'; }],
    ['request options without credentials', body => { (body.webauthn as Record<string, unknown>).allowCredentials = []; }],
    ['an out-of-range timeout', body => { (body.webauthn as Record<string, unknown>).timeout = 5; }],
    ['a short nonce', body => { (body as Record<string, unknown>).nonce = 'AAEC'; }],
    ['an uppercase digest', body => { (body as Record<string, unknown>).digest = body.digest.toUpperCase(); }],
    ['a change purpose', body => { (body as Record<string, unknown>).purpose = 'change'; }],
    ['an invalid recipient', body => { body.release.recipient = 'nope'; }],
    ['an unknown requirement', body => { body.required.push({ id: 'voice', evidence: 'device' }); }],
    ['a Wi-Fi radio requirement that is not desktop-only', body => { body.required.push({ id: 'wifi', evidence: 'device', reading: 'wifi' }); }],
    ['a Bluetooth requirement without its match list', body => { delete body.required[3].match; }],
    ['a desktop match from Web Bluetooth', body => { (body.required[3].match as Record<string, unknown>[])[0].source = 'web-bluetooth'; }],
    ['a duplicate requirement', body => { body.required.push({ id: 'mfa', evidence: 'server' }); }],
  ];
  for (const [name, change] of badRelease) {
    it(`refuses a release challenge with ${name}`, () => {
      const body = releaseChallengeFixture();
      change(body);
      assert.throws(() => parseReleaseChallenge(body, FIXTURE_MULTISIG, '12'));
    });
  }

  it('accepts enrollment begin answers and refuses registrations on change routes', () => {
    const challenge = parseChangeChallenge(enrollChallengeFixture(), 'enroll');
    assert.equal(challenge.class, 'loosen');
    assert.equal(challenge.effectiveAt, Date.parse('2026-10-14T10:00:00.000Z'));
    assert.equal(challenge.webauthn.create?.authenticatorSelection?.userVerification, 'required');
    assert.throws(() => parseChangeChallenge(enrollChallengeFixture(), 'change'));
    const tighten = { ...enrollChallengeFixture(), class: 'tighten', effectiveAt: null };
    assert.equal(parseChangeChallenge(tighten, 'enroll').effectiveAt, null);
    // Owner decision 2026-10-13: a loosening applies at once (null), as the current server answers; a recovery change must
    // say when, and a tightening must not.
    assert.equal(parseChangeChallenge({ ...enrollChallengeFixture(), effectiveAt: null }, 'enroll').effectiveAt, null);
    assert.throws(() => parseChangeChallenge({ ...enrollChallengeFixture(), class: 'recovery', effectiveAt: null }, 'enroll'));
    assert.throws(() => parseChangeChallenge({ ...enrollChallengeFixture(), class: 'tighten' }, 'enroll'));
    const attested = enrollChallengeFixture();
    (attested.webauthn.create as Record<string, unknown>).attestation = 'direct';
    assert.throws(() => parseChangeChallenge(attested, 'enroll'));
    const weak = enrollChallengeFixture();
    (weak.webauthn.create as Record<string, unknown>).pubKeyCredParams = [{ type: 'public-key', alg: -8 }];
    assert.throws(() => parseChangeChallenge(weak, 'enroll'));
  });

  it('reads capture flags and refuses an unmasked observed network', () => {
    const body = { ...enrollChallengeFixture(), capture: { geo: true, bluetooth: 'choose', network: { observedCidr: 'IPv4 203.0.x.x/32' } } };
    const capture = parseChangeChallenge(body, 'enroll').capture;
    assert.deepEqual(capture, { geo: true, wifi: false, bluetooth: true, network: { observedCidr: 'IPv4 203.0.x.x/32' }, totp: null });
    // mfa.add: the new vault authenticator's base32 secret, and nothing that is not one.
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    assert.deepEqual(parseChangeChallenge({ ...body, capture: { totp: { secret } } }, 'enroll').capture.totp, { secret });
    for (const bad of [{ secret: secret.toLowerCase() }, { secret: secret.slice(1) }, { secret, uri: 'otpauth://totp/x' }, { secret: 7 }]) {
      assert.throws(() => parseChangeChallenge({ ...body, capture: { totp: bad } }, 'enroll'), JSON.stringify(bad));
    }
    assert.throws(() => parseChangeChallenge({ ...body, capture: { totp: { secret } } }, 'change'));
    assert.throws(() => parseChangeChallenge({ ...body, capture: { network: { observedCidr: '203.0.113.7/32' } } }, 'enroll'));
    assert.throws(() => parseChangeChallenge({ ...body, capture: { bluetooth: true } }, 'enroll'));
  });

  it('reads finish and cancel answers exactly', () => {
    assert.deepEqual(parseChangeResult({ status: 'applied', configVersion: 8 }), { status: 'applied', configVersion: 8 });
    assert.deepEqual(parseChangeResult({ status: 'pending', change: { id: 'chg_c3', class: 'loosen', effectiveAt: '2026-10-14T10:00:00.000Z' } }),
      { status: 'pending', change: { id: 'chg_c3', class: 'loosen', effectiveAt: Date.parse('2026-10-14T10:00:00.000Z') } });
    assert.throws(() => parseChangeResult({ status: 'applied', configVersion: 8, layers: [] }));
    assert.throws(() => parseChangeResult({ status: 'pending', change: { id: 'x', class: 'loosen', effectiveAt: '2026-10-14T10:00:00.000Z' } }));
    assert.deepEqual(parseCancelResult({ status: 'cancelled', configVersion: 9 }), { status: 'cancelled', configVersion: 9 });
    assert.throws(() => parseCancelResult({ status: 'applied', configVersion: 9 }));
  });

  it('keeps only the well-formed extras of a refusal, for the codes that define them', () => {
    const required = [{ id: 'biometrics', evidence: 'passkey' }, { id: 'mfa', evidence: 'server' }];
    assert.deepEqual(parseLayerRefusal('layers-required', { required }, null).required?.map(item => item.id), ['biometrics', 'mfa']);
    assert.equal(parseLayerRefusal('denied', { required }, null).required, null);
    assert.equal(parseLayerRefusal('layers-required', { required: [{ id: 'voice' }] }, null).required, null);
    const layers = [{ id: 'geolocation', ok: false, reason: 'Your reported location is outside your safe zones.' }, { id: 'biometrics', ok: true }];
    assert.deepEqual(parseLayerRefusal('layer-failed', { layers }, null).layers, [
      { id: 'geolocation', ok: false, reason: 'Your reported location is outside your safe zones.' }, { id: 'biometrics', ok: true, reason: null }]);
    // A reason that leaks a reading is dropped with the rest of the list.
    assert.equal(parseLayerRefusal('layer-failed', { layers: [{ id: 'geolocation', ok: false, reason: 'You are at 48.8566, 2.3522' }] }, null).layers, null);
    assert.equal(parseLayerRefusal('locked', {}, '120').retryAfterSeconds, 120);
    // ANTARA Desktop and the extension call cross-origin and may not see Retry-After: the body carries it too.
    assert.equal(parseLayerRefusal('locked', { retryAfterSeconds: 300 }, null).retryAfterSeconds, 300);
    assert.equal(parseLayerRefusal('locked', { retryAfterSeconds: 300 }, '120').retryAfterSeconds, 120);
    for (const bad of [0, -5, 1.5, '300', Number.NaN, 1e9]) assert.equal(parseLayerRefusal('locked', { retryAfterSeconds: bad }, null).retryAfterSeconds, null, String(bad));
    assert.equal(parseLayerRefusal('denied', { retryAfterSeconds: 300 }, null).retryAfterSeconds, null);
    assert.equal(parseLayerRefusal('locked', {}, 'soon').retryAfterSeconds, null);
    assert.equal(parseLayerRefusal('denied', {}, '120').retryAfterSeconds, null);
    assert.deepEqual(parseLayerRequirements([]), []);
  });
});
