import { resolve } from "node:path";
import { readSecurityStore, writeSecurityStore } from "../solares/storage.js";
import type { Address, Hex } from "viem";
import type { PolicyConfig, FunctionRule } from "./policy.js";
import type { ChainId } from "./uniswap.js";

/**
 * Per-vault policy store. The layers a user enables at vault creation live HERE,
 * on the server, keyed by the vault address — NOT on the client. That's the
 * whole point: the co-signer loads the stored policy at spend time, so a tampered
 * client can't send an empty policy to bypass the rules it agreed to.
 */

// DATA_DIR lets the host point storage at a persistent disk (Render etc.);
// falls back to ./data for local dev.
const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), "data");
const FILE = resolve(DATA_DIR, "vault-policies.json");

type Store = Record<string, PolicyConfig>;

function key(chain: ChainId, safeAddress: Address): string {
  return `${chain}:${safeAddress.toLowerCase()}`;
}

function load(): Store {
  return readSecurityStore<Store>(FILE);
}

function persist(store: Store): void {
  writeSecurityStore(FILE, store);
}

/** Only persist the fields the policy engine understands (whitelist). */
export function sanitizePolicy(input: unknown): PolicyConfig {
  const b = (input ?? {}) as Record<string, unknown>;
  const cfg: PolicyConfig = {};
  if (b.requireGeo === true) cfg.requireGeo = true;
  if (b.requireWebauthn === true) cfg.requireWebauthn = true;
  if (b.requireUsbKey === true) cfg.requireUsbKey = true;
  if (typeof b.usbDeviceId === "string" && b.usbDeviceId) cfg.usbDeviceId = b.usbDeviceId;
  if (b.requireBluetooth === true) cfg.requireBluetooth = true;
  if (typeof b.bluetoothId === "string" && b.bluetoothId) cfg.bluetoothId = b.bluetoothId;
  if (typeof b.maxValueWei === "string" && /^\d+$/.test(b.maxValueWei))
    cfg.maxValueWei = b.maxValueWei;
  if (
    b.geofence &&
    typeof b.geofence === "object" &&
    typeof (b.geofence as any).lat === "number" &&
    typeof (b.geofence as any).lng === "number" &&
    typeof (b.geofence as any).radiusM === "number"
  ) {
    const g = b.geofence as any;
    cfg.geofence = { lat: g.lat, lng: g.lng, radiusM: g.radiusM };
  }
  if (Array.isArray(b.allowlist)) {
    const list = (b.allowlist as unknown[]).filter(
      (a): a is Address => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)
    );
    if (list.length) cfg.allowlist = list;
  }
  if (Array.isArray(b.functions)) {
    const fns = (b.functions as unknown[])
      .map(sanitizeFunctionRule)
      .filter((r): r is FunctionRule => r != null);
    if (fns.length) cfg.functions = fns;
  }
  return cfg;
}

/** Whitelist a single ARK per-function rule. Returns null if it is invalid. */
function sanitizeFunctionRule(input: unknown): FunctionRule | null {
  const b = (input ?? {}) as Record<string, unknown>;
  if (typeof b.selector !== "string" || !/^0x[0-9a-fA-F]{8}$/.test(b.selector)) return null;
  const r: FunctionRule = { selector: b.selector.toLowerCase() as Hex };
  if (typeof b.target === "string" && /^0x[0-9a-fA-F]{40}$/.test(b.target))
    r.target = b.target as Address;
  if (typeof b.label === "string" && b.label) r.label = b.label.slice(0, 48);
  if (b.requireGeo === true) r.requireGeo = true;
  if (b.requireWebauthn === true) r.requireWebauthn = true;
  if (b.requireUsbKey === true) r.requireUsbKey = true;
  if (typeof b.usbDeviceId === "string" && b.usbDeviceId) r.usbDeviceId = b.usbDeviceId;
  if (b.requireBluetooth === true) r.requireBluetooth = true;
  if (typeof b.bluetoothId === "string" && b.bluetoothId) r.bluetoothId = b.bluetoothId;
  if (
    typeof b.minVoiceConfidence === "number" &&
    b.minVoiceConfidence >= 0 &&
    b.minVoiceConfidence <= 1
  )
    r.minVoiceConfidence = b.minVoiceConfidence;
  if (typeof b.maxValueWei === "string" && /^\d+$/.test(b.maxValueWei))
    r.maxValueWei = b.maxValueWei;
  if (b.geofence && typeof b.geofence === "object") {
    const g = b.geofence as Record<string, unknown>;
    if (
      typeof g.lat === "number" &&
      typeof g.lng === "number" &&
      typeof g.radiusM === "number"
    )
      r.geofence = { lat: g.lat, lng: g.lng, radiusM: g.radiusM };
  }
  return r;
}

export function getPolicy(chain: ChainId, safeAddress: Address, required = false): PolicyConfig {
  const policy = load()[key(chain, safeAddress)];
  if (required && !policy) throw new Error("No stored policy for this vault; signing is disabled.");
  return policy ?? {};
}

export function setPolicy(
  chain: ChainId,
  safeAddress: Address,
  cfg: PolicyConfig
): void {
  const store = load();
  store[key(chain, safeAddress)] = cfg;
  persist(store);
}
