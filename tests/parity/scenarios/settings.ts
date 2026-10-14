/**
 * Area E parity scenarios: Settings (docs/UI_ARGUS_PARITY.md 6.16, 10.3).
 *
 * Before the integration pass the shell still renders the legacy settings panel, so the
 * "after" run captures Area E's SettingsScreen on its own preview page (see
 * scenarios/activity.ts). Once shell/screens.ts points at settings/SettingsScreen, every
 * run uses the real shell harness again.
 */
import { PARITY_RUN, type ParityScenario } from '../types';
import { AREA_E_PREVIEW, wiredInShell } from './activity';

const PATH = PARITY_RUN === 'after' && !wiredInShell('settings/SettingsScreen') ? AREA_E_PREVIEW : undefined;
const SETTINGS_ARGUS = ['argus-pwa-desktop-view-settings.png', 'argus-ext-popup-08-settings-full.png', 'argus-pwa-mobile-view-settings.png'];

export const entries: readonly ParityScenario[] = [
  {
    id: 'settings-signed-out',
    area: 'E',
    screen: '6.16',
    title: 'Settings, signed out: Account sign-in, every section in ARGUS order with its signed-out line',
    argus: SETTINGS_ARGUS,
    path: PATH,
    state: 'signed-out',
    hash: 'settings',
  },
  {
    id: 'settings-signed-in',
    area: 'E',
    screen: '6.16',
    title: 'Settings, signed in: Account, Wallets, Address book, Security, Preferences, Networks, About',
    argus: SETTINGS_ARGUS,
    path: PATH,
    state: 'signed-in',
    hash: 'settings',
  },
  {
    id: 'settings-address-book',
    area: 'E',
    screen: '6.16',
    title: 'Settings › Address book as a narrow sub-page with Back (#addressbook)',
    argus: ['argus-ext-popup-12-address-book.png', 'argus-ext-popup-08-settings.png'],
    surfaces: ['mobile', 'panel-360'],
    path: PATH,
    state: 'signed-in',
    hash: 'addressbook',
    steps: async ({ page, expectPresent }) => {
      // The legacy shell has no #addressbook route and lands on the Wallet ("not present before").
      await expectPresent(page.getByRole('region', { name: 'Address book', exact: true }), 'Address book sub-page');
    },
  },
  {
    id: 'settings-existing-vaults',
    area: 'E',
    screen: '6.16',
    title: 'Settings › Security › "Manage existing": the embedded Safe/Squads workspace, ice primary',
    argus: ['argus-ext-popup-49-vault-sim-settings-full.png', 'argus-pwa-desktop-view-settings.png'],
    path: PATH,
    state: 'signed-in',
    hash: 'settings',
    steps: async ({ page, click, expectPresent }) => {
      await click(['Manage existing']);
      await expectPresent(page.getByRole('region', { name: 'Multisig vault workspace', exact: true }), 'Multisig vault workspace');
    },
  },
];
