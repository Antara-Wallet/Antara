import { API_URL, SOLANA_CLUSTER, SOLANA_RPC_URL } from '../wallet/config';
import { type EIP1193Provider, type Hex } from 'viem';
import { type ReviewedQuote, type SavedOrder, type TradeIntent, type TradeRecord, assertEvmNetworkFee, isTerminal, relayNetwork, sameAddress, SOLANA_CHAIN_ID, tradeNetwork, type RelayTransactionData } from './model';
import { validateIntent, validateTransaction, verifyReviewedQuote } from './validation';
import { assertApprovalReceipt, sendSolanaDeposit, submitRelayDeposit } from './execution';
import { assertSolanaCluster } from '../wallet/solanaNetwork';
import { loadTradeHistory, persistTrade } from './history';
import { applySettlementStatus } from './settlement';
export { loadTradeHistory, persistTrade } from './history';

// Same API origin as the wallet session and balances (same-origin `/api` unless VITE_API_BASE is set).
export const RELAY_API = `${API_URL}/api/solares/relay`;
export type RelayWalletAccess = {
  getSession(): { authenticated: boolean; userId: string | null; addresses: { solana: string | null; ethereum: string | null } };
  getAccessToken(): Promise<string | null>;
  getEvmProvider(chainId: number): Promise<EIP1193Provider>;
  sendSolanaTransaction(transaction: Uint8Array): Promise<string>;
};
async function authenticatedFetch(wallet: Pick<RelayWalletAccess, 'getAccessToken'>, path: string, body?: unknown) {
  const token = await wallet.getAccessToken();
  if (!token) throw new Error('Sign in again to continue.');
  const response = await fetch(`${RELAY_API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : 'Relay is unavailable.');
  }
  return data;
}
export async function fetchQuote(wallet: RelayWalletAccess, intent: TradeIntent): Promise<ReviewedQuote> {
  validateIntent(intent);
  const reviewed = await authenticatedFetch(wallet, '/quote', intent) as ReviewedQuote;
  // Policy, independently recomputed order hash and the pinned solver's signature, before the review is shown.
  await verifyReviewedQuote(reviewed, intent);
  return reviewed;
}
const refreshingTrades = new Map<string, Promise<TradeRecord>>();
export async function refreshTrade(wallet: RelayWalletAccess, record: TradeRecord): Promise<TradeRecord> {
  const session = wallet.getSession();
  // Saved routes on removed legacy networks render read-only; they are not tracked against Relay any more.
  const source = tradeNetwork(record.intent.originChainId);
  tradeNetwork(record.intent.destinationChainId);
  const assertSession = () => {
    const current = wallet.getSession();
    if (!session.userId || !current.authenticated || current.userId !== session.userId || !sameAddress(current.addresses[source.vm] ?? '', record.intent.user, source.vm)) {
      throw new Error('Select the wallet that submitted this swap to check its status.');
    }
  };
  assertSession();
  const key = `${session.userId}:${record.requestId}`;
  const pending = refreshingTrades.get(key);
  if (pending) return pending;
  const refresh = (async () => {
    const data: unknown = await authenticatedFetch(wallet, `/status/${record.requestId}`);
    assertSession();
    const latest = loadTradeHistory().find(item => item.requestId === record.requestId) ?? record;
    const result = applySettlementStatus(latest, data);
    return persistTrade(result).find(item => item.requestId === record.requestId)!;
  })();
  refreshingTrades.set(key, refresh);
  try { return await refresh; } finally { refreshingTrades.delete(key); }
}
let executing = false;
/** Wallet adapters still request the user's signature. No private keys enter ANTARA. */
export async function executeTrade(wallet: RelayWalletAccess, reviewed: ReviewedQuote, onUpdate: (record: TradeRecord) => void): Promise<TradeRecord> {
  if (executing) throw new Error('A trade is already waiting for your wallet.');
  const session = wallet.getSession();
  // Claim the guard before any await so a second call cannot pass it during verification.
  executing = true;
  let finished = false;
  const assertCanSign = () => {
    const current = wallet.getSession();
    const source = tradeNetwork(reviewed.intent.originChainId), destination = tradeNetwork(reviewed.intent.destinationChainId);
    if (finished || !current.authenticated || !session.userId || current.userId !== session.userId ||
      !sameAddress(current.addresses[source.vm] || '', reviewed.intent.user, source.vm) ||
      !sameAddress(current.addresses[destination.vm] || '', reviewed.intent.recipient, destination.vm)) {
      throw new Error('Your session or selected wallet changed. Review a fresh route before signing.');
    }
    if (Date.now() >= reviewed.expiresAt) throw new Error('Quote expired before signing. Review a fresh route.');
  };
  let order: SavedOrder;
  try {
    // Hold our own reviewed snapshot across asynchronous wallet requests, and verify that exact snapshot.
    reviewed = structuredClone(reviewed);
    await verifyReviewedQuote(reviewed, reviewed.intent);
    // The session or the expiry can change during the asynchronous signature check.
    assertCanSign();
    const existing = loadTradeHistory().find((record) => record.requestId === reviewed.requestId);
    if (existing) throw new Error('This route already has a saved execution. Check its status instead of depositing again.');
    const { orderId, orderData, orderSignature } = reviewed.quote.protocol.v2;
    order = { orderId, orderData, orderSignature };
  } catch (error) { executing = false; throw error; }
  let submitted = false;
  let signingStarted = false;
  let depositAttempted = false;
  let record: TradeRecord = { requestId: reviewed.requestId, intent: reviewed.intent, createdAt: Date.now(), status: 'waiting', sourceTxHashes: [], destinationTxHashes: [] };
  const update = (patch: Partial<TradeRecord>, required = false) => { record = { ...record, ...patch }; persistTrade(record, required); onUpdate(record); };
  try {
    const sdk = await import('@relayprotocol/relay-sdk');
    const viem = await import('viem');
    // Supported EVM chains only (Ethereum, BNB Smart Chain, Robinhood Chain, Base), from the network registry.
    const { SUPPORTED_VIEM_CHAINS: definitions, viemChainFor } = await import('../evmChains');
    const web3 = await import('@solana/web3.js');
    const solanaRpc = SOLANA_RPC_URL;
    const proxyUrl = new URL(RELAY_API, window.location.origin).href;
    sdk.createClient({
      baseApiUrl: proxyUrl,
      chains: [
        ...definitions.map(sdk.convertViemChainToRelayChain),
        { id: SOLANA_CHAIN_ID, name: 'solana', displayName: 'Solana', vmType: 'svm', httpRpcUrl: solanaRpc },
      ],
      pollingInterval: 5_000,
      maxPollingAttemptsBeforeTimeout: 36,
      useGasFeeEstimations: false,
      websocket: { enabled: false },
    });
    const source = tradeNetwork(reviewed.intent.originChainId);
    const funding = source.funding;
    let adapted: import('@relayprotocol/relay-sdk').AdaptedWallet;
    let confirmApproval: (hash: string) => Promise<void> = async () => { throw new Error('This route cannot contain an approval.'); };
    if (source.vm === 'solana') {
      if (SOLANA_CLUSTER !== 'mainnet-beta') throw new Error('Relay trading uses mainnet. Change the Solana network before trading.');
      const { adaptSolanaWallet } = await import('@relayprotocol/relay-svm-wallet-adapter');
      const connection = new web3.Connection(solanaRpc, 'confirmed');
      await assertSolanaCluster(connection, 'mainnet-beta');
      adapted = adaptSolanaWallet(reviewed.intent.user, source.id, connection, async (transaction) => {
        assertCanSign();
        const simulation = await connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: true });
        if (simulation.value.err) throw new Error(`Solana simulation failed. Check ${funding.label} balance and SOL for network fees.`);
        if (transaction.serialize().length > 1232) throw new Error('The Solana route exceeds the transaction size limit.');
        assertCanSign();
        update({ detail: 'Confirm the deposit in your wallet.', order }, true);
        signingStarted = true;
        depositAttempted = true;
        // A send whose answer was lost keeps its signature and is followed; a definite refusal sent nothing (execution.ts).
        const sent = await sendSolanaDeposit(() => wallet.sendSolanaTransaction(transaction.serialize()));
        if ('error' in sent) { depositAttempted = sent.maybeSent; throw sent.error; }
        submitted = true;
        update({ status: 'pending', sourceTxHashes: [...record.sourceTxHashes, sent.signature], detail: undefined });
        return { signature: sent.signature };
      });
    } else {
      assertCanSign();
      const provider = await wallet.getEvmProvider(source.id);
      const chain = viemChainFor(source.id);
      const account = reviewed.intent.user as Hex;
      const walletClient = viem.createWalletClient({ account, chain, transport: viem.custom(provider) });
      const publicClient = viem.createPublicClient({ chain, transport: viem.custom(provider) });
      confirmApproval = async (hash) => {
        if (Number(BigInt(await provider.request({ method: 'eth_chainId' }))) !== source.id) throw new Error('The approval network changed.');
        const timeout = Math.max(1, Math.min(120_000, reviewed.expiresAt - Date.now()));
        const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as Hex, timeout, checkReplacement: false });
        assertApprovalReceipt(hash, receipt);
        if (Number(BigInt(await provider.request({ method: 'eth_chainId' }))) !== source.id) throw new Error('The approval network changed.');
        assertCanSign();
      };
      const balance = await publicClient.readContract({ address: funding.address as Hex, abi: viem.parseAbi(['function balanceOf(address account) view returns (uint256)']), functionName: 'balanceOf', args: [account] });
      if (balance < BigInt(reviewed.intent.amount)) throw new Error(`Insufficient ${funding.label} on ${source.name}. Choose another source balance.`);
      adapted = sdk.adaptViemWallet(walletClient, { disableCapabilitiesCheck: true });
      adapted.handleSendTransactionStep = async (chainId, item, step) => {
        assertCanSign();
        const accounts = await provider.request({ method: 'eth_accounts' });
        const currentChain = await provider.request({ method: 'eth_chainId' });
        if (Number(BigInt(currentChain)) !== source.id || !accounts.some((address) => sameAddress(address, account, 'ethereum'))) throw new Error('The connected wallet or network changed.');
        if (chainId !== source.id) throw new Error('Unexpected transaction chain.');
        const data = item.data as RelayTransactionData;
        validateTransaction(data, step.id, reviewed.intent, reviewed.quote.protocol.v2.orderId);
        const transaction = { account, to: data.to as Hex, data: data.data as Hex, value: 0n };
        const gas = await publicClient.estimateGas(transaction);
        const fee = await publicClient.estimateFeesPerGas();
        const maxFeePerGas = fee.maxFeePerGas;
        const gasLimit = gas * 120n / 100n;
        // Per-network native fee ceiling: 0.02 ETH on Ethereum, Base and Robinhood Chain; 0.01 BNB on BNB Smart Chain.
        assertEvmNetworkFee(source, gasLimit, maxFeePerGas);
        if (await publicClient.getBalance({ address: account }) < gasLimit * maxFeePerGas) throw new Error(`Add ${source.nativeSymbol} on ${source.name} for the network fee.`);
        assertCanSign();
        const liveChain = await provider.request({ method: 'eth_chainId' });
        const liveAccounts = await provider.request({ method: 'eth_accounts' });
        assertCanSign();
        if (Number(BigInt(liveChain)) !== source.id || !liveAccounts.some(address => sameAddress(address, account, 'ethereum'))) throw new Error('The wallet account or network changed before signing.');
        update({ detail: step.id === 'approve' ? `Confirm the exact ${funding.label} allowance in your wallet.` : 'Confirm the deposit in your wallet.', ...(step.id === 'deposit' ? { order } : {}) }, true);
        signingStarted = true;
        depositAttempted = step.id === 'deposit';
        const hash = await walletClient.sendTransaction({ ...transaction, gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas });
        submitted = true;
        update({ status: step.id === 'deposit' ? 'pending' : 'waiting', sourceTxHashes: [...record.sourceTxHashes, hash], detail: step.id === 'approve' ? `${funding.label} approval submitted. Awaiting the deposit.` : undefined });
        return hash;
      };
    }
    // SDK 8's settlement loop never times out while the service keeps returning pending.
    // Submit only the reviewed steps through its adapters, then hand off to read-only tracking.
    await submitRelayDeposit({
      steps: structuredClone(reviewed.quote.steps),
      assertCanSign,
      confirmApproval,
      send: async (step) => {
        const item = step.items[0];
        validateTransaction(item.data, step.id, reviewed.intent, reviewed.quote.protocol.v2.orderId);
        type Send = typeof adapted.handleSendTransactionStep;
        const hash = await adapted.handleSendTransactionStep(source.id, item as unknown as Parameters<Send>[1], step as unknown as Parameters<Send>[2]);
        if (!hash) throw new Error('The wallet did not return a transaction hash. Check your wallet history before retrying.');
        return hash;
      },
      indexDeposit: async (hash) => {
        // The request id is sent for older servers; this server only forwards the hash to Relay's indexer.
        try { await authenticatedFetch(wallet, '/transactions/index', { txHash: hash, chainId: String(source.id), requestId: reviewed.requestId }); }
        catch { update({ status: 'unresolved', detail: 'Deposit submitted, but notification could not be confirmed. Check status before another trade.' }); }
      },
    });
    // A transaction hash is not settlement evidence. Tracking cannot ask for another signature.
    finished = true;
    try { record = await refreshTrade(wallet, record); onUpdate(record); }
    catch { if (!isTerminal(record.status)) update({ detail: 'Swap submitted. You can follow its progress in Activity.' }); }
    return record;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Wallet execution did not finish.';
    const rejected = typeof error === 'object' && error !== null && ('code' in error && error.code === 4001);
    if (submitted || signingStarted) {
      if (!isTerminal(record.status)) update({
        status: !depositAttempted || rejected ? 'failure' : 'unresolved',
        detail: !depositAttempted || rejected
          ? `Deposit was not submitted. ${submitted ? `Your exact-amount ${relayNetwork(reviewed.intent.originChainId).funding.label} allowance may remain. ` : ''}${message}`
          : `${message} Check status before attempting another trade.`,
      });
      return record;
    }
    throw error;
  } finally {
    finished = true;
    executing = false;
  }
}
