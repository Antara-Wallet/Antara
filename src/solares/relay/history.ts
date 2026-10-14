import { sameTradeIntent, type SavedOrder, type TradeRecord } from './model';
import { validateRecordedIntent } from './validation';

export const TRADE_STORAGE_KEY = 'solares.relay.activity.v1';
type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>;
const volatile = new Map<string, TradeRecord>();
const hashesValid = (hashes: unknown) => Array.isArray(hashes) && hashes.length <= 40 && hashes.every(hash => typeof hash === 'string' && /^[a-zA-Z0-9]{32,128}$/.test(hash));
/** The signed order a deposit committed to (optional: records saved before October 2026 omit it). */
function orderValid(order: unknown): boolean {
  if (order === undefined) return true;
  if (!order || typeof order !== 'object' || Array.isArray(order)) return false;
  const saved = order as SavedOrder;
  const data = saved.orderData as unknown as { version?: unknown; output?: { deadline?: unknown } } | null;
  return typeof saved.orderId === 'string' && /^0x[\da-f]{64}$/i.test(saved.orderId) &&
    typeof saved.orderSignature === 'string' && /^0x[\da-f]{130}$/i.test(saved.orderSignature) &&
    !!data && typeof data === 'object' && data.version === 'v1' && Number.isSafeInteger(data.output?.deadline) && Number(data.output?.deadline) > 0;
}
function validRecord(item: unknown): item is TradeRecord {
  try {
    if (!item || typeof item !== 'object') return false;
    const record = item as TradeRecord;
    if (!/^0x[\da-f]{64}$/i.test(record.requestId) || !Number.isSafeInteger(record.createdAt)) return false;
    // Saved routes on removed legacy networks stay readable (read-only); new routes are validated fail-closed elsewhere.
    validateRecordedIntent(record.intent);
    return ['waiting', 'depositing', 'pending', 'submitted', 'delayed', 'success', 'refund', 'failure', 'unresolved'].includes(record.status) &&
      hashesValid(record.sourceTxHashes) && hashesValid(record.destinationTxHashes) && (record.detail === undefined || typeof record.detail === 'string') &&
      (record.settlementUpdatedAt === undefined || Number.isSafeInteger(record.settlementUpdatedAt)) && orderValid(record.order);
  } catch { return false; }
}
function read(storage: HistoryStorage, strict = true): TradeRecord[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(TRADE_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed) || (strict && !parsed.every(validRecord))) throw new Error('Invalid history');
    return parsed.filter(validRecord);
  } catch {
    throw new Error('Route history is unreadable. Restore it before starting another trade.');
  }
}
/** Never regress successful/refunded settlement or erase already submitted hashes. */
export function mergeTradeRecord(previous: TradeRecord | undefined, incoming: TradeRecord): TradeRecord {
  if (!previous) return incoming;
  if (previous.requestId !== incoming.requestId || !sameTradeIntent(previous.intent, incoming.intent)) {
    throw new Error('Saved route does not match this execution.');
  }
  if (previous.order && incoming.order && previous.order.orderId.toLowerCase() !== incoming.order.orderId.toLowerCase()) {
    throw new Error('Saved route does not match this execution.');
  }
  const order = previous.order ?? incoming.order;
  const terminalEvidence = (incoming.status === 'success' || incoming.status === 'refund') && incoming.destinationTxHashes.length > 0;
  const preserve = (previous.status === 'success' || previous.status === 'refund') ||
    (previous.settlementUpdatedAt !== undefined && (incoming.settlementUpdatedAt === undefined
      ? !terminalEvidence : incoming.settlementUpdatedAt < previous.settlementUpdatedAt));
  return {
    ...(preserve ? previous : incoming),
    settlementUpdatedAt: preserve ? previous.settlementUpdatedAt : incoming.settlementUpdatedAt ?? previous.settlementUpdatedAt,
    sourceTxHashes: [...new Set([...previous.sourceTxHashes, ...incoming.sourceTxHashes])],
    destinationTxHashes: [...new Set([...previous.destinationTxHashes, ...incoming.destinationTxHashes])],
    ...(order ? { order } : {}),
  };
}
export function retainTradeHistory(records: TradeRecord[]): TradeRecord[] {
  // Relay failure means an unsuccessful fill, not that the funds were refunded.
  // Retain those recovery records along with every still-pending route.
  const resolved = (record: TradeRecord) => record.status === 'success' || record.status === 'refund';
  const unresolved = records.filter(record => !resolved(record));
  const completed = records.filter(resolved).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  return [...unresolved, ...completed].sort((a, b) => b.createdAt - a.createdAt);
}
export function loadTradeHistory(storage: HistoryStorage = localStorage): TradeRecord[] {
  let records: TradeRecord[] = [];
  try { records = read(storage, false); } catch { /* Signing uses the strict read below. Keep any in-memory executions visible. */ }
  for (const record of volatile.values()) {
    const index = records.findIndex(item => item.requestId === record.requestId);
    if (index < 0) records.push(record);
    else records[index] = mergeTradeRecord(records[index], record);
  }
  return retainTradeHistory(records);
}
/** A write-ahead route must be durably saved before requesting any signature. */
export function persistTrade(record: TradeRecord, required = false, storage: HistoryStorage = localStorage): TradeRecord[] {
  if (!validRecord(record)) throw new Error('Invalid route history update.');
  let writable = true;
  try { read(storage); }
  catch (error) { if (required) throw error; writable = false; }
  const records = loadTradeHistory(storage);
  const saved = mergeTradeRecord(records.find(item => item.requestId === record.requestId), record);
  const next = retainTradeHistory([saved, ...records.filter(item => item.requestId !== record.requestId)]);
  try {
    // A post-submission update must not replace corrupted recovery data with an
    // apparently empty ledger. Keep it in memory and block future signatures.
    if (!writable) throw new Error('History requires recovery');
    const serialized = JSON.stringify(next);
    storage.setItem(TRADE_STORAGE_KEY, serialized);
    if (required && storage.getItem(TRADE_STORAGE_KEY) !== serialized) throw new Error('Route history write was not retained.');
    volatile.delete(record.requestId);
  } catch {
    if (required) throw new Error('Cannot safely save this route. Free device storage before signing a transaction.');
    volatile.set(record.requestId, saved);
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('solares:relay-activity'));
  return next;
}
