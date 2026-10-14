import { type Hex } from "viem";
import { signHash } from "./vault";
import { signAndBroadcast, waitForReceipt } from "./swap";
import { enrollPasskey, approveWithPasskey } from "./webauthn";
import { listUsbDevices, listBluetoothDevices, getLocation } from "./devices";
import {
  predictVault,
  buildVaultDeployment,
  getVaultDeployed,
  buildVaultTx,
  buildVaultExec,
  proposeVaultTx,
  confirmVaultTx,
  getVaultTx,
  getVaultSignatures,
  getCosigner,
  cosignVaultTx,
  getVaultPolicy,
  setVaultPolicy,
  buildSwap,
  type SwapChain,
  type SwapQuote,
  type VaultConfig,
  type PendingVaultTx,
  type PolicyFactors,
  type CosignResult,
  type VaultPolicyConfig,
} from "./api";

/**
 * Safe vault orchestration. Same trust model as swaps: protocol-kit (in the
 * backend) only ENCODES and HASHES — the private key never leaves Rust. We hand
 * the SafeTx EIP-712 hash to `signHash`, get back a 65-byte ECDSA signature
 * (v in {27,28}) which is exactly what Safe's `checkSignatures` expects for an
 * EOA owner, then broadcast the assembled tx from the owner EOA (which pays gas).
 *
 * Phase 1: 1-of-1 vault owned by the device key. The owner EOA both signs the
 * SafeTx and funds the deployment / execTransaction gas.
 */

export type VaultPhase =
  | "predicting"
  | "deploying"
  | "confirming"
  | "building"
  | "signing"
  | "executing"
  | "done"
  | "error";

export interface DeployResult {
  safeAddress: Hex;
  hash: Hex;
}

export interface VaultExecResult {
  safeTxHash: Hex;
  hash: Hex;
  status: "success" | "reverted";
}

/** Deterministic Safe address for a 1-of-1 vault owned by `owner`. */
export async function predictVaultAddress(
  chain: SwapChain,
  owner: Hex,
  saltNonce?: string
): Promise<Hex> {
  const { address } = await predictVault({
    chain,
    owners: [owner],
    threshold: 1,
    saltNonce,
  });
  return address;
}

/** Deterministic Safe address for an arbitrary owner set + threshold. */
export async function predictMultiVaultAddress(
  chain: SwapChain,
  owners: Hex[],
  threshold: number,
  saltNonce?: string
): Promise<Hex> {
  const { address } = await predictVault({ chain, owners, threshold, saltNonce });
  return address;
}

export async function isVaultDeployed(chain: SwapChain, safeAddress: Hex): Promise<boolean> {
  const { deployed } = await getVaultDeployed(chain, safeAddress);
  return deployed;
}

/**
 * Deploy the 1-of-1 Safe. The owner EOA (accountIndex) signs + broadcasts the
 * one-time deployment tx and pays the gas.
 */
export async function createVaultOnChain(
  opts: {
    chain: SwapChain;
    accountIndex: number;
    owner: Hex; // owner EOA = device account at accountIndex (signs + pays gas)
    owners?: Hex[]; // full owner set (defaults to [owner]); must include `owner`
    threshold?: number; // defaults to 1
    saltNonce?: string;
  },
  onPhase?: (phase: VaultPhase) => void
): Promise<DeployResult> {
  const { chain, accountIndex, owner, saltNonce } = opts;
  const owners = opts.owners ?? [owner];
  const threshold = opts.threshold ?? 1;
  const phase = (p: VaultPhase) => onPhase?.(p);
  const cfg: VaultConfig = { chain, owners, threshold, saltNonce };

  try {
    phase("deploying");
    const deploy = await buildVaultDeployment(cfg);
    const hash = await signAndBroadcast(
      chain,
      accountIndex,
      owner,
      deploy.to,
      BigInt(deploy.value),
      deploy.data
    );
    phase("confirming");
    const status = await waitForReceipt(chain, hash);
    if (status !== "success") {
      phase("error");
      throw new Error("vault deployment reverted");
    }
    phase("done");
    return { safeAddress: deploy.safeAddress, hash };
  } catch (e) {
    phase("error");
    throw e;
  }
}

/**
 * Send a transaction FROM the vault. Builds a SafeTx, signs its EIP-712 hash in
 * Rust, encodes `execTransaction`, then the owner EOA signs + broadcasts the
 * outer call (and pays gas). For a 1-of-1 vault one owner signature suffices.
 */
export async function sendFromVault(
  opts: {
    chain: SwapChain;
    accountIndex: number;
    owner: Hex; // owner EOA = signer + gas payer
    safeAddress: Hex;
    to: Hex;
    value: string; // raw smallest unit
    data?: Hex;
    operation?: number;
  },
  onPhase?: (phase: VaultPhase) => void
): Promise<VaultExecResult> {
  const { chain, accountIndex, owner, safeAddress, to, value } = opts;
  const data = opts.data ?? "0x";
  const phase = (p: VaultPhase) => onPhase?.(p);

  try {
    phase("building");
    const { safeTxHash, safeTxData } = await buildVaultTx({
      chain,
      safeAddress,
      to,
      value,
      data,
      operation: opts.operation ?? 0,
    });

    phase("signing");
    const signature = await signHash(accountIndex, safeTxHash);

    phase("executing");
    const exec = await buildVaultExec({
      chain,
      safeAddress,
      safeTxData,
      signatures: [{ signer: owner, data: signature }],
    });
    const hash = await signAndBroadcast(
      chain,
      accountIndex,
      owner,
      exec.to,
      BigInt(exec.value),
      exec.data
    );

    phase("confirming");
    const status = await waitForReceipt(chain, hash);
    phase(status === "success" ? "done" : "error");
    return { safeTxHash, hash, status };
  } catch (e) {
    phase("error");
    throw e;
  }
}

/* ---------- Multi-owner coordination (Safe Transaction Service) ---------- */

/**
 * Phase 2 flow. For a threshold > 1 vault, no single owner can execute alone.
 * The device builds the SafeTx, signs its EIP-712 hash in Rust, and PROPOSES it
 * to the off-chain Transaction Service with its signature as the first
 * confirmation. Other owners (the FIDO2 co-signer) later confirm. Returns the
 * safeTxHash so the UI can poll for confirmations.
 */
export async function proposeVaultTransfer(opts: {
  chain: SwapChain;
  accountIndex: number;
  owner: Hex; // device owner EOA = proposer
  safeAddress: Hex;
  to: Hex;
  value: string; // raw smallest unit
  data?: Hex;
  operation?: number;
}): Promise<{ safeTxHash: Hex }> {
  const { chain, accountIndex, owner, safeAddress, to, value } = opts;
  const data = opts.data ?? "0x";
  const { safeTxHash, safeTxData } = await buildVaultTx({
    chain,
    safeAddress,
    to,
    value,
    data,
    operation: opts.operation ?? 0,
  });
  const signature = await signHash(accountIndex, safeTxHash);
  await proposeVaultTx({
    chain,
    safeAddress,
    safeTxHash,
    safeTxData,
    proposer: { signer: owner, data: signature },
  });
  return { safeTxHash };
}

/**
 * Add a device owner's confirmation to an already-proposed SafeTx. The signer is
 * a different device account (index) that is also an owner of the vault — the
 * same code path the FIDO2 co-signer will take, but with a Rust ECDSA signature.
 */
export async function confirmVaultTransfer(opts: {
  chain: SwapChain;
  accountIndex: number; // the confirming owner's device account
  safeTxHash: Hex;
}): Promise<void> {
  const { chain, accountIndex, safeTxHash } = opts;
  const signature = await signHash(accountIndex, safeTxHash);
  await confirmVaultTx({ chain, safeTxHash, signature });
}

/** Current confirmation state of a proposed SafeTx. */
export async function getVaultTransfer(
  chain: SwapChain,
  safeTxHash: Hex
): Promise<PendingVaultTx> {
  return getVaultTx(chain, safeTxHash);
}

/**
 * Once a proposed SafeTx has reached its threshold, gather the signatures from
 * the service, encode `execTransaction`, and have an owner EOA sign + broadcast
 * the outer call (and pay gas). Any owner can execute.
 */
export async function executeReadyVaultTx(
  opts: {
    chain: SwapChain;
    accountIndex: number; // owner EOA that broadcasts + pays gas
    owner: Hex;
    safeAddress: Hex;
    safeTxHash: Hex;
  },
  onPhase?: (phase: VaultPhase) => void
): Promise<VaultExecResult> {
  const { chain, accountIndex, owner, safeAddress, safeTxHash } = opts;
  const phase = (p: VaultPhase) => onPhase?.(p);
  try {
    phase("building");
    const [{ signatures }, tx] = await Promise.all([
      getVaultSignatures(chain, safeTxHash),
      getVaultTx(chain, safeTxHash),
    ]);
    if (!tx.isReady) throw new Error("not enough confirmations yet");

    phase("executing");
    // Recreate the EXACT SafeTx from the service's canonical fields so the hash
    // (and therefore the gathered signatures) stay valid for checkSignatures.
    const exec = await buildVaultExec({
      chain,
      safeAddress,
      safeTxData: {
        to: tx.to,
        value: tx.value,
        data: tx.data,
        operation: tx.operation,
        safeTxGas: tx.safeTxGas,
        baseGas: tx.baseGas,
        gasPrice: tx.gasPrice,
        gasToken: tx.gasToken,
        refundReceiver: tx.refundReceiver,
        nonce: tx.nonce,
      },
      signatures,
    });
    const hash = await signAndBroadcast(
      chain,
      accountIndex,
      owner,
      exec.to,
      BigInt(exec.value),
      exec.data
    );

    phase("confirming");
    const status = await waitForReceipt(chain, hash);
    phase(status === "success" ? "done" : "error");
    return { safeTxHash, hash, status };
  } catch (e) {
    phase("error");
    throw e;
  }
}

/* ---------- ARK co-signer vault (ARGUS-style 2-of-2 policy vault) ---------- */

/**
 * The vault model that mirrors ARGUS: a Safe 2-of-2 owned by
 * [your master wallet, the ARK co-signer]. The co-signer (Member 2) only signs
 * once the policy engine passes, so funds move only when BOTH your key signs AND
 * the rules are satisfied. One wallet → one vault.
 */

/** The ARK co-signer's owner address (Member 2), or null if not configured. */
export async function getVaultCosigner(): Promise<Hex | null> {
  const { enabled, address } = await getCosigner();
  return enabled && address ? address : null;
}

/** The four security layers a user can toggle on a vault (ARGUS parity). */
export interface VaultLayers {
  faceId: boolean; // WebAuthn / Windows Hello / Touch ID
  bluetooth: boolean; // registered Bluetooth device nearby
  usb: boolean; // registered USB security key present
  geo: boolean; // location supplied (geo-fence)
}

export function layersToConfig(l: VaultLayers): VaultPolicyConfig {
  return {
    requireWebauthn: l.faceId,
    requireBluetooth: l.bluetooth,
    requireUsbKey: l.usb,
    requireGeo: l.geo,
  };
}

export function configToLayers(c: VaultPolicyConfig): VaultLayers {
  return {
    faceId: !!c.requireWebauthn,
    bluetooth: !!c.requireBluetooth,
    usb: !!c.requireUsbKey,
    geo: !!c.requireGeo || !!c.geofence,
  };
}

/** Read the security layers currently enabled on a vault. */
export async function getVaultLayers(chain: SwapChain, safeAddress: Hex): Promise<VaultLayers> {
  const { config } = await getVaultPolicy(chain, safeAddress);
  return configToLayers(config);
}

const NO_LAYERS: VaultLayers = { faceId: false, bluetooth: false, usb: false, geo: false };
const DEFAULT_LAYERS_KEY = "ark.defaultLayers";

/** The layer preferences chosen at onboarding, used to pre-fill vault creation. */
export function getDefaultLayers(): VaultLayers {
  try {
    const raw = localStorage.getItem(DEFAULT_LAYERS_KEY);
    if (raw) return { ...NO_LAYERS, ...(JSON.parse(raw) as Partial<VaultLayers>) };
  } catch {
    /* ignore */
  }
  return { ...NO_LAYERS };
}

export function setDefaultLayers(layers: VaultLayers): void {
  try {
    localStorage.setItem(DEFAULT_LAYERS_KEY, JSON.stringify(layers));
  } catch {
    /* ignore */
  }
}

/**
 * Change a deployed vault's security policy. If the CURRENT policy has active
 * layers, the change must be authorized by passing them right now — capture live
 * factors + a WebAuthn approval bound to "policy-update". So you can't strip
 * protections without the device/location/biometric present.
 */
export async function updateVaultPolicy(
  chain: SwapChain,
  safeAddress: Hex,
  newConfig: VaultPolicyConfig,
  currentConfig: VaultPolicyConfig
): Promise<void> {
  const guarded =
    currentConfig.requireWebauthn ||
    currentConfig.requireUsbKey ||
    currentConfig.requireBluetooth ||
    currentConfig.requireGeo ||
    currentConfig.geofence != null;

  let factors: PolicyFactors | undefined;
  let webauthn: unknown;
  if (guarded) {
    factors = await captureFactors(currentConfig);
    if (currentConfig.requireWebauthn) {
      webauthn = await approveWithPasskey(chain, safeAddress, "policy-update");
    }
  }

  // Newly enabling Face ID needs a passkey enrolled before it can be required.
  if (newConfig.requireWebauthn && !currentConfig.requireWebauthn) {
    await enrollPasskey(chain, safeAddress);
  }

  await setVaultPolicy({ chain, safeAddress, config: newConfig, factors, webauthn });
}

/** Deterministic address of the co-signed 2-of-2 vault for `owner`. */
export async function predictCosignedVault(
  chain: SwapChain,
  owner: Hex,
  cosigner: Hex,
  saltNonce?: string
): Promise<Hex> {
  return predictMultiVaultAddress(chain, [owner, cosigner], 2, saltNonce);
}

/**
 * Deploy the co-signed 2-of-2 vault. The user owner EOA signs + pays gas. The
 * chosen security layers are persisted server-side first (keyed by the vault's
 * deterministic address) so the co-signer enforces them from the first spend.
 */
export async function createCosignedVault(
  opts: {
    chain: SwapChain;
    accountIndex: number;
    owner: Hex;
    cosigner: Hex;
    config?: VaultPolicyConfig;
    saltNonce?: string;
  },
  onPhase?: (phase: VaultPhase) => void
): Promise<DeployResult> {
  const safeAddress = await predictCosignedVault(
    opts.chain,
    opts.owner,
    opts.cosigner,
    opts.saltNonce
  );
  if (opts.config) {
    // Enroll the passkey BEFORE persisting the policy / deploying, so we never
    // create a Face-ID-required vault without a usable credential.
    if (opts.config.requireWebauthn) {
      await enrollPasskey(opts.chain, safeAddress);
    }
    await setVaultPolicy({ chain: opts.chain, safeAddress, config: opts.config });
  }
  return createVaultOnChain(
    {
      chain: opts.chain,
      accountIndex: opts.accountIndex,
      owner: opts.owner,
      owners: [opts.owner, opts.cosigner],
      threshold: 2,
      saltNonce: opts.saltNonce,
    },
    onPhase
  );
}

/**
 * Capture the LIVE device/location readings the vault's enabled layers need.
 * These are real reads (USB enumeration, Bluetooth presence, OS geolocation);
 * the co-signer matches them against the registered ids / geofence server-side.
 * Face ID is handled separately via a real WebAuthn assertion.
 */
async function captureFactors(cfg: VaultPolicyConfig): Promise<PolicyFactors> {
  const f: PolicyFactors = {};
  if (cfg.requireUsbKey) {
    const devices = await listUsbDevices();
    f.usb = { presentIds: devices.map((d) => d.id) };
  }
  if (cfg.requireBluetooth) {
    const devices = await listBluetoothDevices();
    f.bluetooth = { presentIds: devices.filter((d) => d.connected).map((d) => d.id) };
  }
  if (cfg.requireGeo || cfg.geofence) {
    const pos = await getLocation();
    f.geo = { lat: pos.lat, lng: pos.lng };
  }
  return f;
}

export interface CosignedSendResult extends VaultExecResult {
  policy: CosignResult["policy"];
}

/**
 * Send from the co-signed vault. Build the SafeTx, sign it with the user's key
 * (Rust), ask the backend to evaluate policy + co-sign (Member 2); if the rules
 * pass, encode execTransaction with BOTH signatures and broadcast. If policy
 * fails, the co-signer withholds its signature and the transfer cannot proceed.
 */
export async function sendFromCosignedVault(
  opts: {
    chain: SwapChain;
    accountIndex: number;
    owner: Hex; // user master key = signer + gas payer
    safeAddress: Hex;
    to: Hex;
    value: string; // raw smallest unit
    data?: Hex;
    operation?: number;
    factors?: PolicyFactors;
  },
  onPhase?: (phase: VaultPhase) => void
): Promise<CosignedSendResult> {
  const { chain, accountIndex, owner, safeAddress, to, value } = opts;
  const data = opts.data ?? "0x";
  const phase = (p: VaultPhase) => onPhase?.(p);

  try {
    phase("building");
    const { safeTxHash, safeTxData } = await buildVaultTx({
      chain,
      safeAddress,
      to,
      value,
      data,
      operation: opts.operation ?? 0,
    });

    phase("signing");
    const userSig = await signHash(accountIndex, safeTxHash);

    // Gather the proofs the vault's enabled layers require. Face ID runs a real
    // WebAuthn approval bound to this safeTxHash; the others are MVP-captured.
    const { config } = await getVaultPolicy(chain, safeAddress);
    const factors = opts.factors ?? (await captureFactors(config));
    let webauthn: unknown;
    if (config.requireWebauthn) {
      webauthn = await approveWithPasskey(chain, safeAddress, safeTxHash);
    }

    // Member 2: backend evaluates the vault policy, then co-signs if it passes.
    const cosign = await cosignVaultTx({
      chain,
      safeAddress,
      safeTxHash,
      safeTxData,
      factors,
      webauthn,
    });
    if (!cosign.ok || !cosign.signature) {
      phase("error");
      const failed = cosign.policy.checks.filter((c) => !c.ok).map((c) => c.name);
      throw new Error(
        `co-signer rejected: policy failed (${failed.join(", ") || "unknown"})`
      );
    }

    phase("executing");
    const exec = await buildVaultExec({
      chain,
      safeAddress,
      safeTxData,
      signatures: [
        { signer: owner, data: userSig },
        cosign.signature,
      ],
    });
    const hash = await signAndBroadcast(
      chain,
      accountIndex,
      owner,
      exec.to,
      BigInt(exec.value),
      exec.data
    );

    phase("confirming");
    const status = await waitForReceipt(chain, hash);
    phase(status === "success" ? "done" : "error");
    return { safeTxHash, hash, status, policy: cosign.policy };
  } catch (e) {
    phase("error");
    throw e;
  }
}

/**
 * Swap FROM the vault (Safe): the swap call is executed by the Safe through the
 * co-signer rail, so the same Face ID / device / geo layers gate it and the
 * output lands back in the vault. Native-in only for now (ERC-20 input needs a
 * Permit2/approve dance from the Safe, which is a later step).
 */
export async function executeVaultSwap(
  opts: {
    chain: SwapChain;
    accountIndex: number;
    owner: Hex;
    safeAddress: Hex;
    tokenIn: string;
    tokenOut: string;
    amountIn: string; // raw smallest unit
    slippageBps?: number;
  },
  onPhase?: (phase: VaultPhase) => void
): Promise<{ hash: Hex; status: "success" | "reverted"; quote: SwapQuote }> {
  const { chain, accountIndex, owner, safeAddress, tokenIn, tokenOut, amountIn } = opts;
  const build = await buildSwap({
    chain,
    tokenIn,
    tokenOut,
    amountIn,
    recipient: safeAddress, // output goes back to the vault
    slippageBps: opts.slippageBps ?? 50,
  });
  if (build.kind !== "tx") {
    throw new Error(
      "Token-to-token swaps from the vault are coming soon. For now pay with ETH from the vault, or swap from your wallet."
    );
  }
  const res = await sendFromCosignedVault(
    {
      chain,
      accountIndex,
      owner,
      safeAddress,
      to: build.to,
      value: build.value,
      data: build.data,
    },
    onPhase
  );
  return { hash: res.hash, status: res.status, quote: build.quote };
}
