import { keccak256, stringToHex, getAddress, parseTransaction, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { COMMON_TOKENS, NATIVE } from "./tokens";
import type {
  Portfolio,
  PortfolioToken,
  Transfer,
  SwapChain,
  SwapQuote,
  BuildResult,
  TxParams,
  SafeTxData,
  PendingVaultTx,
  CosignResult,
  PolicyCheck,
  VaultPolicyConfig,
  StealthAnnouncementItem,
  TokenInfo,
  AgentGate,
  ChatResponse,
  Trenches,
  TrenchToken,
} from "./api";

/**
 * DISABLED HISTORICAL DEMO FIXTURES — never shown to a user.
 *
 * This module once backed a fake recording mode for the legacy ARK app. Every
 * holding, transfer, price and approval below is fabricated. It is inert:
 * `isDemoMode()` always returns false, so api.ts, vault.ts and devices.ts never
 * route here, and there is no keyboard shortcut, `?demo=1` or `VITE_DEMO` switch
 * any more (src/solares/wallet/defaults.test.ts guards this). Do not re-enable
 * it in any build a user can open; ANTARA never shows invented balances.
 * Removing this module entirely is tracked as an open cleanup in docs/HANDOFF.md.
 */

const FLAG = "ark.demo";
const DEPLOYED = "ark.demo.deployed";
const VAULTS = "ark.demo.vaults"; // every PREDICTED vault address (deployed or not)
const ENROLLED = "ark.demo.enrolled";
const POLICY = "ark.demo.policy:";

// How long the phone "Face ID" QR stays pending before it auto-approves.
const PHONE_APPROVE_MS = 8_000;

export function isDemoMode(): boolean {
  // Historical recording fixtures remain as source references. ANTARA never
  // routes a wallet session into synthetic balances or simulated approvals.
  return false;
}

export function setDemoMode(_on: boolean): void {
  try {
    localStorage.removeItem(FLAG);
  } catch {
    /* ignore */
  }
}

/** Wipe demo vaults/policies/enrollments (fresh take), keep demo mode on. */
export function resetDemoState(): void {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("ark.demo.")) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------ tiny helpers ------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const latency = () => sleep(220 + Math.random() * 320);

function randHex(bytes: number): `0x${string}` {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return `0x${Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

/** Deterministic fake address from arbitrary inputs (stable across reloads). */
function detAddress(key: string): `0x${string}` {
  return getAddress(`0x${keccak256(stringToHex(`ark-demo:${key}`)).slice(26)}`);
}

function toRaw(balance: number, decimals: number): string {
  // Avoid float overflow at 18 decimals: scale to 6 dp, then pad.
  const scaled = BigInt(Math.round(balance * 1e6));
  return (scaled * 10n ** BigInt(Math.max(0, decimals - 6))).toString();
}

function readSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function writeSet(key: string, s: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...s]));
  } catch {
    /* ignore */
  }
}

const vaultKey = (chain: string, addr: string) => `${chain}:${addr.toLowerCase()}`;

/* ------------------------------- price book ------------------------------- */

const PRICE: Record<string, number> = {
  ETH: 1_880,
  WETH: 1_880,
  USDC: 1,
  USDT: 1,
  DAI: 1,
  WBTC: 58_000,
  CBBTC: 58_000,
  DEGEN: 0.012,
  ARK: 0.42,
};

const ARK_TOKEN = "0x9a2c4d33ff2b2d46ac8fe6f0fbb2c0ce9a2c4d33";

interface TokenMeta {
  symbol: string;
  name: string;
  decimals: number;
}

/** chain:addressLower -> meta, built from the app's curated token list. */
const TOKEN_META = new Map<string, TokenMeta>();
for (const chain of Object.keys(COMMON_TOKENS) as SwapChain[]) {
  for (const t of COMMON_TOKENS[chain]) {
    if (t.address !== "native") {
      TOKEN_META.set(`${chain}:${t.address.toLowerCase()}`, {
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
      });
    }
  }
}
TOKEN_META.set(`base:${ARK_TOKEN}`, { symbol: "ARK", name: "ARK", decimals: 18 });

function metaFor(chain: SwapChain, token: string): TokenMeta {
  if (token === "native" || token === "") return { ...NATIVE[chain], name: NATIVE[chain].name };
  return (
    TOKEN_META.get(`${chain}:${token.toLowerCase()}`) ?? {
      symbol: "TOKEN",
      name: "Unknown Token",
      decimals: 18,
    }
  );
}

const priceOf = (symbol: string) => PRICE[symbol.toUpperCase()] ?? 1;

/* -------------------------------- portfolio ------------------------------- */

interface Holding {
  chain: SwapChain;
  tokenAddress: string | null;
  symbol: string;
  name: string;
  decimals: number;
  balance: number;
}

// The main wallet: healthy but believable.
const WALLET_HOLDINGS: Holding[] = [
  { chain: "base", tokenAddress: null, symbol: "ETH", name: "Ethereum", decimals: 18, balance: 1.8432 },
  { chain: "base", tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", name: "USD Coin", decimals: 6, balance: 2_500 },
  { chain: "base", tokenAddress: ARK_TOKEN, symbol: "ARK", name: "ARK", decimals: 18, balance: 15_000 },
  { chain: "ethereum", tokenAddress: null, symbol: "ETH", name: "Ethereum", decimals: 18, balance: 0.6421 },
  { chain: "ethereum", tokenAddress: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", name: "Wrapped BTC", decimals: 8, balance: 0.021 },
];

/* ------------------------- stateful balance ledger ------------------------- */
/*
 * Vaults start EMPTY. Moving funds wallet -> vault is a real signed transfer in
 * demo mode too, so we decode it at broadcast time and credit the vault (and
 * debit the wallet). Vault sends/withdrawals debit it back at the co-sign step,
 * where the exact SafeTx transfer is visible. Keys: `${chain}:native` or
 * `${chain}:${tokenAddressLower}` -> float amount.
 */
const BAL = "ark.demo.balances";

interface Ledger {
  wallet: Record<string, number>; // deltas applied on top of WALLET_HOLDINGS
  vaults: Record<string, Record<string, number>>; // absolute vault balances
}

function readLedger(): Ledger {
  try {
    const raw = localStorage.getItem(BAL);
    if (raw) return JSON.parse(raw) as Ledger;
  } catch {
    /* ignore */
  }
  return { wallet: {}, vaults: {} };
}

function writeLedger(l: Ledger): void {
  try {
    localStorage.setItem(BAL, JSON.stringify(l));
  } catch {
    /* ignore */
  }
}

const assetKey = (chain: string, token: string | null) =>
  `${chain}:${token ? token.toLowerCase() : "native"}`;

/* Real demo transactions, so Activity shows what actually happened. */
const EVENTS = "ark.demo.events";
const WALLET_ADDR = "ark.demo.walletaddr";

interface DemoEvent {
  chain: string;
  hash: string;
  from: string;
  to: string;
  asset: string;
  value: number;
  blockNum: string;
}

function readEvents(): DemoEvent[] {
  try {
    return JSON.parse(localStorage.getItem(EVENTS) ?? "[]") as DemoEvent[];
  } catch {
    return [];
  }
}

function recordEvent(e: Omit<DemoEvent, "blockNum">): void {
  try {
    const all = readEvents();
    all.push({
      ...e,
      from: e.from.toLowerCase(),
      to: e.to.toLowerCase(),
      blockNum: String(33_413_000 + all.length),
    });
    localStorage.setItem(EVENTS, JSON.stringify(all.slice(-50)));
  } catch {
    /* ignore */
  }
}

/** The active wallet, learned from portfolio fetches of non-vault addresses. */
function walletAddr(): string {
  try {
    return localStorage.getItem(WALLET_ADDR) ?? "0x0000000000000000000000000000000000000001";
  } catch {
    return "0x0000000000000000000000000000000000000001";
  }
}

function creditVault(vault: string, key: string, amount: number): void {
  const l = readLedger();
  const v = (l.vaults[vault.toLowerCase()] ??= {});
  v[key] = (v[key] ?? 0) + amount;
  writeLedger(l);
}

function creditWallet(key: string, amount: number): void {
  const l = readLedger();
  l.wallet[key] = (l.wallet[key] ?? 0) + amount;
  writeLedger(l);
}

/** ERC-20 `transfer(address,uint256)` calldata -> {to, amount}, or null. */
function parseErc20Transfer(data: string): { to: string; amount: bigint } | null {
  if (!data?.startsWith("0xa9059cbb") || data.length < 138) return null;
  return {
    to: `0x${data.slice(34, 74)}`.toLowerCase(),
    amount: BigInt(`0x${data.slice(74, 138)}`),
  };
}

function holdingFromKey(key: string, amount: number): Holding | null {
  const [chain, token] = key.split(":") as [SwapChain, string];
  if (amount <= 1e-9) return null;
  const m = metaFor(chain, token === "native" ? "native" : token);
  return {
    chain,
    tokenAddress: token === "native" ? null : token,
    symbol: m.symbol,
    name: m.name,
    decimals: m.decimals,
    balance: amount,
  };
}

function vaultHoldings(address: string): Holding[] {
  const v = readLedger().vaults[address.toLowerCase()] ?? {};
  return Object.entries(v)
    .map(([k, amt]) => holdingFromKey(k, amt))
    .filter(Boolean) as Holding[];
}

function walletHoldings(): Holding[] {
  const deltas = readLedger().wallet;
  return WALLET_HOLDINGS.map((h) => {
    const d = deltas[assetKey(h.chain, h.tokenAddress)] ?? 0;
    return { ...h, balance: Math.max(0, h.balance + d) };
  });
}

function buildPortfolio(address: string, holdings: Holding[]): Portfolio {
  const tokens: PortfolioToken[] = holdings.map((h) => {
    const priceUsd = priceOf(h.symbol);
    return {
      chain: h.chain,
      tokenAddress: h.tokenAddress,
      symbol: h.symbol,
      name: h.name,
      decimals: h.decimals,
      balance: h.balance.toString(),
      raw: toRaw(h.balance, h.decimals),
      priceUsd,
      valueUsd: h.balance * priceUsd,
    };
  });
  return {
    address,
    tokens,
    totalUsd: tokens.reduce((s, t) => s + (t.valueUsd ?? 0), 0),
    live: true,
  };
}

function demoHistory(address: string): { transfers: Transfer[] } {
  const other = detAddress("counterparty");
  const mk = (
    chain: Transfer["chain"],
    direction: "in" | "out",
    asset: string,
    value: number,
    block: number
  ): Transfer => ({
    chain,
    hash: randHex(32),
    from: direction === "in" ? other : address,
    to: direction === "in" ? address : other,
    direction,
    asset,
    value,
    blockNum: String(block),
  });
  return {
    transfers: [
      mk("base", "in", "ETH", 0.5, 33_412_884),
      mk("base", "out", "USDC", 250, 33_401_112),
      mk("base", "in", "USDC", 1_000, 33_388_530),
      mk("ethereum", "in", "ETH", 0.25, 23_119_004),
      mk("base", "out", "ETH", 0.12, 33_290_818),
    ],
  };
}

/* --------------------------- vault / phone state --------------------------- */

const COSIGNER = detAddress("cosigner");

let pendingDeploy: `0x${string}` | null = null;

// The last swap built, so broadcast (wallet swaps) and cosign (vault swaps)
// can apply the right ledger moves instead of misreading the transfer.
let lastSwap: {
  router: string;
  recipient: string;
  inKey: string;
  inSymbol: string;
  amountIn: number;
  outKey: string;
  outSymbol: string;
  amountOut: number;
} | null = null;

interface PhoneSession {
  kind: "enroll" | "approve";
  chain: SwapChain;
  safeAddress: string;
  start: number;
}
const phoneSessions = new Map<string, PhoneSession>();

function policyChecks(cfg: VaultPolicyConfig): PolicyCheck[] {
  const checks: PolicyCheck[] = [
    { name: "cap", ok: true, detail: "Within the per-transaction cap" },
    { name: "allowlist", ok: true, detail: "Recipient allowed" },
  ];
  if (cfg.requireWebauthn) checks.push({ name: "face_id", ok: true, detail: "Passkey verified on phone" });
  if (cfg.requireGeo || cfg.geofence) checks.push({ name: "geo", ok: true, detail: "Inside the geofence" });
  if (cfg.requireUsbKey) checks.push({ name: "usb", ok: true, detail: "Registered USB key present" });
  if (cfg.requireBluetooth) checks.push({ name: "bluetooth", ok: true, detail: "Registered device nearby" });
  return checks;
}

function getPolicy(chain: string, addr: string): VaultPolicyConfig {
  try {
    const raw = localStorage.getItem(POLICY + vaultKey(chain, addr));
    if (raw) return JSON.parse(raw) as VaultPolicyConfig;
  } catch {
    /* ignore */
  }
  return {};
}

/* --------------------------------- trenches -------------------------------- */

function trenchToken(i: number, stage: number): TrenchToken {
  const names: [string, string][] = [
    ["HENLO", "Henlo"],
    ["GLORP", "Glorp"],
    ["BONKER", "Bonker"],
    ["WAGYU", "Wagyu Finance"],
    ["PEPEQ", "Pepe Quantum"],
    ["MOONCAT", "Mooncat"],
    ["DERP", "Derp Industries"],
    ["ZOOMER", "Zoomer"],
  ];
  const [symbol, name] = names[i % names.length];
  const age = stage === 0 ? 60 + i * 140 : stage === 1 ? 3_600 + i * 900 : 14_400 + i * 3_600;
  const mc = stage === 0 ? 8_000 + i * 3_000 : stage === 1 ? 42_000 + i * 9_000 : 120_000 + i * 60_000;
  return {
    chain: "base",
    address: detAddress(`trench:${stage}:${i}`),
    symbol,
    name,
    logo: null,
    launchpad: i % 2 === 0 ? "baseapp" : "basememe",
    ageSeconds: age,
    marketCap: mc,
    volume: mc * (0.4 + (i % 3) * 0.3),
    liquidity: mc * 0.22,
    holderCount: 40 + i * 31 + stage * 260,
    progress: stage === 0 ? 0.12 + i * 0.09 : stage === 1 ? 0.82 + (i % 3) * 0.05 : 1,
    top10HolderRate: 0.18 + (i % 4) * 0.04,
    devHoldRate: 0.03 + (i % 3) * 0.02,
    sniperCount: i % 5,
    sniperHoldRate: 0.02 * (i % 4),
    insiderRate: 0.04 + 0.02 * (i % 3),
    isHoneypot: false,
    buyTax: 0,
    sellTax: 0,
    isRenounced: true,
    smartDegenCount: (i * 7) % 23,
    twitter: null,
    website: null,
    telegram: null,
  };
}

function demoTrenches(): Trenches {
  return {
    new_creation: Array.from({ length: 8 }, (_, i) => trenchToken(i, 0)),
    near_completion: Array.from({ length: 6 }, (_, i) => trenchToken(i + 3, 1)),
    completed: Array.from({ length: 6 }, (_, i) => trenchToken(i + 6, 2)),
  };
}

/* ---------------------------------- quotes --------------------------------- */

function quote(
  chain: SwapChain,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  slippageBps: number
): SwapQuote {
  const inMeta = metaFor(chain, tokenIn);
  const outMeta = metaFor(chain, tokenOut);
  const amtIn = Number(amountIn) / 10 ** inMeta.decimals;
  const amtOut = (amtIn * priceOf(inMeta.symbol) * 0.997) / priceOf(outMeta.symbol);
  const rawOut = BigInt(Math.round(amtOut * 1e6)) * 10n ** BigInt(Math.max(0, outMeta.decimals - 6));
  const minOut = (rawOut * BigInt(10_000 - slippageBps)) / 10_000n;
  return {
    chain,
    tokenIn,
    tokenOut,
    nativeIn: tokenIn === "native",
    amountIn,
    amountOut: rawOut.toString(),
    minOut: minOut.toString(),
    feeTier: 500,
    slippageBps,
    priceImpactBps: 12,
    gasEstimate: "184000",
  };
}

/* ---------------------------------- router --------------------------------- */

export async function demoRequest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  await latency();
  const url = new URL(`http://demo${path}`);
  const p = url.pathname;
  const q = url.searchParams;
  const b = (body ?? {}) as Record<string, any>;
  const out = (v: unknown) => v as T;

  // ---- portfolio / history ----
  if (p.startsWith("/portfolio/")) {
    const address = p.slice("/portfolio/".length);
    // Vault addresses (keyed off predict, so pre-deploy fetches are right too)
    // show only what was actually moved into them; wallets show the rich
    // holdings adjusted by any deposits/withdrawals.
    const isVault = readSet(VAULTS).has(vaultKey("base", address));
    if (!isVault) {
      try {
        localStorage.setItem(WALLET_ADDR, address.toLowerCase());
      } catch {
        /* ignore */
      }
    }
    return out(buildPortfolio(address, isVault ? vaultHoldings(address) : walletHoldings()));
  }
  if (p.startsWith("/history/")) {
    const address = p.slice("/history/".length).toLowerCase();
    // Real demo moves (deposits, sends, swaps) newest-first; wallets also get
    // a canned backstory below them. Fresh vaults start with no history.
    const mine: Transfer[] = readEvents()
      .filter((e) => e.from === address || e.to === address)
      .reverse()
      .map((e) => ({
        chain: e.chain as Transfer["chain"],
        hash: e.hash as Transfer["hash"],
        from: e.from,
        to: e.to,
        direction: e.to === address ? "in" : "out",
        asset: e.asset,
        value: e.value,
        blockNum: e.blockNum,
      }));
    const isVault = readSet(VAULTS).has(`base:${address}`);
    const backstory = isVault ? [] : demoHistory(address).transfers;
    return out({ transfers: [...mine, ...backstory] });
  }

  // ---- swaps / raw tx rail ----
  if (p === "/swap/quote")
    return out(
      quote(
        q.get("chain") as SwapChain,
        q.get("tokenIn") ?? "native",
        q.get("tokenOut") ?? "native",
        q.get("amountIn") ?? "0",
        Number(q.get("slippageBps") ?? 50)
      )
    );
  if (p === "/swap/build") {
    const qt = quote(b.chain, b.tokenIn, b.tokenOut, b.amountIn, b.slippageBps ?? 50);
    const router = detAddress("universal-router");
    if (b.recipient) {
      const inMeta = metaFor(b.chain, qt.tokenIn);
      const outMeta = metaFor(b.chain, qt.tokenOut);
      lastSwap = {
        router: router.toLowerCase(),
        recipient: String(b.recipient).toLowerCase(),
        inKey: assetKey(b.chain, qt.tokenIn === "native" ? null : qt.tokenIn),
        inSymbol: inMeta.symbol,
        amountIn: Number(qt.amountIn) / 10 ** inMeta.decimals,
        outKey: assetKey(b.chain, qt.tokenOut === "native" ? null : qt.tokenOut),
        outSymbol: outMeta.symbol,
        amountOut: Number(qt.amountOut) / 10 ** outMeta.decimals,
      };
    }
    const res: BuildResult = {
      kind: "tx",
      to: router,
      value: qt.nativeIn ? qt.amountIn : "0",
      data: "0x",
      deadline: Math.floor(Date.now() / 1000) + 600,
      quote: qt,
    };
    return out(res);
  }
  if (p === "/tx/params") {
    const chainIds: Record<string, number> = { ethereum: 1, base: 8453 };
    const res: TxParams = {
      chainId: chainIds[q.get("chain") ?? "base"] ?? 8453,
      nonce: 7,
      maxFeePerGas: "1500000000",
      maxPriorityFeePerGas: "1000000",
      gas: "210000",
    };
    return out(res);
  }
  if (p === "/tx/broadcast") {
    if (pendingDeploy) {
      const s = readSet(DEPLOYED);
      s.add(vaultKey("base", pendingDeploy));
      writeSet(DEPLOYED, s);
      pendingDeploy = null;
    }
    // Decode the signed tx and apply it to the ledger + activity feed:
    // wallet -> vault deposits, wallet -> external sends, and wallet swaps
    // (call to the mock router). Vault-outgoing is handled at cosign.
    const hash = randHex(32);
    try {
      const chain = String(b.chain ?? "base");
      const tx = parseTransaction(b.raw as Hex);
      const vaults = readSet(VAULTS);
      const dataStr = (tx.data ?? "0x") as string;
      const toLower = (tx.to ?? "").toLowerCase();
      const wallet = walletAddr();
      const nativeSym = metaFor(chain as SwapChain, "native").symbol;
      const isWalletSwap = lastSwap != null && toLower === lastSwap.router;
      if (isWalletSwap && lastSwap) {
        creditWallet(lastSwap.inKey, -lastSwap.amountIn);
        creditWallet(lastSwap.outKey, lastSwap.amountOut);
        recordEvent({ chain, hash, from: wallet, to: lastSwap.router, asset: lastSwap.inSymbol, value: lastSwap.amountIn });
        recordEvent({ chain, hash, from: lastSwap.router, to: wallet, asset: lastSwap.outSymbol, value: lastSwap.amountOut });
        lastSwap = null;
      } else if (tx.to && dataStr === "0x" && (tx.value ?? 0n) > 0n) {
        const amt = Number(tx.value) / 1e18;
        creditWallet(assetKey(chain, null), -amt);
        if (vaults.has(vaultKey("base", tx.to))) creditVault(tx.to, assetKey(chain, null), amt);
        recordEvent({ chain, hash, from: wallet, to: toLower, asset: nativeSym, value: amt });
      } else if (tx.to) {
        const t = parseErc20Transfer(dataStr);
        if (t) {
          const m = metaFor(chain as SwapChain, tx.to);
          const amt = Number(t.amount) / 10 ** m.decimals;
          creditWallet(assetKey(chain, tx.to), -amt);
          if (vaults.has(vaultKey("base", t.to))) creditVault(t.to, assetKey(chain, tx.to), amt);
          recordEvent({ chain, hash, from: wallet, to: t.to, asset: m.symbol, value: amt });
        }
      }
    } catch {
      /* unparseable raw tx — ignore, demo broadcast still succeeds */
    }
    return out({ hash });
  }
  if (p === "/tx/receipt") return out({ receipt: { status: "success", blockNumber: "33412991" } });

  // ---- vault (Safe) ----
  if (p === "/vault/predict" || p === "/vault/deploy/build") {
    const addr = detAddress(
      `vault:${b.chain}:${(b.owners ?? []).map((o: string) => o.toLowerCase()).join(",")}:${b.threshold}:${b.saltNonce ?? ""}`
    );
    const vs = readSet(VAULTS);
    vs.add(vaultKey("base", addr));
    writeSet(VAULTS, vs);
    if (p === "/vault/predict") return out({ address: addr });
    pendingDeploy = addr;
    return out({ safeAddress: addr, to: detAddress("safe-proxy-factory"), value: "0", data: "0x" });
  }
  if (p === "/vault/deployed")
    return out({ deployed: readSet(DEPLOYED).has(vaultKey(q.get("chain") ?? "base", q.get("address") ?? "")) });
  if (p === "/vault/tx/build") {
    const data: SafeTxData = {
      to: b.to,
      value: String(b.value ?? "0"),
      data: b.data ?? "0x",
      operation: b.operation ?? 0,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: "0x0000000000000000000000000000000000000000",
      refundReceiver: "0x0000000000000000000000000000000000000000",
      nonce: 0,
    };
    return out({ safeTxHash: randHex(32), safeTxData: data });
  }
  if (p === "/vault/tx/exec/build") return out({ to: b.safeAddress, value: "0", data: "0x" });
  if (p === "/vault/tx/propose" || p === "/vault/tx/confirm") return out({ ok: true });
  if (p === "/vault/tx" || p === "/vault/tx/signatures" || p === "/vault/tx/pending") {
    const empty: PendingVaultTx[] = [];
    if (p === "/vault/tx/pending") return out({ pending: empty });
    if (p === "/vault/tx/signatures") return out({ signatures: [] });
    throw new Error("demo: no pending SafeTx");
  }

  // ---- co-signer / policy ----
  if (p === "/vault/cosigner") return out({ enabled: true, address: COSIGNER });
  if (p === "/vault/cosign") {
    const cfg = getPolicy(b.chain, b.safeAddress);
    // Apply the approved SafeTx to the vault's ledger: ETH out, ERC-20 out,
    // and (for vault swaps) the quoted output coming back in.
    try {
      const chain = String(b.chain ?? "base");
      const vault = String(b.safeAddress).toLowerCase();
      const std = (b.safeTxData ?? {}) as Record<string, any>;
      const val = BigInt(std.value ?? "0");
      const toLower = String(std.to ?? "").toLowerCase();
      const txHash = String(b.safeTxHash ?? randHex(32));
      const nativeSym = metaFor(chain as SwapChain, "native").symbol;
      // A vault swap is a call to the (mock) router with the vault as recipient
      // — its output lands back in the vault, never in the wallet.
      const isSwap = lastSwap != null && lastSwap.router === toLower && lastSwap.recipient === vault;
      if (val > 0n) creditVault(vault, assetKey(chain, null), -Number(val) / 1e18);
      const t = parseErc20Transfer(String(std.data ?? "0x"));
      if (t && std.to) {
        const m = metaFor(chain as SwapChain, std.to);
        const amt = Number(t.amount) / 10 ** m.decimals;
        creditVault(vault, assetKey(chain, std.to), -amt);
        // Withdraw to wallet: credit the wallet side back.
        if (!isSwap && !readSet(VAULTS).has(vaultKey("base", t.to)))
          creditWallet(assetKey(chain, std.to), amt);
        if (!isSwap) recordEvent({ chain, hash: txHash, from: vault, to: t.to, asset: m.symbol, value: amt });
      } else if (!isSwap && val > 0n && std.to && !readSet(VAULTS).has(vaultKey("base", std.to))) {
        creditWallet(assetKey(chain, null), Number(val) / 1e18);
      }
      if (!isSwap && val > 0n && std.to) {
        recordEvent({ chain, hash: txHash, from: vault, to: toLower, asset: nativeSym, value: Number(val) / 1e18 });
      }
      if (isSwap && lastSwap) {
        creditVault(vault, lastSwap.outKey, lastSwap.amountOut);
        recordEvent({ chain, hash: txHash, from: vault, to: lastSwap.router, asset: lastSwap.inSymbol, value: lastSwap.amountIn });
        recordEvent({ chain, hash: txHash, from: lastSwap.router, to: vault, asset: lastSwap.outSymbol, value: lastSwap.amountOut });
        lastSwap = null;
      }
    } catch {
      /* ledger is best-effort — cosign still succeeds */
    }
    const res: CosignResult = {
      ok: true,
      policy: { ok: true, checks: policyChecks(cfg) },
      signature: { signer: COSIGNER, data: `0x${"11".repeat(64)}1b` as `0x${string}` },
    };
    return out(res);
  }
  if (p === "/vault/policy" && method === "GET")
    return out({ config: getPolicy(q.get("chain") ?? "base", q.get("safeAddress") ?? "") });
  if (p === "/vault/policy") {
    try {
      localStorage.setItem(POLICY + vaultKey(b.chain, b.safeAddress), JSON.stringify(b.config ?? {}));
    } catch {
      /* ignore */
    }
    return out({ ok: true, config: b.config ?? {} });
  }

  // ---- WebAuthn / phone Face ID ----
  if (p === "/vault/webauthn/registered")
    return out({ registered: readSet(ENROLLED).has(vaultKey(q.get("chain") ?? "base", q.get("safeAddress") ?? "")) });
  if (p === "/vault/webauthn/register/options" || p === "/vault/webauthn/auth/options") return out({});
  if (p === "/vault/webauthn/register/verify") return out({ verified: true });
  if (p === "/vault/webauthn/phone/start" || p === "/vault/webauthn/phone/approve/start") {
    const token = randHex(8).slice(2);
    const kind = p.endsWith("approve/start") ? "approve" : "enroll";
    phoneSessions.set(token, { kind, chain: b.chain, safeAddress: b.safeAddress, start: Date.now() });
    const code = token.slice(0, 6).toUpperCase();
    return out({ token, url: `https://useark.app/e/${code}` });
  }
  if (p.startsWith("/vault/webauthn/phone/poll/")) {
    const token = p.slice("/vault/webauthn/phone/poll/".length);
    const s = phoneSessions.get(token);
    if (!s) return out({ status: "expired" });
    if (Date.now() - s.start < PHONE_APPROVE_MS) return out({ status: "pending" });
    if (s.kind === "enroll") {
      const e = readSet(ENROLLED);
      e.add(vaultKey(s.chain, s.safeAddress));
      writeSet(ENROLLED, e);
    }
    return out({ status: "done", result: { demo: true, verified: true } });
  }

  // ---- stealth ----
  if (p === "/stealth/announce") {
    stealthItems.push({
      id: stealthItems.length + 1,
      chain: b.chain,
      stealthAddress: b.stealthAddress,
      ephemeralPub: b.ephemeralPub,
      viewTag: b.viewTag,
      ts: Date.now(),
    });
    return out({ ok: true, id: stealthItems.length });
  }
  if (p === "/stealth/announcements") return out({ items: stealthItems, cursor: stealthItems.length });

  // ---- tokens / agent / trenches ----
  if (p.startsWith("/token/")) {
    const [, , chain, address] = p.split("/");
    const m = metaFor(chain as SwapChain, address);
    const res: TokenInfo = {
      address: address as `0x${string}`,
      symbol: m.symbol,
      name: m.name,
      decimals: m.decimals,
      logo: null,
    };
    return out(res);
  }
  if (p === "/agent/gate") {
    const res: AgentGate = {
      address: q.get("address") ?? "",
      token: ARK_TOKEN,
      balance: "15000",
      priceUsd: 0.42,
      usd: 6_300,
      requiredUsd: 500,
      ok: true,
    };
    return out(res);
  }
  if (p === "/agent/chat") {
    const res: ChatResponse = {
      content: [
        {
          type: "text",
          text: "I checked the vault: 0.75 ETH and 1,200 USDC available, policy cap $500 per transaction with Face ID required. What would you like me to do?",
        },
      ],
      stop_reason: "end_turn",
    };
    return out(res);
  }
  if (p.startsWith("/trenches/")) return out(demoTrenches());

  console.warn(`[ark-demo] unmocked ${method} ${path}`);
  throw new Error(`demo mode: no mock for ${path}`);
}

const stealthItems: StealthAnnouncementItem[] = [];

/* --------------------- Rust vault-core stubs (browser) --------------------- */
/*
 * Used ONLY when demo mode runs outside Tauri (plain `npm run dev` in a
 * browser), where the Rust invoke bridge doesn't exist. Inside the Tauri app
 * the REAL key core runs even in demo mode. Never enter a real recovery
 * phrase in browser demo mode — this stub is not a key store.
 */

// A well-known BIP-39 TEST vector — never holds real funds.
export const DEMO_MNEMONIC =
  "gravity machine north sort system female filter attitude volume fold club stay";

const RUST = "ark.demo.rust";

interface RustState {
  accounts: { index: number; address: string }[];
}

function rustState(): RustState | null {
  try {
    const raw = localStorage.getItem(RUST);
    return raw ? (JSON.parse(raw) as RustState) : null;
  } catch {
    return null;
  }
}

function saveRust(s: RustState): void {
  try {
    localStorage.setItem(RUST, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

const DUMMY_SIG = `0x${"22".repeat(64)}1b`;

export async function demoInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  await sleep(120 + Math.random() * 180);
  const a = (args ?? {}) as Record<string, any>;
  const s = rustState();

  switch (cmd) {
    case "vault_exists":
      return s != null;
    case "create_vault": {
      const address = mnemonicToAccount(DEMO_MNEMONIC).address;
      saveRust({ accounts: [{ index: 0, address }] });
      return { mnemonic: DEMO_MNEMONIC, account: { index: 0, address } };
    }
    case "import_vault": {
      // Derive account 0 so the UI shows a consistent address, then DROP the
      // phrase — this stub never persists secrets.
      const address = mnemonicToAccount(String(a.mnemonic ?? DEMO_MNEMONIC)).address;
      saveRust({ accounts: [{ index: 0, address }] });
      return { index: 0, address };
    }
    case "unlock_vault":
    case "list_accounts":
      if (!s) throw new Error("no vault");
      return s.accounts;
    case "lock_vault":
      return undefined;
    case "add_account": {
      if (!s) throw new Error("no vault");
      const derived = s.accounts.filter((x) => x.index < 0x1000_0000);
      const index = derived.length;
      const account = { index, address: detAddress(`account:${index}`) };
      saveRust({ accounts: [...s.accounts, account] });
      return account;
    }
    case "import_account": {
      if (!s) throw new Error("no vault");
      const imported = s.accounts.filter((x) => x.index >= 0x1000_0000);
      const index = 0x1000_0000 + imported.length;
      const account = { index, address: detAddress(`imported:${index}`) };
      saveRust({ accounts: [...s.accounts, account] });
      return account;
    }
    case "sign_hash":
    case "stealth_sign":
      return DUMMY_SIG;
    case "reveal_mnemonic":
      return DEMO_MNEMONIC;
    case "reveal_private_key":
      return `0x${"ab".repeat(32)}`;
    case "stealth_meta_address":
      return {
        spendPub: `02${keccak256(stringToHex("demo-spend")).slice(2, 66)}`,
        viewPub: `03${keccak256(stringToHex("demo-view")).slice(2, 66)}`,
        meta: `st:base:0x02${keccak256(stringToHex("demo-spend")).slice(2, 66)}03${keccak256(stringToHex("demo-view")).slice(2, 66)}`,
      };
    case "stealth_send_compute":
      return {
        stealthAddress: detAddress(`stealth:${stealthItems.length}`),
        ephemeralPub: `02${keccak256(stringToHex(`eph:${stealthItems.length}`)).slice(2, 66)}`,
        viewTag: 42,
      };
    case "stealth_scan":
      return [];
    case "list_usb_devices":
      return [
        {
          id: "1050:0407:0012345",
          vendor_id: "1050",
          product_id: "0407",
          product: "YubiKey 5 NFC",
          manufacturer: "Yubico",
          serial: "0012345",
          kind: "security-key",
          can_store_file: false,
        },
      ];
    case "list_bluetooth_devices":
      return [{ id: "a4:83:e7:2f:19:b0", name: "iPhone", connected: true }];
    case "get_location":
      return { lat: 40.4168, lng: -3.7038, accuracy_m: 12 };
    default:
      console.warn(`[ark-demo] unmocked invoke ${cmd}`);
      throw new Error(`demo mode: no mock for invoke ${cmd}`);
  }
}

/** True when the Tauri invoke bridge is present (running inside the app). */
export const hasTauriBridge = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
