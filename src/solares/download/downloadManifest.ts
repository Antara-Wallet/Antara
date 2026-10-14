/**
 * The public download list (public/downloads/manifest.json, written by scripts/downloads-manifest.mjs).
 * The /download page offers a file only when its entry is complete and well formed: a same-origin
 * /downloads/ path with the right extension, a positive size and a SHA-256. Anything else, including
 * `available: false`, shows as "Coming soon" instead of a broken or unverifiable link.
 */
export const DOWNLOADS_MANIFEST_URL = '/downloads/manifest.json';

export type DownloadId = 'desktop-windows' | 'chrome-extension';

export interface DownloadEntry {
  id: DownloadId;
  name: string;
  file: string;
  fileName: string;
  size: number;
  sha256: string;
  version: string;
}

export interface DownloadManifest {
  version: string;
  files: Partial<Record<DownloadId, DownloadEntry>>;
}

const EXTENSIONS: Record<DownloadId, string> = { 'desktop-windows': '.exe', 'chrome-extension': '.zip' };
const FILE_PATH = /^\/downloads\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isDownloadId(value: unknown): value is DownloadId {
  return value === 'desktop-windows' || value === 'chrome-extension';
}

/** Validates one entry; returns null when it is unavailable or incomplete. */
export function parseDownloadEntry(value: unknown, fallbackVersion: string): DownloadEntry | null {
  if (!isRecord(value) || !isDownloadId(value.id) || value.available === false) return null;
  const { id, file, size, sha256 } = value;
  if (typeof file !== 'string') return null;
  const match = FILE_PATH.exec(file);
  if (!match || match[1].includes('..') || !match[1].toLowerCase().endsWith(EXTENSIONS[id])) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null;
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return null;
  const version = typeof value.version === 'string' && VERSION.test(value.version) ? value.version : fallbackVersion;
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 120) : match[1];
  return { id, name, file, fileName: match[1], size, sha256, version };
}

/** Parses manifest.json. Throws only when the document itself is not a download list. */
export function parseDownloadManifest(value: unknown): DownloadManifest {
  if (!isRecord(value) || !Array.isArray(value.files)) throw new Error('The download list is not in the expected format.');
  const version = typeof value.version === 'string' && VERSION.test(value.version) ? value.version : '';
  const files: DownloadManifest['files'] = {};
  for (const item of value.files) {
    const entry = parseDownloadEntry(item, version);
    if (entry && !files[entry.id]) files[entry.id] = entry;
  }
  return { version, files };
}

/** 23_456_789 -> "22.4 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
