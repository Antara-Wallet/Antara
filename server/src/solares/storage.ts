import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Missing storage is initial setup. Corrupt or unreadable storage is an error,
 * never an empty policy/credential set that silently disables protection. */
export function readSecurityStore<T extends object>(file: string): T {
  if (!existsSync(file)) return {} as T;
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Security storage is invalid; restore a verified backup before continuing.');
  }
  return value as T;
}

/** Same-directory atomic replacement avoids half-written policies on restart. */
export function writeSecurityStore(file: string, value: object): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
