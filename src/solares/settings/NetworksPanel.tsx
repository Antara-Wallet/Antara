// Settings › Networks (docs/UI_ARGUS_PARITY.md 6.16, ARGUS "Network"): the five supported
// networks in registry order, each with what the wallet state actually shows about its
// balances and the explorer links use. No RPC URL is shown.
import { useSolaresWallet } from '../wallet';
import { SOLANA_CLUSTER } from '../wallet/config';
import { StatusChip } from '../ui';
import { SettingsSection } from './SettingsParts';
import { networkRows } from './settingsModel';

export function NetworksPanel() {
  const wallet = useSolaresWallet();
  const rows = networkRows({
    authenticated: wallet.authenticated,
    ready: wallet.ready,
    balances: wallet.balances,
    balancesLoading: wallet.balancesLoading,
    balancesError: wallet.balancesError,
    addresses: wallet.addresses,
    cluster: SOLANA_CLUSTER,
  });
  return (
    <SettingsSection id="set-networks" title="Networks">
      <ul className="set-net-list" aria-label="Network status">
        {rows.map(row => (
          <li key={row.key} className="set-net">
            <span className="set-net-text">
              <span className="set-net-name">
                {row.name}
                {row.cluster && <span className="set-net-cluster">{row.cluster}</span>}
              </span>
              <span className="set-net-explorer">Explorer · {row.explorer}</span>
            </span>
            <StatusChip tone={row.status.tone} label={row.status.label} />
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}
