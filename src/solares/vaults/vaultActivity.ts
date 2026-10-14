/**
 * Vault activity on this device (docs/UI_ARGUS_PARITY.md 8.5): deposits, releases and
 * activations started here, per Privy user. Public values only (addresses, amounts,
 * signatures); the chain stays authoritative and this list is a device-local record.
 *
 * Reading never throws: malformed rows are dropped, and unreadable or blocked storage
 * reads as an empty list. Writing replaces a record with the same id (a submitted
 * release that later confirms), keeps the newest 100, and dispatches
 * `solares:vault-activity` on window so Activity re-reads on the same page.
 */

export interface VaultActivityRecord {
  id: string;
  kind: 'deposit' | 'release' | 'activation';
  multisig: string;
  asset?: 'SOL' | 'USDC';
  /** A decimal amount as entered or confirmed, e.g. "0.25". */
  amount?: string;
  recipient?: string;
  /** Squads transaction index of a release. */
  index?: string;
  signature: string;
  status: 'confirmed' | 'submitted';
  createdAt: string;
}

export const VAULT_ACTIVITY_KEY = (privyUserId: string) => `solares.vault.activity.v1:${privyUserId}`;
export const VAULT_ACTIVITY_EVENT = 'solares:vault-activity';
export const VAULT_ACTIVITY_LIMIT = 100;

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const AMOUNT = /^\d{1,20}(?:\.\d{1,9})?$/;
const INDEX = /^\d{1,20}$/;
const ID = /^[A-Za-z0-9:_.-]{1,120}$/;
const KINDS = ['deposit', 'release', 'activation'] as const;

/** A record exactly as stored, or null when any field is missing, unexpected or malformed. */
export function parseVaultActivityRecord(value: unknown): VaultActivityRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const allowed = ['id', 'kind', 'multisig', 'asset', 'amount', 'recipient', 'index', 'signature', 'status', 'createdAt'];
  if (Object.keys(item).some(key => !allowed.includes(key))) return null;
  if (typeof item.id !== 'string' || !ID.test(item.id)) return null;
  if (typeof item.kind !== 'string' || !(KINDS as readonly string[]).includes(item.kind)) return null;
  if (typeof item.multisig !== 'string' || !ADDRESS.test(item.multisig)) return null;
  if (item.asset !== undefined && item.asset !== 'SOL' && item.asset !== 'USDC') return null;
  if (item.amount !== undefined && (typeof item.amount !== 'string' || !AMOUNT.test(item.amount))) return null;
  if (item.recipient !== undefined && (typeof item.recipient !== 'string' || !ADDRESS.test(item.recipient))) return null;
  if (item.index !== undefined && (typeof item.index !== 'string' || !INDEX.test(item.index))) return null;
  if (typeof item.signature !== 'string' || !SIGNATURE.test(item.signature)) return null;
  if (item.status !== 'confirmed' && item.status !== 'submitted') return null;
  if (typeof item.createdAt !== 'string' || item.createdAt.length > 40 || !Number.isFinite(Date.parse(item.createdAt))) return null;
  // A release names what moved and where; a deposit names what moved.
  if (item.kind === 'release' && (item.asset === undefined || item.amount === undefined || item.recipient === undefined || item.index === undefined)) return null;
  if (item.kind === 'deposit' && (item.asset === undefined || item.amount === undefined)) return null;
  return {
    id: item.id, kind: item.kind as VaultActivityRecord['kind'], multisig: item.multisig,
    ...(item.asset !== undefined ? { asset: item.asset as 'SOL' | 'USDC' } : {}),
    ...(item.amount !== undefined ? { amount: item.amount as string } : {}),
    ...(item.recipient !== undefined ? { recipient: item.recipient as string } : {}),
    ...(item.index !== undefined ? { index: item.index as string } : {}),
    signature: item.signature, status: item.status, createdAt: item.createdAt,
  };
}

const newestFirst = (a: VaultActivityRecord, b: VaultActivityRecord) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The stored rows; null when the stored value exists but is not a JSON array, or storage cannot be read. */
function readRaw(privyUserId: string): unknown[] | null {
  try {
    const stored = localStorage.getItem(VAULT_ACTIVITY_KEY(privyUserId));
    if (!stored) return [];
    const value = JSON.parse(stored) as unknown;
    return Array.isArray(value) ? value : null;
  } catch { return null; }
}

/** This user's vault records on this device, newest first, at most 100, malformed rows dropped. */
export function vaultActivity(privyUserId: string): VaultActivityRecord[] {
  if (!privyUserId) return [];
  const seen = new Set<string>();
  return (readRaw(privyUserId) ?? []).map(parseVaultActivityRecord)
    .filter((record): record is VaultActivityRecord => !!record && !seen.has(record.id) && !!seen.add(record.id))
    .sort(newestFirst).slice(0, VAULT_ACTIVITY_LIMIT);
}

/**
 * Saves one record for this user (replacing one with the same id) and dispatches `solares:vault-activity`.
 * A malformed record is refused with an error. Storage that cannot be read or written is left untouched
 * (an unreadable value is never overwritten), because the on-chain action already happened and the chain
 * remains the record.
 */
export function recordVaultActivity(privyUserId: string, record: VaultActivityRecord): void {
  if (!privyUserId) throw new Error('Sign in to record vault activity.');
  const parsed = parseVaultActivityRecord(record);
  if (!parsed) throw new Error('This vault activity record is malformed. Nothing was saved.');
  if (readRaw(privyUserId) === null) return;
  const next = [parsed, ...vaultActivity(privyUserId).filter(item => item.id !== parsed.id)].sort(newestFirst).slice(0, VAULT_ACTIVITY_LIMIT);
  try { localStorage.setItem(VAULT_ACTIVITY_KEY(privyUserId), JSON.stringify(next)); }
  catch { return; }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(VAULT_ACTIVITY_EVENT, { detail: { privyUserId, id: parsed.id } }));
  }
}
