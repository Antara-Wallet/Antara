import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ANTARA_WALLET_NAME, EXPORT_MESSAGES, embeddedWalletsOf, evmSigner, exportChainFor, exportErrorMessage, isEmbeddedAddress, isEmbeddedClientType,
  isEmbeddedEvmWallet, solanaSigner, walletExplorers, walletIdentity,
} from './walletIdentity';
import { disconnectedWallet } from './context';

const SOLANA_ANTARA = 'Cu73KkPjfrA4xVZiZWRdM1JZVVDu5U9t4zU3oKMxsAvf';
const PHANTOM = 'EMX22GqsGJbZAMr3uE6g6yZ7EjZz8Y1tMRu2CnZny5tD';
const EVM_ANTARA = '0x7E6c0000000000000000000000000000000F9805';

test('the embedded wallet is the ANTARA wallet; external wallets keep their name with an External hint', () => {
  assert.deepEqual(walletIdentity({ name: 'Privy', embedded: true }, 'solana'), { label: 'ANTARA wallet', embedded: true, hint: null, app: null, family: 'solana' });
  assert.deepEqual(walletIdentity({ name: 'privy', embedded: true }, 'evm'), { label: 'ANTARA wallet', embedded: true, hint: null, app: null, family: 'evm' });
  assert.deepEqual(walletIdentity({ name: 'Phantom' }, 'solana'), { label: 'Phantom', embedded: false, hint: 'External', app: 'Phantom', family: 'solana' });
  assert.deepEqual(walletIdentity({ name: 'MetaMask', embedded: false }, 'evm'), { label: 'MetaMask', embedded: false, hint: 'External', app: 'MetaMask', family: 'evm' });
  // A nameless external wallet falls back to its family, never to an empty label.
  assert.equal(walletIdentity({ name: '  ' }, 'solana').label, 'Solana wallet');
  assert.equal(walletIdentity({ name: '' }, 'evm').label, 'EVM wallet');
  assert.equal(ANTARA_WALLET_NAME, 'ANTARA wallet');
});

test('Privy wallets become signers named ANTARA wallet; external wallets use their display name', () => {
  assert.equal(isEmbeddedClientType('privy'), true);
  assert.equal(isEmbeddedClientType('privy-v2'), true);
  assert.equal(isEmbeddedClientType('phantom'), false);
  assert.equal(isEmbeddedClientType(undefined), false);
  const linked = [
    { type: 'email', address: 'someone@example.com' },
    { type: 'wallet', chainType: 'solana', walletClientType: 'privy', connectorType: 'embedded', address: SOLANA_ANTARA },
    { type: 'wallet', chainType: 'solana', walletClientType: 'phantom', connectorType: 'solana_adapter', address: PHANTOM },
    { type: 'wallet', chainType: 'ethereum', walletClientType: 'privy', connectorType: 'embedded', address: EVM_ANTARA },
    // A linked wallet that only claims a Privy client type through another connector is not embedded.
    { type: 'wallet', chainType: 'ethereum', walletClientType: 'privy', connectorType: 'injected', address: '0x4444444444444444444444444444444444444444' },
    null,
  ];
  const embedded = embeddedWalletsOf(linked);
  assert.deepEqual([...embedded.solana], [SOLANA_ANTARA]);
  assert.deepEqual([...embedded.ethereum], [EVM_ANTARA.toLowerCase()]);
  assert.deepEqual(embeddedWalletsOf(undefined), { solana: new Set(), ethereum: new Set() });
  assert.equal(isEmbeddedAddress(embedded, 'ethereum', EVM_ANTARA.toUpperCase().replace('0X', '0x')), true);
  assert.equal(isEmbeddedAddress(embedded, 'solana', SOLANA_ANTARA.toLowerCase()), false, 'Solana addresses are case-sensitive');
  assert.equal(isEmbeddedAddress(embedded, 'solana', null), false);
  assert.deepEqual(solanaSigner({ address: SOLANA_ANTARA, standardWallet: { name: 'Privy' } }, embedded), { address: SOLANA_ANTARA, name: 'ANTARA wallet', embedded: true });
  assert.deepEqual(solanaSigner({ address: PHANTOM, standardWallet: { name: 'Phantom' } }, embedded), { address: PHANTOM, name: 'Phantom', embedded: false });
  // What a connected wallet says about itself is never enough: an injected Wallet Standard wallet can set
  // isPrivyWallet, so only Privy's linked accounts make a Solana wallet the ANTARA wallet.
  const spoofed = Object.assign({ name: 'Privy' }, { isPrivyWallet: true });
  assert.deepEqual(solanaSigner({ address: 'Other1111111111111111111111111111111111111', standardWallet: spoofed }, embedded), { address: 'Other1111111111111111111111111111111111111', name: 'Privy', embedded: false });
  assert.equal(solanaSigner({ address: SOLANA_ANTARA, standardWallet: spoofed }, embeddedWalletsOf([])).embedded, false);
  // EVM: Privy's own embedded connector for a linked embedded address.
  assert.deepEqual(evmSigner({ address: EVM_ANTARA, walletClientType: 'privy', connectorType: 'embedded', meta: { name: 'Privy Wallet' } }, embedded), { address: EVM_ANTARA, name: 'ANTARA wallet', embedded: true });
  assert.equal(isEmbeddedEvmWallet({ address: EVM_ANTARA, walletClientType: 'privy', connectorType: 'embedded' }, embedded), true);
  // An EIP-6963 extension announcing itself as "Privy" gets client type "privy" but an injected connector.
  assert.deepEqual(evmSigner({ address: '0x5555555555555555555555555555555555555555', walletClientType: 'privy', connectorType: 'injected', meta: { name: 'Privy' } }, embedded),
    { address: '0x5555555555555555555555555555555555555555', name: 'Privy', embedded: false });
  assert.equal(isEmbeddedEvmWallet({ address: EVM_ANTARA, walletClientType: 'privy', connectorType: 'injected' }, embedded), false, 'even with the ANTARA wallet’s address');
  assert.equal(isEmbeddedEvmWallet({ address: '0x4444444444444444444444444444444444444444', walletClientType: 'privy', connectorType: 'embedded' }, embedded), false, 'an address not linked as embedded');
  assert.deepEqual(evmSigner({ address: '0x1', walletClientType: 'metamask', connectorType: 'injected', meta: { name: 'MetaMask' } }, embedded), { address: '0x1', name: 'MetaMask', embedded: false });
  assert.deepEqual(evmSigner({ address: '0x2', walletClientType: 'rabby_wallet', meta: null }, embedded), { address: '0x2', name: 'rabby_wallet', embedded: false });
  assert.deepEqual(evmSigner({ address: '0x3' }, embedded), { address: '0x3', name: 'EVM wallet', embedded: false });
});

test('the explorer links are Solscan for Solana and each supported EVM explorer for an EVM address', () => {
  assert.deepEqual(walletExplorers('solana', SOLANA_ANTARA), [{ name: 'Solscan', network: 'Solana', url: `https://solscan.io/account/${SOLANA_ANTARA}` }]);
  assert.equal(walletExplorers('solana', SOLANA_ANTARA, 'devnet')[0].url, `https://solscan.io/account/${SOLANA_ANTARA}?cluster=devnet`);
  const evm = walletExplorers('evm', EVM_ANTARA);
  assert.deepEqual(evm.map(item => item.network), ['Ethereum', 'BNB Smart Chain', 'Robinhood Chain', 'Base']);
  assert.equal(evm[0].url, `https://etherscan.io/address/${EVM_ANTARA}`);
  assert.ok(evm.every(item => item.url.startsWith('https://') && item.url.endsWith(EVM_ANTARA)));
  assert.equal(exportChainFor('solana'), 'solana');
  assert.equal(exportChainFor('evm'), 'ethereum');
});

test('export failures become readable messages and never echo the raw provider error', () => {
  const cases: Array<[unknown, string]> = [
    [new Error('User must be authenticated before exporting their Privy wallet'), EXPORT_MESSAGES.session],
    [new Error('Must have valid access token.'), EXPORT_MESSAGES.session],
    [new Error('User must have an embedded wallet.'), EXPORT_MESSAGES.external],
    [new Error('Export is not supported for bitcoin-segwit wallets'), EXPORT_MESSAGES.unsupported],
    [new Error('Wallet not ready for export'), EXPORT_MESSAGES.notReady],
    [new Error('Key export is disabled for this app'), EXPORT_MESSAGES.disabled],
    [new Error('Request failed with status code 403'), EXPORT_MESSAGES.disabled],
    [new Error('MFA verification failed'), EXPORT_MESSAGES.verification],
    [new Error('User exited the flow'), EXPORT_MESSAGES.cancelled],
    [new Error('Request failed with status code 500'), EXPORT_MESSAGES.failed],
    ['something odd', EXPORT_MESSAGES.failed],
    [undefined, EXPORT_MESSAGES.failed],
    [new Error(EXPORT_MESSAGES.external), EXPORT_MESSAGES.external],
  ];
  for (const [error, expected] of cases) assert.equal(exportErrorMessage(error), expected, String(error));
  const secretLooking = new Error('5Jsecret-material-that-must-never-be-echoed');
  assert.equal(exportErrorMessage(secretLooking), EXPORT_MESSAGES.failed);
});

test('the signed-out wallet exports nothing and says why', async () => {
  await assert.rejects(disconnectedWallet.exportWallet('solana', SOLANA_ANTARA), { message: EXPORT_MESSAGES.signedOut });
  await assert.rejects(disconnectedWallet.exportWallet('ethereum', EVM_ANTARA), { message: EXPORT_MESSAGES.signedOut });
});
