import { decodeFunctionData, parseAbiItem, toFunctionSelector, type Address, type Hex } from "viem";

/**
 * Vault policy engine — the EVM port of ARGUS's security layers. Before the ARK
 * co-signer (vault Member 2) signs a transaction, every enabled rule must pass.
 * This is what enforces "the vault rules are correctly satisfied" off-chain; an
 * on-chain Safe Guard can later enforce a hard subset (limits/allowlists) that
 * not even the co-signer can bypass.
 *
 * Factors mirror ARGUS: geo-fence, WebAuthn/biometric, USB hardware key,
 * Bluetooth proximity, voice. Each is OPTIONAL — a rule only blocks when it is
 * configured. Unconfigured rules pass, so a fresh vault works out of the box and
 * factors are tightened over time.
 */

export interface PolicyFactors {
  // Live device/location state captured on the client at spend time. The rules
  // (which device, which area) live in PolicyConfig server-side; these are just
  // the current readings the co-signer checks against. All optional.
  geo?: { lat: number; lng: number };
  webauthn?: { verified: boolean };
  usb?: { presentIds: string[] }; // ids of USB devices currently connected
  bluetooth?: { presentIds: string[] }; // ids of Bluetooth devices currently present
  voice?: { confidence: number };
}

export interface PolicyConfig {
  /** Max value (wei, as string) a single tx may move. Omit = no cap. */
  maxValueWei?: string;
  /** If set, recipient (`to`) must be in this allowlist. */
  allowlist?: Address[];
  /** Require a location to be supplied (Geo location layer). */
  requireGeo?: boolean;
  /** Circular geo-fence the spend must originate within (tighter than requireGeo). */
  geofence?: { lat: number; lng: number; radiusM: number };
  /** Require a passing WebAuthn/biometric assertion (Face ID layer). */
  requireWebauthn?: boolean;
  /** Require this specific USB device to be connected (id = VID:PID:serial). */
  requireUsbKey?: boolean;
  usbDeviceId?: string;
  /** Require this specific Bluetooth device to be present (id = address). */
  requireBluetooth?: boolean;
  bluetoothId?: string;
  /** Minimum voice-match confidence (0..1). Omit = no voice check. */
  minVoiceConfidence?: number;
  /**
   * ARK per-function rules. When this vault is the admin of another contract,
   * each privileged call can demand stricter layers based on the 4-byte function
   * selector (for example, `upgradeTo` requires every factor while `pause` needs
   * only a biometric). Rules only ADD requirements on top of the base policy
   * above; they can never relax it.
   */
  functions?: FunctionRule[];
}

/**
 * A per-function policy rule (ARK). Matched by 4-byte selector, optionally
 * pinned to a specific target contract. The factor fields mirror PolicyConfig
 * and are layered on top of the base policy for calls that match.
 */
export interface FunctionRule {
  /** 4-byte function selector, e.g. "0x40c10f19" for mint(address,uint256). */
  selector: Hex;
  /** Optional target contract. Omit = this selector on ANY contract the vault calls. */
  target?: Address;
  /** Human label for messages, e.g. "mint" or "upgradeTo". */
  label?: string;
  requireGeo?: boolean;
  geofence?: { lat: number; lng: number; radiusM: number };
  requireWebauthn?: boolean;
  requireUsbKey?: boolean;
  usbDeviceId?: string;
  requireBluetooth?: boolean;
  bluetoothId?: string;
  minVoiceConfidence?: number;
  maxValueWei?: string;
}

export interface PolicyContext {
  to: Address;
  value: string; // wei
  data: Hex;
  /** Safe operation: 0 = CALL (default), 1 = DELEGATECALL. */
  operation?: number;
  factors?: PolicyFactors;
}

export interface PolicyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PolicyResult {
  ok: boolean;
  checks: PolicyCheck[];
}

/** Haversine distance in meters between two lat/lng points. */
function haversineM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** The 4-byte selector of a calldata blob ("0x" + 8 hex), or null if absent. */
function selectorOf(data: Hex | undefined): Hex | null {
  if (!data || data.length < 10) return null;
  return data.slice(0, 10).toLowerCase() as Hex;
}

// Known wrapper functions whose calldata embeds inner calls. Decoding them lets
// per-function policy see a privileged call hidden inside a batch, a timelock, a
// Multicall3 aggregate, or a module/forwarder execute, instead of only the
// harmless-looking outer selector. Anything we recognize as a wrapper but cannot
// fully decode is treated as DANGEROUS (fail closed), never as a benign leaf.
const MAX_DEPTH = 12;
const MAX_LEAVES = 512;

const SEL_MULTICALL = toFunctionSelector("function multicall(bytes[])");
const SEL_MULTISEND = toFunctionSelector("function multiSend(bytes)");
const SEL_AGG = toFunctionSelector("function aggregate((address,bytes)[])");
const SEL_TRYAGG = toFunctionSelector("function tryAggregate(bool,(address,bytes)[])");
const SEL_AGG3 = toFunctionSelector("function aggregate3((address,bool,bytes)[])");
const SEL_AGG3VALUE = toFunctionSelector("function aggregate3Value((address,bool,uint256,bytes)[])");
const SEL_EXEC3 = toFunctionSelector("function execute(address,uint256,bytes)");
const SEL_EXEC_MODULE = toFunctionSelector("function execTransactionFromModule(address,uint256,bytes,uint8)");
const SEL_TL_EXECUTE = toFunctionSelector("function execute(address,uint256,bytes,bytes32,bytes32)");
const SEL_TL_EXECUTE_BATCH = toFunctionSelector("function executeBatch(address[],uint256[],bytes[],bytes32,bytes32)");
const SEL_TL_SCHEDULE = toFunctionSelector("function schedule(address,uint256,bytes,bytes32,bytes32,uint256)");
const SEL_TL_SCHEDULE_BATCH = toFunctionSelector("function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)");

const WRAPPER_SELECTORS = new Set<string>([
  SEL_MULTICALL, SEL_MULTISEND, SEL_AGG, SEL_TRYAGG, SEL_AGG3, SEL_AGG3VALUE,
  SEL_EXEC3, SEL_EXEC_MODULE, SEL_TL_EXECUTE, SEL_TL_EXECUTE_BATCH,
  SEL_TL_SCHEDULE, SEL_TL_SCHEDULE_BATCH,
]);

const ABI_MULTICALL = [parseAbiItem("function multicall(bytes[] data)")];
const ABI_MULTISEND = [parseAbiItem("function multiSend(bytes transactions)")];
const ABI_AGG = [parseAbiItem("function aggregate((address target,bytes callData)[] calls)")];
const ABI_TRYAGG = [parseAbiItem("function tryAggregate(bool requireSuccess,(address target,bytes callData)[] calls)")];
const ABI_AGG3 = [parseAbiItem("function aggregate3((address target,bool allowFailure,bytes callData)[] calls)")];
const ABI_AGG3VALUE = [parseAbiItem("function aggregate3Value((address target,bool allowFailure,uint256 value,bytes callData)[] calls)")];
const ABI_EXEC3 = [parseAbiItem("function execute(address target,uint256 value,bytes data)")];
const ABI_EXEC_MODULE = [parseAbiItem("function execTransactionFromModule(address to,uint256 value,bytes data,uint8 operation)")];
const ABI_TL_EXECUTE = [parseAbiItem("function execute(address target,uint256 value,bytes payload,bytes32 predecessor,bytes32 salt)")];
const ABI_TL_EXECUTE_BATCH = [parseAbiItem("function executeBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt)")];
const ABI_TL_SCHEDULE = [parseAbiItem("function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)")];
const ABI_TL_SCHEDULE_BATCH = [parseAbiItem("function scheduleBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt,uint256 delay)")];

interface CallLeaf {
  to: Address;
  selector: Hex;
  value: bigint;
  delegatecall?: boolean;
  danger?: string; // a recognized-but-unverifiable construct: hard deny
}

type Child = { to: Address; data: Hex; op: number; value: bigint };

/** Decode a Safe multiSend(bytes) blob into its packed legs (op, to, value, data).
 *  Throws on ANY length mismatch so the caller fails CLOSED. */
function decodeMultiSend(data: Hex): Child[] {
  const { args } = decodeFunctionData({ abi: ABI_MULTISEND, data });
  const packed = (args[0] as Hex).slice(2);
  const legs: Child[] = [];
  let i = 0;
  // each leg: op(1) + to(20) + value(32) + len(32) + data(len), in hex chars
  while (i < packed.length) {
    if (i + 170 > packed.length) throw new Error("multiSend: truncated leg header");
    const op = parseInt(packed.slice(i, i + 2), 16); i += 2;
    const to = (`0x${packed.slice(i, i + 40)}`) as Address; i += 40;
    const value = BigInt(`0x${packed.slice(i, i + 64)}`); i += 64;
    const len = parseInt(packed.slice(i, i + 64), 16); i += 64;
    if (i + len * 2 > packed.length) throw new Error("multiSend: truncated leg data");
    const d = (`0x${packed.slice(i, i + len * 2)}`) as Hex; i += len * 2;
    legs.push({ to, data: d, op, value });
  }
  return legs;
}

/** If `data` is a known wrapper, return the inner calls it embeds, else null.
 *  Throws if it IS a wrapper but cannot be decoded, so the caller fails closed. */
function decodeWrapper(sel: Hex, to: Address, data: Hex): Child[] | null {
  if (sel === SEL_MULTISEND) return decodeMultiSend(data);
  if (sel === SEL_MULTICALL) {
    const { args } = decodeFunctionData({ abi: ABI_MULTICALL, data });
    return (args[0] as Hex[]).map((d) => ({ to, data: d, op: 0, value: 0n }));
  }
  if (sel === SEL_AGG || sel === SEL_TRYAGG) {
    const { args } = decodeFunctionData({ abi: sel === SEL_AGG ? ABI_AGG : ABI_TRYAGG, data });
    const calls = (sel === SEL_AGG ? args[0] : args[1]) as { target: Address; callData: Hex }[];
    return calls.map((c) => ({ to: c.target, data: c.callData, op: 0, value: 0n }));
  }
  if (sel === SEL_AGG3) {
    const { args } = decodeFunctionData({ abi: ABI_AGG3, data });
    return (args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[]).map((c) => ({ to: c.target, data: c.callData, op: 0, value: 0n }));
  }
  if (sel === SEL_AGG3VALUE) {
    const { args } = decodeFunctionData({ abi: ABI_AGG3VALUE, data });
    return (args[0] as readonly { target: Address; allowFailure: boolean; value: bigint; callData: Hex }[]).map((c) => ({ to: c.target, data: c.callData, op: 0, value: c.value }));
  }
  if (sel === SEL_EXEC3) {
    const { args } = decodeFunctionData({ abi: ABI_EXEC3, data });
    return [{ to: args[0] as Address, value: args[1] as bigint, data: args[2] as Hex, op: 0 }];
  }
  if (sel === SEL_EXEC_MODULE) {
    const { args } = decodeFunctionData({ abi: ABI_EXEC_MODULE, data });
    return [{ to: args[0] as Address, value: args[1] as bigint, data: args[2] as Hex, op: Number(args[3]) }];
  }
  if (sel === SEL_TL_EXECUTE || sel === SEL_TL_SCHEDULE) {
    const { args } = decodeFunctionData({ abi: sel === SEL_TL_EXECUTE ? ABI_TL_EXECUTE : ABI_TL_SCHEDULE, data });
    return [{ to: args[0] as Address, value: args[1] as bigint, data: args[2] as Hex, op: 0 }];
  }
  if (sel === SEL_TL_EXECUTE_BATCH || sel === SEL_TL_SCHEDULE_BATCH) {
    const { args } = decodeFunctionData({ abi: sel === SEL_TL_EXECUTE_BATCH ? ABI_TL_EXECUTE_BATCH : ABI_TL_SCHEDULE_BATCH, data });
    const targets = args[0] as Address[];
    const values = args[1] as bigint[];
    const payloads = args[2] as Hex[];
    return targets.map((t, idx) => ({ to: t, value: values[idx] ?? 0n, data: payloads[idx] ?? ("0x" as Hex), op: 0 }));
  }
  return null;
}

/**
 * Flatten a call into its leaf calls, recursing through batch and timelock
 * wrappers (multicall, multiSend, TimelockController execute/schedule) so a
 * privileged call hidden inside one is still seen. A delegatecall to anything
 * other than a decodable multiSend is flagged dangerous: it runs arbitrary code
 * in the vault's own storage context and can rewrite its owners/modules/guard.
 */
function flattenCalls(
  to: Address,
  data: Hex,
  operation: number,
  value: bigint,
  depth: number,
  budget: { n: number }
): CallLeaf[] {
  const sel = selectorOf(data);
  // Raw delegatecall to anything but a decodable multiSend can rewrite the vault.
  if (operation === 1 && sel !== SEL_MULTISEND) {
    return [{ to, selector: sel ?? ("0x" as Hex), value, delegatecall: true }];
  }
  if (sel && WRAPPER_SELECTORS.has(sel)) {
    if (depth >= MAX_DEPTH) {
      return [{ to, selector: sel, value, danger: "wrapper nested too deep to verify" }];
    }
    let children: Child[] | null;
    try {
      children = decodeWrapper(sel, to, data);
    } catch {
      // It IS a known wrapper but we couldn't decode it -> never assume benign.
      return [{ to, selector: sel, value, danger: "batch wrapper could not be decoded" }];
    }
    if (children) {
      const out: CallLeaf[] = [];
      for (const c of children) {
        if (++budget.n > MAX_LEAVES) {
          out.push({ to: c.to, selector: selectorOf(c.data) ?? ("0x" as Hex), value: c.value, danger: "batch too large to verify" });
          return out;
        }
        out.push(...flattenCalls(c.to, c.data, c.op, c.value, depth + 1, budget));
      }
      return out;
    }
    return [{ to, selector: sel, value, danger: "unhandled wrapper" }];
  }
  // A leaf call, or a plain value transfer (no selector). Either way it counts
  // toward the spend limit and allowlist via this leaf's `to`/`value`.
  return [{ to, selector: sel ?? ("0x" as Hex), value }];
}

/** Pick the most specific ARK function rule for this (target, selector). */
function pickRule(cfg: PolicyConfig, to: Address, sel: Hex): FunctionRule | null {
  const rules = cfg.functions ?? [];
  const s = sel.toLowerCase();
  const t = to.toLowerCase();
  // A rule pinned to this exact target wins over a selector-only rule.
  const pinned = rules.find(
    (r) => r.selector.toLowerCase() === s && r.target?.toLowerCase() === t
  );
  if (pinned) return pinned;
  return rules.find((r) => r.selector.toLowerCase() === s && !r.target) ?? null;
}

/** Layer a function rule onto the base policy. Rules only TIGHTEN, never relax. */
function tighten(base: PolicyConfig, r: FunctionRule): PolicyConfig {
  const eff: PolicyConfig = { ...base };
  if (r.requireGeo) eff.requireGeo = true;
  if (r.geofence) eff.geofence = r.geofence;
  if (r.requireWebauthn) eff.requireWebauthn = true;
  if (r.requireUsbKey) {
    eff.requireUsbKey = true;
    if (r.usbDeviceId) eff.usbDeviceId = r.usbDeviceId;
  }
  if (r.requireBluetooth) {
    eff.requireBluetooth = true;
    if (r.bluetoothId) eff.bluetoothId = r.bluetoothId;
  }
  if (r.minVoiceConfidence != null) {
    eff.minVoiceConfidence = Math.max(base.minVoiceConfidence ?? 0, r.minVoiceConfidence);
  }
  if (r.maxValueWei != null) {
    eff.maxValueWei =
      base.maxValueWei != null && BigInt(base.maxValueWei) < BigInt(r.maxValueWei)
        ? base.maxValueWei
        : r.maxValueWei;
  }
  return eff;
}

export function evaluatePolicy(
  ctx: PolicyContext,
  cfg: PolicyConfig = {}
): PolicyResult {
  const checks: PolicyCheck[] = [];
  const f = ctx.factors ?? {};

  // ARK: flatten every batch/wrapper so a privileged call hidden inside one is
  // still gated, and HARD-DENY any construct we cannot verify (raw delegatecall,
  // over-deep nesting, an undecodable or oversized batch). Values and targets are
  // tracked PER LEAF so inner calls can't dodge the spend limit or allowlist.
  const outerValue = (() => {
    try {
      return BigInt(ctx.value);
    } catch {
      return 0n;
    }
  })();
  const leaves = flattenCalls(ctx.to, ctx.data, ctx.operation ?? 0, outerValue, 0, { n: 1 });

  const danger = leaves.find((l) => l.delegatecall || l.danger);
  if (danger) {
    checks.push({
      name: danger.delegatecall ? "delegatecall" : "structure",
      ok: false,
      detail: danger.delegatecall
        ? `raw delegatecall to ${danger.to} can rewrite the vault; blocked`
        : `${danger.danger}; blocked because the call cannot be verified safe`,
    });
    return { ok: false, checks };
  }

  // Every per-function rule any leaf triggers is unioned, so a batch is as strict
  // as its most dangerous part (and several dangerous parts stack).
  const matched: FunctionRule[] = [];
  for (const leaf of leaves) {
    if (leaf.selector === "0x") continue; // plain value transfer, no selector rule
    const r = pickRule(cfg, leaf.to, leaf.selector);
    if (r && !matched.includes(r)) matched.push(r);
  }
  let eff: PolicyConfig = cfg;
  for (const r of matched) eff = tighten(eff, r);
  if (matched.length) {
    checks.push({
      name: "function",
      ok: true,
      detail: `${matched.map((r) => r.label ?? r.selector).join(", ")}: stricter policy applied`,
    });
  }

  // --- On-chain-verifiable rules (also enforced by the on-chain Guard) ---
  if (eff.maxValueWei != null) {
    // Sum value across ALL leaves (outer call + every inner batch leg).
    const total = leaves.reduce((s, l) => s + l.value, 0n);
    const ok = total <= BigInt(eff.maxValueWei);
    checks.push({
      name: "spend-limit",
      ok,
      detail: ok ? "within limit" : `total ${total} wei exceeds max ${eff.maxValueWei} wei`,
    });
  }

  if (eff.allowlist && eff.allowlist.length > 0) {
    const set = new Set(eff.allowlist.map((a) => a.toLowerCase()));
    // EVERY leaf target must be allowed, not just the outer one.
    const bad = leaves.find((l) => !set.has(l.to.toLowerCase()));
    checks.push({
      name: "allowlist",
      ok: !bad,
      detail: bad ? `recipient ${bad.to} not in allowlist` : "all recipients allowed",
    });
  }

  // --- Off-chain factors (ARGUS parity) ---
  if (eff.geofence) {
    const ok =
      f.geo != null && haversineM(eff.geofence, f.geo) <= eff.geofence.radiusM;
    checks.push({
      name: "geo-fence",
      ok,
      detail: f.geo == null
        ? "no location provided"
        : ok
          ? "inside geo-fence"
          : "outside geo-fence",
    });
  } else if (eff.requireGeo) {
    const ok = f.geo != null;
    checks.push({
      name: "geo",
      ok,
      detail: ok ? `location ${f.geo!.lat},${f.geo!.lng}` : "no location provided",
    });
  }

  if (eff.requireWebauthn) {
    const ok = f.webauthn?.verified === true;
    checks.push({ name: "webauthn", ok, detail: ok ? "verified" : "not verified" });
  }

  if (eff.requireUsbKey) {
    const present = f.usb?.presentIds ?? [];
    const ok = eff.usbDeviceId != null && present.includes(eff.usbDeviceId);
    checks.push({
      name: "usb-key",
      ok,
      detail: eff.usbDeviceId == null
        ? "no device registered"
        : ok
          ? "registered device connected"
          : "registered device not connected",
    });
  }

  if (eff.requireBluetooth) {
    const present = f.bluetooth?.presentIds ?? [];
    const ok = eff.bluetoothId != null && present.includes(eff.bluetoothId);
    checks.push({
      name: "bluetooth",
      ok,
      detail: eff.bluetoothId == null
        ? "no device registered"
        : ok
          ? "registered device present"
          : "registered device not present",
    });
  }

  if (eff.minVoiceConfidence != null) {
    const conf = f.voice?.confidence ?? 0;
    const ok = conf >= eff.minVoiceConfidence;
    checks.push({
      name: "voice",
      ok,
      detail: ok ? `confidence ${conf}` : `confidence ${conf} < ${eff.minVoiceConfidence}`,
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
