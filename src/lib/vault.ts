import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isDemoMode, demoInvoke, hasTauriBridge } from "./demo";

// Thin typed wrapper over the Rust vault core. The seed/private keys live only
// in Rust; this layer only ever receives addresses and signatures.

// In demo mode OUTSIDE Tauri (plain browser) there is no Rust bridge, so route
// to the demo stub. Inside the Tauri app the real core runs even in demo mode.
// The desktop build withholds the keystore's signing, reveal and import commands
// (src-tauri/capabilities/default.json); Tauri's ACL refusal becomes a clear message.
export const LEGACY_COMMAND_DISABLED = "Local keystore signing, key reveal and import are disabled in this desktop build.";
const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  isDemoMode() && !hasTauriBridge()
    ? (demoInvoke(cmd, args) as Promise<T>)
    : tauriInvoke<T>(cmd, args).catch((error: unknown) => {
      if (/not allowed/i.test(String(error))) throw new Error(LEGACY_COMMAND_DISABLED);
      throw error;
    });

export interface Account {
  index: number;
  address: `0x${string}`;
}

export interface CreatedVault {
  mnemonic: string; // shown once for backup, then dropped from JS
  account: Account;
}

export const vaultExists = () => invoke<boolean>("vault_exists");

export const createVault = (password: string) =>
  invoke<CreatedVault>("create_vault", { password });

export const importVault = (password: string, mnemonic: string) =>
  invoke<Account>("import_vault", { password, mnemonic });

export const unlockVault = (password: string) =>
  invoke<Account[]>("unlock_vault", { password });

export const lockVault = () => invoke<void>("lock_vault");

export const listAccounts = () => invoke<Account[]>("list_accounts");

export const addAccount = () => invoke<Account>("add_account");

/** Import an external wallet (recovery phrase or 0x private key) as a standalone
 *  account. Re-authenticates with the password so the key can be sealed at rest. */
export const importAccount = (password: string, secret: string) =>
  invoke<Account>("import_account", { password, secret });

export const signHash = (index: number, hash: string) =>
  invoke<`0x${string}`>("sign_hash", { index, hash });

export const revealMnemonic = (password: string) =>
  invoke<string>("reveal_mnemonic", { password });

export const revealPrivateKey = (password: string, index: number) =>
  invoke<`0x${string}`>("reveal_private_key", { password, index });

// --- Stealth addresses (ERC-5564): private receiving --------------------------

export interface StealthMeta {
  spendPub: string; // compressed hex
  viewPub: string; // compressed hex
  meta: string; // st:<chain>:0x<spendPub><viewPub>
}

export interface StealthSend {
  stealthAddress: `0x${string}`;
  ephemeralPub: string;
  viewTag: number;
}

export interface StealthAnnouncement {
  ephemeralPub: string;
  viewTag?: number;
}

export interface StealthMatch {
  ephemeralPub: string;
  stealthAddress: `0x${string}`;
}

/** This account's stealth meta-address to share so others can pay it privately. */
export const stealthMetaAddress = (index: number, chain: string) =>
  invoke<StealthMeta>("stealth_meta_address", { index, chain });

/** Sender: derive a one-time stealth address + announcement for a recipient. */
export const stealthSendCompute = (spendPub: string, viewPub: string) =>
  invoke<StealthSend>("stealth_send_compute", { spendPub, viewPub });

/** Recipient: scan announcements; returns the ones that belong to this account. */
export const stealthScan = (
  index: number,
  announcements: StealthAnnouncement[]
) => invoke<StealthMatch[]>("stealth_scan", { index, announcements });

/** Recipient: sign a digest with a discovered payment's one-time key (to sweep). */
export const stealthSign = (index: number, ephemeralPub: string, hash: string) =>
  invoke<`0x${string}`>("stealth_sign", { index, ephemeralPub, hash });
