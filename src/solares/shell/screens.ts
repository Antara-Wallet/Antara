/**
 * The one wiring module between the shell and its screens (docs/UI_ARGUS_PARITY.md
 * section 9, "One wiring module"), switched to the section 8.1 screens by the
 * integration pass. Lazy slots stay lazy, keeping the code split and Suspense fallbacks.
 */
import { lazy } from 'react';

/** Send (6.8): Area B's four-step SendFlow. */
export const SendScreen = lazy(() => import('../transfers/SendFlow').then(module => ({ default: module.SendFlow })));
/** Swap (6.10): Area C's TradeWorkspace, prefilled from token detail. */
export const SwapScreen = lazy(() => import('../relay/TradeWorkspace').then(module => ({ default: module.TradeWorkspace })));
/** Wallet screen, Vault side (6.6): Area D's WalletVault. */
export const VaultScreen = lazy(() => import('../vaults/WalletVault').then(module => ({ default: module.WalletVault })));
/** Protection page (6.15): Area D's ProtectionScreen with the status planet; the home entry cards. */
export { ProtectionScreen, ProtectionOverview as ProtectionCards } from '../protection/ProtectionWorkspace';
/** Activity (6.11): Area E's ActivityScreen. */
export { ActivityScreen } from '../activity/ActivityScreen';
/** The Wallet home's Activity tab (8.4). */
export { useActivityItems } from '../activity/activityModel';
/** Settings (6.16): Area E's SettingsScreen. */
export { SettingsScreen } from '../settings/SettingsScreen';
/** Receive (6.7): Area B's two-step ReceiveSheet, wallet and vault sides. */
export { ReceiveSheet as ReceiveScreen } from '../receive/ReceiveSheet';
/** Address book (6.9): Area B's screen, inside Settings (`#addressbook`). */
export { AddressBookScreen } from '../addressbook/AddressBookScreen';
/** Vault summary (8.2): Area D's provider, mounted once by the shell. */
export { PairedVaultSummaryProvider, usePairedVaultSummary } from '../vaults/summary';
export type { PairedVaultSummary } from '../vaults/summary';
/** The account sheet offers "Address book": Settings now holds Area B's AddressBookScreen. */
export const ADDRESS_BOOK_AVAILABLE = true;
