import {
  serializeTransaction,
  keccak256,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import {
  stealthMetaAddress,
  stealthSendCompute,
  stealthScan,
  stealthSign,
} from "./vault";
import {
  announceStealth,
  getStealthAnnouncements,
  getPortfolio,
  getTxParams,
  broadcastTx,
  type SwapChain,
} from "./api";
import { sendAsset } from "./send";
import { waitForReceipt } from "./swap";

/**
 * Stealth-address orchestration (ERC-5564) for private receiving.
 *
 *  - getMyMeta:     this account's meta-address to share/publish.
 *  - sendPrivately: derive a fresh one-time address, send funds, announce it.
 *  - scanInbox:     scan announcements with the viewing key; list funded payments.
 *  - sweepNative:   move a discovered payment's native ETH out, signing with the
 *                   one-time key (which never leaves Rust).
 *
 * Only RECEIVING is unlinkable: each payment lands at a fresh address nobody can
 * tie back to you. Sweeping carelessly (many stealth addresses into one) can
 * re-link them; true sending privacy is a later step.
 */

export interface ParsedMeta {
  spendPub: string;
  viewPub: string;
  chainLabel: string;
}

// st:<chain>:0x<spendPub(33B=66hex)><viewPub(33B=66hex)>
const META_RE = /^st:([a-z0-9]+):0x([0-9a-fA-F]{66})([0-9a-fA-F]{66})$/;

export function isMetaAddress(s: string): boolean {
  return META_RE.test(s.trim());
}

export function parseMetaAddress(meta: string): ParsedMeta {
  const m = META_RE.exec(meta.trim());
  if (!m) throw new Error("Invalid stealth address");
  return { chainLabel: m[1], spendPub: `0x${m[2]}`, viewPub: `0x${m[3]}` };
}

export const getMyMeta = (index: number, chain: SwapChain) =>
  stealthMetaAddress(index, chain);

export type StealthPhase =
  | "computing"
  | "signing"
  | "confirming"
  | "announcing"
  | "broadcasting"
  | "preparing"
  | "done";

/** Send to a stealth meta-address: one-time address -> send -> announce. */
export async function sendPrivately(
  p: {
    chain: SwapChain;
    accountIndex: number;
    from: Hex;
    meta: string;
    tokenAddress: string | null;
    amount: string;
    decimals: number;
  },
  onPhase?: (ph: StealthPhase) => void
): Promise<{ hash: Hex; stealthAddress: Hex }> {
  const { spendPub, viewPub } = parseMetaAddress(p.meta);
  onPhase?.("computing");
  const s = await stealthSendCompute(spendPub, viewPub);

  const res = await sendAsset(
    {
      chain: p.chain,
      accountIndex: p.accountIndex,
      from: p.from,
      to: s.stealthAddress,
      tokenAddress: p.tokenAddress,
      amount: p.amount,
      decimals: p.decimals,
    },
    (ph) => {
      if (ph === "signing") onPhase?.("signing");
      else if (ph === "confirming") onPhase?.("confirming");
    }
  );

  // Announce so the recipient can discover it. Best-effort: the funds are already
  // sent, and the recipient can also be told (R, viewTag) out of band.
  onPhase?.("announcing");
  try {
    await announceStealth({
      chain: p.chain,
      stealthAddress: s.stealthAddress,
      ephemeralPub: s.ephemeralPub,
      viewTag: s.viewTag,
    });
  } catch {
    /* relay is best-effort */
  }
  onPhase?.("done");
  return { hash: res.hash, stealthAddress: s.stealthAddress };
}

export interface InboxItem {
  stealthAddress: `0x${string}`;
  ephemeralPub: string;
  nativeRaw: string; // wei
  nativeFormatted: string;
  symbol: string;
  valueUsd: number;
}

/** Scan announcements with the viewing key; return payments holding native funds. */
export async function scanInbox(
  chain: SwapChain,
  accountIndex: number
): Promise<InboxItem[]> {
  const { items } = await getStealthAnnouncements(chain);
  if (!items.length) return [];

  const matches = await stealthScan(
    accountIndex,
    items.map((a) => ({ ephemeralPub: a.ephemeralPub, viewTag: a.viewTag }))
  );

  const out: InboxItem[] = [];
  for (const m of matches) {
    try {
      const pf = await getPortfolio(m.stealthAddress);
      const native = pf.tokens.find(
        (t) => t.chain === chain && t.tokenAddress == null
      );
      const raw = native ? BigInt(native.raw) : 0n;
      if (raw > 0n && native) {
        out.push({
          stealthAddress: m.stealthAddress,
          ephemeralPub: m.ephemeralPub,
          nativeRaw: raw.toString(),
          nativeFormatted: native.balance,
          symbol: native.symbol,
          valueUsd: native.valueUsd ?? 0,
        });
      }
    } catch {
      /* skip an address we can't read right now */
    }
  }
  return out;
}

const NATIVE_GAS = 21_000n;

function splitSig(sig: string): { r: Hex; s: Hex; yParity: number } {
  const h = sig.startsWith("0x") ? sig.slice(2) : sig;
  if (h.length !== 130) throw new Error("expected a 65-byte signature");
  return {
    r: `0x${h.slice(0, 64)}`,
    s: `0x${h.slice(64, 128)}`,
    yParity: parseInt(h.slice(128, 130), 16) - 27,
  };
}

/**
 * Sweep native ETH out of a discovered stealth address to `to`, signing with the
 * one-time key. value = balance - gas*maxFee, so the tx always covers its own gas
 * and nothing is left stranded that we'd need to top up.
 */
export async function sweepNative(
  p: {
    chain: SwapChain;
    accountIndex: number;
    ephemeralPub: string;
    stealthAddress: Hex;
    to: Hex;
  },
  onPhase?: (ph: StealthPhase) => void
): Promise<Hex> {
  onPhase?.("preparing");
  const params = await getTxParams(p.chain, p.stealthAddress, p.to, "0", "0x");
  const maxFee = BigInt(params.maxFeePerGas);
  const maxPrio = BigInt(params.maxPriorityFeePerGas);

  const pf = await getPortfolio(p.stealthAddress);
  const native = pf.tokens.find((t) => t.tokenAddress == null);
  const balance = native ? BigInt(native.raw) : 0n;
  const fee = NATIVE_GAS * maxFee;
  if (balance <= fee) throw new Error("Balance too low to cover the sweep gas");
  const value = balance - fee;

  const tx: TransactionSerializableEIP1559 = {
    type: "eip1559",
    chainId: params.chainId,
    nonce: params.nonce,
    to: p.to,
    value,
    data: "0x",
    gas: NATIVE_GAS,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPrio,
  };

  const digest = keccak256(serializeTransaction(tx));
  onPhase?.("signing");
  const sig = await stealthSign(p.accountIndex, p.ephemeralPub, digest);
  const signed = serializeTransaction(tx, splitSig(sig));
  onPhase?.("broadcasting");
  const { hash } = await broadcastTx(p.chain, signed);
  onPhase?.("confirming");
  await waitForReceipt(p.chain, hash);
  onPhase?.("done");
  return hash;
}
