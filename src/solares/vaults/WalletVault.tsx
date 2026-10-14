import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { useSolaresWallet } from '../wallet';
import { API_URL } from '../wallet/config';
import { byKey } from '../networks';
import type { WalletChain } from '../wallet/types';
import { assertWalletSession } from '../wallet/session';
import { WALLET_NOT_CONFIRMED_MESSAGE, WalletNotLinkedError, isLinkedHere, retryUntilLinked, walletNotLinked } from '../wallet/linkRecovery';
import { formatAmount } from '../relay/model';
import { TokenLogo } from '../TokenLogo';
import { AddressText, Icon } from '../ui';
import { VaultBalanceCard, VaultLayersPreview, VaultStateCard, type VaultCardValue } from './VaultCards';
import { parsePairedVault, type PairedVaultDiscovery } from './paired';
import type { EvmVault } from './evm';
import { PairedSolanaVault } from './PairedSolanaVault';
import { usePrices } from '../wallet/usePrices';
import { vaultValue } from './vaultValue';

type View = { status: 'loading' | 'error'; message?: string } | { status: 'resolved'; discovery: PairedVaultDiscovery; vault?: EvmVault };

type WalletVaultProps = {
  chain: WalletChain; privacy: boolean; onPrivacy: () => void; onSignIn: () => void; onWallet: () => void; onSettings: () => void;
  /** Receive into the vault (vault side of the Receive sheet). */
  onReceive?: () => void;
  /** Receive into the spending wallet, to add the SOL a vault creation needs (wallet side of the Receive sheet). */
  onFundWallet?: () => void;
};

/** Solana: the paired Squads vault with the ANTARA guardian. EVM: read-only discovery of an existing ARK Safe; the EVM paired vault comes next. */
export function WalletVault(props: WalletVaultProps) {
  return props.chain === 'solana' ? <PairedSolanaVault {...props} /> : <EvmWalletVault {...props} />;
}

function EvmWalletVault({ chain, privacy, onPrivacy, onSignIn, onWallet, onSettings }: WalletVaultProps) {
  const wallet = useSolaresWallet();
  // Network name, native coin and stablecoin come from the registry; Robinhood Chain shows USDG, never USDC.
  const network = byKey(chain);
  const stablecoin = network.funding;
  const owner = wallet.authenticated ? wallet.addresses.ethereum : null;
  const [view, setView] = useState<View>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [settings, setSettings] = useState(false);
  const canRead = wallet.configured && wallet.authenticated && wallet.ready && !!owner;
  useEffect(() => {
    if (!canRead || !owner) return;
    const controller = new AbortController();
    const session = wallet.getSession();
    setView({ status: 'loading' });
    const assertCurrent = () => {
      if (controller.signal.aborted) throw new Error('Vault view changed.');
      assertWalletSession(session, wallet.getSession());
    };
    void (async () => {
      try {
        const query = new URLSearchParams({ chain, owner });
        // A wallet this client sees linked but the server does not list yet is asked again (wallet/linkRecovery.ts).
        const linkedHere = isLinkedHere(wallet.linkedWallets, 'ethereum', owner);
        const response = await retryUntilLinked(async () => {
          const token = await wallet.getAccessToken();
          assertCurrent();
          if (!token) throw new Error('Sign in again to check your vault.');
          const answer = await fetch(`${API_URL}/api/solares/paired-vault?${query}`, {
            headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
          });
          if (answer.status === 403) throw walletNotLinked(403, await answer.json().catch(() => null)) ?? new Error('Your vault could not be checked. Please try again.');
          return answer;
        }, { signal: controller.signal, retryable: outcome => linkedHere && !outcome.ok && outcome.error instanceof WalletNotLinkedError })
          .catch(error => { throw error instanceof WalletNotLinkedError ? new Error(linkedHere ? WALLET_NOT_CONFIRMED_MESSAGE : error.message) : error; });
        if (!response.ok) throw new Error('Your vault could not be checked. Please try again.');
        const discovery = parsePairedVault(await response.json(), owner, chain);
        assertCurrent();
        let vault: EvmVault | undefined;
        if (discovery.status === 'deployed') {
          if (network.evmChainId === null) throw new Error('The paired vault could not be verified.');
          const { verifyEvmVault } = await import('./evm');
          assertCurrent();
          vault = await verifyEvmVault({ address: owner, getProvider: wallet.getEvmProvider }, network.evmChainId, discovery.address);
          assertCurrent();
          if (vault.threshold !== 2 || vault.owners.length !== 2 ||
            !vault.owners.some(value => value.toLowerCase() === discovery.cosigner.toLowerCase())) {
            throw new Error('This vault no longer matches your wallet’s security service.');
          }
        }
        setView({ status: 'resolved', discovery, vault });
      } catch (error) {
        if (!controller.signal.aborted) setView({ status: 'error', message: error instanceof Error ? error.message : 'Unable to check your vault.' });
      }
    })();
    return () => controller.abort();
    // Parent keys this component by account, selected wallet and chain. Callback
    // identity changes caused by balance refreshes must not restart discovery.
  }, [chain, owner, canRead, wallet.userId, wallet.linkedWallets, attempt]);

  const vault = canRead && view.status === 'resolved' ? view.vault : undefined;
  const loading = wallet.authenticated && (!wallet.ready || !owner || (canRead && view.status === 'loading'));
  const status = canRead && view.status === 'resolved' ? view.discovery.status : null;
  // Without a verified vault the balance is unknown, never zero.
  const balanceHint = privacy || loading || vault ? undefined : !wallet.authenticated ? 'Sign in to load balances' : 'Vault balance unavailable';
  const title = !wallet.authenticated ? 'Your wallet. Its own vault.' : vault ? 'Your vault is linked to this wallet' : loading ? 'Finding your vault' : view.status === 'error' ? 'We couldn’t check your vault' : 'Your vault, built around your wallet';
  const description = !wallet.authenticated
    ? 'Sign in to access your wallet and its dedicated vault in one place.'
    : vault ? 'This is your existing ARK vault, shown read-only. Transfers and security changes are not available with this sign-in; the EVM paired vault comes next.'
    : loading ? 'Checking the vault associated with this wallet on ' + network.name + '.'
    : view.status === 'error' ? view.message
    : status === 'unsupported' ? `Paired vaults are not available on ${network.name} yet. Your wallet is ready for everyday use.`
    : `Vault activation is not available yet. EVM vault coming next: paired vaults start on Solana, and on ${network.name} your wallet is ready for everyday use with nothing held in a vault.`;

  // The vault's total in US dollars at Relay prices (vaultValue.ts); without a price, its largest holding.
  const prices = usePrices(!!vault);
  const valued = vault ? vaultValue({ chain, native: BigInt(vault.nativeBalance), stablecoin: BigInt(vault.stablecoinBalance), prices, privacy }) : null;
  const cardValue: VaultCardValue = privacy ? { kind: 'masked' }
    : valued?.headline.kind === 'usd' ? { kind: 'usd', amount: valued.headline.amount, approx: valued.headline.approx, title: valued.title }
    : valued?.headline.kind === 'amount' ? { kind: 'amount', amount: valued.headline.amount, unit: valued.headline.unit }
    : { kind: 'placeholder', unit: 'USD', reason: valued?.headline.kind === 'pending' ? valued.headline.reason : balanceHint ?? 'Vault balance unavailable' };
  const meta = valued ? [`Vault balance on ${network.name}`, valued.excluded, valued.source].filter(Boolean).join(' · ') : !wallet.authenticated ? 'Sign in to view your vault' : loading ? 'Checking your vault…' : view.status === 'error' || status === 'unavailable' ? 'Vault balance not verified' : status === 'not-created' ? 'No vault on this network' : 'Vault unavailable on this network';
  const card = <VaultBalanceCard label="Vault · total" value={cardValue} breakdown={valued?.holdingList ?? []} meta={meta} failed={canRead && view.status === 'error'} onRetry={() => setAttempt(attempt + 1)}
    privacy={privacy} onPrivacy={onPrivacy} settingsOpen={settings} onSettings={() => setSettings(!settings)} network={{ name: network.name, logo: chain }}
    foot={<span className="vx-foot-line"><span>{owner ? 'For your wallet' : 'A dedicated vault for each wallet'}</span>{owner && <AddressText address={owner} form="short" />}</span>} compact={!vault} />;

  return <section className="wallet-vault vx" aria-label="Your wallet’s vault" data-state={vault ? 'linked' : 'evm'}>
    {settings ? <section className="vx-settings" aria-label="Vault settings">
      <header className="vx-settings-head">
        <button type="button" className="ui-btn-text vx-back" onClick={() => setSettings(false)}><Icon name="back" size={16} />Back to vault</button>
        <h2>Vault settings</h2>
        <button type="button" className="ui-btn vx-small-btn" onClick={() => setSettings(false)}>Done</button>
      </header>
      <section className="vx-details ui-card" aria-labelledby="vx-evm-details">
        <header className="vx-section-head"><div><h3 id="vx-evm-details">Vault details</h3></div></header>
        <dl className="vx-dl">
          <div><dt>Linked wallet</dt><dd>{owner ? <AddressText address={owner} copy copyLabel="Copy wallet address" /> : 'Sign in to see your wallet.'}</dd></div>
          <div><dt>Security layers</dt><dd><small>EVM vault coming next. On EVM networks ANTARA only shows an existing ARK vault, read-only; activation and changes are not available in this version.</small></dd></div>
          <div><dt>Protection</dt><dd><small>Protection layers, including the optional vault authenticator (MFA), apply to the Solana vault. Your regular wallet has no MFA.</small></dd></div>
        </dl>
        <button type="button" className="ui-btn vx-small-btn" onClick={onSettings}>Open protection</button>
      </section>
    </section> : <div className="vx-layout">
      <div className="vx-main">
        {card}
        <VaultStateCard title={title} text={description ?? ''} loading={loading} tone={view.status === 'error' && canRead ? 'danger' : 'neutral'} icon={!wallet.authenticated ? 'vault' : 'shield'}>
          {!wallet.authenticated ? <button type="button" className="ui-btn-primary" onClick={onSignIn} disabled={wallet.configured && !wallet.ready}>Sign in</button>
            : view.status === 'error' ? <button type="button" className="ui-btn-primary" onClick={() => setAttempt(attempt + 1)}>Try again</button>
            : loading ? null : <button type="button" className="ui-btn" onClick={onWallet}>Back to wallet</button>}
        </VaultStateCard>
        {vault && <section className="vx-assets ui-card" aria-label="Vault assets">
          <header className="vx-section-head"><div><h3>Tokens</h3></div></header>
          <ul className="vx-token-list">
            {[{ symbol: network.native.symbol, label: network.native.symbol, amount: formatUnits(BigInt(vault.nativeBalance), network.native.decimals) }, { symbol: stablecoin.circleIssued ? stablecoin.symbol : 'stablecoin', label: stablecoin.label, amount: formatAmount(vault.stablecoinBalance, stablecoin.decimals) }].map(asset =>
              <li key={asset.label}><TokenLogo symbol={asset.symbol} /><span className="vx-token-name"><strong>{asset.label}</strong><small>{network.name}</small></span><span className="vx-token-amount">{privacy ? '••••••' : asset.amount}</span></li>)}
          </ul>
          <div className="vx-address-row"><span className="vx-address-label">Verified vault</span><AddressText address={vault.address} form="short" copy copyLabel="Copy vault address" /></div>
        </section>}
      </div>
      <aside className="vx-side" aria-label="About your vault">
        <VaultLayersPreview note="Protection layers apply to the Solana vault. Each vault chooses its own; only a passkey is required." />
      </aside>
    </div>}
  </section>;
}
