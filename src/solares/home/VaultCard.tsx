// "Your vault" on the Wallet home: the one obvious place to create the selected wallet's
// 2-of-2 Solana vault, and its status afterwards. Reads only the shared vault summary
// (vaults/summary.ts, docs/UI_ARGUS_PARITY.md 8.2); the balance of an active vault is read
// on demand from Solana by the vault module's own verifier (verifyPairedSolanaVault), so
// nothing here guesses a state or a number.
//
//   not created   "Create your vault" (primary) and one line on what it is
//   activating    progress (Create on Solana · Register · Add a passkey) and the next action
//   active        the verified vault total in US dollars ("≈ $8.43", Relay prices, owner decision
//                 2026-10-13), what it holds ("0.005 SOL · 0 USDC") and "Open vault"
//   unavailable   a short honest reason, and Retry where a retry can help
//
// Every action opens the Vault side (#vault), where activation, deposits and releases live.
import { useEffect, useState } from 'react';
import { Icon, MEDIA, StatusChip, Stepper } from '../ui';
import { useSolaresWallet } from '../wallet';
import { usePairedVaultSummary } from '../shell/screens';
import { LoadFailed, PlaceholderAmount } from '../wallet/BalancePlaceholder';
import { usePrices } from '../wallet/usePrices';
import { SOLANA_CLUSTER } from '../wallet/config';
import { MASK, UNKNOWN } from './homeModel';
import { vaultValue } from '../vaults/vaultValue';
import { VAULT_STEPS, vaultCardModel } from './vaultCardModel';
import { requestVaultCreation, requestVaultIntent } from '../vaults/vaultIntent';


type VaultBalance =
  | { status: 'idle' | 'loading' | 'failed' }
  | { status: 'ready'; usdc: string | null; sol: string };

/** The active vault's balances, read from Solana by the vault module's verifier. */
function useVaultBalance(multisig: string | null, owner: string | null): VaultBalance & { retry: () => void } {
  const [balance, setBalance] = useState<VaultBalance>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!multisig || !owner) { setBalance({ status: 'idle' }); return; }
    let live = true;
    setBalance({ status: 'loading' });
    void (async () => {
      try {
        // Loaded on demand: the chain read pulls in the Squads client.
        const { verifyPairedSolanaVault } = await import('../vaults/solana');
        const vault = await verifyPairedSolanaVault(multisig, owner);
        if (live) setBalance({ status: 'ready', usdc: vault.usdcBalance, sol: vault.nativeBalance });
      } catch {
        if (live) setBalance({ status: 'failed' });
      }
    })();
    return () => { live = false; };
  }, [multisig, owner, attempt]);
  return { ...balance, retry: () => setAttempt(value => value + 1) };
}

export interface VaultCardProps {
  privacy: boolean;
  onOpenVault: () => void;
  /** The Protection page, where the vault's security layers are explained and managed. */
  onOpenProtection?: () => void;
  /** Compact: the narrow and medium layouts, where the card sits between the balance and the assets. */
  className?: string;
}

export function VaultCard({ privacy, onOpenVault, onOpenProtection, className }: VaultCardProps) {
  const wallet = useSolaresWallet();
  const summary = usePairedVaultSummary();
  const model = vaultCardModel(summary);
  const owner = wallet.authenticated ? wallet.addresses.solana : null;
  const balance = useVaultBalance(summary.state === 'active' ? summary.multisig : null, owner);
  const active = summary.state === 'active';
  const prices = usePrices(active && balance.status === 'ready');
  const value = balance.status === 'ready' ? vaultValue({
    chain: 'solana', native: BigInt(balance.sol), stablecoin: balance.usdc === null ? null : BigInt(balance.usdc), prices, privacy, cluster: SOLANA_CLUSTER,
  }) : null;
  const busy = summary.state === 'loading' || (summary.state === 'registered' && summary.stage === 'checking');

  return (
    <section className={`ui-card home-side-card home-vault-card${className ? ` ${className}` : ''}`} data-vault-state={summary.state} aria-labelledby="home-vault-title" aria-busy={busy || undefined}>
      <div className="home-vault-art" aria-hidden="true"><img src={MEDIA.sanctuary} alt="" decoding="async" loading="lazy" /></div>
      <div className="home-side-head">
        <span className="home-vault-icon" aria-hidden="true"><Icon name="vault" size={18} /></span>
        <h2 id="home-vault-title" className="home-side-title">Your vault</h2>
        <StatusChip tone={model.tone} label={model.chip} className="home-vault-chip" />
      </div>

      {active && (
        <div className="home-vault-balance">
          <span className="home-vault-balance-label ui-eyebrow">Vault · total</span>
          <strong className="home-vault-amount" title={value?.title}
            aria-label={privacy ? undefined : value?.headline.kind === 'pending' ? value.headline.reason : value ? undefined : balance.status === 'failed' ? 'Vault balance unavailable' : 'Loading vault balance'}>
            {privacy ? MASK
              : value?.headline.kind === 'usd' ? <>{value.headline.approx && <span className="home-approx">≈ </span>}{value.headline.amount}</>
              : value?.headline.kind === 'amount' ? <>{value.headline.amount}<small>{value.headline.unit}</small></>
              : <PlaceholderAmount value={UNKNOWN} />}
          </strong>
          {value && (
            <span className="home-vault-sub">{value.holdings}{balance.status === 'ready' && balance.usdc === null ? ' · USDC is on mainnet only' : ''}</span>
          )}
          {value && (value.source || value.excluded) && (
            <span className="home-vault-sub home-vault-source">{[value.excluded, value.source].filter(Boolean).join(' · ')}</span>
          )}
          {balance.status === 'loading' && <span className="home-vault-sub">Reading your vault on Solana</span>}
          {balance.status === 'failed' && <LoadFailed className="home-vault-failed" onRetry={balance.retry} retryLabel="Retry loading vault balance" />}
        </div>
      )}

      <p className="home-side-text">{model.text}</p>

      {model.step !== null && (
        <Stepper steps={VAULT_STEPS} current={model.step} label="Vault activation" className="home-vault-steps" />
      )}

      {(model.action || model.retry || onOpenProtection) && (
        <div className="home-side-actions">
          {model.action && (
            <button type="button" className={model.action.primary ? 'ui-btn-primary home-side-action' : 'ui-btn home-side-action'} onClick={() => {
              // "Create your vault" / "Finish activation" hand off to the Vault side's own create
              // sequence (every confirmation still runs there); "Add a passkey" opens that form.
              if (model.action?.intent === 'create') requestVaultCreation();
              else if (model.action?.intent === 'passkey') requestVaultIntent({ kind: 'layer', layer: 'biometrics' });
              onOpenVault();
            }}>
              {model.action.label === 'Create your vault' && <Icon name="plus" size={16} />}
              {model.action.label}
              {!model.action.primary && <Icon name="arrow" size={15} />}
            </button>
          )}
          {model.retry && <button type="button" className="ui-btn-text home-side-retry" onClick={summary.reload}>Retry</button>}
          {onOpenProtection && (
            <button type="button" className="ui-btn-text home-side-link" aria-label="Open protection layers" onClick={onOpenProtection}>
              Protection layers <Icon name="arrow" size={14} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
