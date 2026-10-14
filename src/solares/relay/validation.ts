import { PublicKey } from '@solana/web3.js';
import { decodeFunctionData, encodeFunctionData, isAddress, parseAbi, sha256, toHex } from 'viem';
import { RELAY_EVM_DEPOSITORY, RELAY_SOLANA_DEPOSITORY_PROGRAM, RELAY_SOLANA_DEPOSITORY_VAULT } from '../networks';
import {
  MAX_FILL_WINDOW_MS, MIN_FILL_WINDOW_MS, RELAY_EVM_FILL_CONTRACT, RELAY_SOLVER,
  isFundingAddress, maxFundingAmount, pinnedTokens, receivingEnabled, relayNetwork, sameAddress, sameTradeIntent, tokenFor, tradeNetwork,
  type RelayNetwork, type TradeNetwork, type TradeToken, type RelayQuote, type TradeIntent, type RelayTransactionData, type ReviewedQuote,
} from './model';
import { verifyClientSettlementIntegrity, verifyOrderSignature } from './integrity';

// Independently pinned deployed addresses (network registry). A quote cannot choose its own validator.
// The EVM depository is identical on Ethereum, BNB Smart Chain, Robinhood Chain and Base.
export const EVM_DEPOSITORY = RELAY_EVM_DEPOSITORY;
export const SOLANA_DEPOSITORY = RELAY_SOLANA_DEPOSITORY_PROGRAM;
export const SOLANA_DEPOSITORY_VAULT = RELAY_SOLANA_DEPOSITORY_VAULT;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const COMPUTE_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const DEPOSIT_ABI = parseAbi(['function depositErc20(address depositor, address token, uint256 amount, bytes32 id)']);
export const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function integer(value: unknown, maxDigits = 78): value is string { return typeof value === 'string' && new RegExp(`^(0|[1-9]\\d{0,${maxDigits - 1}})$`).test(value); }
export function validAddress(value: unknown, vm: 'solana' | 'ethereum'): value is string {
  if (typeof value !== 'string') return false;
  if (vm === 'ethereum') return isAddress(value, { strict: false }) && !/^0x0{40}$/i.test(value);
  try { return new PublicKey(value).toBase58() === value && value !== SYSTEM_PROGRAM; } catch { return false; }
}
/** Stablecoin tickers a token may use only at its pinned address on that network. */
function impersonatesStablecoin(symbol: string, network: RelayNetwork): boolean {
  const normalized = symbol.normalize('NFKC').replace(/[\s\u200b-\u200d\u2060\ufeff]/g, '').toUpperCase();
  return normalized === 'USDC' || normalized === network.funding.symbol.toUpperCase();
}
/**
 * `trade` validates a token for a new route on a supported network. `record`
 * only re-reads a saved route (including removed legacy networks) so device
 * history stays readable; it never authorizes a quote or signature.
 */
type ValidationMode = 'trade' | 'record';
export function validateTradeToken(input: unknown, chainId: number, mode: ValidationMode = 'trade'): TradeToken {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'Invalid token.');
  const token = input as TradeToken;
  const network = mode === 'trade' ? tradeNetwork(chainId) : relayNetwork(chainId);
  ensure(Object.keys(token).every(key => ['chainId', 'address', 'symbol', 'name', 'decimals'].includes(key)), 'Unexpected token fields.');
  ensure(token.chainId === chainId && typeof token.address === 'string' &&
    (sameAddress(token.address, network.native, network.vm) || validAddress(token.address, network.vm)), 'Token address does not match its network.');
  ensure(Number.isSafeInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 36, 'Unsupported token decimals.');
  ensure(typeof token.symbol === 'string' && token.symbol.trim().length > 0 && token.symbol.length <= 32 && !/[\p{C}]/u.test(token.symbol), 'Invalid token symbol.');
  ensure(typeof token.name === 'string' && token.name.trim().length > 0 && token.name.length <= 100 && !/[\p{C}]/u.test(token.name), 'Invalid token name.');
  const pinned = pinnedTokens(network).find(item => sameAddress(token.address, item.address, network.vm));
  if (pinned) ensure(token.decimals === pinned.decimals && token.symbol === pinned.symbol, 'Known token metadata changed.');
  if (mode === 'trade' && !network.legacy) {
    ensure(!network.rejectedLookalikes.some(item => sameAddress(item, token.address, network.vm)), 'This token imitates a stablecoin and is not supported.');
    ensure(pinned || !impersonatesStablecoin(token.symbol, network), `This token uses a stablecoin ticker it does not own on ${network.name}. Check the contract address.`);
  }
  return token;
}
function checkIntent(input: unknown, mode: ValidationMode): TradeIntent {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'Invalid trade request.');
  const data = input as Record<string, unknown>;
  ensure(Object.keys(data).every((key) => ['originChainId', 'destinationChainId', 'user', 'recipient', 'amount', 'destinationToken', 'slippageBps'].includes(key)), 'Unexpected trade request fields.');
  ensure(Number.isSafeInteger(data.originChainId) && Number.isSafeInteger(data.destinationChainId), 'Invalid network.');
  const lookup = mode === 'trade' ? tradeNetwork : relayNetwork;
  const source = lookup(data.originChainId as number);
  const destination = lookup(data.destinationChainId as number);
  ensure(validAddress(data.user, source.vm) && validAddress(data.recipient, destination.vm), 'Wallet address does not match its network.');
  // Amounts are base units of the source network's funding stablecoin, at its own decimals. New routes and saved
  // records share the 100,000-unit protocol sanity ceiling; there is no other swap cap (owner decision 2026-10-13).
  const max = maxFundingAmount(source.funding.decimals);
  ensure(integer(data.amount, max.toString().length) && BigInt(data.amount) > 0n && BigInt(data.amount) <= max, `Invalid ${source.funding.label} amount.`);
  if (data.destinationToken === 'USDC' || data.destinationToken === 'native') {
    // The legacy 'USDC' selector means Circle USDC; it never resolves to another issuer's token.
    ensure(data.destinationToken === 'native' || destination.funding.circleIssued, `USDC is not available on ${destination.name}. Select the token again.`);
  } else validateTradeToken(data.destinationToken, destination.id, mode);
  ensure(data.slippageBps === 50 || data.slippageBps === 100, 'Slippage must be 0.5% or 1%.');
  const output = tokenFor(destination, data.destinationToken as TradeIntent['destinationToken']);
  ensure(source.id !== destination.id || !sameAddress(output.address, source.funding.address, source.vm), `Choose a token other than ${source.funding.label} on this network.`);
  // New routes only; saved records on these directions stay readable.
  ensure(mode === 'record' || receivingEnabled(source.id, destination.id), `Swaps from another network into ${destination.name} are not enabled yet. Swap on ${destination.name} itself or choose another receiving network.`);
  return data as TradeIntent;
}
/** Fail-closed validation for a new route on a supported network. */
export function validateIntent(input: unknown): TradeIntent {
  return checkIntent(input, 'trade');
}
/** Re-reads a saved route, including one on a removed legacy network. Never use it to authorize a quote or signature. */
export function validateRecordedIntent(input: unknown): TradeIntent {
  return checkIntent(input, 'record');
}
export function quoteRequestId(quote: RelayQuote): string {
  const id = quote.requestId ?? quote.steps.find((step) => step.id === 'deposit')?.requestId;
  ensure(typeof id === 'string' && /^0x[\da-f]{64}$/i.test(id), 'Route has no valid tracking identifier.');
  return id;
}
/**
 * Synchronous review checks WITHOUT the solver signature. It never authorizes a signature on its own:
 * every signing path calls `verifyReviewedQuote`. Exported only for unit tests with synthetic orders,
 * which cannot carry a valid solver signature.
 */
export function validateReviewedQuoteWithoutSignature(reviewed: ReviewedQuote, intent: TradeIntent, now = Date.now()): void {
  validateIntent(reviewed.intent);
  validateIntent(intent);
  ensure(sameTradeIntent(reviewed.intent, intent), 'The quoted request changed.');
  validateQuote(reviewed.quote, intent, now);
  ensure(reviewed.requestId === quoteRequestId(reviewed.quote), 'The quoted tracking identifier changed.');
  ensure(Number.isSafeInteger(reviewed.quotedAt) && Number.isSafeInteger(reviewed.expiresAt) &&
    reviewed.quotedAt <= now + 10_000 && reviewed.expiresAt > now && reviewed.expiresAt > reviewed.quotedAt &&
    reviewed.expiresAt <= reviewed.quotedAt + 90_000 &&
    reviewed.expiresAt <= reviewed.quote.protocol.v2.orderData.output.deadline * 1000 - 10_000,
  'The quote expired or has an invalid validity window. Review a fresh route.');
  verifyClientSettlementIntegrity(reviewed.quote);
}
/**
 * The only gate before a reviewed quote is shown as signable, returned by the API or sent to a wallet:
 * the synchronous policy, the independently recomputed order hash, and the pinned solver's signature.
 */
export async function verifyReviewedQuote(reviewed: ReviewedQuote, intent: TradeIntent, now = Date.now()): Promise<void> {
  validateReviewedQuoteWithoutSignature(reviewed, intent, now);
  await verifyOrderSignature(reviewed.quote);
}
/** Lower a canonical upstream allowance to the exact debit; never broaden it. */
export function normalizeQuoteApprovals(quote: RelayQuote, intent: TradeIntent): RelayQuote {
  const source = tradeNetwork(intent.originChainId);
  if (source.vm !== 'ethereum' || !Array.isArray(quote.steps)) return quote;
  for (const step of quote.steps) {
    if (step.id !== 'approve') continue;
    ensure(step.kind === 'transaction' && step.items?.length === 1, 'Unsupported approval structure.');
    const data = step.items[0].data;
    ensure(data.chainId === source.id && typeof data.from === 'string' && sameAddress(data.from, intent.user, source.vm), 'Approval source changed.');
    ensure(typeof data.to === 'string' && isFundingAddress(source, data.to) && BigInt(data.value ?? '0') === 0n, 'Approval targets an unexpected token or native value.');
    ensure(typeof data.data === 'string' && /^0x[\da-f]+$/i.test(data.data), 'Malformed approval.');
    const decoded = decodeFunctionData({ abi: APPROVE_ABI, data: data.data as `0x${string}` });
    ensure(sameAddress(decoded.args[0], source.depository, source.vm) && decoded.args[1] >= BigInt(intent.amount), 'Approval spender or amount is invalid.');
    ensure(encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: decoded.args }).toLowerCase() === data.data.toLowerCase(), 'Approval contains unexpected data.');
    data.data = encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: [source.depository as `0x${string}`, BigInt(intent.amount)] });
  }
  return quote;
}
function ata(owner: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync([owner.toBytes(), new PublicKey(TOKEN_PROGRAM).toBytes(), mint.toBytes()], new PublicKey(ATA_PROGRAM))[0].toBase58();
}
function bytes(hex: string): Uint8Array {
  ensure(/^(?:[\da-f]{2})*$/i.test(hex), 'Malformed Solana instruction.');
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}
function u64(data: Uint8Array, offset: number) { return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true); }
export function validateTransaction(data: RelayTransactionData, stepId: string, intent: TradeIntent, orderId: string): void {
  const source = tradeNetwork(intent.originChainId);
  if (source.vm === 'ethereum') {
    ensure(data.chainId === source.id && typeof data.from === 'string' && sameAddress(data.from, intent.user, source.vm), 'Transaction source changed.');
    ensure(typeof data.to === 'string' && typeof data.data === 'string' && /^0x[\da-f]+$/i.test(data.data), 'Malformed transaction.');
    ensure(integer(data.value ?? '0') && BigInt(data.value ?? '0') === 0n, 'Stablecoin route unexpectedly sends native funds.');
    if (stepId === 'approve') {
      ensure(isFundingAddress(source, data.to), 'Approval targets an unexpected token.');
      const decoded = decodeFunctionData({ abi: APPROVE_ABI, data: data.data as `0x${string}` });
      ensure(sameAddress(decoded.args[0], source.depository, source.vm) && decoded.args[1] === BigInt(intent.amount), 'Approval must grant only the exact trade amount to Relay.');
      ensure(encodeFunctionData({ abi: APPROVE_ABI, functionName: 'approve', args: decoded.args }).toLowerCase() === data.data.toLowerCase(), 'Approval contains unexpected data.');
    } else {
      ensure(stepId === 'deposit' && sameAddress(data.to, source.depository, source.vm), 'Unsupported transaction target.');
      const decoded = decodeFunctionData({ abi: DEPOSIT_ABI, data: data.data as `0x${string}` });
      ensure(sameAddress(decoded.args[0], intent.user, source.vm) && isFundingAddress(source, decoded.args[1]), 'Deposit payer or token changed.');
      ensure(decoded.args[2] === BigInt(intent.amount) && decoded.args[3].toLowerCase() === orderId.toLowerCase(), 'Deposit amount or order changed.');
      ensure(encodeFunctionData({ abi: DEPOSIT_ABI, functionName: 'depositErc20', args: decoded.args }).toLowerCase() === data.data.toLowerCase(), 'Deposit contains unexpected data.');
    }
    return;
  }
  ensure(stepId === 'deposit' && (!data.chainId || data.chainId === source.id), 'Unsupported Solana step.');
  ensure(Array.isArray(data.instructions) && data.instructions.length > 0 && data.instructions.length <= 8, 'Unsupported Solana instruction count.');
  ensure(source.depository === SOLANA_DEPOSITORY, 'Relay Solana depository changed.');
  const program = new PublicKey(SOLANA_DEPOSITORY);
  // The vault is pinned and must still be the program's canonical PDA.
  const vault = new PublicKey(SOLANA_DEPOSITORY_VAULT);
  ensure(PublicKey.findProgramAddressSync([new TextEncoder().encode('vault')], program)[0].equals(vault), 'Relay Solana vault changed.');
  const depository = PublicKey.findProgramAddressSync([new TextEncoder().encode('relay_depository')], program)[0];
  const payer = new PublicKey(intent.user);
  const mint = new PublicKey(source.funding.address);
  const expectedAccounts = [depository.toBase58(), intent.user, intent.user, vault.toBase58(), source.funding.address, ata(payer, mint), ata(vault, mint), TOKEN_PROGRAM, ATA_PROGRAM, SYSTEM_PROGRAM];
  let deposits = 0;
  let computeUnits = 200_000;
  let microLamports = 0n;
  const computeKinds = new Set<number>();
  for (const instruction of data.instructions) {
    ensure(Array.isArray(instruction.keys) && typeof instruction.data === 'string', 'Malformed Solana instruction.');
    const raw = bytes(instruction.data);
    if (instruction.programId === SOLANA_DEPOSITORY) {
      deposits += 1;
      const discriminator = sha256(toHex('global:deposit_token')).slice(2, 18);
      ensure(raw.length === 48 && instruction.data.slice(0, 16).toLowerCase() === discriminator, 'Unsupported Solana depository operation.');
      ensure(u64(raw, 8) === BigInt(intent.amount) && `0x${instruction.data.slice(32)}`.toLowerCase() === orderId.toLowerCase(), 'Solana deposit does not match this order.');
      ensure(instruction.keys.length === 10 && instruction.keys.every((key, index) => key.pubkey === expectedAccounts[index]), 'Solana deposit account changed.');
      ensure(instruction.keys[1].isSigner && instruction.keys.every((key) => !key.isSigner || key.pubkey === intent.user), 'Unexpected Solana signer.');
    } else if (instruction.programId === COMPUTE_PROGRAM) {
      ensure(instruction.keys.length === 0 && !computeKinds.has(raw[0]), 'Unexpected compute budget accounts or duplicate instruction.');
      computeKinds.add(raw[0]);
      if (raw[0] === 2 && raw.length === 5) computeUnits = new DataView(raw.buffer).getUint32(1, true);
      else if (raw[0] === 3 && raw.length === 9) microLamports = u64(raw, 1);
      else throw new Error('Unsupported compute budget operation.');
    } else if (instruction.programId === MEMO_PROGRAM) {
      ensure(raw.length <= 128 && instruction.keys.every((key) => !key.isWritable && (!key.isSigner || key.pubkey === intent.user)), 'Unexpected memo accounts.');
    } else {
      // The canonical deposit creates its vault ATA internally. Token approvals,
      // free-standing transfers, Jupiter swaps, tips, and unknown programs are rejected.
      throw new Error('This route requires instructions outside the verified stablecoin deposit flow.');
    }
  }
  ensure(deposits === 1, 'Route must contain exactly one Solana deposit.');
  ensure(computeUnits > 0 && computeUnits <= 1_400_000 && BigInt(computeUnits) * microLamports <= 20_000_000n * 1_000_000n, 'Solana priority fee exceeds the 0.02 SOL limit.');
  ensure(!data.addressLookupTableAddresses || (data.addressLookupTableAddresses.length <= 4 && data.addressLookupTableAddresses.every((key) => validAddress(key, 'solana'))), 'Invalid address lookup tables.');
}

/** The `extraData` Relay commits on an order leg: the pinned EVM fill contract, ABI-encoded, or empty on Solana. */
export function expectedOrderExtraData(network: TradeNetwork): string {
  return network.vm === 'solana' ? '0x' : `0x${'0'.repeat(24)}${RELAY_EVM_FILL_CONTRACT.slice(2)}`;
}
type SettlementOrder = RelayQuote['protocol']['v2']['orderData'];
type RefundOption = SettlementOrder['inputs'][number]['refunds'][number];
/**
 * Relay settlement terms (docs/RELAY_POLICY_2026-10.md section 4; the swap caps of 2026-10-12 were removed 2026-10-13).
 * Relay may hold the deposit until the fill deadline and a refund minimum may be 0, but every refund
 * option must pay the user's own wallets in a pinned token on the route's own chains, and only the
 * pinned solver can claim the escrow. Anything else fails closed.
 */
export function validateSettlementTerms(order: SettlementOrder, intent: TradeIntent, source: TradeNetwork, destination: TradeNetwork, token: TradeToken): void {
  ensure(order.solverChainId === RELAY_SOLVER.chain && typeof order.solver === 'string' && order.solver.toLowerCase() === RELAY_SOLVER.address, 'Route names an unrecognized Relay solver.');
  ensure(typeof order.output.extraData === 'string' && order.output.extraData.toLowerCase() === expectedOrderExtraData(destination), 'Route names an unrecognized settlement contract.');
  const refunds: unknown = order.inputs[0].refunds;
  ensure(Array.isArray(refunds) && refunds.length >= 1 && refunds.length <= 2, 'Unsupported refund terms.');
  const isOrigin = (refund: RefundOption) => refund.chainId === source.protocol && sameAddress(refund.recipient, intent.user, source.vm) &&
    isFundingAddress(source, refund.currency) && refund.extraData.toLowerCase() === expectedOrderExtraData(source) &&
    BigInt(refund.minimumAmount) <= BigInt(intent.amount);
  // A destination alternative may pay only the verified recipient, in the destination funding stablecoin,
  // its native asset or the output token, never a registry lookalike.
  const isDestination = (refund: RefundOption) => refund.chainId === destination.protocol && sameAddress(refund.recipient, intent.recipient, destination.vm) &&
    (isFundingAddress(destination, refund.currency) || sameAddress(refund.currency, destination.native, destination.vm) || sameAddress(refund.currency, token.address, destination.vm)) &&
    !destination.rejectedLookalikes.some((item) => sameAddress(item, refund.currency, destination.vm)) &&
    refund.extraData.toLowerCase() === expectedOrderExtraData(destination);
  let origins = 0;
  for (const refund of refunds as RefundOption[]) {
    ensure(refund && typeof refund === 'object' && typeof refund.chainId === 'string' && typeof refund.recipient === 'string' &&
      typeof refund.currency === 'string' && typeof refund.extraData === 'string', 'Malformed refund terms.');
    ensure(integer(refund.minimumAmount), 'Invalid refund minimum.');
    ensure(refund.deadline === order.output.deadline, 'Refund deadline differs from the fill deadline.');
    if (isOrigin(refund)) origins += 1;
    else ensure(isDestination(refund), 'Route can refund outside your own wallets or tokens.');
  }
  ensure(origins > 0, 'Route does not return refunds to your source wallet.');
}

/** Structural + transaction validation runs again in the browser immediately before signing. */
export function validateQuote(quote: RelayQuote, intent: TradeIntent, now = Date.now()): void {
  validateIntent(intent);
  const source = tradeNetwork(intent.originChainId);
  const destination = tradeNetwork(intent.destinationChainId);
  const token = tokenFor(destination, intent.destinationToken);
  const details = quote?.details;
  ensure(details && typeof details.sender === 'string' && typeof details.recipient === 'string', 'Incomplete route summary.');
  ensure(sameAddress(details.sender, intent.user, source.vm) && sameAddress(details.recipient, intent.recipient, destination.vm), 'Route wallet changed.');
  ensure(details.currencyIn?.currency?.chainId === source.id && typeof details.currencyIn.currency.address === 'string' && isFundingAddress(source, details.currencyIn.currency.address) && details.currencyIn.amount === intent.amount, 'Route input changed.');
  ensure(details.currencyOut?.currency?.chainId === destination.id && sameAddress(details.currencyOut.currency.address, token.address, destination.vm), 'Route output changed.');
  // Each funding stablecoin keeps its own precision (Binance-Peg USDC uses 18 decimals, the others 6).
  ensure(details.currencyIn.currency.decimals === source.funding.decimals && details.currencyOut.currency.decimals === token.decimals, 'Quoted token decimals changed.');
  // A quote may not relabel the funding stablecoin (for example USDG as "USDC").
  ensure(details.currencyIn.currency.symbol === undefined || details.currencyIn.currency.symbol === source.funding.symbol, 'Quoted funding token metadata changed.');
  ensure(integer(details.currencyOut.amount) && integer(details.currencyOut.minimumAmount) && BigInt(details.currencyOut.minimumAmount) > 0n && BigInt(details.currencyOut.minimumAmount) <= BigInt(details.currencyOut.amount), 'Invalid minimum output.');
  ensure(BigInt(details.currencyOut.minimumAmount) >= BigInt(details.currencyOut.amount) * BigInt(10_000 - intent.slippageBps) / 10_000n, 'Minimum output exceeds your chosen slippage tolerance.');
  const protocol = quote.protocol?.v2;
  const order = protocol?.orderData;
  ensure(order?.version === 'v1' && protocol.hubType === 'onchain' && /^0x[\da-f]{64}$/i.test(protocol.orderId), 'This route lacks a supported verifiable settlement order.');
  // Relay orders stay fillable for about 7 days. A deadline closer than 5 minutes could expire before the deposit lands.
  ensure(Number.isSafeInteger(order.output?.deadline) && order.output.deadline * 1000 > now + MIN_FILL_WINDOW_MS && order.output.deadline * 1000 <= now + MAX_FILL_WINDOW_MS,
    'Route expired or has an unsupported fill window. Check your device clock and request a new quote.');
  ensure(order.inputs?.length === 1 && order.output.payments?.length === 1 && order.output.calls?.length === 0 && order.fees?.length === 0, 'Complex settlement orders are not enabled.');
  const input = order.inputs[0].payment;
  const output = order.output.payments[0];
  ensure(input?.chainId === source.protocol && typeof input.currency === 'string' && isFundingAddress(source, input.currency) && input.amount === intent.amount && input.weight === '1', 'Protocol input does not match the requested trade.');
  ensure(order.output.chainId === destination.protocol && sameAddress(output.currency, token.address, destination.vm) && sameAddress(output.recipient, intent.recipient, destination.vm), 'Protocol destination changed.');
  ensure(output.minimumAmount === details.currencyOut.minimumAmount && output.expectedAmount === details.currencyOut.amount, 'Protocol output does not match the displayed quote.');
  validateSettlementTerms(order, intent, source, destination, token);
  ensure(protocol.paymentDetails && sameAddress(protocol.paymentDetails.depository, source.depository, source.vm) && protocol.paymentDetails.chainId === source.protocol && isFundingAddress(source, protocol.paymentDetails.currency) && protocol.paymentDetails.amount === intent.amount, 'Protocol payment changed.');
  ensure(Array.isArray(quote.steps) && quote.steps.length >= 1 && quote.steps.length <= 2, 'Unsupported route steps.');
  const requestId = quoteRequestId(quote);
  let deposits = 0;
  let approvals = 0;
  for (const step of quote.steps) {
    ensure(step.kind === 'transaction' && step.items?.length === 1 && ['approve', 'deposit'].includes(step.id), 'Unsupported signature or transaction step.');
    ensure(!step.requestId || step.requestId === requestId, 'Inconsistent route identifier.');
    if (step.id === 'deposit') deposits += 1;
    else { approvals += 1; ensure(deposits === 0, 'Approval order is invalid.'); }
    for (const item of step.items) {
      ensure(item.status === 'incomplete', 'A quote cannot reuse an already completed transaction.');
      if (item.check) ensure(item.check.method === 'GET' && item.check.endpoint === `/intents/status/v3?requestId=${requestId}`, 'Unexpected route status endpoint.');
      validateTransaction(item.data, step.id, intent, protocol.orderId);
    }
  }
  ensure(deposits === 1 && approvals <= 1, 'Route must contain exactly one deposit.');
}
