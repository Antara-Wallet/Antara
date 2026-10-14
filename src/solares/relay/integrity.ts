import { PublicKey } from '@solana/web3.js';
import { hashStruct, recoverMessageAddress, toHex, type Hex } from 'viem';
import { RELAY_NETWORKS, RELAY_SOLVER, type RelayQuote } from './model';

// Relay settlement-sdk 0.0.146, order/index: the v1 EIP-712 wire schema.
// Keep the browser verifier limited to our two VMs instead of bundling the
// SDK's unrelated chain clients. Server regression tests compare this against
// the pinned SDK's independent getOrderId implementation on every supported VM.
const TYPES = {
  Order: [{ name: 'version', type: 'string' }, { name: 'solverChainId', type: 'string' }, { name: 'solver', type: 'address' }, { name: 'salt', type: 'uint256' }, { name: 'inputs', type: 'Input[]' }, { name: 'output', type: 'Output' }, { name: 'fees', type: 'Fee[]' }],
  Input: [{ name: 'payment', type: 'InputPayment' }, { name: 'refunds', type: 'InputRefund[]' }],
  InputPayment: [{ name: 'chainId', type: 'string' }, { name: 'currency', type: 'bytes' }, { name: 'amount', type: 'uint256' }, { name: 'weight', type: 'uint256' }],
  InputRefund: [{ name: 'chainId', type: 'string' }, { name: 'recipient', type: 'bytes' }, { name: 'currency', type: 'bytes' }, { name: 'minimumAmount', type: 'uint256' }, { name: 'deadline', type: 'uint32' }, { name: 'extraData', type: 'bytes' }],
  Output: [{ name: 'chainId', type: 'string' }, { name: 'payments', type: 'OutputPayment[]' }, { name: 'deadline', type: 'uint32' }, { name: 'calls', type: 'bytes[]' }, { name: 'extraData', type: 'bytes' }],
  OutputPayment: [{ name: 'recipient', type: 'bytes' }, { name: 'currency', type: 'bytes' }, { name: 'minimumAmount', type: 'uint256' }, { name: 'expectedAmount', type: 'uint256' }],
  Fee: [{ name: 'recipientChainId', type: 'string' }, { name: 'recipient', type: 'bytes' }, { name: 'currencyChainId', type: 'string' }, { name: 'currency', type: 'bytes' }, { name: 'amount', type: 'uint256' }],
};
function hex(value: string): Hex {
  if (!/^0x(?:[\da-f]{2})*$/i.test(value)) throw new Error('Invalid settlement bytes.');
  return value as Hex;
}
function address(value: string, protocol: string): Hex {
  const network = RELAY_NETWORKS.find(chain => chain.protocol === protocol);
  if (!network) throw new Error('Unsupported settlement network.');
  if (network.vm === 'solana') return toHex(new PublicKey(value).toBytes());
  if (!/^0x[\da-f]{40}$/i.test(value)) throw new Error('Invalid settlement address.');
  return value as Hex;
}

export function settlementOrderId(order: RelayQuote['protocol']['v2']['orderData']): Hex {
  if (order.version !== 'v1') throw new Error('Unsupported settlement order version.');
  return hashStruct({ types: TYPES, primaryType: 'Order', data: {
    version: order.version, solverChainId: order.solverChainId, solver: order.solver, salt: order.salt,
    inputs: order.inputs.map(input => ({
      payment: { ...input.payment, currency: address(input.payment.currency, input.payment.chainId) },
      refunds: input.refunds.map(refund => ({ ...refund, recipient: address(refund.recipient, refund.chainId), currency: address(refund.currency, refund.chainId), extraData: hex(refund.extraData) })),
    })),
    output: { ...order.output,
      payments: order.output.payments.map(payment => ({ ...payment, recipient: address(payment.recipient, order.output.chainId), currency: address(payment.currency, order.output.chainId) })),
      calls: order.output.calls.map(hex), extraData: hex(order.output.extraData),
    },
    fees: order.fees.map(fee => ({ ...fee, recipient: address(fee.recipient, fee.recipientChainId), currency: address(fee.currency, fee.currencyChainId) })),
  } });
}

export function verifyClientSettlementIntegrity(quote: RelayQuote): void {
  if (settlementOrderId(quote.protocol.v2.orderData).toLowerCase() !== quote.protocol.v2.orderId.toLowerCase()) {
    throw new Error('Relay settlement order failed independent wallet verification.');
  }
}

/**
 * The order must be signed (EIP-191 over the raw 32-byte order id) by the pinned Relay solver.
 * Call it only after the order id was recomputed, so the signature covers the verified order.
 */
export async function verifyOrderSignature(quote: RelayQuote): Promise<void> {
  const { orderId, orderSignature } = quote.protocol.v2;
  if (typeof orderId !== 'string' || !/^0x[\da-f]{64}$/i.test(orderId) || typeof orderSignature !== 'string' || !/^0x[\da-f]{130}$/i.test(orderSignature)) {
    throw new Error('Relay settlement order is not signed.');
  }
  // A malformed signature makes viem throw (for example "Point is not on curve"); report it as unsigned.
  const signer = await recoverMessageAddress({ message: { raw: orderId as Hex }, signature: orderSignature as Hex }).catch(() => '');
  if (signer.toLowerCase() !== RELAY_SOLVER.address) throw new Error('Relay settlement order is not signed by the pinned Relay solver.');
}
