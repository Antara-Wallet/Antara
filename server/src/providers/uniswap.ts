import {
  createPublicClient,
  http,
  getAddress,
  encodeAbiParameters,
  encodePacked,
  encodeFunctionData,
  concatHex,
  numberToHex,
  maxUint160,
  maxUint256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { mainnet, base } from "viem/chains";
import { ALCHEMY_API_KEY, hasAlchemy, type Chain } from "../config.js";
import { cache } from "../cache.js";

/**
 * Uniswap v3 read-only quoting. We staticcall QuoterV2.quoteExactInputSingle
 * over our Alchemy RPC across the standard fee tiers and keep the best output.
 *
 * Quoting only — this NEVER touches keys. The actual swap (calldata + signing +
 * broadcast) is built elsewhere; secrets stay in the Rust vault core.
 */

const FEE_TIERS = [100, 500, 3000, 10000] as const; // 0.01% .. 1%
const QUOTE_TTL = 10_000;

// Per-chain Uniswap v3 deployment + canonical tokens (checksummed lazily).
// Canonical Permit2 — same address on every chain.
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

interface UniChain {
  viemChain: typeof mainnet | typeof base;
  alchemyNetwork: string;
  quoterV2: Address;
  universalRouter: Address; // verified against Uniswap official deployments
  weth: Address; // wrapped native, used to quote when the user sells native gas
}

const UNI: Record<Chain["id"], UniChain> = {
  ethereum: {
    viemChain: mainnet,
    alchemyNetwork: "eth-mainnet",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    universalRouter: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  base: {
    viemChain: base,
    alchemyNetwork: "base-mainnet",
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    universalRouter: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
    weth: "0x4200000000000000000000000000000000000006",
  },
};

// QuoterV2 is non-view on-chain but safe to eth_call; we declare it view so
// viem's readContract will staticcall it.
const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "view",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export type ChainId = Chain["id"];

export interface SwapQuote {
  chain: ChainId;
  tokenIn: string; // resolved address used for quoting (WETH if native)
  tokenOut: string;
  nativeIn: boolean; // true when the user is selling the native gas token
  amountIn: string; // raw, smallest unit
  amountOut: string; // raw, best across fee tiers
  minOut: string; // amountOut after slippage tolerance
  feeTier: number; // the pool fee tier that won (e.g. 3000 = 0.3%)
  slippageBps: number;
  priceImpactBps: number | null; // vs a near-zero-size reference quote
  gasEstimate: string | null;
}

const clients = new Map<ChainId, PublicClient>();
/** Shared viem public client for a chain (Alchemy RPC). Reused by rpc.ts. */
export function getRpcClient(chain: ChainId): PublicClient {
  return clientFor(chain);
}
function clientFor(chain: ChainId): PublicClient {
  let c = clients.get(chain);
  if (!c) {
    const u = UNI[chain];
    c = createPublicClient({
      chain: u.viemChain,
      transport: http(`https://${u.alchemyNetwork}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`),
    }) as PublicClient;
    clients.set(chain, c);
  }
  return c;
}

/** Resolve "native"/"eth"/null to the wrapped-native address for quoting. */
export function resolveToken(chain: ChainId, token: string): { address: Address; native: boolean } {
  const t = token.trim().toLowerCase();
  if (t === "" || t === "native" || t === "eth" || t === "pol" || t === "matic") {
    return { address: UNI[chain].weth, native: true };
  }
  return { address: getAddress(token), native: false };
}

interface TierResult {
  feeTier: number;
  amountOut: bigint;
  gasEstimate: bigint;
}

async function quoteTier(
  chain: ChainId,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: number
): Promise<TierResult | null> {
  try {
    const res = (await clientFor(chain).readContract({
      address: UNI[chain].quoterV2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
    })) as readonly [bigint, bigint, number, bigint];
    return { feeTier: fee, amountOut: res[0], gasEstimate: res[3] };
  } catch {
    return null; // pool/tier doesn't exist => skip
  }
}

async function bestTier(
  chain: ChainId,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint
): Promise<TierResult | null> {
  const results = await Promise.all(
    FEE_TIERS.map((fee) => quoteTier(chain, tokenIn, tokenOut, amountIn, fee))
  );
  let best: TierResult | null = null;
  for (const r of results) {
    if (r && r.amountOut > 0n && (!best || r.amountOut > best.amountOut)) best = r;
  }
  return best;
}

/**
 * Price impact in bps: compare the execution rate (amountOut/amountIn) against
 * a reference rate from a tiny trade in the same pool (≈ the marginal price).
 */
async function priceImpactBps(
  chain: ChainId,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  feeTier: number,
  amountOut: bigint
): Promise<number | null> {
  const ref = amountIn / 10_000n;
  if (ref <= 0n) return null;
  const refQuote = await quoteTier(chain, tokenIn, tokenOut, ref, feeTier);
  if (!refQuote || refQuote.amountOut <= 0n) return null;
  // rates scaled to compare without floats losing precision on big numbers.
  const execRate = (amountOut * 10n ** 18n) / amountIn;
  const refRate = (refQuote.amountOut * 10n ** 18n) / ref;
  if (refRate <= 0n) return null;
  const impact = refRate > execRate ? refRate - execRate : 0n;
  return Number((impact * 10_000n) / refRate);
}

export async function getQuote(
  chain: ChainId,
  tokenInRaw: string,
  tokenOutRaw: string,
  amountIn: bigint,
  slippageBps: number
): Promise<SwapQuote> {
  if (!hasAlchemy()) throw new Error("ALCHEMY_API_KEY not set");
  if (amountIn <= 0n) throw new Error("amountIn must be > 0");

  const tin = resolveToken(chain, tokenInRaw);
  const tout = resolveToken(chain, tokenOutRaw);

  const key = `uniq:${chain}:${tin.address}:${tout.address}:${amountIn}:${slippageBps}`;
  return cache.wrap(key, QUOTE_TTL, async () => {
    const best = await bestTier(chain, tin.address, tout.address, amountIn);
    if (!best) throw new Error("no Uniswap v3 route found for this pair");

    const minOut = best.amountOut - (best.amountOut * BigInt(slippageBps)) / 10_000n;
    const impact = await priceImpactBps(
      chain,
      tin.address,
      tout.address,
      amountIn,
      best.feeTier,
      best.amountOut
    ).catch(() => null);

    return {
      chain,
      tokenIn: tin.address,
      tokenOut: tout.address,
      nativeIn: tin.native,
      amountIn: amountIn.toString(),
      amountOut: best.amountOut.toString(),
      minOut: minOut.toString(),
      feeTier: best.feeTier,
      slippageBps,
      priceImpactBps: impact,
      gasEstimate: best.gasEstimate > 0n ? best.gasEstimate.toString() : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Swap transaction builder (Universal Router + Permit2)
// ---------------------------------------------------------------------------

// Universal Router command bytes (stable across UR versions).
const CMD_V3_SWAP_EXACT_IN = "00";
const CMD_PERMIT2_PERMIT = "0a";
const CMD_WRAP_ETH = "0b";
const CMD_UNWRAP_WETH = "0c";

// Router recipient sentinels.
const MSG_SENDER: Address = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";

const ERC20_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const PERMIT2_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

const V3_SWAP_INPUT = [
  { name: "recipient", type: "address" },
  { name: "amountIn", type: "uint256" },
  { name: "amountOutMin", type: "uint256" },
  { name: "path", type: "bytes" },
  { name: "payerIsUser", type: "bool" },
] as const;

const WRAP_UNWRAP_INPUT = [
  { name: "recipient", type: "address" },
  { name: "amountMin", type: "uint256" },
] as const;

const PERMIT2_PERMIT_INPUT = [
  {
    name: "permitSingle",
    type: "tuple",
    components: [
      {
        name: "details",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint160" },
          { name: "expiration", type: "uint48" },
          { name: "nonce", type: "uint48" },
        ],
      },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" },
    ],
  },
  { name: "signature", type: "bytes" },
] as const;

/** EIP-712 typed data for a Permit2 PermitSingle — frontend signs the digest. */
export interface Permit2TypedData {
  domain: { name: string; chainId: number; verifyingContract: Address };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "PermitSingle";
  message: {
    details: { token: Address; amount: string; expiration: number; nonce: number };
    spender: Address;
    sigDeadline: string;
  };
}

export interface PermitInput {
  token: Address;
  amount: string;
  expiration: number;
  nonce: number;
  spender: Address;
  sigDeadline: string;
  signature: Hex;
}

export type BuildResult =
  | {
      kind: "tx";
      to: Address;
      value: string; // hex wei
      data: Hex;
      deadline: number;
      quote: SwapQuote;
    }
  | {
      kind: "permit_required";
      needsErc20Approve: boolean;
      approveTx?: { to: Address; value: string; data: Hex };
      permit2: { address: Address; typedData: Permit2TypedData };
      quote: SwapQuote;
    };

function encodePath(tokenIn: Address, fee: number, tokenOut: Address): Hex {
  return encodePacked(["address", "uint24", "address"], [tokenIn, fee, tokenOut]);
}

function executeCalldata(commands: string[], inputs: Hex[], deadline: number): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "execute",
        stateMutability: "payable",
        inputs: [
          { name: "commands", type: "bytes" },
          { name: "inputs", type: "bytes[]" },
          { name: "deadline", type: "uint256" },
        ],
        outputs: [],
      },
    ] as const,
    functionName: "execute",
    args: [concatHex(commands.map((c) => `0x${c}` as Hex)), inputs, BigInt(deadline)],
  });
}

function permit2TypedData(
  chainId: number,
  token: Address,
  spender: Address,
  nonce: number,
  expiration: number,
  sigDeadline: number
): Permit2TypedData {
  return {
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2 },
    types: {
      PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
      ],
      PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
      ],
    },
    primaryType: "PermitSingle",
    message: {
      details: { token, amount: maxUint160.toString(), expiration, nonce },
      spender,
      sigDeadline: sigDeadline.toString(),
    },
  };
}

/**
 * Build a ready-to-sign Universal Router swap. For native-in swaps no Permit2 is
 * needed and a `tx` is returned immediately. For ERC-20-in swaps, the first call
 * returns `permit_required` (typed data to sign + any ERC-20 approve tx); call
 * again with the signed `permit` to receive the final `tx`.
 */
export async function buildSwap(opts: {
  chain: ChainId;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  recipient: Address;
  slippageBps: number;
  permit?: PermitInput;
  deadlineSeconds?: number;
}): Promise<BuildResult> {
  if (!hasAlchemy()) throw new Error("ALCHEMY_API_KEY not set");
  const u = UNI[opts.chain];
  const recipient = getAddress(opts.recipient);
  const tin = resolveToken(opts.chain, opts.tokenIn);
  const tout = resolveToken(opts.chain, opts.tokenOut);
  if (tin.address.toLowerCase() === tout.address.toLowerCase())
    throw new Error("tokenIn and tokenOut resolve to the same token");

  const quote = await getQuote(
    opts.chain,
    opts.tokenIn,
    opts.tokenOut,
    opts.amountIn,
    opts.slippageBps
  );
  const minOut = BigInt(quote.minOut);
  const deadline = Math.floor(Date.now() / 1000) + (opts.deadlineSeconds ?? 1800);
  const path = encodePath(tin.address, quote.feeTier, tout.address);

  // --- Native-in (ETH -> token): wrap then swap, no Permit2. ---
  if (tin.native) {
    const commands = [CMD_WRAP_ETH, CMD_V3_SWAP_EXACT_IN];
    const inputs: Hex[] = [
      encodeAbiParameters(WRAP_UNWRAP_INPUT, [ADDRESS_THIS, opts.amountIn]),
      encodeAbiParameters(V3_SWAP_INPUT, [MSG_SENDER, opts.amountIn, minOut, path, false]),
    ];
    return {
      kind: "tx",
      to: u.universalRouter,
      value: numberToHex(opts.amountIn),
      data: executeCalldata(commands, inputs, deadline),
      deadline,
      quote,
    };
  }

  // --- ERC-20-in: needs Permit2. If no signature yet, return what to sign. ---
  const client = clientFor(opts.chain);
  if (!opts.permit) {
    const [erc20Allowance, p2] = await Promise.all([
      client.readContract({
        address: tin.address,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: "allowance",
        args: [recipient, PERMIT2],
      }) as Promise<bigint>,
      client.readContract({
        address: PERMIT2,
        abi: PERMIT2_ALLOWANCE_ABI,
        functionName: "allowance",
        args: [recipient, tin.address, u.universalRouter],
      }) as Promise<readonly [bigint, number, number]>,
    ]);

    const needsErc20Approve = erc20Allowance < opts.amountIn;
    const approveTx = needsErc20Approve
      ? {
          to: tin.address,
          value: "0x0",
          data: encodeFunctionData({
            abi: [
              {
                type: "function",
                name: "approve",
                stateMutability: "nonpayable",
                inputs: [
                  { name: "spender", type: "address" },
                  { name: "amount", type: "uint256" },
                ],
                outputs: [{ name: "", type: "bool" }],
              },
            ] as const,
            functionName: "approve",
            args: [PERMIT2, maxUint256],
          }),
        }
      : undefined;

    const nonce = p2[2];
    const expiration = Math.floor(Date.now() / 1000) + 30 * 24 * 3600; // 30 days
    return {
      kind: "permit_required",
      needsErc20Approve,
      approveTx,
      permit2: {
        address: PERMIT2,
        typedData: permit2TypedData(
          u.viemChain.id,
          tin.address,
          u.universalRouter,
          nonce,
          expiration,
          deadline
        ),
      },
      quote,
    };
  }

  // --- ERC-20-in with a signed permit: PERMIT2_PERMIT + swap (+ unwrap if native-out). ---
  const permitInput = encodeAbiParameters(PERMIT2_PERMIT_INPUT, [
    {
      details: {
        token: opts.permit.token,
        amount: BigInt(opts.permit.amount),
        expiration: opts.permit.expiration,
        nonce: opts.permit.nonce,
      },
      spender: opts.permit.spender,
      sigDeadline: BigInt(opts.permit.sigDeadline),
    },
    opts.permit.signature,
  ]);

  const commands = [CMD_PERMIT2_PERMIT, CMD_V3_SWAP_EXACT_IN];
  const swapRecipient = tout.native ? ADDRESS_THIS : MSG_SENDER;
  const inputs: Hex[] = [
    permitInput,
    encodeAbiParameters(V3_SWAP_INPUT, [swapRecipient, opts.amountIn, minOut, path, true]),
  ];
  if (tout.native) {
    commands.push(CMD_UNWRAP_WETH);
    inputs.push(encodeAbiParameters(WRAP_UNWRAP_INPUT, [MSG_SENDER, minOut]));
  }

  return {
    kind: "tx",
    to: u.universalRouter,
    value: "0x0",
    data: executeCalldata(commands, inputs, deadline),
    deadline,
    quote,
  };
}
