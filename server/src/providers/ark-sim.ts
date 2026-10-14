/**
 * ARK simulation harness. Encodes REAL calldata for many different contract
 * types (ERC20/721/1155, Ownable, AccessControl, UUPS proxy, AMM, governor,
 * batchers) and runs each through the live policy engine, asserting the
 * co-signer would allow or deny it. Includes adversarial bypass attempts
 * (calls hidden inside multicall / multiSend, raw delegatecall).
 *
 * Run: npx tsx src/providers/ark-sim.ts
 */
import {
  encodeFunctionData,
  parseAbiItem,
  toFunctionSelector,
  type Hex,
  type Address,
} from "viem";
import { evaluatePolicy, type PolicyConfig, type FunctionRule, type PolicyFactors } from "./policy.js";

// ---- helpers ------------------------------------------------------------

const addr = (byte: string): Address => (`0x${byte.repeat(20)}`) as Address;
const TOKEN = addr("11");
const PROXY = addr("22");
const POOL = addr("44");
const GOVT = addr("55"); // a TimelockController the vault controls
const ATTACKER = addr("bb");
const KEY = "usb-key-1";
const ZERO32 = ("0x" + "00".repeat(32)) as Hex;
const ADMIN_ROLE = ZERO32; // DEFAULT_ADMIN_ROLE

const name = (sig: string) => sig.replace(/^function\s+/, "").split("(")[0];
const enc = (sig: string, args: unknown[] = []): Hex =>
  encodeFunctionData({ abi: [parseAbiItem(`function ${sig}`)], functionName: name(sig), args });
const sel = (sig: string): Hex => toFunctionSelector(`function ${sig}`);

const fr = (sig: string, label: string, reqs: Partial<FunctionRule>): FunctionRule => ({
  selector: sel(sig),
  label,
  ...reqs,
});

// multicall(bytes[]) — OZ Multicall / many tokens. Inner calls hit the same target.
const multicall = (inner: Hex[]): Hex =>
  encodeFunctionData({
    abi: [parseAbiItem("function multicall(bytes[] data)")],
    functionName: "multicall",
    args: [inner],
  });

// Safe multiSend(bytes) — packed (op,to,value,len,data) legs, possibly different targets/ops.
type Leg = { op: number; to: Address; value?: bigint; data: Hex };
const packLeg = (l: Leg): string => {
  const op = l.op.toString(16).padStart(2, "0");
  const to = l.to.slice(2).toLowerCase().padStart(40, "0");
  const value = (l.value ?? 0n).toString(16).padStart(64, "0");
  const d = (l.data ?? "0x").slice(2);
  const len = (d.length / 2).toString(16).padStart(64, "0");
  return op + to + value + len + d;
};
const multiSend = (legs: Leg[]): Hex =>
  encodeFunctionData({
    abi: [parseAbiItem("function multiSend(bytes transactions)")],
    functionName: "multiSend",
    args: [(`0x${legs.map(packLeg).join("")}`) as Hex],
  });

// TimelockController wrappers: the inner action runs from the timelock, so if the
// vault controls the timelock these must be gated by the inner selector too.
const tlExecute = (target: Address, payload: Hex): Hex =>
  enc("execute(address,uint256,bytes,bytes32,bytes32)", [target, 0n, payload, ZERO32, ZERO32]);
const tlExecuteBatch = (targets: Address[], payloads: Hex[]): Hex =>
  enc("executeBatch(address[],uint256[],bytes[],bytes32,bytes32)", [targets, targets.map(() => 0n), payloads, ZERO32, ZERO32]);
const tlSchedule = (target: Address, payload: Hex): Hex =>
  enc("schedule(address,uint256,bytes,bytes32,bytes32,uint256)", [target, 0n, payload, ZERO32, ZERO32, 0n]);

// Multicall3 aggregate3 — explicit per-call targets, a real cross-contract batcher.
const agg3 = (calls: { target: Address; data: Hex }[]): Hex =>
  encodeFunctionData({
    abi: [parseAbiItem("function aggregate3((address target,bool allowFailure,bytes callData)[] calls)")],
    functionName: "aggregate3",
    args: [calls.map((c) => ({ target: c.target, allowFailure: false, callData: c.data }))],
  });
// generic module/forwarder execute(address,uint256,bytes)
const exec3 = (target: Address, value: bigint, data: Hex): Hex =>
  enc("execute(address,uint256,bytes)", [target, value, data]);
// wrap `inner` in n layers of multicall, to probe the depth fail-closed boundary
const deepNest = (n: number, inner: Hex): Hex => {
  let d = inner;
  for (let k = 0; k < n; k++) d = multicall([d]);
  return d;
};
// a multiSend whose legs lie about their data length (parser must fail closed)
const multiSendBadLen = (legs: Leg[]): Hex =>
  encodeFunctionData({
    abi: [parseAbiItem("function multiSend(bytes transactions)")],
    functionName: "multiSend",
    args: [
      (`0x${legs
        .map((l) => {
          const op = l.op.toString(16).padStart(2, "0");
          const to = l.to.slice(2).toLowerCase().padStart(40, "0");
          const value = (l.value ?? 0n).toString(16).padStart(64, "0");
          const len = (9999).toString(16).padStart(64, "0"); // lie about the length
          const d = (l.data ?? "0x").slice(2);
          return op + to + value + len + d;
        })
        .join("")}`) as Hex,
    ],
  });

// ---- the policy under test (a token + upgradeable proxy + governance) ----

const POLICY: PolicyConfig = {
  functions: [
    fr("upgradeTo(address)", "upgrade", { requireWebauthn: true, requireGeo: true, requireUsbKey: true, usbDeviceId: KEY }),
    fr("upgradeToAndCall(address,bytes)", "upgrade", { requireWebauthn: true, requireGeo: true, requireUsbKey: true, usbDeviceId: KEY }),
    fr("mint(address,uint256)", "mint", { requireWebauthn: true, requireGeo: true }),
    fr("burn(uint256)", "burn", { requireWebauthn: true }),
    fr("transferOwnership(address)", "transferOwnership", { requireWebauthn: true, requireGeo: true, requireUsbKey: true, usbDeviceId: KEY }),
    fr("grantRole(bytes32,address)", "grantRole", { requireWebauthn: true, requireUsbKey: true, usbDeviceId: KEY }),
    fr("setFeeTo(address)", "setFeeTo", { requireWebauthn: true }),
    fr("pause()", "pause", { requireWebauthn: true }),
    fr("withdraw(uint256)", "withdraw", { requireWebauthn: true, requireGeo: true }),
    fr("setBaseURI(string)", "setBaseURI", { requireWebauthn: true }),
    fr("setPeer(uint32,bytes32)", "setPeer", { requireWebauthn: true, requireGeo: true }),
    fr("setPriceFeed(address,address)", "setPriceFeed", { requireWebauthn: true }),
  ],
};

const F: Record<string, PolicyFactors> = {
  none: {},
  face: { webauthn: { verified: true } },
  faceGeo: { webauthn: { verified: true }, geo: { lat: 1, lng: 2 } },
  full: { webauthn: { verified: true }, geo: { lat: 1, lng: 2 }, usb: { presentIds: [KEY] } },
};

// A 32-byte role id and some addresses for arg encoding.
const ROLE = (`0x${"00".repeat(31)}01`) as Hex;
const R = (b: string) => addr(b);

// ---- scenarios ----------------------------------------------------------

type Ctx = { to: Address; value: string; data: Hex; operation?: number; factors?: PolicyFactors };
type Case = [string, Ctx, boolean];

const C: Case[] = [
  // --- non-privileged calls: no rule, should always pass (any contract type) ---
  ["ERC20 transfer (not admin)", { to: TOKEN, value: "0", data: enc("transfer(address,uint256)", [R("cc"), 5n]) }, true],
  ["ERC20 approve (not admin)", { to: TOKEN, value: "0", data: enc("approve(address,uint256)", [R("cc"), 5n]) }, true],
  ["ERC721 setApprovalForAll (not admin)", { to: TOKEN, value: "0", data: enc("setApprovalForAll(address,bool)", [R("cc"), true]) }, true],
  ["ERC1155 safeTransferFrom (not admin)", { to: TOKEN, value: "0", data: enc("safeTransferFrom(address,address,uint256,uint256,bytes)", [R("aa"), R("cc"), 1n, 2n, "0x"]) }, true],
  ["unknown selector (random dApp)", { to: POOL, value: "0", data: "0xdeadbeef" }, true],
  ["plain ETH send (no calldata)", { to: R("cc"), value: "1000", data: "0x" }, true],

  // --- privileged calls, correct factors -> allow ---
  ["mint with face+geo", { to: TOKEN, value: "0", data: enc("mint(address,uint256)", [R("cc"), 100n]), factors: F.faceGeo }, true],
  ["pause with face", { to: TOKEN, value: "0", data: enc("pause()"), factors: F.face }, true],
  ["burn with face", { to: TOKEN, value: "0", data: enc("burn(uint256)", [5n]), factors: F.face }, true],
  ["setFeeTo with face", { to: POOL, value: "0", data: enc("setFeeTo(address)", [R("cc")]), factors: F.face }, true],
  ["withdraw with face+geo", { to: TOKEN, value: "0", data: enc("withdraw(uint256)", [5n]), factors: F.faceGeo }, true],
  ["upgradeTo with full factors", { to: PROXY, value: "0", data: enc("upgradeTo(address)", [R("cc")]), factors: F.full }, true],
  ["upgradeToAndCall with full", { to: PROXY, value: "0", data: enc("upgradeToAndCall(address,bytes)", [R("cc"), "0x"]), factors: F.full }, true],
  ["transferOwnership with full", { to: TOKEN, value: "0", data: enc("transferOwnership(address)", [R("cc")]), factors: F.full }, true],
  ["grantRole with face+usb", { to: TOKEN, value: "0", data: enc("grantRole(bytes32,address)", [ROLE, R("cc")]), factors: F.full }, true],
  ["setBaseURI with face", { to: TOKEN, value: "0", data: enc("setBaseURI(string)", ["ipfs://x"]), factors: F.face }, true],

  // --- privileged calls, missing factors -> deny (stolen key alone) ---
  ["mint with NO factors (stolen key)", { to: TOKEN, value: "0", data: enc("mint(address,uint256)", [ATTACKER, 10n ** 27n]), factors: F.none }, false],
  ["mint with face only (missing geo)", { to: TOKEN, value: "0", data: enc("mint(address,uint256)", [ATTACKER, 1n]), factors: F.face }, false],
  ["upgradeTo with face+geo (missing usb key)", { to: PROXY, value: "0", data: enc("upgradeTo(address)", [ATTACKER]), factors: F.faceGeo }, false],
  ["upgradeTo with NO factors", { to: PROXY, value: "0", data: enc("upgradeTo(address)", [ATTACKER]), factors: F.none }, false],
  ["transferOwnership with face only", { to: TOKEN, value: "0", data: enc("transferOwnership(address)", [ATTACKER]), factors: F.face }, false],
  ["grantRole with face only (missing usb)", { to: TOKEN, value: "0", data: enc("grantRole(bytes32,address)", [ROLE, ATTACKER]), factors: F.face }, false],
  ["pause with NO factors", { to: TOKEN, value: "0", data: enc("pause()"), factors: F.none }, false],
  ["withdraw with NO factors", { to: TOKEN, value: "0", data: enc("withdraw(uint256)", [10n ** 24n]), factors: F.none }, false],

  // --- ADVERSARIAL: hide a privileged call inside a batch ---
  ["multicall hiding upgradeTo, full factors", { to: PROXY, value: "0", data: multicall([enc("upgradeTo(address)", [ATTACKER])]), factors: F.full }, true],
  ["multicall hiding upgradeTo, face+geo (missing usb)", { to: PROXY, value: "0", data: multicall([enc("upgradeTo(address)", [ATTACKER])]), factors: F.faceGeo }, false],
  ["multicall hiding mint, NO factors", { to: TOKEN, value: "0", data: multicall([enc("mint(address,uint256)", [ATTACKER, 1n])]), factors: F.none }, false],
  ["multicall [transfer, mint], NO factors (mint must gate)", { to: TOKEN, value: "0", data: multicall([enc("transfer(address,uint256)", [R("cc"), 1n]), enc("mint(address,uint256)", [ATTACKER, 1n])]), factors: F.none }, false],
  ["nested multicall[multicall[upgradeTo]], full", { to: PROXY, value: "0", data: multicall([multicall([enc("upgradeTo(address)", [ATTACKER])])]), factors: F.full }, true],
  ["multiSend hiding mint, NO factors", { to: TOKEN, value: "0", data: multiSend([{ op: 0, to: TOKEN, data: enc("mint(address,uint256)", [ATTACKER, 1n]) }]), operation: 1, factors: F.none }, false],
  ["multiSend [pause+upgradeTo] needs BOTH (face only)", { to: PROXY, value: "0", data: multiSend([{ op: 0, to: TOKEN, data: enc("pause()") }, { op: 0, to: PROXY, data: enc("upgradeTo(address)", [ATTACKER]) }]), operation: 1, factors: F.face }, false],
  ["multiSend [pause+upgradeTo] with full factors", { to: PROXY, value: "0", data: multiSend([{ op: 0, to: TOKEN, data: enc("pause()") }, { op: 0, to: PROXY, data: enc("upgradeTo(address)", [ATTACKER]) }]), operation: 1, factors: F.full }, true],

  // --- ADVERSARIAL: raw delegatecall (vault takeover vector) ---
  ["raw delegatecall to attacker, full factors -> still DENY", { to: ATTACKER, value: "0", data: enc("anything()"), operation: 1, factors: F.full }, false],
  ["multiSend with an inner delegatecall leg -> DENY", { to: PROXY, value: "0", data: multiSend([{ op: 1, to: ATTACKER, data: enc("pwn()") }]), operation: 1, factors: F.full }, false],

  // --- more contract types (breadth) ---
  ["ERC4626 deposit (not admin)", { to: POOL, value: "0", data: enc("deposit(uint256,address)", [5n, R("cc")]) }, true],
  ["bridge setPeer with face+geo", { to: POOL, value: "0", data: enc("setPeer(uint32,bytes32)", [1, ROLE]), factors: F.faceGeo }, true],
  ["bridge setPeer with NO factors", { to: POOL, value: "0", data: enc("setPeer(uint32,bytes32)", [1, ROLE]), factors: F.none }, false],
  ["oracle setPriceFeed with face", { to: POOL, value: "0", data: enc("setPriceFeed(address,address)", [R("cc"), R("dd")]), factors: F.face }, true],

  // --- ADVERSARIAL: route a privileged call through a TimelockController the vault controls ---
  ["timelock execute hiding upgradeTo, full", { to: GOVT, value: "0", data: tlExecute(PROXY, enc("upgradeTo(address)", [ATTACKER])), factors: F.full }, true],
  ["timelock execute hiding upgradeTo, face+geo (missing usb)", { to: GOVT, value: "0", data: tlExecute(PROXY, enc("upgradeTo(address)", [ATTACKER])), factors: F.faceGeo }, false],
  ["timelock schedule hiding upgradeTo, NO factors", { to: GOVT, value: "0", data: tlSchedule(PROXY, enc("upgradeTo(address)", [ATTACKER])), factors: F.none }, false],
  ["timelock executeBatch [mint, upgrade], full (both gate)", { to: GOVT, value: "0", data: tlExecuteBatch([TOKEN, PROXY], [enc("mint(address,uint256)", [ATTACKER, 1n]), enc("upgradeTo(address)", [ATTACKER])]), factors: F.full }, true],
  ["timelock executeBatch [mint, upgrade], face+geo (missing usb)", { to: GOVT, value: "0", data: tlExecuteBatch([TOKEN, PROXY], [enc("mint(address,uint256)", [ATTACKER, 1n]), enc("upgradeTo(address)", [ATTACKER])]), factors: F.faceGeo }, false],

  // --- ADVERSARIAL: cross-wrapper nesting (batch -> timelock -> upgrade) ---
  ["multiSend -> timelock execute -> upgradeTo, full", { to: GOVT, value: "0", data: multiSend([{ op: 0, to: GOVT, data: tlExecute(PROXY, enc("upgradeTo(address)", [ATTACKER])) }]), operation: 1, factors: F.full }, true],
  ["multiSend -> timelock execute -> upgradeTo, face only", { to: GOVT, value: "0", data: multiSend([{ op: 0, to: GOVT, data: tlExecute(PROXY, enc("upgradeTo(address)", [ATTACKER])) }]), operation: 1, factors: F.face }, false],

  // --- privilege escalation: stolen key tries to grant itself admin ---
  ["escalation: grantRole(DEFAULT_ADMIN, attacker), NO factors", { to: TOKEN, value: "0", data: enc("grantRole(bytes32,address)", [ADMIN_ROLE, ATTACKER]), factors: F.none }, false],

  // --- FIXED BYPASSES (audit regression): the engine must now BLOCK these ---
  ["deep-nest(14) multicall hiding upgradeTo, full -> DENY (over-depth fails closed)", { to: PROXY, value: "0", data: deepNest(14, enc("upgradeTo(address)", [ATTACKER])), factors: F.full }, false],
  ["deep-nest(8) multicall hiding upgradeTo, face+geo (missing usb) -> DENY (decoded)", { to: PROXY, value: "0", data: deepNest(8, enc("upgradeTo(address)", [ATTACKER])), factors: F.faceGeo }, false],
  ["deep-nest(8) multicall hiding upgradeTo, full -> ALLOW (decoded + satisfied)", { to: PROXY, value: "0", data: deepNest(8, enc("upgradeTo(address)", [ATTACKER])), factors: F.full }, true],
  ["Multicall3 aggregate3 hiding upgradeTo, NO factors -> DENY", { to: POOL, value: "0", data: agg3([{ target: PROXY, data: enc("upgradeTo(address)", [ATTACKER]) }]), factors: F.none }, false],
  ["Multicall3 aggregate3 [mint, upgrade], full -> ALLOW", { to: POOL, value: "0", data: agg3([{ target: TOKEN, data: enc("mint(address,uint256)", [ATTACKER, 1n]) }, { target: PROXY, data: enc("upgradeTo(address)", [ATTACKER]) }]), factors: F.full }, true],
  ["generic execute() hiding upgradeTo, NO factors -> DENY", { to: POOL, value: "0", data: exec3(PROXY, 0n, enc("upgradeTo(address)", [ATTACKER])), factors: F.none }, false],
  ["execTransactionFromModule hiding mint, NO factors -> DENY", { to: POOL, value: "0", data: enc("execTransactionFromModule(address,uint256,bytes,uint8)", [TOKEN, 0n, enc("mint(address,uint256)", [ATTACKER, 1n]), 0]), factors: F.none }, false],
  ["truncated multiSend (lying length) -> DENY (fails closed)", { to: PROXY, value: "0", data: multiSendBadLen([{ op: 0, to: TOKEN, data: enc("mint(address,uint256)", [ATTACKER, 1n]) }]), operation: 1, factors: F.full }, false],
];

// ---- run ----------------------------------------------------------------

let pass = 0;
let fail = 0;
for (const [label, ctx, expect] of C) {
  let got: boolean;
  let detail = "";
  try {
    const r = evaluatePolicy(ctx, POLICY);
    got = r.ok;
    detail = r.checks.map((c) => c.name + (c.ok ? "" : "!")).join(",");
  } catch (e) {
    got = false;
    detail = "THREW " + (e instanceof Error ? e.message : String(e));
  }
  if (got === expect) {
    pass++;
    console.log(`  ok   - ${label}`);
  } else {
    fail++;
    console.log(`  FAIL - ${label}  (got ok=${got}, expected ${expect})  [${detail}]`);
  }
}

// ---- custom-policy cases: spend-limit + allowlist must see INNER batch legs ----
const VALCFG: PolicyConfig = { maxValueWei: (10n ** 18n).toString() }; // 1 ETH cap
const ALLOWCFG: PolicyConfig = { allowlist: [TOKEN, PROXY] };
const CV: [string, Ctx, PolicyConfig, boolean][] = [
  ["direct send over cap -> DENY", { to: ATTACKER, value: (100n * 10n ** 18n).toString(), data: "0x" }, VALCFG, false],
  ["direct send under cap -> ALLOW", { to: ATTACKER, value: (5n * 10n ** 17n).toString(), data: "0x" }, VALCFG, true],
  ["multiSend inner value 100 ETH exceeds 1 ETH cap -> DENY", { to: PROXY, value: "0", data: multiSend([{ op: 0, to: ATTACKER, value: 100n * 10n ** 18n, data: "0x" }]), operation: 1 }, VALCFG, false],
  ["multiSend two legs summing over cap -> DENY", { to: PROXY, value: "0", data: multiSend([{ op: 0, to: ATTACKER, value: 6n * 10n ** 17n, data: "0x" }, { op: 0, to: ATTACKER, value: 6n * 10n ** 17n, data: "0x" }]), operation: 1 }, VALCFG, false],
  ["multiSend inner value 0.5 ETH under cap -> ALLOW", { to: PROXY, value: "0", data: multiSend([{ op: 0, to: ATTACKER, value: 5n * 10n ** 17n, data: "0x" }]), operation: 1 }, VALCFG, true],
  ["multiSend inner target NOT in allowlist -> DENY", { to: PROXY, value: "0", data: multiSend([{ op: 0, to: ATTACKER, data: enc("transfer(address,uint256)", [ATTACKER, 1n]) }]), operation: 1 }, ALLOWCFG, false],
  ["multiSend inner target in allowlist -> ALLOW", { to: PROXY, value: "0", data: multiSend([{ op: 0, to: TOKEN, data: enc("transfer(address,uint256)", [ATTACKER, 1n]) }]), operation: 1 }, ALLOWCFG, true],
];
for (const [label, ctx, cfg, expect] of CV) {
  let got: boolean;
  let detail = "";
  try {
    const r = evaluatePolicy(ctx, cfg);
    got = r.ok;
    detail = r.checks.map((c) => c.name + (c.ok ? "" : "!")).join(",");
  } catch (e) {
    got = false;
    detail = "THREW " + (e instanceof Error ? e.message : String(e));
  }
  if (got === expect) {
    pass++;
    console.log(`  ok   - ${label}`);
  } else {
    fail++;
    console.log(`  FAIL - ${label}  (got ok=${got}, expected ${expect})  [${detail}]`);
  }
}

// ---- fuzz: random calldata must never crash the engine -------------------
let fuzzThrows = 0;
const rndHex = (bytes: number) => {
  let s = "0x";
  // deterministic-ish pseudo-random without Math.random (varies by index)
  for (let i = 0; i < bytes; i++) s += ((i * 37 + 13) & 0xff).toString(16).padStart(2, "0");
  return s as Hex;
};
for (let i = 0; i < 2000; i++) {
  const len = i % 50;
  try {
    evaluatePolicy(
      { to: TOKEN, value: String(i), data: rndHex(len), operation: i % 2, factors: F.face },
      POLICY
    );
  } catch {
    fuzzThrows++;
  }
}
console.log(`\n  fuzz: 2000 random calls, ${fuzzThrows} crashes`);

console.log(`\n${pass}/${pass + fail} scenarios passed, ${fail} failed, fuzz crashes ${fuzzThrows}`);
if (fail > 0 || fuzzThrows > 0) process.exitCode = 1;
