import Safe, { EthSafeTransaction, generatePreValidatedSignature, type Eip1193Provider } from '@safe-global/protocol-kit';
import { getSafeSingletonDeployments, getSafeL2SingletonDeployments, getProxyFactoryDeployment, getCompatibilityFallbackHandlerDeployment } from '@safe-global/safe-deployments';
import type { SafeTransactionData } from '@safe-global/types-kit';
import { concatHex, createPublicClient, createWalletClient, custom, decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, keccak256, parseAbi, zeroAddress, type Address, type EIP1193Provider, type Hex } from 'viem';
import { SUPPORTED_EVM_NETWORKS, byKey, isFundingToken } from '../networks';
import { VIEM_CHAINS } from '../evmChains';
import { assertSameOwners, assertReviewedVaultPolicy, parseAmount, validateVaultPolicy } from './validation';
import { preserveVaultTransaction, waitForVaultReceipt } from './transaction';

/**
 * Safe vault networks from the registry, in display order: Ethereum, BNB Smart
 * Chain, Robinhood Chain and Base (canonical Safe 1.3.0/1.4.1/1.5.0 deployments
 * exist on each). Each vault's stablecoin is that network's pinned funding
 * token. Arbitrum and Polygon are not supported.
 */
export const EVM_NETWORKS = Object.freeze(SUPPORTED_EVM_NETWORKS.filter(network => network.safeSupported).map(network => Object.freeze({
  id: network.evmChainId,
  key: network.key,
  name: network.name,
  chain: VIEM_CHAINS[network.key],
  native: network.native.symbol,
  nativeDecimals: network.native.decimals,
  stablecoin: Object.freeze({ symbol: network.funding.symbol, label: network.funding.label, address: network.funding.address as Address, decimals: network.funding.decimals }),
})));
export type EvmVaultNetwork = typeof EVM_NETWORKS[number];
export type VaultAsset = 'native' | 'stablecoin';
export interface EvmSigner { address: string; getProvider: (chainId: number) => Promise<EIP1193Provider> }
/** `stablecoinBalance` is the raw balance of the network's funding stablecoin (see EVM_NETWORKS) at its own decimals. */
export interface EvmVault { kind: 'safe'; address: string; depositAddress: string; chainId: number; owners: string[]; threshold: number; timeLockSeconds: 0; version: string; observedAt: string; nativeBalance: string; stablecoinBalance: string }
export interface EvmProposal { version: 1; chainId: number; safeAddress: string; safeTxHash: string; data: SafeTransactionData }
export interface EvmProposalView { proposal: EvmProposal; approvals: string[]; threshold: number; recipient: string; amount: string; asset: string; stale: boolean }
/** Fail closed for Arbitrum, Polygon and any chain without a supported Safe deployment. */
export function evmVaultNetwork(chainId: number): EvmVaultNetwork {
  const network = EVM_NETWORKS.find(network => network.id === chainId);
  if (!network) throw new Error('Unsupported vault network.');
  if (!isFundingToken(byKey(network.key), network.stablecoin.address)) throw new Error('Unsupported vault asset.');
  return network;
}
const networkFor = evmVaultNetwork;
function vaultAmount(network: EvmVaultNetwork, asset: VaultAsset, amount: string) {
  if (asset !== 'native' && asset !== 'stablecoin') throw new Error('Unsupported vault asset.');
  return parseAmount(amount, asset === 'stablecoin' ? network.stablecoin.decimals : network.nativeDecimals);
}
async function clients(signer: EvmSigner, chainId: number) {
  const network = networkFor(chainId), provider = await signer.getProvider(chainId);
  // Both libraries use EIP-1193; Safe permits custom RPC methods beyond viem's typed method union.
  return { network, provider: provider as unknown as Eip1193Provider, publicClient: createPublicClient({ chain: network.chain, transport: custom(provider) }), walletClient: createWalletClient({ account: getAddress(signer.address), chain: network.chain, transport: custom(provider) }) };
}

export async function verifyEvmVault(signer: EvmSigner, chainId: number, address: string): Promise<EvmVault> {
  if (!isAddress(address)) throw new Error('Enter a valid Safe address.');
  const { provider, publicClient, network } = await clients(signer, chainId);
  const safe = await Safe.init({ provider, signer: signer.address, safeAddress: address });
  if (!await safe.isSafeDeployed() || await safe.getChainId() !== BigInt(chainId)) throw new Error('The Safe is not deployed on the requested chain.');
  const version = safe.getContractVersion();
  if (!['1.3.0', '1.4.1', '1.5.0'].includes(version)) throw new Error('This Safe contract version is not supported.');
  const [owners, threshold, modules, guard, fallback, storage, code, native, stablecoin] = await Promise.all([
    safe.getOwners(), safe.getThreshold(), safe.getModules(), safe.getGuard(), safe.getFallbackHandler(),
    publicClient.getStorageAt({ address, slot: '0x0' }), publicClient.getCode({ address }), publicClient.getBalance({ address }),
    publicClient.readContract({ address: network.stablecoin.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
  ]);
  validateVaultPolicy({ owners, threshold, userAddress: signer.address, chain: 'evm' });
  const ownerCode = await Promise.all(owners.map(owner => publicClient.getCode({ address: getAddress(owner) })));
  if (ownerCode.some(runtime => runtime && runtime !== '0x')) throw new Error('Contract owners need a separate signature integration. Attach a vault with independent EOA owners.');
  if (modules.length || guard.toLowerCase() !== zeroAddress) throw new Error('This Safe uses a module or guard requiring a separate security review.');
  if (!storage || !code) throw new Error('Unable to verify Safe bytecode.');
  const singletonAddress = getAddress(`0x${storage.slice(-40)}`);
  const filter = { version, network: chainId.toString(), released: true };
  const deployments = [getSafeSingletonDeployments(filter), getSafeL2SingletonDeployments(filter)];
  const singleton = deployments.flatMap(item => item ? Object.values(item.deployments) : []).find(item => item?.address.toLowerCase() === singletonAddress.toLowerCase());
  if (!singleton) throw new Error('Unknown Safe singleton implementation.');
  const singletonCode = await publicClient.getCode({ address: singletonAddress });
  if (!singletonCode || keccak256(singletonCode).toLowerCase() !== singleton.codeHash.toLowerCase()) throw new Error('The Safe implementation bytecode differs from its published deployment.');
  const expectedFallback = getCompatibilityFallbackHandlerDeployment(filter);
  const fallbackAddresses = expectedFallback ? Object.values(expectedFallback.deployments).map(d => d?.address.toLowerCase()) : [];
  if (fallback.toLowerCase() !== zeroAddress && !fallbackAddresses.includes(fallback.toLowerCase())) throw new Error('Unknown fallback handler.');
  if (fallback.toLowerCase() !== zeroAddress && expectedFallback) {
    const release = Object.values(expectedFallback.deployments).find(d => d?.address.toLowerCase() === fallback.toLowerCase());
    const runtime = await publicClient.getCode({ address: getAddress(fallback) });
    if (!release || !runtime || keccak256(runtime).toLowerCase() !== release.codeHash.toLowerCase()) throw new Error('Fallback handler bytecode could not be verified.');
  }
  const factory = getProxyFactoryDeployment(filter);
  const factoryAddress = factory?.networkAddresses[chainId.toString()];
  if (!factory || !factoryAddress) throw new Error('No verified Safe factory exists for this chain/version.');
  const factoryRelease = Object.values(factory.deployments).find(d => d?.address.toLowerCase() === factoryAddress.toLowerCase());
  const factoryCode = await publicClient.getCode({ address: getAddress(factoryAddress) });
  if (!factoryRelease || !factoryCode || keccak256(factoryCode).toLowerCase() !== factoryRelease.codeHash.toLowerCase()) throw new Error('Safe factory bytecode could not be verified.');
  const creationCode = await publicClient.readContract({ address: getAddress(factoryAddress), abi: parseAbi(['function proxyCreationCode() view returns (bytes)']), functionName: 'proxyCreationCode' });
  // A read-only contract creation simulation returns canonical proxy runtime. This prevents a lookalike contract from spoofing owners/threshold.
  const expectedProxy = await publicClient.call({ data: concatHex([creationCode, encodeAbiParameters([{ type: 'address' }], [singletonAddress])]) });
  if (!expectedProxy.data || keccak256(code) !== keccak256(expectedProxy.data)) throw new Error('The vault proxy bytecode is not the canonical Safe proxy.');
  return { kind: 'safe', address: getAddress(address), depositAddress: getAddress(address), chainId, owners, threshold, timeLockSeconds: 0, version, observedAt: new Date().toISOString(), nativeBalance: native.toString(), stablecoinBalance: stablecoin.toString() };
}

export async function createEvmVault(signer: EvmSigner, chainId: number, owners: string[], threshold: number) {
  const policy = validateVaultPolicy({ owners, threshold, userAddress: signer.address, chain: 'evm' });
  if (owners.some(owner => !isAddress(owner) || owner.toLowerCase() === zeroAddress)) throw new Error('Every owner must have a valid nonzero Ethereum address.');
  const { provider, walletClient, publicClient } = await clients(signer, chainId);
  const ownerCode = await Promise.all(policy.owners.map(owner => publicClient.getCode({ address: getAddress(owner) })));
  if (ownerCode.some(runtime => runtime && runtime !== '0x')) throw new Error('Use independently controlled EOA wallets as owners. Contract owners are not supported by this approval flow.');
  const entropy = crypto.getRandomValues(new Uint8Array(16));
  const saltNonce = BigInt(`0x${Array.from(entropy, n => n.toString(16).padStart(2, '0')).join('')}`).toString();
  const safe = await Safe.init({ provider, signer: signer.address, predictedSafe: { safeAccountConfig: { owners: policy.owners, threshold, fallbackHandler: zeroAddress }, safeDeploymentConfig: { saltNonce, safeVersion: '1.4.1' } } });
  const deployment = await safe.createSafeDeploymentTransaction();
  const signature = await walletClient.sendTransaction({ to: getAddress(deployment.to), data: deployment.data as Hex, value: BigInt(deployment.value) });
  await waitForVaultReceipt(signature, chainId, publicClient);
  return preserveVaultTransaction(signature, async () => {
    const vault = await verifyEvmVault(signer, chainId, await safe.getAddress());
    assertSameOwners(vault.owners, policy.owners, 'evm');
    if (vault.threshold !== threshold) throw new Error('The deployed threshold differs from the reviewed configuration.');
    return { vault, signature };
  }, true);
}

export async function depositEvmVault(signer: EvmSigner, vault: EvmVault, asset: VaultAsset, amount: string) {
  const raw = vaultAmount(networkFor(vault.chainId), asset, amount);
  assertReviewedVaultPolicy(await verifyEvmVault(signer, vault.chainId, vault.address), vault);
  const { network, publicClient, walletClient } = await clients(signer, vault.chainId);
  const signature = await walletClient.sendTransaction(asset === 'stablecoin'
    ? { to: network.stablecoin.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(vault.address), raw] }), value: 0n }
    : { to: getAddress(vault.address), value: raw });
  await waitForVaultReceipt(signature, vault.chainId, publicClient);
  return signature;
}

export async function proposeEvmRelease(signer: EvmSigner, vault: EvmVault, recipient: string, asset: VaultAsset, amount: string): Promise<EvmProposal> {
  const raw = vaultAmount(networkFor(vault.chainId), asset, amount);
  const verified = await verifyEvmVault(signer, vault.chainId, vault.address);
  assertReviewedVaultPolicy(verified, vault);
  if (!isAddress(recipient) || recipient.toLowerCase() === zeroAddress || recipient.toLowerCase() === vault.address.toLowerCase()) throw new Error('Enter a nonzero recipient different from the vault.');
  const { provider, network } = await clients(signer, vault.chainId);
  if (raw > BigInt(asset === 'stablecoin' ? verified.stablecoinBalance : verified.nativeBalance)) throw new Error('The vault has insufficient balance.');
  const safe = await Safe.init({ provider, signer: signer.address, safeAddress: vault.address });
  const tx = await safe.createTransaction({ transactions: [{ to: asset === 'stablecoin' ? network.stablecoin.address : recipient, value: asset === 'stablecoin' ? '0' : raw.toString(), data: asset === 'stablecoin' ? encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, raw] }) : '0x', operation: 0 }] });
  return { version: 1, chainId: vault.chainId, safeAddress: vault.address, safeTxHash: await safe.getTransactionHash(tx), data: tx.data };
}

export function parseEvmProposal(json: string): EvmProposal {
  if (json.length > 16_384) throw new Error('Proposal is too large.');
  const proposal = JSON.parse(json) as EvmProposal;
  if (proposal?.version !== 1 || !isAddress(proposal.safeAddress || '') || !/^0x[0-9a-fA-F]{64}$/.test(proposal.safeTxHash || '') || !proposal.data) throw new Error('Invalid ANTARA proposal document.');
  networkFor(proposal.chainId);
  const data = proposal.data;
  if (!isAddress(data.to || '') || data.to.toLowerCase() === zeroAddress || data.to.toLowerCase() === proposal.safeAddress.toLowerCase() || data.operation !== 0 || !Number.isSafeInteger(data.nonce) || data.nonce < 0 || !/^\d+$/.test(data.value || '') || !/^0x([0-9a-fA-F]{2})*$/.test(data.data || '')) throw new Error('Invalid withdrawal transaction fields.');
  if (data.gasPrice !== '0' || data.baseGas !== '0' || data.safeTxGas !== '0' || data.gasToken?.toLowerCase() !== zeroAddress || data.refundReceiver?.toLowerCase() !== zeroAddress) throw new Error('ANTARA withdrawals do not allow hidden gas refunds or custom gas fields.');
  return proposal;
}

export async function readEvmProposal(signer: EvmSigner, proposalInput: EvmProposal, reviewedVault: EvmVault): Promise<EvmProposalView> {
  const proposal = parseEvmProposal(JSON.stringify(proposalInput));
  const vault = await verifyEvmVault(signer, proposal.chainId, proposal.safeAddress);
  assertReviewedVaultPolicy(vault, reviewedVault);
  const { provider, network } = await clients(signer, proposal.chainId);
  const safe = await Safe.init({ provider, signer: signer.address, safeAddress: proposal.safeAddress });
  const tx = new EthSafeTransaction(proposal.data);
  if ((await safe.getTransactionHash(tx)).toLowerCase() !== proposal.safeTxHash.toLowerCase()) throw new Error('Proposal hash does not match the chain, vault, and transaction data.');
  let recipient = proposal.data.to, raw = BigInt(proposal.data.value), asset: string = network.native, decimals = network.nativeDecimals;
  if (proposal.data.data !== '0x') {
    // Only this network's pinned stablecoin; a token that merely shares its ticker is rejected.
    if (proposal.data.to.toLowerCase() !== network.stablecoin.address.toLowerCase() || raw !== 0n) throw new Error(`Only ${network.native} and the verified ${network.stablecoin.label} token are supported on ${network.name}.`);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: proposal.data.data as Hex });
    if (decoded.functionName !== 'transfer') throw new Error('Only direct token transfers are supported.');
    const [to, amount] = decoded.args as [Address, bigint];
    recipient = to; raw = amount; asset = network.stablecoin.label; decimals = network.stablecoin.decimals;
    if (proposal.data.data.toLowerCase() !== encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }).toLowerCase()) throw new Error('Non-canonical token transfer payload.');
  }
  if (raw <= 0n || recipient.toLowerCase() === zeroAddress || recipient.toLowerCase() === proposal.safeAddress.toLowerCase()) throw new Error('Invalid withdrawal destination or amount.');
  const [approvals, nonce] = await Promise.all([safe.getOwnersWhoApprovedTx(proposal.safeTxHash), safe.getNonce()]);
  return { proposal, approvals, threshold: vault.threshold, recipient, amount: formatUnits(raw, decimals), asset, stale: nonce !== proposal.data.nonce };
}

export async function approveEvmRelease(signer: EvmSigner, proposal: EvmProposal, reviewedVault: EvmVault) {
  const view = await readEvmProposal(signer, proposal, reviewedVault);
  if (view.stale) throw new Error('This proposal nonce is not current. Rebuild and review it.');
  if (view.approvals.some(owner => owner.toLowerCase() === signer.address.toLowerCase())) throw new Error('This owner has already approved.');
  const { provider, publicClient } = await clients(signer, proposal.chainId);
  const safe = await Safe.init({ provider, signer: signer.address, safeAddress: proposal.safeAddress });
  const result = await safe.approveTransactionHash(proposal.safeTxHash);
  await waitForVaultReceipt(result.hash as Hex, proposal.chainId, publicClient);
  return result.hash;
}
export async function executeEvmRelease(signer: EvmSigner, proposal: EvmProposal, reviewedVault: EvmVault) {
  const view = await readEvmProposal(signer, proposal, reviewedVault);
  if (view.stale || view.approvals.length < view.threshold) throw new Error('This proposal needs its current owner quorum.');
  const { provider, publicClient } = await clients(signer, proposal.chainId);
  const safe = await Safe.init({ provider, signer: signer.address, safeAddress: proposal.safeAddress });
  const tx = new EthSafeTransaction(proposal.data);
  for (const owner of view.approvals) tx.addSignature(generatePreValidatedSignature(owner));
  const result = await safe.executeTransaction(tx);
  const receipt = await waitForVaultReceipt(result.hash as Hex, proposal.chainId, publicClient);
  // Safe can emit ExecutionFailure inside a successful outer receipt; never claim success from receipt alone.
  const executionSuccess = keccak256(new TextEncoder().encode('ExecutionSuccess(bytes32,uint256)'));
  const executed = receipt.logs.some(log => log.address.toLowerCase() === proposal.safeAddress.toLowerCase() && log.topics[0] === executionSuccess && (log.topics[1] || log.data.slice(0, 66)).toLowerCase() === proposal.safeTxHash.toLowerCase());
  await preserveVaultTransaction(result.hash, async () => {
    if (!executed) throw new Error('The Safe did not emit a matching successful withdrawal event. Inspect the transaction on the explorer.');
  }, true);
  return result.hash;
}
