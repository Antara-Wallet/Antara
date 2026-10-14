/**
 * ARK per-function policy tests.
 * Run: npx tsx src/providers/policy.ark.test.ts
 *
 * Verifies that function-selector rules TIGHTEN (never relax) the base policy,
 * so a vault that owns a contract can demand stricter layers on dangerous
 * admin functions (mint, upgrade) than on harmless ones (pause).
 */
import assert from "node:assert/strict";
import { evaluatePolicy, type PolicyConfig } from "./policy.js";

const hx = (s: string) => s as `0x${string}`;
const MINT = "0x40c10f19"; // mint(address,uint256)
const PAUSE = "0x8456cb59"; // pause()
const CONTRACT = hx("0x1111111111111111111111111111111111111111");

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log("  ok   -", name);
  } catch (e) {
    console.error("  FAIL -", name, "\n      ", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}

const base: PolicyConfig = {
  functions: [
    { selector: hx(MINT), label: "mint", requireWebauthn: true, requireGeo: true },
    { selector: hx(PAUSE), label: "pause", requireWebauthn: true },
  ],
};

test("unmatched selector falls back to base policy", () => {
  const r = evaluatePolicy({ to: CONTRACT, value: "0", data: hx("0xdeadbeef") }, base);
  assert.equal(r.ok, true);
});

test("mint with no factors is denied (rule adds webauthn + geo)", () => {
  const r = evaluatePolicy({ to: CONTRACT, value: "0", data: hx(MINT) }, base);
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.name === "function" && c.ok));
  assert.ok(r.checks.some((c) => c.name === "webauthn" && !c.ok));
});

test("mint with webauthn + geo passes", () => {
  const r = evaluatePolicy(
    {
      to: CONTRACT,
      value: "0",
      data: hx(MINT),
      factors: { webauthn: { verified: true }, geo: { lat: 1, lng: 2 } },
    },
    base
  );
  assert.equal(r.ok, true);
});

test("pause needs only webauthn, not geo", () => {
  const r = evaluatePolicy(
    { to: CONTRACT, value: "0", data: hx(PAUSE), factors: { webauthn: { verified: true } } },
    base
  );
  assert.equal(r.ok, true);
});

test("target-pinned rule beats selector-only rule", () => {
  const cfg: PolicyConfig = {
    functions: [
      { selector: hx(MINT), label: "mint-any", requireWebauthn: true },
      {
        selector: hx(MINT),
        target: CONTRACT,
        label: "mint-here",
        requireWebauthn: true,
        requireGeo: true,
      },
    ],
  };
  const r = evaluatePolicy(
    { to: CONTRACT, value: "0", data: hx(MINT), factors: { webauthn: { verified: true } } },
    cfg
  );
  assert.equal(r.ok, false); // pinned rule also needs geo
  assert.ok(r.checks.some((c) => c.name === "geo" && !c.ok));
});

test("a function rule cannot relax the base policy", () => {
  const cfg: PolicyConfig = {
    requireWebauthn: true,
    functions: [{ selector: hx(MINT), label: "mint", requireGeo: true }],
  };
  const geoOnly = evaluatePolicy(
    { to: CONTRACT, value: "0", data: hx(MINT), factors: { geo: { lat: 1, lng: 2 } } },
    cfg
  );
  assert.equal(geoOnly.ok, false); // base webauthn still required
  const both = evaluatePolicy(
    {
      to: CONTRACT,
      value: "0",
      data: hx(MINT),
      factors: { geo: { lat: 1, lng: 2 }, webauthn: { verified: true } },
    },
    cfg
  );
  assert.equal(both.ok, true);
});

test("maxValueWei tightens to the smaller of base and rule", () => {
  const cfg: PolicyConfig = {
    maxValueWei: "1000",
    functions: [{ selector: hx(MINT), label: "mint", maxValueWei: "10" }],
  };
  assert.equal(evaluatePolicy({ to: CONTRACT, value: "100", data: hx(MINT) }, cfg).ok, false);
  assert.equal(evaluatePolicy({ to: CONTRACT, value: "5", data: hx(MINT) }, cfg).ok, true);
});

console.log(`\n${passed} checks passed`);
