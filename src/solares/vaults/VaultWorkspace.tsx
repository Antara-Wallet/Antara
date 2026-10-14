import { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { useSolaresWallet } from '../wallet';
import { PRIMARY_NETWORK, SOLANA_CLUSTER } from '../wallet/config';
import { assertWalletSession } from '../wallet/session';
import { byKey, describeLegacyChain, explorerAddressUrl, explorerTxUrl } from '../networks';
import { VaultTransactionError } from './transaction';
import { verifySolanaVault, depositSolanaVault, proposeSolanaRelease, readSolanaProposal, approveSolanaRelease, executeSolanaRelease, type SolanaVault, type SolanaProposal } from './solana';
import { EVM_NETWORKS, verifyEvmVault, depositEvmVault, proposeEvmRelease, readEvmProposal, parseEvmProposal, approveEvmRelease, executeEvmRelease, type EvmVault, type EvmProposalView, type VaultAsset } from './evm';
import { ExternalLink } from '../../platform/ExternalLink';
import './vaults.css';
import '../workspace-cinema.css';

type Vault = SolanaVault | EvmVault;
type SavedVault = { address: string; network: string };
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-6)}`;
/** A Squads vault's on-chain delay after quorum. Owner decision 2026-10-13: none is required, and new vaults have none. */
function squadsDelayText(seconds: number): string {
  if (seconds === 0) return 'No on-chain delay after quorum';
  const hours = seconds / 3600;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(2)} hour${hours === 1 ? '' : 's'} on-chain delay after quorum`;
}

export function VaultWorkspace() {
  const wallet = useSolaresWallet();
  // Solana (Squads) is the primary network; Safe vaults follow in registry order.
  const [network, setNetwork] = useState<string>(PRIMARY_NETWORK);
  const [attachAddress, setAttachAddress] = useState('');
  const [vault, setVault] = useState<Vault | null>(null);
  const [saved, setSaved] = useState<SavedVault[]>([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [signature, setSignature] = useState('');
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState<VaultAsset>('native');
  const [recipient, setRecipient] = useState('');
  const [proposalInput, setProposalInput] = useState('');
  const [solanaProposal, setSolanaProposal] = useState<SolanaProposal | null>(null);
  const [evmProposal, setEvmProposal] = useState<EvmProposalView | null>(null);
  const solana = network === 'solana';
  const owner = solana ? wallet.addresses.solana : wallet.addresses.ethereum;
  const scope = `${wallet.userId}:${network}:${owner}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const proposalRevision = useRef(0);
  const session = wallet.getSession();
  function assertCurrentView() {
    assertWalletSession(session, wallet.getSession());
    if (scopeRef.current !== scope) throw new Error('Your vault network or signing owner changed. Verify the vault again.');
  }
  const signer = { address: wallet.addresses.solana || '', send: wallet.sendSolanaTransaction };
  const evmSigner = { address: wallet.addresses.ethereum || '', getProvider: wallet.getEvmProvider };
  const storageKey = wallet.userId ? `solares.vault-references.v1:${wallet.userId}` : null;
  const proposalKey = storageKey && vault ? `${storageKey}:proposal:${network}:${vault.address}` : null;
  // Native coin and stablecoin are pinned per network: USDC (Binance-Peg, 18 decimals) on BNB Smart Chain, USDG on Robinhood Chain.
  const evmNetwork = solana ? undefined : EVM_NETWORKS.find(item => item.id === Number(network));
  const chainNetwork = solana ? byKey('solana') : evmNetwork ? byKey(evmNetwork.key) : undefined;
  const networkName = solana ? `Solana ${SOLANA_CLUSTER === 'devnet' ? 'devnet' : 'mainnet'}` : chainNetwork?.name;
  const nativeSymbol = chainNetwork?.native.symbol || '';
  const nativeDecimals = chainNetwork?.native.decimals ?? 18;
  const stablecoin = chainNetwork?.funding;
  const stablecoinLabel = stablecoin?.label || '';
  // Device-local references to removed networks (Arbitrum, Polygon) stay visible, read-only.
  const legacySaved = saved.flatMap(item => { const legacy = /^\d+$/.test(item.network) ? describeLegacyChain(Number(item.network)) : undefined; return legacy ? [{ ...item, legacy }] : []; });
  useEffect(() => {
    setVault(null); setSolanaProposal(null); setEvmProposal(null); setSignature(''); setMessage(''); setError('');
  }, [network, owner, wallet.userId]);
  useEffect(() => {
    try { const references = storageKey ? JSON.parse(localStorage.getItem(storageKey) || '[]') : []; setSaved(Array.isArray(references) ? references.slice(0, 20).filter(item => typeof item?.address === 'string' && typeof item?.network === 'string') : []); } catch { setSaved([]); }
  }, [storageKey]);
  useEffect(() => {
    setSolanaProposal(null); setEvmProposal(null);
    try { setProposalInput(proposalKey ? localStorage.getItem(proposalKey) || '' : ''); } catch { setProposalInput(''); }
  }, [proposalKey]);
  async function run(label: string, operation: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError(''); setMessage(''); setSignature('');
    try { await operation(); } catch (failure) {
      if (scopeRef.current === scope) {
        setError(failure instanceof Error ? failure.message : 'The operation could not be completed.');
        if (failure instanceof VaultTransactionError) {
          setSignature(failure.signature);
          setMessage(failure.outcome === 'reverted' ? 'The transaction reverted on-chain. No vault action completed; network fees may have been charged.' : failure.confirmed ? 'The transaction is confirmed, but its resulting vault action could not be verified. Inspect the transaction before taking another action.' : 'This transaction was submitted. Confirmation is unresolved. Inspect the explorer and do not repeat it.');
        }
      }
    } finally { setBusy(''); }
  }
  function remember(value: Vault) {
    assertCurrentView();
    setVault(value);
    const next = [{ address: value.address, network: value.kind === 'squads' ? 'solana' : String(value.chainId) }, ...saved.filter(item => item.address !== value.address || item.network !== network)].slice(0, 20);
    setSaved(next);
    if (storageKey) { try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Public reference persistence is optional; chain state is authoritative. */ } }
  }
  async function verify(address = vault?.address || attachAddress) {
    if (!owner) throw new Error('Select your signing wallet on this network first.');
    const result = solana ? await verifySolanaVault(address.trim(), owner) : await verifyEvmVault(evmSigner, Number(network), address.trim());
    remember(result);
    return result;
  }
  async function inspect(input = proposalInput) {
    if (!vault || !owner) throw new Error('Verify a vault first.');
    const revision = proposalRevision.current;
    const assertUnchanged = () => { assertCurrentView(); if (revision !== proposalRevision.current) throw new Error('The proposal changed during verification. Verify it again.'); };
    if (vault.kind === 'squads') { const result = await readSolanaProposal(vault, input.trim(), owner); assertUnchanged(); setSolanaProposal(result); setEvmProposal(null); }
    else {
      const document = parseEvmProposal(input);
      if (document.safeAddress.toLowerCase() !== vault.address.toLowerCase() || document.chainId !== vault.chainId) throw new Error('This proposal belongs to a different vault or network.');
      const result = await readEvmProposal(evmSigner, document, vault); assertUnchanged(); setEvmProposal(result); setSolanaProposal(null);
    }
    if (proposalKey) { try { localStorage.setItem(proposalKey, input); } catch { /* Never turn a verified chain action into a failure because local storage is unavailable. */ } }
  }
  function confirmed(hash: string, text: string) {
    assertCurrentView(); setSignature(hash); setMessage(text);
  }
  async function refreshAfterConfirmation(operation: () => Promise<void>) {
    try { await operation(); } catch (failure) {
      if (scopeRef.current === scope) setError(`The transaction is confirmed, but refreshing the view failed. Do not repeat it. ${failure instanceof Error ? failure.message : 'Try refreshing verification.'}`);
    }
  }
  const currentProposal = solanaProposal || evmProposal;
  const explorer = (hash: string) => chainNetwork ? explorerTxUrl(chainNetwork, hash, { solanaCluster: SOLANA_CLUSTER }) : '';
  const vaultStablecoin = vault ? vault.kind === 'squads' ? vault.usdcBalance : vault.stablecoinBalance : null;
  const enabled = wallet.configured && wallet.authenticated && wallet.ready && !!owner;
  return <section className="sv-workspace antara-vault-workspace" aria-label="Multisig vault workspace">
    <header className="vault-page-heading"><h2>Existing multisig vaults</h2><p>Manage a previously created Safe or Squads vault.</p></header>
    {!wallet.configured && <div className="sv-notice"><strong>Sign-in setup required.</strong><p>Set up sign-in in Settings to access an existing vault.</p></div>}
    {wallet.configured && !wallet.authenticated && <div className="sv-notice"><strong>Sign in to access an existing vault.</strong><button onClick={wallet.login}>Sign in</button></div>}
    <div className="sv-network-row"><label>Vault network<select value={network} disabled={!!busy} onChange={event => { setNetwork(event.target.value); setAsset('native'); setProposalInput(''); }}><option value="solana">Solana · Squads{SOLANA_CLUSTER === 'devnet' ? ' · devnet' : ''}</option>{EVM_NETWORKS.map(item => <option key={item.id} value={item.id}>{item.name} · Safe</option>)}</select></label><label>Wallet<select value={owner || ''} disabled={!enabled || !!busy} onChange={event => solana ? wallet.selectSolanaSigner(event.target.value) : wallet.selectEvmSigner(event.target.value)}><option value="" disabled>{wallet.authenticated ? 'Select your wallet' : 'Sign in to choose a wallet'}</option>{(solana ? wallet.solanaSigners : wallet.evmSigners).map(item => <option key={item.address} value={item.address}>{item.name} · {short(item.address)}</option>)}</select></label><button className="sv-secondary" disabled={!wallet.authenticated || !!busy} onClick={wallet.connectWallet}>Add external wallet</button></div>
    {owner && <p className="sv-address-label">Current owner <code>{owner}</code></p>}
    {saved.some(item => item.network === network) && <div className="sv-saved"><span>Saved references</span>{saved.filter(item => item.network === network).map(item => <button key={`${item.network}:${item.address}`} disabled={!!busy || !enabled} onClick={() => void run('Verifying vault', async () => { await verify(item.address); setMessage('Vault configuration verified from the chain.'); })}>{short(item.address)} · verify</button>)}</div>}
    {!!legacySaved.length && <div className="sv-saved sv-legacy-saved" aria-label="Saved references on networks no longer supported"><span>No longer supported · read-only</span>{legacySaved.map(item => <ExternalLink key={`${item.network}:${item.address}`} href={explorerAddressUrl(item.legacy, item.address)}>{short(item.address)} · {item.legacy.label} ↗</ExternalLink>)}</div>}
    {!vault ? <div className="sv-panel"><h3>Open an existing vault</h3><p>Select a saved vault or enter its address. Your selected wallet must have access.</p><label>{solana ? 'Squads multisig address' : 'Safe contract address'}<input value={attachAddress} onChange={event => setAttachAddress(event.target.value)} spellCheck={false} placeholder={solana ? 'Squads multisig address' : '0x…'} /></label><button className="sv-primary" disabled={!enabled || !attachAddress || !!busy} onClick={() => void run('Verifying vault', async () => { await verify(); setMessage('Vault configuration verified from the chain.'); })}>Open vault</button></div> : <>
      <div className="sv-panel sv-verified"><div><span className="sv-eyebrow">VERIFIED ON {networkName?.toUpperCase()}</span><h3>{vault.threshold} of {vault.owners.length} owner approvals</h3><p>{vault.kind === 'squads' ? squadsDelayText(vault.timeLockSeconds) : `Safe ${vault.version} · no modules · no guard · no time delay`}</p></div><div className="sv-reserve"><strong>{Number(formatUnits(BigInt(vault.nativeBalance), nativeDecimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })} {nativeSymbol}</strong><span>{vaultStablecoin === null || !stablecoin ? `${stablecoinLabel} unavailable on devnet` : `${formatUnits(BigInt(vaultStablecoin), stablecoin.decimals)} ${stablecoinLabel}`}</span></div><label className="sv-deposit-address">Verified deposit address<code>{vault.depositAddress}</code></label><div className="sv-owner-list">{vault.owners.map((address, index) => <span key={address}><b>{index + 1}</b><code title={address}>{short(address)}</code></span>)}</div><div className="sv-actions"><button className="sv-secondary" disabled={!!busy} onClick={() => void run('Refreshing verification', async () => { await verify(); setMessage('Vault configuration refreshed.'); })}>Refresh verification</button><button className="sv-secondary" disabled={!!busy} onClick={() => { setVault(null); setSolanaProposal(null); setEvmProposal(null); }}>Choose another vault</button></div><small>Read from chain at {new Date(vault.observedAt).toLocaleTimeString()}. Configuration is checked again before each action.</small></div>
      <div className="sv-grid"><div className="sv-panel"><span className="sv-eyebrow">RESERVE MANAGEMENT</span><h3>Deposit or release funds</h3><div className="sv-split"><label>Asset<select value={asset} onChange={event => setAsset(event.target.value as VaultAsset)}><option value="native">{nativeSymbol}</option>{(!solana || SOLANA_CLUSTER !== 'devnet') && <option value="stablecoin">{stablecoinLabel}</option>}</select></label><label>Amount<input value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" placeholder="0.00" /></label></div><button className="sv-secondary" disabled={!!busy || !amount || !enabled} onClick={() => void run('Depositing into vault', async () => {
        const hash = vault.kind === 'squads' ? await depositSolanaVault(signer, vault, asset === 'stablecoin' ? 'USDC' : 'SOL', amount) : await depositEvmVault(evmSigner, vault, asset, amount);
        confirmed(hash, 'Deposit confirmed on-chain.'); await refreshAfterConfirmation(async () => { await verify(); await wallet.refetchBalances(); });
      })}>Deposit {amount || 'funds'} {asset === 'stablecoin' ? stablecoinLabel : nativeSymbol}</button><hr /><label>Release recipient<input value={recipient} onChange={event => setRecipient(event.target.value)} placeholder={owner || 'Recipient address'} spellCheck={false} /></label><button className="sv-text-button" onClick={() => setRecipient(owner || '')}>Use my current wallet</button><button className="sv-primary" disabled={!!busy || !amount || !recipient || !enabled} onClick={() => void run('Preparing release proposal', async () => {
        if (vault.kind === 'squads') { const result = await proposeSolanaRelease(signer, vault, recipient, asset === 'stablecoin' ? 'USDC' : 'SOL', amount); confirmed(result.signature, 'Proposal created with your first on-chain approval. Share the vault address and proposal index with your other owner.'); setProposalInput(result.index); await refreshAfterConfirmation(async () => { await inspect(result.index); }); }
        else { const proposal = await proposeEvmRelease(evmSigner, vault, recipient, asset, amount); assertCurrentView(); const json = JSON.stringify(proposal, null, 2); setProposalInput(json); await inspect(json); setMessage('Proposal prepared. Review the details and approve it on-chain, then share the proposal JSON with your other owner.'); }
      })}>Propose release{solana ? ' & cast first vote' : ''}</button><small>Releases require the vault quorum{solana ? ' and any on-chain delay the vault sets' : ''}. This action never bypasses those protections.</small></div>
      <div className="sv-panel"><span className="sv-eyebrow">OWNER CONSENSUS</span><h3>Review. Approve. Release.</h3><label>{solana ? 'Proposal index' : 'Shared proposal JSON'}<textarea value={proposalInput} onChange={event => { proposalRevision.current++; setProposalInput(event.target.value); setSolanaProposal(null); setEvmProposal(null); }} rows={solana ? 2 : 5} placeholder={solana ? 'For example: 1' : 'Paste an ANTARA release proposal'} spellCheck={false} /></label><div className="sv-actions"><button className="sv-secondary" disabled={!proposalInput || !!busy || !enabled} onClick={() => void run('Reading proposal', async () => { await inspect(); })}>Verify proposal details</button><button className="sv-secondary" disabled={!proposalInput || !!busy} onClick={() => void run('Copying proposal', async () => { await navigator.clipboard.writeText(solana ? `ANTARA vault: ${vault.address}\nNetwork: ${networkName}\nProposal index: ${proposalInput}` : proposalInput); setMessage('Public proposal details copied. Share them with an independent owner.'); })}>Copy for other owner</button></div>
      {currentProposal && <div className="sv-proposal"><strong>{currentProposal.amount} {currentProposal.asset}</strong><span>To <code>{currentProposal.recipient}</code></span><p>{currentProposal.approvals.length} / {currentProposal.threshold} approvals{solanaProposal ? ` · ${solanaProposal.status}` : ''}{currentProposal.stale ? ' · stale' : ''}</p>{solanaProposal?.executableAt && <p>Execution opens {new Date(solanaProposal.executableAt).toLocaleString()}</p>}<div className="sv-actions"><button disabled={!!busy || currentProposal.stale || !enabled} onClick={() => void run('Recording approval', async () => { const hash = solanaProposal && vault.kind === 'squads' ? await approveSolanaRelease(signer, vault, solanaProposal.index) : evmProposal && vault.kind === 'safe' ? await approveEvmRelease(evmSigner, evmProposal.proposal, vault) : ''; confirmed(hash, 'Your approval is confirmed on-chain.'); await refreshAfterConfirmation(async () => { await inspect(); }); })}>Approve as current owner</button><button className="sv-primary" disabled={!!busy || currentProposal.stale || currentProposal.approvals.length < currentProposal.threshold || !enabled} onClick={() => void run('Executing approved release', async () => { const hash = solanaProposal && vault.kind === 'squads' ? await executeSolanaRelease(signer, vault, solanaProposal.index) : evmProposal && vault.kind === 'safe' ? await executeEvmRelease(evmSigner, evmProposal.proposal, vault) : ''; confirmed(hash, 'Withdrawal executed successfully on-chain.'); await refreshAfterConfirmation(async () => { await verify(); await wallet.refetchBalances(); await inspect(); }); })}>Execute release</button></div></div>}
      <small>{solana ? 'Other owners attach the same multisig and inspect this index. Every approval is recorded on Solana.' : 'Copy the proposal JSON to share. Each owner verifies the same chain-bound hash and records an approval on-chain; no centralized signature store is required.'}</small></div></div>
    </>}
    {busy && <div className="sv-notice" role="status">{busy}… Follow the wallet confirmation when prompted.</div>}
    {error && <div className="sv-error" role="alert">{error}</div>}
    {message && <div className="sv-notice" role="status">{message}{signature && <ExternalLink href={explorer(signature)}>View transaction ↗</ExternalLink>}</div>}
    <p className="sv-footnote">Distinct addresses do not prove independent custody. Keep guardian keys and recovery methods separate. Multisig reduces single-key risk; it cannot guarantee loss prevention.</p>
  </section>;
}
export default VaultWorkspace;
