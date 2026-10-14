/**
 * Hash routes of the wallet shell (docs/UI_ARGUS_PARITY.md 5.4). Pure: no DOM access,
 * so the mapping is unit-tested (routes.test.ts).
 *
 * - Every hash is matched case-insensitively (`#VAULT` opens the Vault side, as
 *   `initialPage()` always did).
 * - Unknown and retired hashes (`#trenches`, `#agents`, `#browser`) land on Wallet.
 * - New hashes are letters only, so each one passes `isWalletRoute()` in
 *   src/platform/layers.ts unchanged (the side panel's "Open in full tab" and
 *   `openWalletTab()` carry only those).
 * - The internal page id stays "Portfolio" and its hash `#portfolio`; its visible
 *   label is "Wallet" everywhere (U1).
 */

export type Page = 'Portfolio' | 'Swap' | 'Activity' | 'Protection' | 'Settings';
export type AccountView = 'wallet' | 'vault';
/** A panel a route opens on top of its page: a sheet on the Wallet side, a focused panel on the Vault side, a Settings section. */
export type RoutePanel = 'receive' | 'send' | 'addressbook' | 'vaultdeposit' | 'vaultreceive' | 'vaultrelease' | 'vaultlayers';

export interface Route {
  page: Page;
  /** Which side of the Wallet screen. Only meaningful on 'Portfolio'. */
  view: AccountView;
  panel: RoutePanel | null;
}

/** Pages with their own hash that are primary destinations. Settings sits apart. */
export const NAV_PAGES: readonly Page[] = Object.freeze(['Portfolio', 'Swap', 'Activity', 'Protection']);

/**
 * A primary navigation destination. "Vault" is the Vault side of the Wallet screen
 * (page 'Portfolio', view 'vault', `#vault`), listed beside Wallet so the vault is one
 * click away; the Wallet/Vault pairing of the selected account is unchanged.
 */
export type NavItem = Page | 'Vault';
/** Sidebar and bottom tabs, in order: Wallet, Vault, Swap, Activity, Protection. */
export const NAV_ITEMS: readonly NavItem[] = Object.freeze(['Portfolio', 'Vault', 'Swap', 'Activity', 'Protection']);

/** The navigation item that is current for a page and Wallet-screen side. */
export function activeNavItem(page: Page, view: AccountView): NavItem {
  return page === 'Portfolio' && view === 'vault' ? 'Vault' : page;
}

/** The hash a navigation item writes ('#vault' for Vault). */
export function navHash(item: NavItem): `#${string}` {
  return item === 'Vault' ? viewHash('vault') : pageHash(item);
}

/** Hashes that once opened screens ANTARA no longer has. They land on Wallet. */
export const RETIRED_HASHES: readonly string[] = Object.freeze(['trenches', 'agents', 'browser']);

const ROUTES: Readonly<Record<string, Route>> = Object.freeze({
  // Existing hashes, unchanged.
  portfolio: { page: 'Portfolio', view: 'wallet', panel: null },
  wallet: { page: 'Portfolio', view: 'wallet', panel: null },
  overview: { page: 'Portfolio', view: 'wallet', panel: null },
  discover: { page: 'Portfolio', view: 'wallet', panel: null },
  tokens: { page: 'Portfolio', view: 'wallet', panel: null },
  vault: { page: 'Portfolio', view: 'vault', panel: null },
  vaults: { page: 'Portfolio', view: 'vault', panel: null },
  trade: { page: 'Swap', view: 'wallet', panel: null },
  swap: { page: 'Swap', view: 'wallet', panel: null },
  activity: { page: 'Activity', view: 'wallet', panel: null },
  protection: { page: 'Protection', view: 'wallet', panel: null },
  settings: { page: 'Settings', view: 'wallet', panel: null },
  // New in the parity build.
  receive: { page: 'Portfolio', view: 'wallet', panel: 'receive' },
  send: { page: 'Portfolio', view: 'wallet', panel: 'send' },
  addressbook: { page: 'Settings', view: 'wallet', panel: 'addressbook' },
  vaultdeposit: { page: 'Portfolio', view: 'vault', panel: 'vaultdeposit' },
  vaultreceive: { page: 'Portfolio', view: 'vault', panel: 'vaultreceive' },
  vaultrelease: { page: 'Portfolio', view: 'vault', panel: 'vaultrelease' },
  vaultlayers: { page: 'Portfolio', view: 'vault', panel: 'vaultlayers' },
});

/** Every hash the shell recognises, without '#'. */
export const ROUTE_HASHES: readonly string[] = Object.freeze(Object.keys(ROUTES));

const HOME: Route = Object.freeze({ page: 'Portfolio', view: 'wallet', panel: null });

/** Maps a location hash ('#vault', 'VAULT', '') to a route. Never throws; anything unknown is Wallet. */
export function parseRoute(hash: string): Route {
  const key = String(hash ?? '').replace(/^#/, '').trim().toLowerCase();
  const route = Object.prototype.hasOwnProperty.call(ROUTES, key) ? ROUTES[key] : HOME;
  return { ...route };
}

/** The hash a page is written to when the user navigates there ('#portfolio', '#swap', …). */
export function pageHash(page: Page): `#${string}` {
  return `#${page.toLowerCase()}`;
}

/** The hash for one side of the Wallet screen. */
export function viewHash(view: AccountView): `#${string}` {
  return view === 'vault' ? '#vault' : '#portfolio';
}

/**
 * The hash to leave in the address bar once a one-shot panel route has been opened,
 * so a reload does not reopen the sheet: `#receive` and `#send` settle on `#portfolio`.
 * Vault panels keep their hash (the vault screen reads it to focus that panel), and
 * so does `#addressbook` (Settings reads it to open that section).
 */
export function settledHash(route: Route): `#${string}` | null {
  return route.panel === 'receive' || route.panel === 'send' ? '#portfolio' : null;
}
