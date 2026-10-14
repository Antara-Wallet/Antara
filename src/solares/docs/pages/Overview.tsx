import { DOC_ART } from '../art';
import { Cards, DocLink, Kind, LinkCard, Section, StatusNote, TableWrap, Tag } from '../components';

const layers = [
  { name: 'Biometrics', kind: 'cryptographic', note: 'Required' },
  { name: 'MFA', kind: 'cryptographic', note: 'Optional' },
  { name: 'Safe Zones', kind: 'device-reported', note: 'Optional' },
  { name: 'Wi-Fi', kind: 'server-observed', note: 'Optional' },
  { name: 'Bluetooth', kind: 'device-reported', note: 'Optional' },
  { name: 'Limits', kind: 'cryptographic', note: 'Optional' },
] as const;

export default function Overview() {
  return <>
    <header className="adocs-hero">
      <img className="adocs-hero-art" src={DOC_ART.observatory.src} srcSet={DOC_ART.observatory.srcSet} sizes="(max-width: 700px) 540px, 800px" alt="" decoding="async" />
      <div className="adocs-hero-copy">
        <p className="adocs-eyebrow">ANTARA DOCUMENTATION</p>
        <h1 id="adocs-title" tabIndex={-1}>A wallet for every day. A vault for what you keep.</h1>
        <p className="adocs-lead">ANTARA is a Solana-first wallet for Solana, Ethereum, BNB Smart Chain, Robinhood Chain and Base, on Windows, in Chrome and on the web. You use a regular wallet. From it, you create a multisig vault, and you choose the security layers that must pass before anything leaves it.</p>
        <div className="adocs-hero-actions">
          <DocLink to="/docs/getting-started" className="adocs-button adocs-button-primary">Get started <span aria-hidden="true">→</span></DocLink>
          <DocLink to="/docs/vault" className="adocs-button">How the vault works</DocLink>
        </div>
      </div>
    </header>

    <Section id="model" title="The model in three steps" lead="That is the whole idea: a regular wallet, a vault you create from it, and the layers you put around the vault.">
      <ol className="adocs-model" aria-label="Wallet, then vault, then layers">
        <li className="adocs-model-step">
          <span className="adocs-model-index">01</span>
          <span className="adocs-eyebrow">WALLET</span>
          <h3>Your regular wallet</h3>
          <p>Sign in with your email. ANTARA creates a Solana wallet and an EVM wallet for you. Check balances, receive, send and swap, with no vault layers, delays or MFA codes on your everyday wallet.</p>
          <ul className="adocs-chips" aria-label="Wallet actions"><li>Balances</li><li>Receive</li><li>Send</li><li>Swap</li></ul>
        </li>
        <li className="adocs-model-step">
          <span className="adocs-model-index">02</span>
          <span className="adocs-eyebrow">VAULT</span>
          <h3>A 2-of-2 vault you create</h3>
          <p>From your wallet, you create a Squads v4 multisig vault on Solana: open <b>Vault</b> in the app and choose <b>Create vault</b>. It has two members, and every release needs both.</p>
          <div className="adocs-keys" aria-label="The two vault members">
            <span><b>Your wallet</b><small>proposes, votes, executes</small></span>
            <i aria-hidden="true">+</i>
            <span><b>ANTARA guardian</b><small>can only vote</small></span>
          </div>
        </li>
        <li className="adocs-model-step">
          <span className="adocs-model-index">03</span>
          <span className="adocs-eyebrow">LAYERS</span>
          <h3>Security layers on every release</h3>
          <p>The guardian votes only when every layer you turned on passes for that exact release.</p>
          <ul className="adocs-layer-list" aria-label="Security layers">
            {layers.map(layer => <li key={layer.name}><span>{layer.name}</span><small>{layer.note}</small></li>)}
          </ul>
        </li>
      </ol>
    </Section>

    <Section id="release-path" title="What happens when you release" lead="Deposits go straight into the vault. Only releases are checked, and each step is an on-chain transaction or a check you can see.">
      <ol className="adocs-track" aria-label="Release steps">
        <li><span>1</span><strong>You ask</strong><p>Pick SOL or USDC, an amount and one of your own wallets.</p></li>
        <li><span>2</span><strong>Your wallet proposes</strong><p>It creates the release on Solana and adds the first approval.</p></li>
        <li><span>3</span><strong>Layers are checked</strong><p>Your passkey and your layers, bound to this release, plus your caps if you set any. With MFA on, a code from your vault authenticator app too.</p></li>
        <li><span>4</span><strong>The guardian votes</strong><p>Only after every check passes. It cannot start or execute anything.</p></li>
        <li><span>5</span><strong>Your wallet executes</strong><p>The funds arrive in your own wallet.</p></li>
      </ol>
    </Section>

    <Section id="compare" title="Wallet and vault, side by side">
      <TableWrap label="Wallet and vault compared">
        <table>
          <thead><tr><th scope="col" /><th scope="col">Regular wallet</th><th scope="col">Vault</th></tr></thead>
          <tbody>
            <tr><th scope="row">Made for</th><td>Everyday sending, receiving and swapping</td><td>Funds you want to keep</td></tr>
            <tr><th scope="row">Who signs</th><td>Your wallet alone</td><td>Your wallet and ANTARA&apos;s guardian (2 of 2)</td></tr>
            <tr><th scope="row">Extra checks</th><td>No vault layers or delays. Swaps need your acknowledgement of Relay&apos;s terms.</td><td>A passkey for each release, and every layer you turn on, such as a code from your vault authenticator app or your own caps</td></tr>
            <tr><th scope="row">Where funds can go</th><td>Any address you enter</td><td>Only your own wallets, linked to your Privy account</td></tr>
            <tr><th scope="row">Networks</th><td>Solana, Ethereum, BNB Smart Chain, Robinhood Chain, Base</td><td>Solana (SOL and USDC). An EVM vault is planned.</td></tr>
            <tr><th scope="row">Limits</th><td>None set by ANTARA on swaps, beyond a 100,000-unit sanity check on a single swap</td><td>Optional: caps you set per release and per day, off until you set them</td></tr>
            <tr><th scope="row">If ANTARA is down</th><td>Keys stay with Privy; balances and swaps that use ANTARA&apos;s server wait</td><td>Releases pause; funds stay in the vault</td></tr>
          </tbody>
        </table>
      </TableWrap>
    </Section>

    <Section id="kinds" title="Three kinds of check" lead="Every layer says what it really is, so you can judge how much to rely on it.">
      <dl className="adocs-kinds">
        <div><dt><Kind kind="cryptographic" /></dt><dd>ANTARA verifies a signature or a code, or the guardian enforces the rule itself. Biometrics, MFA and Limits. For MFA, ANTARA&apos;s server checks the 6-digit code from your vault&apos;s own authenticator app for that release.</dd></div>
        <div><dt><Kind kind="server-observed" /></dt><dd>ANTARA&apos;s server sees it directly: the public internet address of your request. Wi-Fi.</dd></div>
        <div><dt><Kind kind="device-reported" /></dt><dd>Your trusted device reports a reading and signs it. ANTARA cannot verify the reading itself. Safe Zones, Bluetooth, and the Wi-Fi name on Desktop.</dd></div>
      </dl>
      <p>See <DocLink to="/docs/security">Security layers</DocLink> for what each layer checks and what it cannot do.</p>
    </Section>

    <Section id="status" title="Where things stand">
      <StatusNote />
      <ul className="adocs-statuslist">
        <li><Tag tone="built">Built</Tag><span>The wallet on five networks in the desktop app, the Chrome extension and the web app; swaps through Relay; the Solana vault and its six layers, including MFA through the vault&apos;s own optional authenticator app.</span></li>
        <li><Tag tone="planned">Planned</Tag><span>An EVM vault, gas sponsorship, swaps from any token, website connections, the Chrome Web Store listing and a signed Windows installer. See the <DocLink to="/docs/roadmap">roadmap</DocLink>.</span></li>
      </ul>
    </Section>

    <Section id="next" title="Read next">
      <Cards>
        <LinkCard to="/docs/getting-started" eyebrow="START" title="Getting started">Install, sign in, fund your wallet and activate a vault.</LinkCard>
        <LinkCard to="/docs/vault" eyebrow="VAULT" title="The vault">The 2-of-2, the guardian, releases, optional limits and recovery.</LinkCard>
        <LinkCard to="/docs/security" eyebrow="LAYERS" title="Security layers">One card per layer, with what it can and cannot prove.</LinkCard>
      </Cards>
    </Section>
  </>;
}
