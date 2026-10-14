import { DOC_ART } from '../art';
import { Callout, Mono, PageHead, Section, TableWrap } from '../components';

export default function Architecture() {
  return <>
    <PageHead eyebrow="05 / ARCHITECTURE" title="Architecture" art={DOC_ART.guardian} artPosition="right 30%"
      lead="Who holds which key, which service does what, and where your data lives. Plain answers, with the limits stated." />

    <Section id="overview" title="The pieces" lead="Three apps on your devices, three services, and the networks themselves.">
      <div className="adocs-arch" role="group" aria-label="ANTARA architecture">
        <div className="adocs-arch-main">
          <div className="adocs-arch-tier">
            <span className="adocs-arch-label">ON YOUR DEVICE</span>
            <div className="adocs-arch-row">
              <div className="adocs-arch-box"><b>ANTARA Desktop</b><small>Windows app. Native passkeys, Wi-Fi, Bluetooth and location for layers.</small></div>
              <div className="adocs-arch-box"><b>Chrome extension</b><small>Side panel and full tab. Only host permission: antara.tech.</small></div>
              <div className="adocs-arch-box"><b>Web app</b><small>antara.tech/app, served by ANTARA.</small></div>
            </div>
          </div>
          <div className="adocs-arch-bus"><span>sign-in · signing · signed-in API calls</span></div>
          <div className="adocs-arch-tier">
            <span className="adocs-arch-label">SERVICES</span>
            <div className="adocs-arch-row">
              <div className="adocs-arch-box"><b>Privy</b><small>Email sign-in. Holds your embedded wallets and the guardian&apos;s server wallet.</small></div>
              <div className="adocs-arch-box" data-accent="true"><b>ANTARA API</b><small>Balances, swap checks, vault registration, layers and the guardian&apos;s decisions.</small></div>
              <div className="adocs-arch-box"><b>Relay</b><small>Swap quotes (through the ANTARA API), deposits and fills.</small></div>
            </div>
          </div>
          <div className="adocs-arch-bus"><span>reads · transactions · swap fills</span></div>
          <div className="adocs-arch-tier">
            <span className="adocs-arch-label">NETWORKS</span>
            <div className="adocs-arch-row" data-two="true">
              <div className="adocs-arch-box" data-accent="true"><b>Solana</b><small>Your wallet, and your Squads v4 vault.</small></div>
              <div className="adocs-arch-box"><b>Ethereum · BNB Smart Chain · Robinhood Chain · Base</b><small>Your EVM wallet.</small></div>
            </div>
          </div>
        </div>
        <div className="adocs-arch-direct"><span>apps → networks · reads, transactions</span></div>
      </div>
      <ul className="adocs-list adocs-arch-paths" aria-label="Who connects to whom">
        <li><b>Apps → Privy:</b> sign-in, and your wallet&apos;s signatures.</li>
        <li><b>Apps → ANTARA API:</b> signed-in calls for balances, swap quotes, vault registration and layer checks. The apps never call Relay directly; the API holds the Relay key.</li>
        <li><b>Apps → networks, directly:</b> reads for your wallet and vault, and sending the transactions your wallet signed.</li>
        <li><b>ANTARA API → networks:</b> balances, and a fresh read of the vault and the release before every guardian vote.</li>
        <li><b>Relay → networks:</b> swap fills and refunds.</li>
      </ul>
    </Section>

    <Section id="privy" title="Privy: sign-in and wallets">
      <p>Privy provides email sign-in, creates your embedded Solana and EVM wallets and holds their keys; Privy describes its key storage in its own documentation. ANTARA never receives your private keys, and the app asks Privy to show its confirmation when your wallet signs. ANTARA&apos;s server verifies your Privy session on every signed-in request and checks that any wallet address you send it is really linked to your account.</p>
    </Section>

    <Section id="squads" title="Squads v4: the vault">
      <p>Your vault is a Squads v4 multisig on Solana (<Mono>SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf</Mono>): your wallet with propose, vote and execute; the guardian with vote only; threshold 2; no configuration authority; no spending limits; no time lock. A release is a Squads vault transaction with exactly one transfer: SOL from the vault, or Circle USDC (<Mono>EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v</Mono>) from the vault&apos;s token account to your own.</p>
    </Section>

    <Section id="guardian" title="The guardian">
      <ul className="adocs-list">
        <li><b>What it is:</b> one Privy server wallet per environment, shared by all users. Its address is pinned in the app and on the server, and any other guardian is refused.</li>
        <li><b>Who controls it:</b> the wallet is owned by two keys together, ANTARA&apos;s server key and an offline admin key. Changing its owner or policy, or exporting it, needs the offline key.</li>
        <li><b>What it may sign:</b> a deny-by-default Privy policy is designed to allow only Squads vote transactions (not yet verified live). ANTARA&apos;s server also builds the vote itself and re-checks its bytes before asking Privy to sign; it never signs a transaction from the app.</li>
        <li><b>When it votes:</b> only after the server&apos;s release policy and your layers pass, and only once for each release.</li>
      </ul>
      <Callout tone="warn" title="Go-live checks not yet run">
        <p>Two checks must pass before the guardian is switched on: that the Privy policy behaves as designed live, and that ANTARA&apos;s server cannot sign as your wallet. Until then, do not read the 2-of-2 as protection against a compromised ANTARA server.</p>
      </Callout>
    </Section>

    <Section id="api" title="The ANTARA API">
      <p>One server at <Mono>antara.tech</Mono> serves the web app and the API under <Mono>/api/solares</Mono>. It reads balances, checks and proxies swap quotes, registers vaults, keeps the release ledger, stores your layer settings and decides whether the guardian votes. Every decision fails closed: an unreadable store or setting refuses rather than allowing. Server secrets stay on the server and are never shipped in an app.</p>
    </Section>

    <Section id="relay" title="Relay: swaps">
      <p>Relay routes swaps from the funding stablecoin. ANTARA&apos;s API holds the Relay key, builds the request, and checks each quote independently: the depository addresses, the order, the calldata or Solana instructions, and the solver&apos;s signature. Routes it cannot verify fail closed. Your wallet signs the deposit; Relay fills or refunds the order.</p>
    </Section>

    <Section id="rpc" title="Network access (RPC)">
      <p>ANTARA&apos;s server reads balances from dedicated endpoints for each of the five networks. A network that cannot be read is shown as unavailable, never as zero. The guardian reads the vault and proposal fresh, from a Solana endpoint whose network identity it checks, before every vote. The apps also reach the networks directly: they read your wallet and vault, and send the transactions your wallet signed. The extension&apos;s pages use public RPC endpoints for this.</p>
    </Section>

    <Section id="data" title="Where data is stored">
      <TableWrap label="Data and where it is stored">
        <table>
          <thead><tr><th scope="col">Data</th><th scope="col">Where</th><th scope="col">Notes</th></tr></thead>
          <tbody>
            <tr><th scope="row">Your wallet keys</th><td>Privy</td><td>ANTARA never receives them.</td></tr>
            <tr><th scope="row">The guardian key</th><td>Privy server wallet</td><td>Owned by ANTARA&apos;s server key and an offline admin key together.</td></tr>
            <tr><th scope="row">Vault and its funds</th><td>Solana</td><td>Public on-chain accounts.</td></tr>
            <tr><th scope="row">Vault registration and release ledger</th><td>ANTARA server, persistent disk</td><td>Used for your caps, if you set any, and to never vote twice.</td></tr>
            <tr><th scope="row">Layer settings</th><td>ANTARA server, persistent disk</td><td>Passkey public keys, trusted device public keys, safe zones (center and radius), trusted network ranges, Wi-Fi names and access points, Bluetooth device identifiers, pending changes and a short change history.</td></tr>
            <tr><th scope="row">Layer readings</th><td>Sent for one check</td><td>Not stored. Audit lines never contain locations, IP addresses, Wi-Fi or Bluetooth identifiers, keys or tokens.</td></tr>
            <tr><th scope="row">Challenges</th><td>ANTARA server memory</td><td>Single use, 5 minutes. A restart clears them, which refuses rather than allows.</td></tr>
            <tr><th scope="row">Device signing key</th><td>Your device (app or browser profile)</td><td>Cannot be exported, but is not secure hardware.</td></tr>
            <tr><th scope="row">Biometric data</th><td>Your device only</td><td>ANTARA receives only the passkey signature.</td></tr>
            <tr><th scope="row">Swap and send history</th><td>Your device, plus public chains</td><td>Relay keeps the order status.</td></tr>
          </tbody>
        </table>
      </TableWrap>
    </Section>

    <Section id="apps" title="Three apps, one wallet">
      <ul className="adocs-list">
        <li><b>Desktop:</b> Tauri 2 with WebView2 on Windows. Only the main window can call native commands; signing, key reveal and import commands from the old local keystore are withheld from every window.</li>
        <li><b>Extension:</b> Manifest V3, side panel. Permissions: side panel and location. Its only host permission is <Mono>antara.tech</Mono>; its pages also connect to Privy, WalletConnect and public network RPC endpoints. It has no content scripts and injects no wallet into websites.</li>
        <li><b>Web:</b> the same app at <Mono>antara.tech/app</Mono>. Because ANTARA&apos;s server also delivers its code there, the desktop app and extension give more independence from that server.</li>
      </ul>
    </Section>
  </>;
}
