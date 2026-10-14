import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXTENSION_CSP } from '../extension/policy.mjs';
import {
  DENIED_COMMANDS, LAYER_COMMANDS, LOCAL_API, PRODUCTION_API_BASE, REQUIRED_FRAMES,
  apiBaseProblems, buildCommands, configProblems, cspProblems, distProblems, envProblems, layerGrantProblems, parseCsp,
  permissionIdentifierProblems,
} from './check-desktop-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
const clone = value => structuredClone(value);
const conf = readJson('src-tauri/tauri.conf.json');
const capabilities = Object.fromEntries(readdirSync(join(root, 'src-tauri/capabilities')).map(name => [name, readJson(`src-tauri/capabilities/${name}`)]));
const appCommands = buildCommands(readFileSync(join(root, 'src-tauri/build.rs'), 'utf8'));

/** The configuration as it stood before the October 12, 2026 desktop hardening. */
const preHardeningConf = () => {
  const old = clone(conf);
  old.app.withGlobalTauri = true;
  old.build.beforeBuildCommand = 'npm run build:app';
  old.app.security.csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com https://hcaptcha.com https://*.hcaptcha.com; style-src 'self' 'unsafe-inline' https://hcaptcha.com https://*.hcaptcha.com; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src ipc: http://ipc.localhost 'self' http://localhost:8787 https: wss:; frame-src https://auth.privy.io https://*.privy.com https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com https://hcaptcha.com https://*.hcaptcha.com; object-src 'none'; base-uri 'self'; worker-src 'self' blob:";
  return old;
};
const preHardeningCapability = {
  identifier: 'default',
  webviews: ['main'],
  permissions: [
    'core:default', 'opener:default', 'allow-list-drives', 'allow-list-usb-devices', 'allow-vault-exists', 'allow-create-vault',
    'allow-import-vault', 'allow-unlock-vault', 'allow-lock-vault', 'allow-list-accounts', 'allow-add-account', 'allow-import-account',
    'allow-sign-hash', 'allow-reveal-mnemonic', 'allow-reveal-private-key', 'allow-stealth-meta-address', 'allow-stealth-send-compute',
    'allow-stealth-scan', 'allow-stealth-sign', 'allow-webauthn-make-credential', 'allow-webauthn-get-assertion',
    'allow-list-bluetooth-devices', 'allow-get-location', 'allow-browser-open', 'allow-browser-activate', 'allow-browser-navigate',
    'allow-browser-close', 'allow-browser-hide-all', 'allow-browser-back', 'allow-browser-forward', 'allow-browser-reload',
  ],
};
const mutated = change => {
  const next = clone(conf);
  change(next);
  return configProblems(next, capabilities, appCommands).join('\n');
};
const capabilityProblems = change => {
  const next = clone(capabilities);
  change(next['default.json']);
  return configProblems(conf, next, appCommands).join('\n');
};

describe('desktop configuration', () => {
  it('passes for the committed tauri.conf.json and capability files', () => {
    assert.deepEqual(configProblems(conf, capabilities, appCommands), []);
  });

  it('rejects the pre-hardening configuration', () => {
    const problems = configProblems(preHardeningConf(), { 'default.json': preHardeningCapability }, appCommands).join('\n');
    assert.match(problems, /withGlobalTauri/);
    assert.match(problems, /challenges\.cloudflare\.com/);
    assert.match(problems, /hcaptcha\.com/);
    assert.match(problems, /localhost:8787/);
    assert.match(problems, /frame-src source https:\/\/\*\.privy\.com is not in the reviewed frame allowlist/);
    assert.match(problems, /beforeBuildCommand/);
    for (const command of DENIED_COMMANDS) assert.match(problems, new RegExp(`granted ${command}\\.`));
  });

  it('trips on each window, CSP and build invariant', () => {
    assert.match(mutated(next => { next.identifier = 'app.other.wallet'; }), /identifier/);
    assert.match(mutated(next => { next.app.windows[0].useHttpsScheme = false; }), /useHttpsScheme/);
    assert.match(mutated(next => { next.app.windows[0].label = 'other'; }), /labelled "main"/);
    assert.match(mutated(next => { next.app.windows.push({ label: 'second' }); }), /exactly one window/);
    assert.match(mutated(next => { next.app.withGlobalTauri = true; }), /withGlobalTauri must be false/);
    assert.match(mutated(next => { delete next.app.withGlobalTauri; }), /withGlobalTauri must be false/);
    assert.match(mutated(next => { next.app.security.dangerousDisableAssetCspModification = true; }), /dangerousDisableAssetCspModification/);
    assert.match(mutated(next => { next.app.security.capabilities = [{}]; }), /capabilities must stay empty/);
    assert.match(mutated(next => { next.build.frontendDist = '../build'; }), /frontendDist/);
    assert.match(mutated(next => { next.build.beforeBuildCommand = 'npm run build:app'; }), /beforeBuildCommand/);
  });

  it('trips on each CSP invariant, including in devCsp', () => {
    const csp = (from, to) => mutated(next => { next.app.security.csp = next.app.security.csp.replace(from, to); });
    assert.match(csp("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'"), /script-src must be exactly/);
    assert.match(csp("script-src 'self'", "script-src 'self' https://challenges.cloudflare.com"), /CAPTCHA host challenges\.cloudflare\.com/);
    assert.match(csp('https://auth.privy.io ', ''), /frame-src must include https:\/\/auth\.privy\.io/);
    assert.match(csp('frame-src https://auth.privy.io', 'frame-src https://auth.privy.io https://*.privy.com'), /https:\/\/\*\.privy\.com is not in the reviewed frame allowlist/);
    assert.match(csp('frame-src https://auth.privy.io', 'frame-src https://auth.privy.io https://*'), /https:\/\/\* is not in the reviewed frame allowlist/);
    assert.match(csp("'self' https: wss:", "'self' http://localhost:1420 https: wss:"), /local origin http:\/\/localhost:1420/);
    assert.match(csp("'self' https: wss:", "'self' http://[::1]:8787 https: wss:"), /local development API/);
    assert.match(csp("'self' https: wss:", "'self' http://rpc.example.com https: wss:"), /plain HTTP http:\/\/rpc\.example\.com/);
    assert.match(csp("object-src 'none'", "object-src 'self'"), /object-src must be exactly/);
    assert.match(mutated(next => { delete next.app.security.csp; }), /non-empty CSP string/);
    assert.match(mutated(next => { next.app.security.devCsp = `${next.app.security.csp}; frame-src https://challenges.cloudflare.com`; }), /devCsp still allows/);
  });

  it('trips on each capability invariant', () => {
    assert.match(configProblems(conf, { ...capabilities, 'legacy.json': {} }, appCommands).join('\n'), /only default\.json/);
    assert.match(capabilityProblems(main => { main.permissions.push({ identifier: 'allow-sign-hash' }); }), /granted sign_hash/);
    assert.match(capabilityProblems(main => { main.permissions.push({ identifier: 'core:default', allow: [{ cmd: 'reveal_mnemonic' }] }); }), /granted reveal_mnemonic/);
    assert.match(capabilityProblems(main => { main.webviews = ['main', 'ark-browser-1']; }), /"main" webview only/);
    assert.match(capabilityProblems(main => { main.windows = ['main']; }), /must not target windows/);
    assert.match(capabilityProblems(main => { main.remote = { urls: ['https://*'] }; }), /remote origins/);
  });

  it('withholds the same commands as the Rust ACL tests', () => {
    const rust = readFileSync(join(root, 'src-tauri/src/browser.rs'), 'utf8');
    const block = /const MAIN_DENIED: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1];
    assert.ok(block, 'MAIN_DENIED not found in src-tauri/src/browser.rs');
    assert.deepEqual([...block.matchAll(/"([a-z_]+)"/g)].map(match => match[1]).sort(), [...DENIED_COMMANDS].sort());
  });

  it('grants every vault-layer command to the main webview and nowhere else', () => {
    assert.deepEqual(layerGrantProblems(capabilities), []);
    // The legacy bridge takes any RP ID and origin from JavaScript: it stays withheld.
    for (const legacy of ['webauthn_make_credential', 'webauthn_get_assertion']) {
      assert.ok(DENIED_COMMANDS.includes(legacy), legacy);
      assert.ok(!LAYER_COMMANDS.includes(legacy), legacy);
      assert.match(capabilityProblems(main => { main.permissions.push(`allow-${legacy.replaceAll('_', '-')}`); }), new RegExp(`must not be granted ${legacy}\\.`));
    }
    for (const command of LAYER_COMMANDS) {
      const permission = `allow-${command.replaceAll('_', '-')}`;
      const missing = new RegExp(`must be granted the vault-layer command ${command} `);
      assert.match(capabilityProblems(main => { main.permissions = main.permissions.filter(entry => entry !== permission); }), missing);
      const beyond = new RegExp(`grants the vault-layer command ${command} beyond`);
      // Another capability file, for a browser child webview, as a string or as an allow rule.
      for (const entry of [permission, { identifier: 'core:default', allow: [{ cmd: command }] }]) {
        const extra = { identifier: 'browser', webviews: ['ark-browser-1'], permissions: [entry] };
        const problems = configProblems(conf, { ...capabilities, 'browser.json': extra }, appCommands).join('\n');
        assert.match(problems, beyond);
        assert.match(problems, /only default\.json/);
      }
      // The default capability widened past the main webview's own origin.
      assert.match(capabilityProblems(main => { main.webviews = ['main', 'ark-browser-1']; }), beyond);
      assert.match(capabilityProblems(main => { main.windows = ['main']; }), beyond);
      assert.match(capabilityProblems(main => { main.remote = { urls: ['https://auth.privy.io'] }; }), beyond);
    }
    // A capability that grants no layer command is not reported as a layer problem.
    assert.deepEqual(layerGrantProblems({ ...capabilities, 'other.json': { webviews: ['x'], permissions: ['allow-list-usb-devices'] } }), []);
  });

  it('reads the enrolled command list from build.rs', () => {
    assert.ok(Array.isArray(appCommands), 'build.rs command list not found');
    for (const command of [...LAYER_COMMANDS, ...DENIED_COMMANDS, 'get_location', 'browser_open']) assert.ok(appCommands.includes(command), command);
    assert.equal(buildCommands('fn main() {}'), null);
    assert.equal(buildCommands('.commands(&[])'), null);
    assert.equal(buildCommands(undefined), null);
  });

  it('fails closed on permission identifiers it cannot expand', () => {
    assert.deepEqual(permissionIdentifierProblems(capabilities, appCommands), []);
    // A custom set in src-tauri/permissions/*.toml bundling layer or withheld commands is not expanded: any
    // unrecognised app identifier is a problem, in the main capability or any other.
    for (const custom of ['vault-layers', 'allow-layer-everything', 'allow-sign-hash-and-more', 'default']) {
      assert.match(capabilityProblems(main => { main.permissions.push(custom); }), new RegExp(`unrecognised permission ${custom}\\.`));
      assert.match(capabilityProblems(main => { main.permissions.push({ identifier: custom }); }), new RegExp(`unrecognised permission ${custom}\\.`));
      const extra = { identifier: 'browser', webviews: ['ark-browser-1'], permissions: [custom] };
      assert.match(configProblems(conf, { ...capabilities, 'browser.json': extra }, appCommands).join('\n'), new RegExp(`browser\\.json grants the unrecognised permission ${custom}\\.`));
    }
    // Generated identifiers (allow and deny) and plugin permissions are recognised.
    assert.deepEqual(permissionIdentifierProblems({ 'default.json': { permissions: ['deny-sign-hash', 'allow-layer-location', 'core:window:allow-close', { identifier: 'opener:allow-open-url' }] } }, appCommands), []);
    assert.match(permissionIdentifierProblems({ 'default.json': { permissions: [{ allow: [{ cmd: 'x' }] }, ''] } }, appCommands).join('\n'), /without an identifier/);
    // Without the enrolled command list nothing can be recognised.
    for (const missing of [undefined, null, []]) {
      assert.match(permissionIdentifierProblems(capabilities, missing).join('\n'), /could not be read/);
      assert.match(configProblems(conf, capabilities, missing).join('\n'), /could not be read/);
    }
  });

  it('lists the same vault-layer commands as the Rust build, handler and ACL tests', () => {
    const expected = [...LAYER_COMMANDS].sort();
    const browser = readFileSync(join(root, 'src-tauri/src/browser.rs'), 'utf8');
    const block = /const LAYER_COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(browser)?.[1];
    assert.ok(block, 'LAYER_COMMANDS not found in src-tauri/src/browser.rs');
    assert.deepEqual([...block.matchAll(/"([a-z_]+)"/g)].map(match => match[1]).sort(), expected);
    const granted = /const MAIN_GRANTED: &\[&str\] = &\[([\s\S]*?)\];/.exec(browser)?.[1] ?? '';
    for (const command of LAYER_COMMANDS) assert.ok(granted.includes(`"${command}"`), `MAIN_GRANTED lacks ${command}`);
    const build = readFileSync(join(root, 'src-tauri/build.rs'), 'utf8');
    for (const command of LAYER_COMMANDS) assert.ok(build.includes(`"${command}"`), `build.rs does not enrol ${command}`);
    const handler = /generate_handler!\[([\s\S]*?)\]\)/.exec(readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8'))?.[1] ?? '';
    const registered = handler.split(',').map(name => name.trim().split('::').pop()).filter(Boolean);
    for (const command of LAYER_COMMANDS) assert.ok(registered.includes(command), `lib.rs does not register ${command}`);
  });

  it('runs from the command line without reading environment files', () => {
    const run = spawnSync(process.execPath, [join(root, 'scripts/check-desktop-build.mjs')], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^OK$/m);
  });
});

describe('API server and extension CSPs', () => {
  const serverSource = readFileSync(join(root, 'server/src/index.ts'), 'utf8');
  const serverCsp = /setHeader\("Content-Security-Policy", "([^"]+)"\)/.exec(serverSource)?.[1];
  const sorted = sources => [...(sources ?? [])].sort();

  it('API server frames and scripts match the desktop policy', () => {
    assert.ok(serverCsp, 'Content-Security-Policy header not found in server/src/index.ts');
    const server = parseCsp(serverCsp);
    const desktop = parseCsp(conf.app.security.csp);
    assert.deepEqual(sorted(server.get('frame-src')), sorted(REQUIRED_FRAMES));
    assert.deepEqual(server.get('script-src'), desktop.get('script-src'));
    assert.deepEqual(server.get('frame-ancestors'), ["'none'"]);
    assert.ok(!/challenges\.cloudflare\.com|hcaptcha\.com/i.test(serverCsp));
    assert.ok(!LOCAL_API.test(serverCsp));
  });

  it('extension frames stay within the desktop allowlist', () => {
    assert.deepEqual(sorted(parseCsp(EXTENSION_CSP).get('frame-src')), sorted(REQUIRED_FRAMES));
  });
});

describe('local API pattern', () => {
  it('matches every loopback and unspecified-address spelling of port 8787', () => {
    for (const text of ['http://localhost:8787', 'http://127.0.0.1:8787/api', 'http://[::1]:8787/api', 'http://0.0.0.0:8787', 'fetch("LOCALHOST:8787")', 'localhost:8787']) {
      assert.ok(LOCAL_API.test(text), text);
    }
  });
  it('ignores other ports and hosts', () => {
    for (const text of ['http://localhost:87870', 'http://localhost:1420', 'https://example.com:8787', 'http://xlocalhost:8787', 'http://10.0.0.0:8787']) {
      assert.ok(!LOCAL_API.test(text), text);
    }
  });
  it('is applied to CSP strings', () => {
    assert.match(cspProblems(conf.app.security.csp.replace("'self' https:", "'self' http://0.0.0.0:8787 https:")).join('\n'), /local development API/);
  });
});

describe('API base', () => {
  it('accepts the production origin', () => {
    const result = apiBaseProblems(PRODUCTION_API_BASE);
    assert.equal(result.origin, PRODUCTION_API_BASE);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(apiBaseProblems(`${PRODUCTION_API_BASE}/`).literals, [`${PRODUCTION_API_BASE}/`, PRODUCTION_API_BASE]);
  });

  it('rejects a non-production origin unless the staging opt-in is set', () => {
    for (const staging of ['https://antara-np9j.onrender.com', 'https://evil.example.com', 'https://www.antara.tech']) {
      const refused = apiBaseProblems(staging);
      assert.equal(refused.origin, null, staging);
      assert.match(refused.problems.join('\n'), /ANTARA_DESKTOP_STAGING=1/, staging);
      const allowed = apiBaseProblems(staging, { staging: true });
      assert.equal(allowed.origin, staging, staging);
      assert.deepEqual(allowed.problems, [], staging);
      assert.match(allowed.warnings.join('\n'), /staging only and must not be distributed/, staging);
    }
  });

  it('rejects unusable values even with the staging opt-in', () => {
    for (const bad of ['', '   ', 'http://antara.tech', 'http://localhost:8787', 'https://localhost:8787', 'https://127.0.0.1', 'https://[::1]', 'https://user:pw@antara.tech', 'https://antara.tech/api', 'https://antara.tech?x=1', 'https://antara.tech#x', 'https://api.local', 'notaurl', 'https://intranet']) {
      for (const staging of [false, true]) {
        const result = apiBaseProblems(bad, { staging });
        assert.ok(result.problems.length > 0, bad);
        assert.equal(result.origin, null, bad);
      }
    }
  });
});

describe('built frontend', () => {
  it('validates the packaged dist folder', () => {
    const dist = mkdtempSync(join(tmpdir(), 'antara-desktop-check-'));
    try {
      mkdirSync(join(dist, 'assets'));
      writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><script type="module" src="/assets/a.js"></script></head></html>');
      writeFileSync(join(dist, 'assets/a.js'), 'const e={VITE_API_BASE:"https://antara.tech"};');
      assert.deepEqual(distProblems(dist, [PRODUCTION_API_BASE]).problems, []);
      assert.match(distProblems(dist, ['https://staging.example.com']).problems.join('\n'), /does not contain the API origin/);

      for (const local of ['http://localhost:8787/api', 'http://[::1]:8787/api', 'http://0.0.0.0:8787']) {
        writeFileSync(join(dist, 'assets/b.js'), `fetch(${JSON.stringify(local)});`);
        assert.match(distProblems(dist, [PRODUCTION_API_BASE]).problems.join('\n'), /assets\/b\.js references the local development API/, local);
      }
      writeFileSync(join(dist, 'assets/b.js'), 'const k=import.meta.env.VITE_RELAY_API_KEY;');
      assert.match(distProblems(dist, [PRODUCTION_API_BASE]).problems.join('\n'), /VITE_RELAY_API_KEY/);
      writeFileSync(join(dist, '.env'), 'X=1');
      assert.match(distProblems(dist, [PRODUCTION_API_BASE]).problems.join('\n'), /Forbidden file in build: \.env/);

      writeFileSync(join(dist, 'index.html'), '<html><head><script type="module" src="/@vite/client"></script><style>body{}</style><script>alert(1)</script><script src="https://cdn.example.com/x.js"></script></head></html>');
      const page = distProblems(dist, []).problems.join('\n');
      assert.match(page, /development page/);
      assert.match(page, /inline <style>/);
      assert.match(page, /inline <script>/);
      assert.match(page, /remote script/);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
    assert.match(distProblems(dist, []).problems.join('\n'), /no index\.html/);
  });
});

describe('public environment', () => {
  it('reports variable names only, never values', () => {
    const result = envProblems({
      VITE_RELAY_API_KEY: 'sekret-value-123',
      VITE_SOLANA_RPC_URL: 'https://rpc.example.com/?api-key=abcdef123456',
      VITE_SOLANA_WS_URL: 'wss://rpc.example.com/?api-key=abcdef123456',
      VITE_API_BASE: PRODUCTION_API_BASE,
    });
    assert.match(result.problems.join('\n'), /VITE_RELAY_API_KEY/);
    assert.equal(result.warnings.length, 2);
    for (const line of [...result.problems, ...result.warnings]) {
      assert.ok(!line.includes('sekret'));
      assert.ok(!line.includes('abcdef'));
    }
  });
});
