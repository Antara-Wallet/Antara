/**
 * Area A parity scenarios: shell, navigation and the account sheet
 * (docs/UI_ARGUS_PARITY.md 6.1, 6.3, 10.3).
 */
import { expect } from '@playwright/test';
import type { ParityScenario, SurfaceId } from '../types';

const SHELL_SURFACES: readonly SurfaceId[] = ['desktop', 'mobile', 'panel-360', 'panel-420'];

export const entries: readonly ParityScenario[] = [
  {
    id: 'shell-nav',
    area: 'A',
    screen: '6.1',
    title: 'Shell after visiting every destination, back on Wallet: sidebar or bottom tabs, topbar, account pill',
    argus: ['argus-pwa-desktop-view-home.png', 'argus-pwa-mobile-sidebar-open.png', 'argus-ext-popup-01-main.png'],
    surfaces: SHELL_SURFACES,
    state: 'signed-in',
    steps: async ({ page, surface, click }) => {
      const nav = surface.narrow
        ? page.getByRole('navigation', { name: 'Mobile navigation' })
        : page.getByRole('complementary', { name: 'App navigation' });
      // "Wallet" everywhere since U1; "Portfolio" is kept only for the desktop before run.
      for (const names of [['Swap'], ['Activity'], ['Protection'], ['Wallet', 'Portfolio']]) {
        await click(names, { within: nav });
        const active = nav.locator('[aria-current="page"]');
        await expect(active).toHaveCount(1);
        expect(names).toContain(await active.getAttribute('aria-label'));
      }
    },
  },
  {
    id: 'account-sheet',
    area: 'A',
    screen: '6.3',
    title: 'Account sheet: Solana wallets first, then EVM, then account actions',
    argus: ['argus-ext-popup-03-address-dropdown.png', 'argus-ext-popup-04-sidebar.png', 'argus-ext-popup-41-vault-sim-address-dropdown.png', 'argus-pwa-desktop-view-wallets.png'],
    surfaces: SHELL_SURFACES,
    state: 'signed-in',
    steps: async ({ page, click, expectPresent }) => {
      await click(['Select wallet']);
      await expectPresent(page.getByRole('dialog'), 'account sheet');
    },
  },
  {
    id: 'account-sheet-signed-out',
    area: 'A',
    screen: '6.3',
    title: 'Account sheet while signed out: "Your ANTARA wallet" and Sign in',
    argus: ['argus-ext-popup-04-sidebar.png', 'argus-ext-popup-50-unlock.png'],
    surfaces: SHELL_SURFACES,
    state: 'signed-out',
    steps: async ({ page, click, expectPresent }) => {
      // Before the build the signed-out pill starts sign-in directly and no sheet opens ("not present before").
      await click(['Select wallet', 'Sign in to ANTARA']);
      await expectPresent(page.getByRole('dialog'), 'signed-out account sheet', 3_000);
    },
  },
  // The shared primitives themselves (4.4), so every run checks them against 10.4.
  {
    id: 'ui-primitives',
    area: 'A',
    screen: '4.4',
    title: 'Shared primitives: buttons, card, AddressText, StatusChip, Stepper, EmptyState, icons',
    argus: [],
    surfaces: ['desktop', 'mobile', 'panel-360'],
    path: '/tests/parity/ui.html',
  },
  {
    id: 'ui-sheet',
    area: 'A',
    screen: '4.4',
    title: 'Shared Sheet: centred dialog on desktop, bottom sheet when narrow, with the toast',
    argus: ['argus-pwa-desktop-modal-receive.png', 'argus-pwa-mobile-modal-receive.png'],
    surfaces: ['desktop', 'mobile', 'panel-360'],
    path: '/tests/parity/ui.html',
    params: { sheet: '1', toast: '1' },
  },
];
