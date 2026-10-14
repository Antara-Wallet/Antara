import { privateKeyToAccount } from "viem/accounts";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { COSIGNER_ADDRESS, COSIGNER_PRIVATE_KEY, hasCosigner } from "../config.js";
import { evaluatePolicy, type PolicyConfig, type PolicyContext, type PolicyResult } from "./policy.js";
import type { OwnerSignature } from "./safe.js";

/**
 * ARK co-signer = vault Member 2. The EVM port of ARGUS's backend co-signer:
 * it holds one stable key and signs a SafeTx hash ONLY after the policy engine
 * passes. Because the vault is 2-of-2, this key can never move funds on its own —
 * the user's master key must also sign. It also cannot initiate a transfer; it
 * only co-signs a SafeTx the user already built and signed.
 */

let account: ReturnType<typeof privateKeyToAccount> | null = null;

function cosigner() {
  if (!hasCosigner()) throw new Error("COSIGNER_PRIVATE_KEY not set");
  if (!account) account = privateKeyToAccount(COSIGNER_PRIVATE_KEY as Hex);
  return account;
}

/** The co-signer's owner address (vault Member 2). Used to build the 2-of-2. */
export function cosignerAddress(): Address {
  return cosigner().address;
}

/**
 * Co-signer address for read-only discovery. A configured public address must be
 * EIP-55 checksummed; an invalid one yields null rather than silently falling
 * back. `derive` returns null when this server holds no key (the key is then
 * never loaded); when it does hold one, the two must match, or discovery would
 * predict a vault the server cannot co-sign. Every rejection fails closed.
 */
export function resolveCosignerAddress(configured: string, derive: () => Address | null, warn: (problem: string) => void = () => {}): Address | null {
  const value = configured.trim();
  if (value && !(isAddress(value, { strict: true }) && getAddress(value) === value)) {
    warn("COSIGNER_ADDRESS is not an EIP-55 checksummed address");
    return null;
  }
  let derived: Address | null;
  try {
    derived = derive();
  } catch {
    warn("COSIGNER_PRIVATE_KEY is not a valid private key");
    return null;
  }
  if (!value) return derived;
  if (derived && getAddress(derived) !== value) {
    warn("COSIGNER_ADDRESS does not match COSIGNER_PRIVATE_KEY");
    return null;
  }
  // Checked above: a non-empty value is an EIP-55 address. Explicit, because the guard's narrowing does not
  // survive when this file is type-checked from the client project (src/solares/layers/endToEnd.test.ts).
  return value as Address;
}

// Both inputs are fixed at startup, so the result (and any warning) is computed once.
let publicAddress: { value: Address | null } | undefined;
export function publicCosignerAddress(): Address | null {
  publicAddress ??= {
    value: resolveCosignerAddress(COSIGNER_ADDRESS, () => (hasCosigner() ? cosignerAddress() : null), (problem) =>
      console.warn(`[cosigner] ${problem}; paired-vault discovery is unavailable.`)),
  };
  return publicAddress.value;
}

export interface CosignResult {
  ok: boolean;
  policy: PolicyResult;
  signature?: OwnerSignature; // present only when ok
}

/**
 * Evaluate the vault policy for a SafeTx; if every rule passes, co-sign its
 * EIP-712 hash and return the owner signature. The signature is a standard ECDSA
 * sig over the digest (v in {27,28}) — exactly what Safe's checkSignatures wants.
 */
export async function cosignSafeTx(
  safeTxHash: Hex,
  ctx: PolicyContext,
  cfg?: PolicyConfig
): Promise<CosignResult> {
  const policy = evaluatePolicy(ctx, cfg);
  if (!policy.ok) return { ok: false, policy };

  const acct = cosigner();
  const data = (await acct.sign({ hash: safeTxHash })) as Hex;
  return {
    ok: true,
    policy,
    signature: { signer: acct.address, data },
  };
}
