import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectRuntime, extensionSurface, openExternal, safeExternalUrl } from './index';
import { API_URL, PAIRED_GUARDIAN_SOLANA, PRIVY_APP_ID, PRIVY_CLIENT_ID, PUBLIC_ENV } from '../solares/wallet/config';
import { SUPPORTED_NETWORKS } from '../solares/networks';

const EXTENSION_ID = 'ckfkljfbjkmkjkkjkpbnmoehfipdcoin';
type Globals = { location?: unknown; chrome?: unknown; window?: unknown; isTauri?: unknown };
const globals = globalThis as Globals;

function withGlobals(values: Globals, run: () => Promise<void> | void) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const restore = () => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globals as Record<string, unknown>)[key];
    }
  };
  return Promise.resolve().then(run).finally(restore);
}

test('only plain http(s) links can leave the app', () => {
  assert.equal(safeExternalUrl('https://solscan.io/tx/abc'), 'https://solscan.io/tx/abc');
  assert.equal(safeExternalUrl('http://example.com/'), 'http://example.com/');
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///C:/x', 'chrome://settings', '/docs', '', 'https://user:pass@example.com/']) {
    assert.equal(safeExternalUrl(url), null, url);
  }
});

test('Node is detected as the web runtime with no extension surface', () => {
  assert.equal(detectRuntime(), 'web');
  assert.equal(extensionSurface(), null);
});

test('extension pages open links in a new browser tab, never in the wallet page', async () => {
  const created: Array<{ url: string; active?: boolean }> = [];
  const chrome = { runtime: { id: EXTENSION_ID }, tabs: { create: async (options: { url: string; active?: boolean }) => { created.push(options); } } };
  await withGlobals({ location: { protocol: 'chrome-extension:', host: EXTENSION_ID }, chrome }, async () => {
    assert.equal(detectRuntime(), 'extension');
    await openExternal('https://basescan.org/tx/0x1');
    await assert.rejects(openExternal('javascript:alert(1)'), /Only http\(s\) links/);
  });
  assert.deepEqual(created, [{ url: 'https://basescan.org/tx/0x1', active: true }]);
});

test('another extension or a look-alike origin is not treated as ANTARA', async () => {
  const chrome = { runtime: { id: EXTENSION_ID }, tabs: { create: async () => undefined } };
  await withGlobals({ location: { protocol: 'chrome-extension:', host: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, chrome }, () => {
    assert.equal(detectRuntime(), 'web');
  });
});

test('web pages open links without an opener relationship', async () => {
  const opened: unknown[][] = [];
  await withGlobals({ window: { open: (...args: unknown[]) => { opened.push(args); return null; } } }, async () => {
    await openExternal('https://etherscan.io/tx/0x2');
  });
  assert.deepEqual(opened, [['https://etherscan.io/tx/0x2', '_blank', 'noopener,noreferrer']]);
});

test('wallet config reads each public variable by name and never the whole import.meta.env', () => {
  const source = readFileSync(new URL('../solares/wallet/config.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // Every import.meta.env access names one VITE_ key; a bare object would inline every variable.
  const accesses = source.match(/import\.meta\.env\b(\??\.\w+)?/g) ?? [];
  assert.ok(accesses.length > 0);
  for (const access of accesses) assert.match(access, /^import\.meta\.env\.VITE_[A-Z0-9_]+$/, access);
  // Each network's browser RPC override is among the explicit keys.
  for (const network of SUPPORTED_NETWORKS) assert.ok(network.rpc.browserEnv in PUBLIC_ENV, network.rpc.browserEnv);
  for (const name of ['VITE_API_BASE', 'VITE_PRIVY_APP_ID', 'VITE_PRIVY_CLIENT_ID', 'VITE_ANTARA_GUARDIAN_SOLANA', 'VITE_SOLANA_CLUSTER', 'VITE_SOLANA_WS_URL']) assert.ok(name in PUBLIC_ENV, name);
  // Outside Vite nothing is configured: no API origin, Privy app, client or guardian pin.
  assert.deepEqual([API_URL, PRIVY_APP_ID, PRIVY_CLIENT_ID, PAIRED_GUARDIAN_SOLANA], ['', '', '', '']);
});
