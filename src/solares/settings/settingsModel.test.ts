import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_SECTIONS, apiHostLabel, guardianLabel, networkRows, surfaceLabel, type NetworkRowInput } from './settingsModel';

const SOL = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const EVM = '0x1111111111111111111111111111111111111111';
const ALL = ['solana', 'ethereum', 'bsc', 'robinhood', 'base'] as const;
const base = (overrides: Partial<NetworkRowInput> = {}): NetworkRowInput => ({
  authenticated: true, ready: true, balances: ALL.map(chain => ({ chain })), balancesLoading: false, balancesError: null,
  addresses: { solana: SOL, ethereum: EVM }, cluster: 'mainnet-beta', ...overrides,
});
const labels = (input: NetworkRowInput) => networkRows(input).map(row => row.status.label);

describe('Settings sections', () => {
  it('follow the ARGUS S20 order adapted to ANTARA', () => {
    assert.deepEqual([...SETTINGS_SECTIONS], ['Account', 'Wallets', 'Address book', 'Security', 'Preferences', 'Networks', 'About']);
  });
});

describe('networkRows', () => {
  it('lists the five networks in registry order, Solana first, with the cluster and explorer only', () => {
    const rows = networkRows(base());
    assert.deepEqual(rows.map(row => row.name), ['Solana', 'Ethereum', 'BNB Smart Chain', 'Robinhood Chain', 'Base']);
    assert.equal(rows[0].cluster, 'mainnet-beta');
    assert.ok(rows.slice(1).every(row => row.cluster === null));
    assert.deepEqual(rows.map(row => row.explorer), ['Solscan', 'Etherscan', 'BscScan', 'Blockscout', 'Basescan']);
    assert.ok(rows.every(row => !/https?:|rpc/i.test(JSON.stringify(row))), 'no RPC URL is shown');
    assert.equal(networkRows(base({ cluster: 'devnet' }))[0].cluster, 'devnet');
  });

  it('reads "Balances loaded" only for networks with rows, and "Balances unavailable" for a failed one', () => {
    const rows = networkRows(base({ balances: ALL.filter(chain => chain !== 'base').map(chain => ({ chain })), balancesError: 'Live balances unavailable on Base. Check your RPC connections.' }));
    assert.deepEqual(rows.map(row => row.status.label), ['Balances loaded', 'Balances loaded', 'Balances loaded', 'Balances loaded', 'Balances unavailable']);
    assert.equal(rows[0].status.tone, 'ok');
    assert.equal(rows[4].status.tone, 'warn');
  });

  it('never says "unavailable" while loading or before the first read', () => {
    assert.deepEqual(labels(base({ balances: [], balancesLoading: true })), Array(5).fill('Loading…'));
    assert.deepEqual(labels(base({ balances: [] })), Array(5).fill('Loading…'));
    assert.deepEqual(labels(base({ ready: false, balances: [] })), Array(5).fill('Loading…'));
    // Rows loading again keep what is already known.
    assert.deepEqual(labels(base({ balancesLoading: true })), Array(5).fill('Balances loaded'));
  });

  it('asks a signed-out viewer to sign in, and names a missing wallet family', () => {
    assert.deepEqual(labels(base({ authenticated: false, balances: [] })), Array(5).fill('Sign in to load balances'));
    assert.deepEqual(labels(base({ addresses: { solana: null, ethereum: EVM }, balances: ALL.slice(1).map(chain => ({ chain })) })), ['No Solana wallet', 'Balances loaded', 'Balances loaded', 'Balances loaded', 'Balances loaded']);
    assert.deepEqual(labels(base({ addresses: { solana: SOL, ethereum: null }, balances: [{ chain: 'solana' }] })), ['Balances loaded', 'No EVM wallet', 'No EVM wallet', 'No EVM wallet', 'No EVM wallet']);
  });
});

describe('About facts', () => {
  it('names the surface from the runtime and the extension page', () => {
    assert.equal(surfaceLabel('tauri', null), 'Desktop app');
    assert.equal(surfaceLabel('extension', 'sidepanel'), 'Chrome extension · side panel');
    assert.equal(surfaceLabel('extension', 'tab'), 'Chrome extension · tab');
    assert.equal(surfaceLabel('extension', 'popup'), 'Chrome extension · popup');
    assert.equal(surfaceLabel('extension', null), 'Chrome extension');
    assert.equal(surfaceLabel('web', null), 'Web');
  });

  it('shows the API host, or "This site" for same-origin requests', () => {
    assert.equal(apiHostLabel(''), 'This site');
    assert.equal(apiHostLabel('  '), 'This site');
    assert.equal(apiHostLabel('https://api.antara.tech'), 'api.antara.tech');
    assert.equal(apiHostLabel('http://127.0.0.1:8787/'), '127.0.0.1:8787');
  });

  it('shortens a pinned guardian and never implies one when the build has none', () => {
    assert.equal(guardianLabel('GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'), 'GmaDrp…uAEGB');
    assert.equal(guardianLabel(''), 'Not set in this build');
  });
});
