import type { EIP1193Provider } from 'viem';
import type { WalletSession } from './types';

/** A reviewed action belongs to one authenticated account and selected wallet pair. */
export function assertWalletSession(expected: WalletSession, current: WalletSession): void {
  if (!expected.authenticated || !current.authenticated || !expected.userId || current.userId !== expected.userId ||
      current.addresses.solana !== expected.addresses.solana ||
      current.addresses.ethereum?.toLowerCase() !== expected.addresses.ethereum?.toLowerCase()) {
    throw new Error('Your account or selected wallet changed. Review this action again.');
  }
}

/** Keep checking at the provider boundary: preflight may finish after logout or a chain switch. */
export async function guardEvmProvider(provider: EIP1193Provider, chainId: number, address: string, assertCurrent: () => void): Promise<EIP1193Provider> {
  const assertSigner = async () => {
    assertCurrent();
    const [chain, accounts] = await Promise.all([
      provider.request({ method: 'eth_chainId' }),
      provider.request({ method: 'eth_accounts' }),
    ]);
    assertCurrent();
    if (Number(chain) !== chainId) throw new Error('The wallet network changed. Review this action again.');
    if (!Array.isArray(accounts) || !accounts.some(account => typeof account === 'string' && account.toLowerCase() === address.toLowerCase())) throw new Error('The selected owner is no longer connected to this provider.');
  };
  await assertSigner();
  const request: EIP1193Provider['request'] = (async (args: { method: string; params?: unknown }) => {
    if (args.method === 'eth_sendRawTransaction') throw new Error('Raw transaction broadcast is unavailable through a reviewed wallet provider.');
    if (args.method === 'eth_sendTransaction' || args.method.startsWith('eth_sign') || args.method === 'personal_sign' || args.method === 'wallet_sendCalls') {
      // Freeze the request before asynchronous checks: a caller must not swap the
      // signer or chain while the provider is checking the current session.
      args = structuredClone(args);
      await assertSigner();
      const params = Array.isArray(args.params) ? args.params : [];
      const assertAddress = (candidate: unknown) => {
        if (typeof candidate !== 'string' || candidate.toLowerCase() !== address.toLowerCase()) throw new Error('Transaction sender or message signer differs from the selected wallet.');
      };
      const assertChain = (candidate: unknown) => {
        if (candidate === undefined) return;
        if ((typeof candidate !== 'string' && typeof candidate !== 'number') || Number(candidate) !== chainId) throw new Error('Signing request targets a different network.');
      };
      if (args.method === 'eth_sendTransaction' || args.method === 'eth_signTransaction' || args.method === 'wallet_sendCalls') {
        const transaction = params[0];
        assertAddress(transaction?.from);
        assertChain(transaction?.chainId);
      } else if (args.method === 'personal_sign' || args.method === 'eth_sign') {
        assertAddress(params[args.method === 'personal_sign' ? 1 : 0]);
      } else if (['eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4'].includes(args.method)) {
        assertAddress(params[0]);
        let typedData: unknown;
        try { typedData = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]; }
        catch { throw new Error('Invalid typed signing data.'); }
        if (!typedData || typeof typedData !== 'object' || !('domain' in typedData) || !typedData.domain || typeof typedData.domain !== 'object') throw new Error('Invalid typed signing domain.');
        if ('chainId' in typedData.domain) assertChain(typedData.domain.chainId);
      } else {
        throw new Error('Unsupported wallet signing method.');
      }
    }
    return provider.request(args as Parameters<EIP1193Provider['request']>[0]);
  }) as EIP1193Provider['request'];
  return new Proxy(provider, {
    get(target, property) {
      if (property === 'request') return request;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
