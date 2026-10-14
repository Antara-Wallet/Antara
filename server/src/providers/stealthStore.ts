import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ChainId } from "./uniswap.js";

/**
 * Stealth-address announcement relay (ERC-5564). Senders post the ephemeral
 * public key + 1-byte view tag for a payment; recipients pull recent
 * announcements and scan them LOCALLY with their viewing key.
 *
 * This server is a dumb public relay — exactly the data an on-chain ERC-5564
 * Announcer would emit. It never learns who an announcement is for: only the
 * holder of the matching viewing key can link one to themselves. (A future
 * version can read these straight from the on-chain Announcer for full interop.)
 */

const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), "data");
const FILE = resolve(DATA_DIR, "stealth-announcements.json");

// Keep the most recent N. Announcements are tiny and only needed until every
// recipient has scanned past them.
const MAX = 20000;

export interface Announcement {
  id: number; // monotonic sequence, used as a scan cursor
  chain: ChainId;
  stealthAddress: string;
  ephemeralPub: string; // compressed secp256k1 pubkey, 0x + 66 hex
  viewTag: number; // 0..255
  ts: number;
}

interface Store {
  seq: number;
  items: Announcement[];
}

function load(): Store {
  try {
    if (!existsSync(FILE)) return { seq: 0, items: [] };
    return JSON.parse(readFileSync(FILE, "utf8")) as Store;
  } catch {
    return { seq: 0, items: [] };
  }
}

function persist(s: Store): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(s));
}

export function addAnnouncement(
  a: Pick<Announcement, "chain" | "stealthAddress" | "ephemeralPub" | "viewTag">
): Announcement {
  const s = load();
  const item: Announcement = { ...a, id: ++s.seq, ts: Date.now() };
  s.items.push(item);
  if (s.items.length > MAX) s.items = s.items.slice(-MAX);
  persist(s);
  return item;
}

/** Announcements for a chain newer than `since` (a prior cursor), oldest first. */
export function listAnnouncements(
  chain: ChainId,
  since = 0,
  limit = 1000
): { items: Announcement[]; cursor: number } {
  const s = load();
  const items = s.items
    .filter((a) => a.chain === chain && a.id > since)
    .slice(0, limit);
  const cursor = items.length ? items[items.length - 1].id : since;
  return { items, cursor };
}
