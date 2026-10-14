import { mnemonicToAccount } from "viem/accounts";
import type { Account } from "./vault";

// Display helpers + UI wallet shape. All key material lives in the Rust vault
// core (see lib/vault.ts); nothing here ever holds a seed or private key.

export function isValidMnemonic(phrase: string): boolean {
  try {
    mnemonicToAccount(phrase.trim());
    return true;
  } catch {
    return false;
  }
}

export function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export interface DerivedWallet {
  name: string;
  address: `0x${string}`;
  index: number;
}

// Imported (external) accounts get indices above this base in the Rust core, so
// we can label them distinctly from the HD-derived ones.
export const IMPORTED_BASE = 0x1000_0000;

export function walletName(index: number): string {
  if (index >= IMPORTED_BASE) return `Imported ${index - IMPORTED_BASE + 1}`;
  return index === 0 ? "Main Wallet" : `Wallet ${index + 1}`;
}

export function toWallets(accounts: Account[]): DerivedWallet[] {
  return accounts.map((a) => ({
    index: a.index,
    address: a.address,
    name: walletName(a.index),
  }));
}
