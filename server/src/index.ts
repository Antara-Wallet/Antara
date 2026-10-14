import express from "express";
import cors from "cors";
import QRCode from "qrcode";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { walletRouter } from "./solares/wallet.js";
import relayRouter from "./solares/relay.js";
import { pairedVaultRouter } from "./solares/pairedVault.js";
import { frontendRouter } from "./solares/frontend.js";
import { solanaRpcRouter } from "./solares/solanaRpcProxy.js";
import { CLIENT_IP_HEADER_SETTING, describeClientIpStrategy } from "./solares/clientIp.js";
import { NETWORK_KEYS, PRIMARY_NETWORK } from "../../src/solares/networks.js";
import { isAddress, recoverMessageAddress } from "viem";
import {
  PORT,
  ALLOWED_ORIGINS,
  WEB_ORIGIN,
  hasAlchemy,
  hasGmgn,
  hasSafeApi,
  hasCosigner,
  TRUST_PROXY,
  CLIENT_IP_HEADER,
  CLIENT_IP_HEADER_EXPLICIT,
  ALCHEMY_API_KEY,
  GMGN_API_KEY,
  ONEINCH_API_KEY,
  SAFE_API_KEY,
  ANTHROPIC_API_KEY,
  COSIGNER_PRIVATE_KEY,
  COSIGNER_ADDRESS,
} from "./config.js";
import { getPortfolio, getHistory, getTokenInfo } from "./providers/alchemy.js";
import { getPrices } from "./providers/defillama.js";
import { getTrending, getTokenSafety } from "./providers/gmgn.js";
import {
  getTrenches,
  getTrenchesAll,
  type TrenchChain,
  type TrenchType,
} from "./providers/gmgn-trenches.js";
import { getQuote, buildSwap, resolveToken, type ChainId } from "./providers/uniswap.js";
import { getTxParams, broadcastRaw, getReceipt } from "./providers/rpc.js";
import {
  predictVaultAddress,
  buildVaultDeployment,
  isVaultDeployed,
  buildVaultTx,
  encodeVaultExec,
  hashVaultTx,
  type SafeAccountConfig,
  type SafeTxData,
  type OwnerSignature,
} from "./providers/safe.js";
import { cosignerAddress, cosignSafeTx, publicCosignerAddress } from "./providers/cosigner.js";
import { type PolicyFactors } from "./providers/policy.js";
import { getPolicy, setPolicy, sanitizePolicy } from "./providers/policyStore.js";
import { addAnnouncement, listAnnouncements } from "./providers/stealthStore.js";
import { checkArkGate } from "./providers/agentGate.js";
import { agentChat } from "./providers/agentChat.js";
import { hasAnthropic } from "./config.js";
import {
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
  hasCredential,
  clearAllCredentials,
} from "./providers/webauthn.js";
import {
  proposeVaultTx,
  confirmVaultTx,
  getVaultTx,
  listPendingVaultTxs,
  collectSignatures,
} from "./providers/safeTxService.js";

// Legacy desktop routes have pinned Alchemy/Uniswap data for Ethereum and Base
// only (see config.ts CHAINS); every other network fails closed here.
const SWAP_CHAINS = new Set<ChainId>(["ethereum", "base"]);

const app = express();
app.disable("x-powered-by");
// Only the configured proxy hops are trusted for req.ip. Per-IP rate limits and
// the Wi-Fi layer read clientIp(req): the edge header when one is configured
// (Render: CF-Connecting-IP), otherwise req.ip. See solares/clientIp.ts.
app.set("trust proxy", TRUST_PROXY);
app.set(CLIENT_IP_HEADER_SETTING, CLIENT_IP_HEADER);
app.use(express.json({ limit: "256kb" }));
// Retry-After is exposed so cross-origin clients (Desktop, the extension) can read lockout and rate-limit waits.
app.use(cors({ origin: ALLOWED_ORIGINS, exposedHeaders: ["Retry-After"] }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  // Arbitrary scripts, framing and plugins are blocked. Network destinations
  // remain HTTPS/WSS-capable for configured RPCs and external wallet providers.
  // Privy CAPTCHA is off, so no Turnstile or hCaptcha host may load script or
  // frames (same policy as src-tauri/tauri.conf.json).
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https:; connect-src 'self' https: wss:; frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api/solares/wallet", walletRouter);
app.use("/api/solares/relay", relayRouter);
app.use("/api/solares/paired-vault", pairedVaultRouter());
app.use("/api/solares/rpc/solana", solanaRpcRouter());

// Existing desktop features remain available only by explicit operator opt-in.
// These routes use the legacy desktop identity and must never become an
// unauthenticated alternative to the Privy-authorized ANTARA browser API.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
app.use((req, res, next) => {
  const legacyMutation = !SAFE_METHODS.has(req.method) && !req.path.startsWith("/api/solares/");
  if (legacyMutation && (process.env.ANTARA_ENABLE_LEGACY_API ?? process.env.AETHRA_ENABLE_LEGACY_API ?? process.env.SOLARES_ENABLE_LEGACY_API) !== "true") {
    return res.status(403).json({ error: "Legacy desktop operations are disabled. Use the ANTARA wallet workspace." });
  }
  next();
});

const bad = (res: express.Response, msg: string) =>
  res.status(400).json({ error: msg });

// Provider errors (viem, Safe, fetch) can embed credential-bearing RPC URLs such
// as Alchemy's /v2/<key>. Clients get a fixed message; the server log keeps a
// redacted line without URLs or configured secrets. RPC URLs can carry the key
// in the path or query (/v2/<key>, ?api-key=), so those parts count on their own.
function urlSecrets(value: string): string[] {
  try {
    const url = new URL(value);
    return [value, url.pathname + url.search, url.search, url.password, ...url.pathname.split("/"), ...url.searchParams.values()];
  } catch {
    return [value];
  }
}
const SECRET_VALUES = [...new Set([
  ALCHEMY_API_KEY, GMGN_API_KEY, ONEINCH_API_KEY, SAFE_API_KEY, ANTHROPIC_API_KEY, COSIGNER_PRIVATE_KEY, COSIGNER_PRIVATE_KEY.replace(/^0x/i, ""),
  ...["PRIVY_APP_SECRET", "RELAY_API_KEY", "ANTARA_ADMIN_SECRET", "AETHRA_ADMIN_SECRET", "SOLARES_ADMIN_SECRET", "ARK_ADMIN_SECRET"].map((name) => process.env[name] ?? ""),
  ...Object.entries(process.env).filter(([name]) => name.endsWith("_RPC_URL")).flatMap(([, value]) => urlSecrets(value ?? "")),
])].filter((v) => v.length >= 8).sort((a, b) => b.length - a.length); // a whole URL before its parts
// viem messages echo whole request bodies (a raw tx can approach the 256 KB body
// limit). Secrets are split out in linear time and the text is bounded before any
// regex runs, so backtracking cannot stall the event loop.
export function redactError(e: unknown): string {
  let text = e instanceof Error ? e.message : String(e);
  for (const secret of SECRET_VALUES) text = text.split(secret).join("[redacted]");
  return text
    .slice(0, 2_000)
    .replace(/[a-z][a-z\d+.-]{0,31}:\/\/\S+/gi, "[url]")
    .replace(/\/v2\/[^\s/"']+/g, "/v2/[redacted]")
    .replace(/\s*\n\s*/g, " | ")
    .slice(0, 300);
}
const fail = (res: express.Response, status: number, message: string, e: unknown) => {
  console.warn(`[api] ${res.req.method} ${res.req.route?.path ?? "route"} failed: ${redactError(e)}`);
  res.status(status).json({ error: message });
};

// Integer query parameter clamped to [min, max]; missing or non-numeric -> fallback.
const intQuery = (value: unknown, fallback: number, min: number, max: number) => {
  const n = typeof value === "string" && value.trim() !== "" ? Math.trunc(Number(value)) : fallback;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    build: "antara-2026-10-12",
    engine: "privy-multisig-relay",
    // Supported networks in display order, from the shared registry.
    primaryChain: PRIMARY_NETWORK,
    chains: NETWORK_KEYS,
    providers: {
      privy: !!process.env.PRIVY_APP_ID && !!process.env.PRIVY_APP_SECRET,
      relay: !!process.env.RELAY_API_KEY,
      alchemy: hasAlchemy(),
      defillama: true,
      gmgn: hasGmgn(),
      safeTxService: hasSafeApi(),
      cosigner: hasCosigner(),
    },
    legacyEnabled: (process.env.ANTARA_ENABLE_LEGACY_API ?? process.env.AETHRA_ENABLE_LEGACY_API ?? process.env.SOLARES_ENABLE_LEGACY_API) === "true",
  });
});

// QR image generator: GET /qr?d=<text> -> PNG. Lets an agent embed a scannable
// QR as a normal image URL (markdown), since some chat UIs (e.g. Bankr) do not
// render MCP image content blocks. Self-hosted so the encoded link never leaves
// our infrastructure.
app.get("/qr", async (req, res) => {
  const d = String(req.query.d ?? "");
  if (!d || d.length > 1024) return bad(res, "d (text to encode, up to 1024 chars) required");
  try {
    const png = await QRCode.toBuffer(d, { type: "png", margin: 1, width: 320 });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.send(png);
  } catch (e) {
    fail(res, 500, "QR code could not be generated.", e);
  }
});

// QR by session token + page kind (e = enroll, a = approve). A short clean URL,
// no query string, so agents reproduce it and chat image proxies fetch it.
// Stateless QR PNG for a short code: encodes the case-insensitive short link.
// Keyed by CODE (not the session token) so an agent that lowercases the URL
// still produces a working QR. Optional .png suffix for renderers that need it.
app.get("/qr/c/:code", async (req, res) => {
  const code = req.params.code.replace(/\.png$/i, "").toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return bad(res, "invalid qr request");
  try {
    const png = await QRCode.toBuffer(`${WEB_ORIGIN}/e/${code}`, {
      type: "png",
      margin: 2,
      width: 320,
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(png);
  } catch (e) {
    fail(res, 500, "QR code could not be generated.", e);
  }
});

app.get("/qr/:kind/:token", async (req, res) => {
  const page = req.params.kind === "e" ? "enroll" : req.params.kind === "a" ? "approve" : null;
  const token = req.params.token.replace(/\.png$/i, "");
  if (!page || !token || !/^[A-Za-z0-9_-]+$/.test(token)) return bad(res, "invalid qr request");
  try {
    const png = await QRCode.toBuffer(`${WEB_ORIGIN}/${page}?s=${token}`, {
      type: "png",
      margin: 1,
      width: 320,
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(png);
  } catch (e) {
    fail(res, 500, "QR code could not be generated.", e);
  }
});

// Admin: wipe ALL enrolled Face ID credentials (e.g. to re-run a fresh demo).
// Requires the x-admin-secret header to match ARK_ADMIN_SECRET.
app.post("/admin/clear-credentials", (req, res) => {
  const secret = process.env.ANTARA_ADMIN_SECRET || process.env.AETHRA_ADMIN_SECRET || process.env.SOLARES_ADMIN_SECRET || process.env.ARK_ADMIN_SECRET;
  if (!secret || req.headers["x-admin-secret"] !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const cleared = clearAllCredentials();
  res.json({ ok: true, clearedVaults: cleared });
});

// Portfolio: native + ERC-20 balances valued in USD, across all chains.
app.get("/portfolio/:address", async (req, res) => {
  const { address } = req.params;
  if (!isAddress(address)) return bad(res, "invalid address");
  try {
    res.json(await getPortfolio(address));
  } catch (e) {
    fail(res, 502, "Portfolio data is temporarily unavailable.", e);
  }
});

// History: recent transfers (on-demand).
app.get("/history/:address", async (req, res) => {
  const { address } = req.params;
  if (!isAddress(address)) return bad(res, "invalid address");
  try {
    res.json({ transfers: await getHistory(address) });
  } catch (e) {
    fail(res, 502, "Transaction history is temporarily unavailable.", e);
  }
});

// Prices: pass ?ids=coingecko:ethereum,base:0x...
app.get("/prices", async (req, res) => {
  const ids = String(req.query.ids ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return bad(res, "ids required");
  try {
    res.json(await getPrices(ids));
  } catch (e) {
    fail(res, 502, "Prices are temporarily unavailable.", e);
  }
});

// GMGN intel (read-only, fail-soft).
app.get("/intel/trending/:chain", async (req, res) => {
  const chain = req.params.chain === "base" ? "base" : "eth";
  res.json({ tokens: await getTrending(chain) });
});

app.get("/intel/safety/:chain/:address", async (req, res) => {
  const chain = req.params.chain === "base" ? "base" : "eth";
  const { address } = req.params;
  if (!isAddress(address)) return bad(res, "invalid address");
  res.json({ safety: await getTokenSafety(chain, address) });
});

// Trenches: new-launch terminal feed (read-only, fail-soft). EVM = Base + BSC.
//   GET /trenches/:chain            -> all three stages in one response
//   GET /trenches/:chain?type=new_creation  -> a single stage
const TRENCH_TYPES = new Set<TrenchType>([
  "new_creation",
  "near_completion",
  "completed",
]);

// The limit is forwarded upstream and keys the shared cache, so it is clamped.
const TRENCH_LIMIT_MAX = 60;
app.get("/trenches/:chain", async (req, res) => {
  const chain: TrenchChain = req.params.chain === "bsc" ? "bsc" : "base";
  const lim = intQuery(req.query.limit, TRENCH_LIMIT_MAX, 1, TRENCH_LIMIT_MAX);
  if (req.query.type != null) {
    const type = String(req.query.type) as TrenchType;
    if (!TRENCH_TYPES.has(type)) return bad(res, "invalid type");
    return res.json({ tokens: await getTrenches(chain, type, lim) });
  }
  res.json(await getTrenchesAll(chain, lim));
});

// Uniswap v3 swap quote (read-only). amountIn is raw smallest-unit (wei).
//   GET /swap/quote?chain=base&tokenIn=native&tokenOut=0x..&amountIn=..&slippageBps=50
// Hosted agent chat. Gated by $ARK holdings. ARK runs the LLM; spend tools the
// model calls are executed client-side (signed with the agent key), never here.
app.post("/agent/chat", async (req, res) => {
  const b = req.body ?? {};
  const owner = String(b.ownerAddress ?? "");
  const vault = String(b.vaultAddress ?? "");
  if (!isAddress(owner)) return bad(res, "valid ownerAddress required");
  if (!isAddress(vault)) return bad(res, "valid vaultAddress required");
  if (!Array.isArray(b.messages)) return bad(res, "messages array required");
  if (!hasAnthropic()) return res.status(503).json({ error: "hosted agent not configured" });
  try {
    const gate = await checkArkGate(owner);
    if (!gate.ok) {
      return res.status(402).json({
        error: `Hold $${gate.requiredUsd} of $ARK to use the hosted agent (you have $${gate.usd.toFixed(2)}).`,
        gate,
      });
    }
  } catch {
    return res.status(502).json({ error: "could not verify $ARK balance" });
  }
  try {
    res.json(await agentChat({ vaultAddress: vault, messages: b.messages }));
  } catch (e) {
    fail(res, 502, "The hosted agent could not respond. Try again shortly.", e);
  }
});

// $ARK holder gate for the hosted agent: does this wallet hold >= $50 of $ARK?
app.get("/agent/gate", async (req, res) => {
  const address = String(req.query.address ?? "");
  if (!isAddress(address)) return bad(res, "valid address required");
  try {
    res.json(await checkArkGate(address));
  } catch (e) {
    fail(res, 502, "The $ARK holder check is temporarily unavailable.", e);
  }
});

// Resolve an arbitrary ERC-20 by address (symbol / decimals / logo) so the swap
// UI can add any token, including a brand-new one, by pasting its address.
app.get("/token/:chain/:address", async (req, res) => {
  const chain = String(req.params.chain) as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  const address = String(req.params.address);
  if (!isAddress(address)) return bad(res, "valid address required");
  try {
    res.json(await getTokenInfo(chain, address));
  } catch (e) {
    fail(res, 404, "token not found", e);
  }
});

// Caller mistakes get a 400 with fixed, data-free text before any provider call.
// Provider failures stay generic, except "no route", which the desktop SwapModal
// turns into liquidity guidance.
function swapInputError(chain: ChainId, tokenIn: string, tokenOut: string, amountIn: bigint): string | null {
  if (amountIn <= 0n) return "amountIn must be > 0";
  try {
    const same = resolveToken(chain, tokenIn).address.toLowerCase() === resolveToken(chain, tokenOut).address.toLowerCase();
    return same ? "tokenIn and tokenOut resolve to the same token" : null;
  } catch {
    return 'tokenIn and tokenOut must be token addresses or "native"';
  }
}
const swapFailure = (e: unknown, fallback: string) =>
  /^no [^\n]*route/i.test(e instanceof Error ? e.message : String(e)) ? "no route found for this pair" : fallback;

app.get("/swap/quote", async (req, res) => {
  const chain = String(req.query.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  const tokenIn = String(req.query.tokenIn ?? "");
  const tokenOut = String(req.query.tokenOut ?? "");
  if (!tokenIn || !tokenOut) return bad(res, "tokenIn and tokenOut required");

  let amountIn: bigint;
  try {
    amountIn = BigInt(String(req.query.amountIn ?? ""));
  } catch {
    return bad(res, "amountIn must be an integer (smallest unit)");
  }
  const invalid = swapInputError(chain, tokenIn, tokenOut, amountIn);
  if (invalid) return bad(res, invalid);

  const slipRaw = Number(req.query.slippageBps ?? 50);
  const slippageBps = isFinite(slipRaw) ? Math.max(1, Math.min(5000, slipRaw)) : 50;

  try {
    res.json(await getQuote(chain, tokenIn, tokenOut, amountIn, slippageBps));
  } catch (e) {
    fail(res, 502, swapFailure(e, "No swap quote is available for this pair right now."), e);
  }
});

// Build a Universal Router swap tx. POST JSON:
//   { chain, tokenIn, tokenOut, amountIn, recipient, slippageBps?, permit? }
// Native-in => returns { kind:"tx", ... } directly.
// ERC-20-in => first returns { kind:"permit_required", ... }; re-POST with the
// signed `permit` to get the final tx.
app.post("/swap/build", async (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!b.tokenIn || !b.tokenOut) return bad(res, "tokenIn and tokenOut required");
  if (!isAddress(String(b.recipient ?? ""))) return bad(res, "valid recipient required");

  let amountIn: bigint;
  try {
    amountIn = BigInt(String(b.amountIn ?? ""));
  } catch {
    return bad(res, "amountIn must be an integer (smallest unit)");
  }
  const invalid = swapInputError(chain, String(b.tokenIn), String(b.tokenOut), amountIn);
  if (invalid) return bad(res, invalid);

  const slipRaw = Number(b.slippageBps ?? 50);
  const slippageBps = isFinite(slipRaw) ? Math.max(1, Math.min(5000, slipRaw)) : 50;

  try {
    res.json(
      await buildSwap({
        chain,
        tokenIn: String(b.tokenIn),
        tokenOut: String(b.tokenOut),
        amountIn,
        recipient: b.recipient,
        slippageBps,
        permit: b.permit,
      })
    );
  } catch (e) {
    fail(res, 502, swapFailure(e, "The swap could not be built. Request a new quote."), e);
  }
});

// Tx params for building an EIP-1559 tx (nonce/fees/gas/chainId).
//   GET /tx/params?chain=&from=&to=&value=&data=
app.get("/tx/params", async (req, res) => {
  const chain = String(req.query.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  if (!isAddress(from) || !isAddress(to)) return bad(res, "valid from and to required");
  let value: bigint;
  try {
    value = BigInt(String(req.query.value ?? "0"));
  } catch {
    return bad(res, "value must be an integer");
  }
  const data = (String(req.query.data ?? "0x") || "0x") as `0x${string}`;
  try {
    res.json(await getTxParams(chain, from, to, value, data));
  } catch (e) {
    fail(res, 502, "Transaction parameters are temporarily unavailable.", e);
  }
});

// Fixed categories the desktop maps to guidance (src/lib/errors.ts); the node's
// raw text is never returned because viem includes the RPC URL in it.
function broadcastFailure(e: unknown): string {
  const low = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (low.includes("insufficient funds")) return "insufficient funds for gas";
  if (low.includes("nonce")) return "nonce conflict; refresh and retry";
  if (low.includes("revert")) return "execution reverted";
  return "The transaction could not be broadcast.";
}

// Broadcast a pre-signed raw tx. POST { chain, raw }
app.post("/tx/broadcast", async (req, res) => {
  const chain = String(req.body?.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  const raw = String(req.body?.raw ?? "");
  if (!raw.startsWith("0x")) return bad(res, "raw tx required");
  try {
    res.json({ hash: await broadcastRaw(chain, raw as `0x${string}`) });
  } catch (e) {
    fail(res, 502, broadcastFailure(e), e);
  }
});

// Poll a tx receipt. GET /tx/receipt?chain=&hash=
app.get("/tx/receipt", async (req, res) => {
  const chain = String(req.query.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  const hash = String(req.query.hash ?? "");
  if (!hash.startsWith("0x")) return bad(res, "hash required");
  try {
    res.json({ receipt: await getReceipt(chain, hash as `0x${string}`) });
  } catch (e) {
    fail(res, 502, "Transaction status is temporarily unavailable.", e);
  }
});

// --------------------------------------------------------------------------
// Vault (Safe smart account). protocol-kit only encodes/hashes; the device
// owner signs the SafeTx hash in the Rust core and we broadcast via /tx/*.
// --------------------------------------------------------------------------

// Parse + validate a Safe owner config from a request body.
function parseSafeConfig(b: Record<string, unknown>): SafeAccountConfig | string {
  const owners = Array.isArray(b.owners) ? b.owners.map(String) : [];
  if (owners.length === 0) return "owners required";
  if (!owners.every((o) => isAddress(o))) return "owners must be addresses";
  const threshold = Number(b.threshold ?? 0);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length)
    return "threshold must be 1..owners.length";
  const saltNonce = b.saltNonce != null ? String(b.saltNonce) : undefined;
  return { owners: owners as `0x${string}`[], threshold, saltNonce };
}

// Predict the deterministic vault address for an owner set. POST { chain, owners, threshold, saltNonce? }
app.post("/vault/predict", async (req, res) => {
  const chain = String(req.body?.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  const cfg = parseSafeConfig(req.body ?? {});
  if (typeof cfg === "string") return bad(res, cfg);
  try {
    res.json({ address: await predictVaultAddress(chain, cfg) });
  } catch (e) {
    fail(res, 502, "The vault address could not be computed.", e);
  }
});

// Build the one-time deployment tx (caller signs+broadcasts from an owner EOA).
// POST { chain, owners, threshold, saltNonce? } -> { safeAddress, to, value, data }
app.post("/vault/deploy/build", async (req, res) => {
  const chain = String(req.body?.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  const cfg = parseSafeConfig(req.body ?? {});
  if (typeof cfg === "string") return bad(res, cfg);
  try {
    res.json(await buildVaultDeployment(chain, cfg));
  } catch (e) {
    fail(res, 502, "The vault deployment could not be built.", e);
  }
});

// Is the vault deployed yet? GET /vault/deployed?chain=&address=
app.get("/vault/deployed", async (req, res) => {
  const chain = String(req.query.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  const address = String(req.query.address ?? "");
  if (!isAddress(address)) return bad(res, "valid address required");
  try {
    res.json({ deployed: await isVaultDeployed(chain, address) });
  } catch (e) {
    fail(res, 502, "Vault deployment status is temporarily unavailable.", e);
  }
});

// Build a SafeTx + its EIP-712 hash to sign in Rust.
// POST { chain, safeAddress, to, value, data, operation? } -> { safeTxHash, safeTxData }
app.post("/vault/tx/build", async (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!isAddress(String(b.safeAddress ?? ""))) return bad(res, "valid safeAddress required");
  if (!isAddress(String(b.to ?? ""))) return bad(res, "valid to required");
  let value: string;
  try {
    value = BigInt(String(b.value ?? "0")).toString();
  } catch {
    return bad(res, "value must be an integer");
  }
  const data = (String(b.data ?? "0x") || "0x") as `0x${string}`;
  try {
    res.json(
      await buildVaultTx(chain, b.safeAddress, {
        to: b.to,
        value,
        data,
        operation: Number(b.operation ?? 0),
      })
    );
  } catch (e) {
    fail(res, 502, "The vault transaction could not be built.", e);
  }
});

// Encode execTransaction once signatures are gathered (caller signs+broadcasts).
// POST { chain, safeAddress, safeTxData, signatures: [{signer,data}] } -> { to, value, data }
app.post("/vault/tx/exec/build", async (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!isAddress(String(b.safeAddress ?? ""))) return bad(res, "valid safeAddress required");
  if (b.safeTxData == null) return bad(res, "safeTxData required");
  const signatures = Array.isArray(b.signatures) ? (b.signatures as OwnerSignature[]) : [];
  if (signatures.length === 0) return bad(res, "at least one signature required");
  try {
    res.json(
      await encodeVaultExec(chain, b.safeAddress, b.safeTxData as SafeTxData, signatures)
    );
  } catch (e) {
    fail(res, 502, "The vault execution could not be built.", e);
  }
});

// ---- Multi-owner coordination via Safe Transaction Service (off-chain) ----

// Publish a SafeTx + proposer signature so other owners can co-sign.
// POST { chain, safeAddress, safeTxHash, safeTxData, proposer:{signer,data} } -> { ok }
app.post("/vault/tx/propose", async (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!isAddress(String(b.safeAddress ?? ""))) return bad(res, "valid safeAddress required");
  if (typeof b.safeTxHash !== "string") return bad(res, "safeTxHash required");
  if (b.safeTxData == null) return bad(res, "safeTxData required");
  const proposer = b.proposer as OwnerSignature | undefined;
  if (!proposer || !isAddress(String(proposer.signer ?? "")) || typeof proposer.data !== "string")
    return bad(res, "proposer {signer,data} required");
  try {
    await proposeVaultTx(chain, b.safeAddress, b.safeTxHash, b.safeTxData as SafeTxData, proposer);
    res.json({ ok: true });
  } catch (e) {
    fail(res, 502, "The vault transaction could not be shared with co-owners.", e);
  }
});

// Add another owner's signature to a proposed SafeTx.
// POST { chain, safeTxHash, signature } -> { ok }
app.post("/vault/tx/confirm", async (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (typeof b.safeTxHash !== "string") return bad(res, "safeTxHash required");
  if (typeof b.signature !== "string") return bad(res, "signature required");
  try {
    await confirmVaultTx(chain, b.safeTxHash as `0x${string}`, b.signature as `0x${string}`);
    res.json({ ok: true });
  } catch (e) {
    fail(res, 502, "The signature could not be recorded.", e);
  }
});

// State of one proposed SafeTx (confirmations gathered, ready?).
// GET /vault/tx?chain=&safeTxHash=
app.get("/vault/tx", async (req, res) => {
  const chain = String(req.query.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  const safeTxHash = String(req.query.safeTxHash ?? "");
  if (!safeTxHash) return bad(res, "safeTxHash required");
  try {
    res.json(await getVaultTx(chain, safeTxHash as `0x${string}`));
  } catch (e) {
    fail(res, 502, "The vault transaction is temporarily unavailable.", e);
  }
});

// SafeTxs still awaiting confirmations for a vault.
// GET /vault/tx/pending?chain=&safeAddress=
app.get("/vault/tx/pending", async (req, res) => {
  const chain = String(req.query.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  const safeAddress = String(req.query.safeAddress ?? "");
  if (!isAddress(safeAddress)) return bad(res, "valid safeAddress required");
  try {
    res.json({ pending: await listPendingVaultTxs(chain, safeAddress) });
  } catch (e) {
    fail(res, 502, "Pending vault transactions are temporarily unavailable.", e);
  }
});

// Gather a ready SafeTx's confirmations into signatures for exec/build.
// GET /vault/tx/signatures?chain=&safeTxHash=
app.get("/vault/tx/signatures", async (req, res) => {
  const chain = String(req.query.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  const safeTxHash = String(req.query.safeTxHash ?? "");
  if (!safeTxHash) return bad(res, "safeTxHash required");
  try {
    res.json({ signatures: await collectSignatures(chain, safeTxHash as `0x${string}`) });
  } catch (e) {
    fail(res, 502, "Vault signatures are temporarily unavailable.", e);
  }
});

// ---- ARK co-signer (vault Member 2) — the ARGUS-style policy co-signer ----

// The co-signer's owner address, so the client can build a 2-of-2 vault as
// [userWallet, cosigner]. GET /vault/cosigner -> { enabled, address? }
app.get("/vault/cosigner", (_req, res) => {
  if (!hasCosigner()) return res.json({ enabled: false });
  try {
    res.json({ enabled: true, address: cosignerAddress() });
  } catch (e) {
    fail(res, 500, "The co-signer is not available.", e);
  }
});

// Evaluate the vault policy and, if it passes, co-sign the SafeTx (Member 2).
// POST { chain, safeAddress, safeTxHash, safeTxData, factors?, policy? }
//   -> { ok, policy:{checks}, signature?:{signer,data} }
app.post("/vault/cosign", async (req, res) => {
  const b = req.body ?? {};
  if (!hasCosigner()) return res.status(503).json({ error: "co-signer not configured" });
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!isAddress(String(b.safeAddress ?? ""))) return bad(res, "valid safeAddress required");
  if (typeof b.safeTxHash !== "string") return bad(res, "safeTxHash required");
  if (b.safeTxData == null) return bad(res, "safeTxData required");
  const safeTxData = b.safeTxData as SafeTxData;
  try {
    // Integrity: the supplied hash MUST match the data we evaluate policy on.
    const expected = await hashVaultTx(chain, b.safeAddress, safeTxData);
    if (expected.toLowerCase() !== String(b.safeTxHash).toLowerCase())
      return bad(res, "safeTxHash does not match safeTxData");

    // Policy is loaded SERVER-SIDE (keyed by vault address) — never trusted from
    // the client — so the enabled layers can't be weakened by a tampered caller.
    const cfg = getPolicy(chain, b.safeAddress, true);
    const factors: PolicyFactors = {
      ...((b.factors as PolicyFactors) ?? {}),
      // Never trust a caller's verified flag, including for per-function rules.
      webauthn: { verified: false },
    };

    // The Face ID layer is verified HERE, not claimed by the client: we check the
    // WebAuthn assertion against the enrolled passkey + this tx's challenge.
    if (b.webauthn) {
      const ok = b.webauthn
        ? await verifyAuthentication(chain, b.safeAddress, expected, b.webauthn)
        : false;
      factors.webauthn = { verified: ok };
    }

    const result = await cosignSafeTx(
      expected,
      {
        to: safeTxData.to,
        value: safeTxData.value,
        data: safeTxData.data,
        operation: Number(safeTxData.operation ?? 0),
        factors,
      },
      cfg
    );
    res.status(result.ok ? 200 : 403).json(result);
  } catch (e) {
    fail(res, 502, "The co-signer could not evaluate this transaction.", e);
  }
});

// ---- WebAuthn / passkey (the "Face ID" vault layer) ----

// Is a passkey enrolled for this vault? GET /vault/webauthn/registered?chain=&safeAddress=
app.get("/vault/webauthn/registered", (req, res) => {
  const chain = String(req.query.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  const safeAddress = String(req.query.safeAddress ?? "");
  if (!isAddress(safeAddress)) return bad(res, "valid safeAddress required");
  res.json({ registered: hasCredential(chain, safeAddress) });
});

// Begin passkey enrollment. POST { chain, safeAddress } -> creation options
app.post("/vault/webauthn/register/options", async (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!isAddress(String(b.safeAddress ?? ""))) return bad(res, "valid safeAddress required");
  try {
    res.json(await registrationOptions(chain, b.safeAddress));
  } catch (e) {
    fail(res, 502, "Face ID enrollment could not be started.", e);
  }
});

// Finish passkey enrollment. POST { chain, safeAddress, response } -> { verified }
app.post("/vault/webauthn/register/verify", async (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!isAddress(String(b.safeAddress ?? ""))) return bad(res, "valid safeAddress required");
  if (b.response == null) return bad(res, "response required");
  // First-credential-wins: once a DEPLOYED vault has a passkey, a new one cannot be
  // added through this unauthenticated path (otherwise an attacker could enroll
  // their own). Re-enrolling a device requires approving with the existing Face ID.
  if (hasCredential(chain, b.safeAddress) && (await isVaultDeployed(chain, b.safeAddress))) {
    return res.status(409).json({
      error: "This vault already has Face ID enrolled. Re-enrolling a device requires approving with the existing Face ID first.",
    });
  }
  try {
    res.json({ verified: await verifyRegistration(chain, b.safeAddress, b.response) });
  } catch (e) {
    fail(res, 400, "Face ID enrollment could not be verified.", e);
  }
});

// ---- Phone-assisted enrollment (our in-app QR -> phone Face ID) ----
// The desktop shows a QR pointing at WEB_ORIGIN/enroll?s=<token>. The phone opens
// it, runs Face ID in ITS OWN browser (real useark.app origin, so the passkey is
// created on the phone), posts the result here, and the desktop polls until done.
// This replaces the OS "use a phone" dialog with our own branded flow.
interface PhoneSession {
  kind: "enroll" | "approve" | "gate";
  chain: ChainId;
  safeAddress: `0x${string}`;
  safeTxHash?: string;
  intent?: string; // gate: the action this approval is bound to
  label?: string; // gate: human-readable description of the action
  approved?: boolean; // gate: server-verified result of the assertion
  status: "pending" | "done" | "error";
  error?: string;
  result?: unknown; // the signed assertion (approve) relayed back to the desktop
  expires: number;
}
const phoneSessions = new Map<string, PhoneSession>();
const PHONE_TTL_MS = 10 * 60_000;

function getPhoneSession(token: string): PhoneSession | null {
  const s = phoneSessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    phoneSessions.delete(token);
    return null;
  }
  return s;
}

// Short, human-typeable codes (no ambiguous chars) that map to a phone session
// token. Users go to useark.app/enroll and type a code instead of pasting a long
// URL, because chat apps like Bankr strip or mangle URLs in messages.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const codeToToken = new Map<string, string>();
function makeCode(token: string): string {
  const b = randomBytes(6);
  let c = "";
  for (let i = 0; i < 6; i++) c += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  if (codeToToken.has(c)) return makeCode(token);
  codeToToken.set(c, token);
  return c;
}

// Desktop: start phone ENROLLMENT. POST { chain, safeAddress } -> { token, url }
app.post("/vault/webauthn/phone/start", (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!isAddress(String(b.safeAddress ?? ""))) return bad(res, "valid safeAddress required");
  const token = randomBytes(18).toString("base64url");
  phoneSessions.set(token, {
    kind: "enroll",
    chain,
    safeAddress: b.safeAddress,
    status: "pending",
    expires: Date.now() + PHONE_TTL_MS,
  });
  res.json({ token, url: `${WEB_ORIGIN}/enroll?s=${token}` });
});

// --- Wallet-signature enrollment proof ---------------------------------------
// Before a Face ID credential can be enrolled for a plain wallet ADDRESS (the
// Bankr Face ID guard, where the identity is the user's own wallet), the caller
// must prove control of that wallet by signing a one-time challenge. This stops
// anyone from enrolling their face against a wallet they do not control.
const enrollChallenges = new Map<string, { challenge: string; expires: number }>();
const ENROLL_CHALLENGE_TTL_MS = 10 * 60_000;
function enrollKey(chain: ChainId, account: string): string {
  return `${chain}:${account.toLowerCase()}`;
}

// Step 1: issue a challenge to sign with the wallet (personal_sign).
// POST { chain, account } -> { challenge }
app.post("/vault/webauthn/enroll/challenge", (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!isAddress(String(b.account ?? ""))) return bad(res, "valid account address required");
  const nonce = randomBytes(16).toString("hex");
  const challenge =
    `ARK Face ID enrollment\n\n` +
    `Wallet: ${b.account}\n` +
    `Chain: ${chain}\n` +
    `Nonce: ${nonce}\n\n` +
    `Signing this authorizes enrolling Face ID protection for this wallet on ARK. ` +
    `It is not a transaction and costs nothing.`;
  enrollChallenges.set(enrollKey(chain, b.account), {
    challenge,
    expires: Date.now() + ENROLL_CHALLENGE_TTL_MS,
  });
  res.json({ challenge });
});

// Step 2: prove control with a personal_sign signature, then get an enroll
// session (QR/link). POST { chain, account, signature } -> { token, url }
app.post("/vault/webauthn/enroll/authorize", async (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!isAddress(String(b.account ?? ""))) return bad(res, "valid account address required");
  if (typeof b.signature !== "string" || !b.signature) return bad(res, "signature required");
  const k = enrollKey(chain, b.account);
  const entry = enrollChallenges.get(k);
  if (!entry || entry.expires < Date.now()) {
    enrollChallenges.delete(k);
    return res.status(400).json({ error: "enrollment challenge expired; request a new one" });
  }
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({
      message: entry.challenge,
      signature: b.signature as `0x${string}`,
    });
  } catch {
    return res.status(401).json({ error: "invalid signature" });
  }
  if (recovered.toLowerCase() !== String(b.account).toLowerCase()) {
    return res.status(401).json({ error: "signature does not match the wallet" });
  }
  enrollChallenges.delete(k);
  const token = randomBytes(18).toString("base64url");
  phoneSessions.set(token, {
    kind: "enroll",
    chain,
    safeAddress: b.account,
    status: "pending",
    expires: Date.now() + PHONE_TTL_MS,
  });
  res.json({ token, code: makeCode(token), url: `${WEB_ORIGIN}/enroll?s=${token}` });
});

// Desktop: start phone APPROVAL bound to a tx. POST { chain, safeAddress, safeTxHash }
app.post("/vault/webauthn/phone/approve/start", (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!isAddress(String(b.safeAddress ?? ""))) return bad(res, "valid safeAddress required");
  if (typeof b.safeTxHash !== "string") return bad(res, "safeTxHash required");
  const token = randomBytes(18).toString("base64url");
  phoneSessions.set(token, {
    kind: "approve",
    chain,
    safeAddress: b.safeAddress,
    safeTxHash: b.safeTxHash,
    status: "pending",
    expires: Date.now() + PHONE_TTL_MS,
  });
  res.json({ token, url: `${WEB_ORIGIN}/approve?s=${token}` });
});

// Generic Face ID GATE bound to an arbitrary action (not a vault tx). Used to
// require the owner's Face ID before an action that executes OUTSIDE the vault,
// e.g. a custodial agent's own transfer on a platform like Bankr. The approval
// is bound to `intent` (a hash of the action) and verified server-side, so the
// agent gets a yes/no it cannot fake. NOTE: this is a confirmation gate, not a
// co-signature — it cannot stop a wallet that is able to sign on its own; it
// enforces that a well-behaved agent asks for Face ID before it acts.
// POST { chain, safeAddress, intent, label? } -> { token, url }
app.post("/vault/webauthn/gate/start", (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!isAddress(String(b.safeAddress ?? ""))) return bad(res, "valid safeAddress required");
  if (typeof b.intent !== "string" || !b.intent) return bad(res, "intent required");
  if (!hasCredential(chain, b.safeAddress)) {
    return res
      .status(409)
      .json({ error: "No Face ID enrolled for this ARK identity. Enroll first (ark_enroll_faceid)." });
  }
  const token = randomBytes(18).toString("base64url");
  phoneSessions.set(token, {
    kind: "gate",
    chain,
    safeAddress: b.safeAddress,
    intent: String(b.intent),
    label: typeof b.label === "string" ? b.label.slice(0, 200) : undefined,
    status: "pending",
    expires: Date.now() + PHONE_TTL_MS,
  });
  res.json({ token, code: makeCode(token), url: `${WEB_ORIGIN}/approve?s=${token}` });
});

// Desktop: poll a phone session. GET .../phone/poll/:token -> { status, approved?, result? }
app.get("/vault/webauthn/phone/poll/:token", (req, res) => {
  const s = getPhoneSession(req.params.token);
  if (!s) return res.json({ status: "expired" });
  res.json({
    status: s.status,
    error: s.error,
    approved: s.kind === "gate" && s.status === "done" ? s.approved === true : undefined,
    result: s.status === "done" && s.kind !== "gate" ? s.result : undefined,
  });
});

// Resolve a short code to its session, so useark.app/enroll can take a typed code
// instead of a long URL. GET .../phone/resolve/:code -> { s: token, page }
app.get("/vault/webauthn/phone/resolve/:code", (req, res) => {
  const token = codeToToken.get(String(req.params.code).toUpperCase());
  const s = token ? getPhoneSession(token) : null;
  if (!token || !s) return res.status(404).json({ error: "code not found or expired" });
  res.json({ s: token, page: s.kind === "enroll" ? "enroll" : "approve" });
});

// Phone page: get the ceremony options for a session (enroll = create, approve = get).
app.get("/vault/webauthn/phone/options/:token", async (req, res) => {
  const s = getPhoneSession(req.params.token);
  if (!s) return res.status(404).json({ error: "session expired" });
  try {
    if (s.kind === "approve") {
      res.json(await authenticationOptions(s.chain, s.safeAddress, s.safeTxHash!));
    } else if (s.kind === "gate") {
      res.json(await authenticationOptions(s.chain, s.safeAddress, s.intent!));
    } else {
      res.json(await registrationOptions(s.chain, s.safeAddress));
    }
  } catch (e) {
    fail(res, 502, "Face ID options are temporarily unavailable.", e);
  }
});

// Phone page: submit the signed result. POST .../phone/verify/:token { response }
app.post("/vault/webauthn/phone/verify/:token", async (req, res) => {
  const s = getPhoneSession(req.params.token);
  if (!s) return res.status(404).json({ error: "session expired" });
  const response = (req.body ?? {}).response;
  if (response == null) return bad(res, "response required");
  try {
    if (s.kind === "approve") {
      // Relay the assertion to the desktop, which hands it to the co-signer; the
      // co-signer verifies it (bound to this exact safeTxHash) before signing.
      s.result = response;
      s.status = "done";
      res.json({ ok: true });
    } else if (s.kind === "gate") {
      // Generic Face ID gate: verify the assertion server-side, bound to the
      // action intent, and record approved/denied for the agent to poll.
      const ok = await verifyAuthentication(s.chain, s.safeAddress, s.intent!, response);
      s.approved = ok;
      s.status = ok ? "done" : "error";
      if (!ok) s.error = "verification failed";
      res.json({ verified: ok });
    } else {
      if (hasCredential(s.chain, s.safeAddress) && (await isVaultDeployed(s.chain, s.safeAddress))) {
        s.status = "error";
        s.error = "vault already enrolled";
        return res.status(409).json({
          error: "This vault already has Face ID enrolled. Re-enrolling requires approving with the existing Face ID.",
        });
      }
      const ok = await verifyRegistration(s.chain, s.safeAddress, response);
      s.status = ok ? "done" : "error";
      if (!ok) s.error = "verification failed";
      res.json({ verified: ok });
    }
  } catch (e) {
    // The desktop polls s.error, so it carries the same fixed text.
    s.status = "error";
    s.error = "Face ID verification failed.";
    fail(res, 400, s.error, e);
  }
});

// Begin a biometric approval bound to a tx.
// POST { chain, safeAddress, safeTxHash } -> request options
app.post("/vault/webauthn/auth/options", async (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!isAddress(String(b.safeAddress ?? ""))) return bad(res, "valid safeAddress required");
  if (typeof b.safeTxHash !== "string") return bad(res, "safeTxHash required");
  try {
    res.json(await authenticationOptions(chain, b.safeAddress, b.safeTxHash));
  } catch (e) {
    fail(res, 502, "Face ID approval could not be started.", e);
  }
});

// Read the stored policy (enabled layers) for a vault.
// GET /vault/policy?chain=&safeAddress= -> { config }
app.get("/vault/policy", (req, res) => {
  const chain = String(req.query.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  const safeAddress = String(req.query.safeAddress ?? "");
  if (!isAddress(safeAddress)) return bad(res, "valid safeAddress required");
  res.json({ config: getPolicy(chain, safeAddress) });
});

// Set/update the policy (enabled layers) for a vault.
// At CREATION (no current required layers) this is unauthenticated. To CHANGE an
// existing policy that already has layers, the caller must currently PASS those
// layers (factors + a WebAuthn assertion bound to "policy-update") — so you can't
// strip protections without the things connected.
// POST { chain, safeAddress, config, factors?, webauthn? } -> { ok, config }
const POLICY_UPDATE_INTENT = "policy-update";
app.post("/vault/policy", async (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!isAddress(String(b.safeAddress ?? ""))) return bad(res, "valid safeAddress required");

  const current = getPolicy(chain, b.safeAddress);
  // Only gate changes to a vault that actually EXISTS on-chain. The address is
  // deterministic, so a stored policy can linger from an earlier/aborted creation
  // attempt; before the Safe is deployed it's still setup, so let creation
  // overwrite it freely. Gating (pass current layers) applies once deployed.
  const deployed = await isVaultDeployed(chain, b.safeAddress);
  const guarded = deployed && Object.keys(current).length > 0;

  if (guarded) {
    // Changing a guarded policy ALWAYS requires a verified Face ID, regardless of
    // which factors the current policy uses. Device factors (geo/USB/Bluetooth/
    // voice) are reported by the client and are spoofable, so they cannot be used
    // to gate their own removal — only the server-verified WebAuthn assertion can.
    const ok = b.webauthn
      ? await verifyAuthentication(chain, b.safeAddress, POLICY_UPDATE_INTENT, b.webauthn)
      : false;
    if (!ok) {
      return res.status(403).json({
        error: "Face ID is required to change a protected vault's settings.",
        policy: { ok: false, checks: [{ name: "webauthn", ok: false, detail: "not verified" }] },
      });
    }
  }

  const cfg = sanitizePolicy(b.config);
  setPolicy(chain, b.safeAddress, cfg);
  res.json({ ok: true, config: cfg });
});

// --- Stealth addresses (ERC-5564): announcement relay ------------------------
// Senders post the ephemeral pubkey + view tag for a stealth payment; recipients
// pull recent announcements and scan them LOCALLY with their viewing key. The
// server is a dumb public relay and never learns who a payment is for.
app.post("/stealth/announce", (req, res) => {
  const b = req.body ?? {};
  const chain = String(b.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  if (!isAddress(String(b.stealthAddress ?? "")))
    return bad(res, "valid stealthAddress required");
  const ephemeralPub = String(b.ephemeralPub ?? "");
  if (!/^0x[0-9a-fA-F]{66}$/.test(ephemeralPub))
    return bad(res, "valid compressed ephemeralPub required");
  const viewTag = Number(b.viewTag);
  if (!Number.isInteger(viewTag) || viewTag < 0 || viewTag > 255)
    return bad(res, "valid viewTag required");
  const item = addAnnouncement({
    chain,
    stealthAddress: b.stealthAddress,
    ephemeralPub,
    viewTag,
  });
  res.json({ ok: true, id: item.id });
});

app.get("/stealth/announcements", (req, res) => {
  const chain = String(req.query.chain ?? "") as ChainId;
  if (!SWAP_CHAINS.has(chain)) return bad(res, "invalid chain");
  const since = intQuery(req.query.since, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intQuery(req.query.limit, 1000, 1, 5000);
  res.json(listAnnouncements(chain, since, limit));
});

const frontendDirectory = fileURLToPath(new URL("../../dist/", import.meta.url));
if (existsSync(frontendDirectory)) app.use(frontendRouter(frontendDirectory));
app.use((_req, res) => { res.status(404).json({ error: "Route not found" }); });
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Provider errors may contain credential-bearing RPC URLs. Never echo them.
  const malformed = error instanceof SyntaxError;
  const tooLarge = !!error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large';
  res.status(tooLarge ? 413 : malformed ? 400 : 500).json({ error: tooLarge ? "Request body too large" : malformed ? "Invalid JSON request" : "The request could not be completed safely." });
});
export { app };
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) app.listen(PORT, () => {
  console.log(`ANTARA listening on http://localhost:${PORT}`);
  // Which client-IP source keys rate limits and the Wi-Fi layer (no request data).
  console.log(JSON.stringify(describeClientIpStrategy(CLIENT_IP_HEADER, TRUST_PROXY, CLIENT_IP_HEADER_EXPLICIT)));
  console.log(
    `  providers: alchemy=${hasAlchemy()} defillama=true gmgn=${hasGmgn()} safeTxService=${hasSafeApi()} cosigner=${hasCosigner()}`
  );
  if (!hasAlchemy())
    console.log("  (set ALCHEMY_API_KEY in .env to enable balances/history)");
  if (!hasSafeApi())
    console.log("  (set SAFE_API_KEY in .env to enable multi-owner vault coordination)");
  if (!hasCosigner())
    console.log("  (set COSIGNER_PRIVATE_KEY in .env to enable co-signed policy vaults)");
  // Warns once here when COSIGNER_ADDRESS is set but invalid or not the key's address.
  if (COSIGNER_ADDRESS) publicCosignerAddress();
});
