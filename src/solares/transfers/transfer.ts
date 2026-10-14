import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ACCOUNT_SIZE, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { createPublicClient, createWalletClient, custom, encodeFunctionData, erc20Abi, formatUnits, isAddress, type Address, type EIP1193Provider, type Hex } from 'viem';
import { LEGACY_NETWORKS, SUPPORTED_NETWORKS, byKey, explorerAddressUrl, explorerTxUrl, isFundingToken, isLegacyNetworkKey, isNetworkKey, type LegacyNetworkKey } from '../networks';
import { viemChainFor } from '../evmChains';
import { SOLANA_CLUSTER, SOLANA_RPC_URL, SOLANA_WS_URL } from '../wallet/config';
import { assertSolanaCluster } from '../wallet/solanaNetwork';
import { SOLANA_UNCONFIRMED_TEXT, SolanaTransactionExpiredError, confirmSolanaSignature, type ConfirmSolanaOptions, type SolanaStatusRpc } from '../wallet/solanaConfirm';
import { SolanaSendError } from '../wallet/solanaSend';
import { parseAmount } from '../vaults/validation';
import type { WalletChain } from '../wallet/types';

/**
 * Direct transfers send a network's native coin or its funding stablecoin, in
 * registry order (Solana first). Stablecoin identity, label and decimals are
 * pinned per network: Circle USDC (6) on Solana, Ethereum and Base, Binance-Peg
 * USDC (18) on BNB Smart Chain and Paxos USDG (6) on Robinhood Chain.
 */
export const SEND_NETWORKS = Object.freeze(SUPPORTED_NETWORKS.map(network => Object.freeze({
  key: network.key,
  name: network.name,
  /** EIP-155 chain id for EVM networks; Relay's chain id for Solana (never used for signing). */
  id: network.evmChainId ?? network.relay.chainId,
  symbol: network.native.symbol,
  decimals: network.native.decimals,
  stablecoin: Object.freeze({ symbol: network.funding.symbol, label: network.funding.label, address: network.funding.address, decimals: network.funding.decimals }),
})));
export type SendNetwork = typeof SEND_NETWORKS[number];
export type SendAsset = 'native' | 'stablecoin';
/** Display label and exact precision of the selected asset; a stablecoin label is never generalized to "USDC". */
export function sendAsset(network: SendNetwork, asset: SendAsset) {
  return asset === 'native'
    ? { label: network.symbol, decimals: network.decimals, address: null }
    : { label: network.stablecoin.label, decimals: network.stablecoin.decimals, address: network.stablecoin.address };
}
export type SendIntent = { chain: WalletChain; asset: SendAsset; sender: string; recipient: string; amount: string };
export type PreparedTransfer = SendIntent & { amountRaw: bigint; fee: string; symbol: string; expires: number; rent: string; solana?: { transaction: Uint8Array; blockhash: string; lastValidBlockHeight: number }; evm?: { to: Address; value: bigint; data: Hex; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; chainId: number; nonce: number } };

export function validateSendIntent(input: SendIntent) {
  // Fail closed: Arbitrum, Polygon and unknown networks have no transfer route.
  const network = SEND_NETWORKS.find(n => n.key === input.chain);
  if (!network || (input.asset !== 'native' && input.asset !== 'stablecoin')) throw new Error('Unsupported network or asset.');
  const token = sendAsset(network, input.asset);
  const recipient = input.recipient.trim();
  if (input.chain === 'solana') {
    for (const address of [input.sender, recipient]) {
      let publicKey: PublicKey;
      try { publicKey = new PublicKey(address); } catch { throw new Error('Enter a valid Solana address.'); }
      if (publicKey.equals(PublicKey.default)) throw new Error('The system program is not a receiving wallet.');
    }
    if (input.asset === 'stablecoin' && SOLANA_CLUSTER !== 'mainnet-beta') throw new Error(`Mainnet ${token.label} transfers are disabled on devnet.`);
  } else if (![input.sender, recipient].every(address => isAddress(address) && !/^0x0{40}$/i.test(address))) {
    throw new Error('Enter a valid, nonzero EVM address.');
  }
  const normalize = (address: string) => input.chain === 'solana' ? address : address.toLowerCase();
  if (normalize(input.sender) === normalize(recipient)) throw new Error('The receiving address must differ from your sending wallet.');
  const amountRaw = parseAmount(input.amount, token.decimals);
  if (amountRaw > (input.chain === 'solana' ? 2n ** 64n - 1n : 2n ** 256n - 1n)) throw new Error('Amount exceeds the network limit.');
  return { network, token, recipient, amountRaw };
}

export async function prepareTransfer(intent: SendIntent, provider?: EIP1193Provider): Promise<PreparedTransfer> {
  const { network, token, recipient, amountRaw } = validateSendIntent(intent);
  const prepared: PreparedTransfer = { ...intent, recipient, amountRaw, symbol: token.label, expires: Date.now() + 90_000, fee: '', rent: '0' };
  if (network.key === 'solana') {
    const connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed', wsEndpoint: SOLANA_WS_URL });
    await assertSolanaCluster(connection, SOLANA_CLUSTER);
    const sender = new PublicKey(intent.sender), receiver = new PublicKey(recipient);
    const balance = await connection.getBalance(sender);
    if (!Number.isSafeInteger(balance)) throw new Error('RPC returned an unsafe balance.');
    const instructions = [];
    let rent = 0;
    if (intent.asset === 'native') instructions.push(SystemProgram.transfer({ fromPubkey: sender, toPubkey: receiver, lamports: amountRaw }));
    else {
      const mint = new PublicKey(network.stablecoin.address);
      const source = getAssociatedTokenAddressSync(mint, sender);
      const destination = getAssociatedTokenAddressSync(mint, receiver, true);
      const [sourceBalance, targetAccount] = await Promise.all([connection.getTokenAccountBalance(source), connection.getAccountInfo(destination)]);
      if (BigInt(sourceBalance.value.amount) < amountRaw) throw new Error(`Your associated ${token.label} account has insufficient funds.`);
      if (!targetAccount) rent = await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(sender, destination, receiver, mint), createTransferCheckedInstruction(source, mint, destination, sender, amountRaw, token.decimals));
    }
    const latest = await connection.getLatestBlockhash();
    const message = new TransactionMessage({ payerKey: sender, recentBlockhash: latest.blockhash, instructions }).compileToV0Message();
    const fee = await connection.getFeeForMessage(message);
    if (fee.value === null) throw new Error('Network fee unavailable. Please retry.');
    if (BigInt(balance) < (intent.asset === 'native' ? amountRaw : 0n) + BigInt(fee.value + rent)) throw new Error(`Insufficient ${network.symbol} for the transfer and network fee.`);
    const transaction = new VersionedTransaction(message);
    const simulation = await connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: true });
    if (simulation.value.err) throw new Error('The network simulation rejected this transfer. Check the receiving address and balance.');
    prepared.fee = `${formatUnits(BigInt(fee.value), network.decimals)} ${network.symbol}`;
    prepared.rent = rent ? `${formatUnits(BigInt(rent), network.decimals)} ${network.symbol}` : '0';
    prepared.solana = { transaction: transaction.serialize(), ...latest };
  } else {
    if (!provider) throw new Error('Connect the sending wallet.');
    const chain = viemChainFor(network.id);
    const client = createPublicClient({ chain, transport: custom(provider) });
    if (await client.getChainId() !== network.id) throw new Error('The wallet is on the wrong network.');
    const sender = intent.sender as Address;
    if (intent.asset === 'stablecoin' && !isFundingToken(byKey(network.key), network.stablecoin.address)) throw new Error('Unsupported network or asset.');
    const to = (intent.asset === 'native' ? recipient : network.stablecoin.address) as Address;
    const value = intent.asset === 'native' ? amountRaw : 0n;
    const data: Hex = intent.asset === 'native' ? '0x' : encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient as Address, amountRaw] });
    if (intent.asset === 'stablecoin') {
      const tokens = await client.readContract({ address: network.stablecoin.address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [sender] });
      if (tokens < amountRaw) throw new Error(`Insufficient ${token.label} on ${network.name}.`);
    }
    const [gas, fees, balance, nonce] = await Promise.all([client.estimateGas({ account: sender, to, value, data }), client.estimateFeesPerGas(), client.getBalance({ address: sender }), client.getTransactionCount({ address: sender, blockTag: 'pending' })]);
    if (!fees.maxFeePerGas || fees.maxPriorityFeePerGas === undefined) throw new Error('Network fee unavailable.');
    const gasLimit = gas * 120n / 100n;
    const maximumFee = gasLimit * fees.maxFeePerGas;
    if (balance < value + maximumFee) throw new Error(`Insufficient ${network.symbol} for the transfer and network fee.`);
    prepared.fee = `up to ${formatUnits(maximumFee, network.decimals)} ${network.symbol}`;
    prepared.evm = { to, value, data, gas: gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, chainId: network.id, nonce };
  }
  return prepared;
}

/**
 * Only raised when nothing reached the network: before asking a wallet to send, or (Solana) when
 * the wallet did not sign or the RPC refused the signed transaction. Transport errors after a
 * possible broadcast remain unknown.
 */
export class TransferNotSubmittedError extends Error {
  constructor(message: string) { super(message); this.name = 'TransferNotSubmittedError'; }
}

/**
 * Sends a reviewed Solana transfer with the wallet's `sendSolanaTransaction` (sign, then broadcast
 * through ANTARA's RPC: wallet/solanaSend.ts) and returns its signature for confirmTransfer.
 * A broadcast whose answer was lost still returns its signature, so the payment is followed
 * on-chain instead of being forgotten. Anything else that rejected sent nothing.
 */
export async function sendSolanaTransfer(transfer: PreparedTransfer, send: (transaction: Uint8Array) => Promise<string>): Promise<string> {
  if (!transfer.solana || transfer.evm || transfer.chain !== 'solana') throw new TransferNotSubmittedError('Invalid Solana transfer review.');
  try { return await send(transfer.solana.transaction); }
  catch (error) {
    if (error instanceof SolanaSendError && error.submitted === 'unknown') {
      if (error.signature) return error.signature;
      throw error;
    }
    throw new TransferNotSubmittedError(error instanceof Error && error.message ? error.message : 'The wallet did not send this transfer.');
  }
}

/** Settles a sent Solana transfer by polling (wallet/solanaConfirm.ts). Throws SolanaTransactionExpiredError when it can no longer land. */
export async function settleSolanaTransfer(
  rpc: SolanaStatusRpc, transfer: PreparedTransfer, signature: string,
  options: Partial<Omit<ConfirmSolanaOptions, 'rpc' | 'signature' | 'blockhash' | 'lastValidBlockHeight'>> = {},
): Promise<'confirmed' | 'reverted'> {
  if (!transfer.solana) throw new Error('Waiting for confirmation.');
  const result = await confirmSolanaSignature({ ...options, rpc, signature, blockhash: transfer.solana.blockhash, lastValidBlockHeight: transfer.solana.lastValidBlockHeight });
  if (result.outcome === 'confirmed' || result.outcome === 'reverted') return result.outcome;
  if (result.outcome === 'expired') throw new SolanaTransactionExpiredError(signature);
  throw new Error(SOLANA_UNCONFIRMED_TEXT);
}

export async function sendEvmTransfer(input: PreparedTransfer, provider: EIP1193Provider) {
  // Keep the reviewed payload stable across every asynchronous preflight.
  const transfer = structuredClone(input);
  let request: NonNullable<PreparedTransfer['evm']>;
  try {
    const { network, token, recipient, amountRaw } = validateSendIntent(transfer);
    if (!transfer.evm || transfer.solana || network.key === 'solana') throw new Error('Invalid EVM transfer review.');
    request = transfer.evm;
    const expectedTo = transfer.asset === 'native' ? recipient : network.stablecoin.address;
    const expectedData = transfer.asset === 'native' ? '0x' : encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient as Address, amountRaw] });
    if (request.chainId !== network.id || request.to.toLowerCase() !== expectedTo.toLowerCase() || request.value !== (transfer.asset === 'native' ? amountRaw : 0n) || request.data.toLowerCase() !== expectedData.toLowerCase() || transfer.amountRaw !== amountRaw || transfer.symbol !== token.label) throw new Error('The transaction differs from the reviewed payment. Review the transfer again.');
    if (!Number.isSafeInteger(request.nonce) || request.nonce < 0 || request.gas <= 0n || request.maxFeePerGas <= 0n || request.maxPriorityFeePerGas < 0n || request.maxPriorityFeePerGas > request.maxFeePerGas) throw new Error('Invalid transaction fee or nonce. Review the transfer again.');
    if (!Number.isFinite(transfer.expires) || transfer.expires <= Date.now()) throw new Error('Transfer review expired. Review a fresh network fee.');
    const [chainId, accounts, nonce] = await Promise.all([
      provider.request({ method: 'eth_chainId' }),
      provider.request({ method: 'eth_accounts' }),
      provider.request({ method: 'eth_getTransactionCount', params: [transfer.sender as Address, 'pending'] }),
    ]);
    if (Number(chainId) !== request.chainId) throw new Error('The wallet network changed. Review the transfer again.');
    if (!Array.isArray(accounts) || !accounts.some(address => typeof address === 'string' && address.toLowerCase() === transfer.sender.toLowerCase())) throw new Error('The wallet account changed. Review the transfer again.');
    // Another app may have spent this nonce while this review was open. Never
    // implicitly replace that payment with our previously estimated transaction.
    if (BigInt(nonce) !== BigInt(request.nonce)) throw new Error('Another transaction changed your wallet nonce. Review the transfer again.');
    if (transfer.expires <= Date.now()) throw new Error('Transfer review expired. Review a fresh network fee.');
  } catch (error) {
    throw new TransferNotSubmittedError(error instanceof Error ? error.message : 'Transfer preflight failed. Review the transfer again.');
  }
  const { chainId, ...transaction } = request;
  const chain = viemChainFor(chainId);
  const client = createWalletClient({ account: transfer.sender as Address, chain, transport: custom(provider) });
  // Do not relabel any error from this point as definitely unsubmitted: the
  // wallet/RPC may have broadcast successfully before its response was lost.
  return client.sendTransaction({ ...transaction, account: transfer.sender as Address, chain });
}

export async function confirmTransfer(transfer: PreparedTransfer, hash: string, provider?: EIP1193Provider): Promise<'confirmed' | 'reverted'> {
  if (transfer.solana) {
    // HTTP polling only: web3.js confirmTransaction (websocket and block height race) misreported landed transactions.
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
    await assertSolanaCluster(connection, SOLANA_CLUSTER);
    return settleSolanaTransfer(connection, transfer, hash);
  }
  if (!provider || !transfer.evm) throw new Error('Waiting for confirmation.');
  const assertChain = async () => {
    if (Number(await provider.request({ method: 'eth_chainId' })) !== transfer.evm!.chainId) throw new Error('The wallet network changed. Confirmation remains pending on the original network.');
  };
  await assertChain();
  // A successful cancellation or unrelated same-nonce replacement is not a
  // successful payment. Track only the hash returned for this payment.
  const receipt = await createPublicClient({ transport: custom(provider) }).waitForTransactionReceipt({ hash: hash as Hex, timeout: 60_000, checkReplacement: false });
  await assertChain();
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('Receipt does not belong to this payment. Confirmation remains pending.');
  return receipt.status === 'success' ? 'confirmed' : 'reverted';
}

/** A supported network, or a legacy one (Arbitrum, Polygon) kept only so earlier device-local records still render. */
export type TransferChain = WalletChain | LegacyNetworkKey;
function transferTarget(chain: TransferChain) {
  return isNetworkKey(chain) ? byKey(chain) : LEGACY_NETWORKS.find(network => network.key === chain);
}
/** Network name for a record; legacy networks are labelled as no longer supported. */
export function transferNetworkLabel(chain: TransferChain) {
  const target = transferTarget(chain);
  return !target ? 'Unknown network' : 'label' in target ? target.label : chain === 'solana' && SOLANA_CLUSTER === 'devnet' ? `${target.name} devnet` : target.name;
}
export function transferExplorer(chain: TransferChain, hash: string, sender?: string) {
  const target = transferTarget(chain);
  if (!target) return '';
  const options = { solanaCluster: SOLANA_CLUSTER } as const;
  return hash ? explorerTxUrl(target, hash, options) : explorerAddressUrl(target, sender || '', options);
}
export interface TransferRecord { id: string; chain: TransferChain; symbol: string; amount: string; recipient: string; sender?: string; nonce?: number; hash: string; status: 'submission-unknown' | 'submitted' | 'confirmed' | 'reverted'; createdAt: string }
export function transferHistory(userId: string): TransferRecord[] {
  // Legacy-network records stay readable (and keep blocking nothing); unknown networks are dropped.
  try { const value: unknown = JSON.parse(localStorage.getItem(`solares:transfers:${userId}`) || '[]'); return Array.isArray(value) ? value.filter((record: TransferRecord) => record && typeof record.hash === 'string' && typeof record.createdAt === 'string' && (isNetworkKey(record.chain) || isLegacyNetworkKey(record.chain))).slice(0, 100) : []; } catch { return []; }
}
export function recordTransfer(userId: string, record: TransferRecord, requirePersistence = false) {
  try { localStorage.setItem(`solares:transfers:${userId}`, JSON.stringify([record, ...transferHistory(userId).filter(r => r.id !== record.id)].slice(0, 100))); }
  catch { if (requirePersistence) throw new Error('Local transaction history is unavailable. Enable site storage before sending so an interrupted payment cannot be repeated accidentally.'); }
  window.dispatchEvent(new Event('solares:transfers'));
}
export function removeTransfer(userId: string, id: string) {
  try { localStorage.setItem(`solares:transfers:${userId}`, JSON.stringify(transferHistory(userId).filter(record => record.id !== id))); } catch { /* Fail closed: a retained unknown attempt remains blocked. */ }
  window.dispatchEvent(new Event('solares:transfers'));
}
export function hasUnresolvedTransfer(userId: string, intent: SendIntent) {
  const same = (a: string, b: string) => intent.chain === 'solana' ? a === b : a.toLowerCase() === b.toLowerCase();
  const network = SEND_NETWORKS.find(n => n.key === intent.chain);
  if (!network || (intent.asset !== 'native' && intent.asset !== 'stablecoin')) throw new Error('Unsupported network or asset.');
  const token = sendAsset(network, intent.asset);
  const requested = parseAmount(intent.amount, token.decimals);
  return transferHistory(userId).some(record => {
    if ((record.status !== 'submission-unknown' && record.status !== 'submitted') || record.chain !== intent.chain || record.symbol !== token.label || !same(record.sender || '', intent.sender) || !same(record.recipient, intent.recipient.trim())) return false;
    try { return parseAmount(record.amount, token.decimals) === requested; } catch { return false; }
  });
}
