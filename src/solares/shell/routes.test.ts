import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWalletRoute } from '../../platform/layers';
import { NAV_ITEMS, NAV_PAGES, RETIRED_HASHES, ROUTE_HASHES, activeNavItem, navHash, pageHash, parseRoute, settledHash, viewHash, type Page } from './routes';

test('existing hashes open the same page as before', () => {
  const expected: Record<string, [Page, 'wallet' | 'vault']> = {
    '#portfolio': ['Portfolio', 'wallet'], '#wallet': ['Portfolio', 'wallet'], '#overview': ['Portfolio', 'wallet'],
    '#discover': ['Portfolio', 'wallet'], '#tokens': ['Portfolio', 'wallet'], '#vault': ['Portfolio', 'vault'],
    '#vaults': ['Portfolio', 'vault'], '#trade': ['Swap', 'wallet'], '#swap': ['Swap', 'wallet'],
    '#activity': ['Activity', 'wallet'], '#protection': ['Protection', 'wallet'], '#settings': ['Settings', 'wallet'],
  };
  for (const [hash, [page, view]] of Object.entries(expected)) {
    assert.deepEqual(parseRoute(hash), { page, view, panel: null }, hash);
  }
});

test('hashes match case-insensitively, with or without the leading #', () => {
  assert.deepEqual(parseRoute('#VAULT'), parseRoute('#vault'));
  assert.deepEqual(parseRoute('Vaults'), parseRoute('#vaults'));
  assert.deepEqual(parseRoute('#Wallet'), { page: 'Portfolio', view: 'wallet', panel: null });
  assert.deepEqual(parseRoute('#SeTtInGs'), { page: 'Settings', view: 'wallet', panel: null });
  assert.deepEqual(parseRoute('#VaultDeposit'), { page: 'Portfolio', view: 'vault', panel: 'vaultdeposit' });
});

test('retired, unknown and empty hashes land on Wallet', () => {
  for (const hash of [...RETIRED_HASHES.map(name => `#${name}`), '', '#', '#nope', '#vault-deposit', '#__proto__', '#constructor', '#toString']) {
    assert.deepEqual(parseRoute(hash), { page: 'Portfolio', view: 'wallet', panel: null }, hash);
  }
  assert.deepEqual([...RETIRED_HASHES], ['trenches', 'agents', 'browser']);
});

test('new hashes open their panel on the right page and side', () => {
  assert.deepEqual(parseRoute('#receive'), { page: 'Portfolio', view: 'wallet', panel: 'receive' });
  assert.deepEqual(parseRoute('#send'), { page: 'Portfolio', view: 'wallet', panel: 'send' });
  assert.deepEqual(parseRoute('#addressbook'), { page: 'Settings', view: 'wallet', panel: 'addressbook' });
  for (const panel of ['vaultdeposit', 'vaultreceive', 'vaultrelease', 'vaultlayers'] as const) {
    assert.deepEqual(parseRoute(`#${panel}`), { page: 'Portfolio', view: 'vault', panel });
  }
});

test('every route hash passes isWalletRoute unchanged (letters only, no hyphen)', () => {
  assert.ok(ROUTE_HASHES.length >= 19);
  for (const hash of ROUTE_HASHES) {
    assert.match(hash, /^[a-z]+$/, hash);
    assert.equal(isWalletRoute(`#${hash}`), true, hash);
  }
  for (const page of [...NAV_PAGES, 'Settings' as const]) assert.equal(isWalletRoute(pageHash(page)), true, page);
  assert.equal(isWalletRoute(viewHash('vault')), true);
});

test('page and view hashes keep the existing deep links', () => {
  assert.deepEqual(NAV_PAGES.map(pageHash), ['#portfolio', '#swap', '#activity', '#protection']);
  assert.equal(pageHash('Settings'), '#settings');
  assert.equal(viewHash('wallet'), '#portfolio');
  assert.equal(viewHash('vault'), '#vault');
  for (const page of [...NAV_PAGES, 'Settings' as const]) assert.equal(parseRoute(pageHash(page)).page, page);
});

test('only one-shot sheet routes settle on #portfolio; vault panels and the address book keep their hash', () => {
  assert.equal(settledHash(parseRoute('#receive')), '#portfolio');
  assert.equal(settledHash(parseRoute('#send')), '#portfolio');
  for (const hash of ['#vaultdeposit', '#vaultreceive', '#vaultrelease', '#vaultlayers', '#addressbook', '#vault', '#swap', '#portfolio']) {
    assert.equal(settledHash(parseRoute(hash)), null, hash);
  }
});

test('parseRoute returns a fresh object each time', () => {
  const route = parseRoute('#vault');
  route.view = 'wallet';
  assert.equal(parseRoute('#vault').view, 'vault');
});

test('primary navigation lists Wallet, Vault, Swap, Activity, Protection; Vault opens the Vault side', () => {
  assert.deepEqual([...NAV_ITEMS], ['Portfolio', 'Vault', 'Swap', 'Activity', 'Protection']);
  assert.deepEqual(NAV_ITEMS.map(navHash), ['#portfolio', '#vault', '#swap', '#activity', '#protection']);
  for (const item of NAV_ITEMS) assert.equal(isWalletRoute(navHash(item)), true, item);
  const vault = parseRoute(navHash('Vault'));
  assert.equal(vault.page, 'Portfolio');
  assert.equal(vault.view, 'vault');
  assert.equal(activeNavItem('Portfolio', 'vault'), 'Vault');
  assert.equal(activeNavItem('Portfolio', 'wallet'), 'Portfolio');
  assert.equal(activeNavItem('Swap', 'vault'), 'Swap');
});
