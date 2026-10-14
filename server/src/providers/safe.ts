import Safe, { EthSafeSignature } from "@safe-global/protocol-kit";
import { type Address, type Hex } from "viem";
import { ALCHEMY_API_KEY, CHAINS } from "../config.js";
import { getRpcClient, type ChainId } from "./uniswap.js";

/**
 * Safe smart-account vault. We use protocol-kit purely to ENCODE and HASH:
 *  - predict the Safe address + build its deployment calldata,
 *  - build a SafeTx and compute its EIP-712 hash,
 *  - encode `execTransaction` once signatures are gathered.
 *
 * We never give protocol-kit a private key. The device owner signs the SafeTx
 * hash inside the Rust vault core (`sign_hash`); the result is a standard
 * ECDSA signature over the EIP-712 digest (v in {27,28}), exactly what Safe's
 * `checkSignatures` expects. Broadcasting goes through rpc.ts. Keys stay in Rust.
 */

// Safe is deployed on all our chains; we start the vault flow on Base.
export type VaultChain = ChainId;

function rpcUrl(chain: VaultChain): string {
  const c = CHAINS.find((x) => x.id === chain);
  if (!c) throw new Error(`unknown chain: ${chain}`);
  if (!ALCHEMY_API_KEY) throw new Error("ALCHEMY_API_KEY not set");
  return `https://${c.alchemyNetwork}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
}

export interface SafeAccountConfig {
  owners: Address[];
  threshold: number;
  saltNonce?: string; // lets one seed own multiple distinct vaults
}

/** A SafeTx in its canonical, fully-specified form (so the hash is stable). */
export interface SafeTxData {
  to: Address;
  value: string;
  data: Hex;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: Address;
  refundReceiver: Address;
  nonce: number;
}

export interface OwnerSignature {
  signer: Address;
  data: Hex; // 65-byte r||s||v from the Rust signer
}

async function initPredicted(chain: VaultChain, cfg: SafeAccountConfig) {
  return Safe.init({
    provider: rpcUrl(chain),
    predictedSafe: {
      safeAccountConfig: { owners: cfg.owners, threshold: cfg.threshold },
      ...(cfg.saltNonce
        ? { safeDeploymentConfig: { saltNonce: cfg.saltNonce } }
        : {}),
    },
  });
}

async function initExisting(chain: VaultChain, safeAddress: Address) {
  return Safe.init({ provider: rpcUrl(chain), safeAddress });
}

/** Deterministic Safe address for a given owner set (before deployment). */
export async function predictVaultAddress(
  chain: VaultChain,
  cfg: SafeAccountConfig
): Promise<Address> {
  const kit = await initPredicted(chain, cfg);
  return (await kit.getAddress()) as Address;
}

/**
 * Predict the address AND build the one-time deployment transaction. The caller
 * signs + broadcasts {to,value,data} from their owner EOA (which pays gas).
 */
export async function buildVaultDeployment(
  chain: VaultChain,
  cfg: SafeAccountConfig
): Promise<{ safeAddress: Address; to: Address; value: string; data: Hex }> {
  const kit = await initPredicted(chain, cfg);
  const [safeAddress, deployTx] = await Promise.all([
    kit.getAddress(),
    kit.createSafeDeploymentTransaction(),
  ]);
  return {
    safeAddress: safeAddress as Address,
    to: deployTx.to as Address,
    value: deployTx.value,
    data: deployTx.data as Hex,
  };
}

/** Whether the Safe is already deployed on-chain (has contract code). */
export async function isVaultDeployed(
  chain: VaultChain,
  safeAddress: Address
): Promise<boolean> {
  const code = await getRpcClient(chain).getCode({ address: safeAddress });
  return code != null && code !== "0x";
}

/**
 * Build a SafeTx for an existing vault and return its canonical data + the
 * EIP-712 hash to sign in Rust. Pass the data back to `encodeVaultExec`.
 */
export async function buildVaultTx(
  chain: VaultChain,
  safeAddress: Address,
  tx: { to: Address; value: string; data: Hex; operation?: number }
): Promise<{ safeTxHash: Hex; safeTxData: SafeTxData }> {
  const kit = await initExisting(chain, safeAddress);
  const safeTransaction = await kit.createTransaction({
    transactions: [
      {
        to: tx.to,
        value: tx.value,
        data: tx.data,
        operation: tx.operation ?? 0,
      },
    ],
  });
  const safeTxHash = (await kit.getTransactionHash(safeTransaction)) as Hex;
  const d = safeTransaction.data;
  return {
    safeTxHash,
    safeTxData: {
      to: d.to as Address,
      value: d.value,
      data: d.data as Hex,
      operation: d.operation,
      safeTxGas: d.safeTxGas,
      baseGas: d.baseGas,
      gasPrice: d.gasPrice,
      gasToken: d.gasToken as Address,
      refundReceiver: d.refundReceiver as Address,
      nonce: d.nonce,
    },
  };
}

/**
 * Recompute the EIP-712 hash of a SafeTx from its canonical data. Used to verify
 * a client-supplied safeTxHash genuinely matches the safeTxData the co-signer is
 * about to evaluate policy on (so it never signs a hash for different intent).
 */
export async function hashVaultTx(
  chain: VaultChain,
  safeAddress: Address,
  safeTxData: SafeTxData
): Promise<Hex> {
  const kit = await initExisting(chain, safeAddress);
  const safeTransaction = await kit.createTransaction({
    transactions: [
      {
        to: safeTxData.to,
        value: safeTxData.value,
        data: safeTxData.data,
        operation: safeTxData.operation,
      },
    ],
    options: {
      safeTxGas: safeTxData.safeTxGas,
      baseGas: safeTxData.baseGas,
      gasPrice: safeTxData.gasPrice,
      gasToken: safeTxData.gasToken,
      refundReceiver: safeTxData.refundReceiver,
      nonce: safeTxData.nonce,
    },
  });
  return (await kit.getTransactionHash(safeTransaction)) as Hex;
}

/**
 * Re-create the exact SafeTx from its canonical data, attach the gathered
 * owner signatures, and encode `execTransaction` calldata. The caller signs +
 * broadcasts {to: safeAddress, value: "0", data} from an owner EOA.
 */
export async function encodeVaultExec(
  chain: VaultChain,
  safeAddress: Address,
  safeTxData: SafeTxData,
  signatures: OwnerSignature[]
): Promise<{ to: Address; value: string; data: Hex }> {
  const kit = await initExisting(chain, safeAddress);
  const safeTransaction = await kit.createTransaction({
    transactions: [
      {
        to: safeTxData.to,
        value: safeTxData.value,
        data: safeTxData.data,
        operation: safeTxData.operation,
      },
    ],
    options: {
      safeTxGas: safeTxData.safeTxGas,
      baseGas: safeTxData.baseGas,
      gasPrice: safeTxData.gasPrice,
      gasToken: safeTxData.gasToken,
      refundReceiver: safeTxData.refundReceiver,
      nonce: safeTxData.nonce,
    },
  });
  for (const s of signatures) {
    safeTransaction.addSignature(new EthSafeSignature(s.signer, s.data));
  }
  const data = (await kit.getEncodedTransaction(safeTransaction)) as Hex;
  return { to: safeAddress, value: "0", data };
}
