import { relayNetwork, type TradeRecord, type TradeStatus } from './model';
import { mergeTradeRecord } from './history';

/** A read-only response can update settlement, never authorize another debit. */
export function applySettlementStatus(record: TradeRecord, input: unknown): TradeRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid settlement response.');
  const data = input as Record<string, unknown>;
  if ((data.originChainId !== undefined && data.originChainId !== record.intent.originChainId) ||
    (data.destinationChainId !== undefined && data.destinationChainId !== record.intent.destinationChainId)) {
    throw new Error('Settlement network does not match the saved route.');
  }
  const statuses: TradeStatus[] = ['waiting', 'depositing', 'pending', 'submitted', 'delayed', 'success', 'refund', 'failure', 'unresolved'];
  if (!statuses.includes(data.status as TradeStatus)) throw new Error('Unrecognized settlement status.');
  const status = data.status as TradeStatus;
  const hashes = (value: unknown, chainId: number): string[] => {
    if (value === undefined) return [];
    const pattern = relayNetwork(chainId).vm === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{64,100}$/ : /^0x[\da-f]{64}$/i;
    if (!Array.isArray(value) || value.length > 20 || !value.every(hash => typeof hash === 'string' && pattern.test(hash))) throw new Error('Invalid settlement transaction hashes.');
    return value;
  };
  const sourceTxHashes = hashes(data.inTxHashes, record.intent.originChainId);
  // A refund is paid on the source chain, or through the order's destination alternative on the destination chain.
  const refundHashes = (value: unknown) => { try { return hashes(value, record.intent.originChainId); } catch { return hashes(value, record.intent.destinationChainId); } };
  const destinationTxHashes = status === 'refund' ? refundHashes(data.txHashes) : hashes(data.txHashes, record.intent.destinationChainId);
  if ((status === 'success' || status === 'refund') && destinationTxHashes.length === 0) throw new Error('Settlement has not supplied a delivery transaction yet.');
  if (data.updatedAt !== undefined && (!Number.isSafeInteger(data.updatedAt) || Number(data.updatedAt) < 0)) throw new Error('Invalid settlement update time.');
  const reason = data.refundFailReason || data.failReason;
  return mergeTradeRecord(record, {
    ...record, status, sourceTxHashes, destinationTxHashes,
    settlementUpdatedAt: data.updatedAt === undefined ? undefined : Number(data.updatedAt),
    detail: typeof reason === 'string' && /^[A-Z0-9_]{1,80}$/.test(reason) ? reason : undefined,
  });
}
