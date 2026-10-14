import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byKey, rpcUrlFor, type EvmNetworkKey } from '../networks';
import { resolveEvmRpcUrls } from './evmRpc';

const resolver = (env: Record<string, string>) => (key: EvmNetworkKey) => rpcUrlFor(byKey(key), env, 'browser');

test('every supported EVM network resolves its pinned browser RPC or a valid public override, in registry order', () => {
  const pinned = resolveEvmRpcUrls(resolver({}));
  assert.equal(pinned.ok, true);
  assert.ok(pinned.ok);
  assert.deepEqual(pinned.urls.map(item => item.key), ['ethereum', 'bsc', 'robinhood', 'base']);
  assert.deepEqual(pinned.urls.map(item => item.url), ['ethereum', 'bsc', 'robinhood', 'base'].map(key => byKey(key as EvmNetworkKey).rpc.defaults[0]));
  const overridden = resolveEvmRpcUrls(resolver({ VITE_BSC_RPC_URL: 'https://bsc.example.test/rpc' }));
  assert.ok(overridden.ok);
  assert.equal(overridden.urls.find(item => item.key === 'bsc')?.url, 'https://bsc.example.test/rpc');
});

test('a malformed public RPC override is a visible configuration error, never a silent fallback to the default', () => {
  for (const value of ['not a url', 'ftp://bsc.example.test']) {
    const setup = resolveEvmRpcUrls(resolver({ VITE_BSC_RPC_URL: value }));
    assert.equal(setup.ok, false);
    assert.ok(!setup.ok);
    assert.match(setup.error, /^EVM RPC configuration is invalid\. VITE_BSC_RPC_URL /);
    assert.match(setup.error, /Sign-in stays disabled until it is fixed\.$/);
    // The configured value is never echoed back.
    assert.equal(setup.error.includes(value), false);
  }
});
