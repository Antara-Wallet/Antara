import { DOC_ART } from '../art';
import { Callout, Cards, Code, DocLink, Mono, PageHead, Section, Step, Steps, Tag } from '../components';

export default function GettingStarted() {
  return <>
    <PageHead eyebrow="01 / GETTING STARTED" title="Getting started" art={DOC_ART.spaceTerrain} artPosition="center 70%"
      lead="Choose where you use ANTARA, sign in with your email, fund your wallet, then create your vault. The same account works in every app." />

    <Section id="choose" title="Choose where to use ANTARA" lead="All three apps open the same wallet and the same account. Your addresses are the same everywhere.">
      <Cards>
        <a className="adocs-linkcard" href="#desktop"><span className="adocs-eyebrow">WINDOWS</span><strong>ANTARA Desktop</strong><span>A native Windows app. It uses Windows Hello directly and is the only app that can also check your Wi-Fi name.</span><em aria-hidden="true">↓</em></a>
        <a className="adocs-linkcard" href="#extension"><span className="adocs-eyebrow">CHROME</span><strong>Chrome extension</strong><span>The wallet in Chrome&apos;s side panel, next to any page you are on.</span><em aria-hidden="true">↓</em></a>
        <a className="adocs-linkcard" href="#web"><span className="adocs-eyebrow">BROWSER</span><strong>Web app</strong><span>Open <Mono>antara.tech/app</Mono> in your browser. Nothing to install.</span><em aria-hidden="true">↓</em></a>
      </Cards>
      <Callout title="No store listing or code-signed installer yet">
        <p>There is no Chrome Web Store listing and no code-signed Windows installer yet. The <DocLink to="/download">download page</DocLink> has the extension as a zip that you load yourself, and lists the Windows installer once it is published. The web app needs no install. A real sign-in has not been verified in any app yet.</p>
      </Callout>
    </Section>

    <Section id="desktop" title="ANTARA Desktop (Windows)">
      <p>ANTARA Desktop is a Windows app built with Tauri. It opens straight into the wallet and uses Windows Hello directly. <Tag tone="planned">Planned</Tag> There is no installer yet: a signed Windows installer is not published, so today the app can only be built from the source code. If that is not for you, use the <a href="#web">web app</a> for now.</p>
      <Callout title="For developers: build ANTARA Desktop">
        <p>You need a copy of the ANTARA repository, Node.js 22.12 or later, Rust with the MSVC toolchain and Microsoft Edge WebView2. In PowerShell, use <Mono>npm.cmd</Mono>.</p>
        <Code label="Windows PowerShell">{`npm.cmd ci
npm.cmd --prefix server ci
# Development window and local API
npm.cmd run desktop:dev
# Packaged app (uses antara.tech)
npm.cmd run desktop:build`}</Code>
        <p>Both read the public settings in <Mono>.env.local</Mono>. <Mono>desktop:dev</Mono> also runs a local API, which needs the local server environment in <Mono>server/.env</Mono>, including its secrets; <Mono>docs/LAPTOP_SETUP.md</Mono> in the repository lists them. The packaged build always uses ANTARA&apos;s HTTPS API, and no secret is ever packaged into the app.</p>
      </Callout>
    </Section>

    <Section id="extension" title="Chrome extension (side panel)">
      <p>The extension puts the same wallet in Chrome&apos;s side panel. It needs Chrome 122 or later. <Tag tone="planned">Planned</Tag> A Chrome Web Store listing is not live yet, so for now you download the extension as a zip and load it yourself.</p>
      <Steps label="Load the extension">
        <Step title="Download and unzip it">Get the zip from the <DocLink to="/download">download page</DocLink> and unzip it into a folder you keep; Chrome runs the extension from that folder. Developers can instead run <Mono>npm.cmd run build:extension</Mono>, which writes the <Mono>dist-extension</Mono> folder and checks the manifest, permissions and security policy.</Step>
        <Step title="Turn on Developer mode">Open <Mono>chrome://extensions</Mono> and switch on <b>Developer mode</b> (top right).</Step>
        <Step title="Load unpacked">Choose <b>Load unpacked</b> and select the unzipped folder (or <Mono>dist-extension</Mono>). The card shows the ID <Mono>ckfkljfbjkmkjkkjkpbnmoehfipdcoin</Mono>.</Step>
        <Step title="Pin and open">Pin ANTARA in the toolbar and click its icon. The wallet opens in the side panel.</Step>
        <Step title="Use a full tab when asked">Passkey and Bluetooth prompts do not show reliably in the side panel yet, so those vault steps continue in a full tab. <b>Open in full tab</b> is at the top of the panel.</Step>
      </Steps>
      <Callout title="What the extension can access">
        <p>Chrome asks for three things: the side panel, your location, and access to <Mono>antara.tech</Mono>. Chrome shows &ldquo;Detect your physical location&rdquo; when you install it; location is read only when a vault&apos;s Safe Zones layer needs it. Its only host permission is <Mono>antara.tech</Mono>. Its pages also connect to Privy (sign-in and wallets), WalletConnect (external wallets) and public network RPC endpoints. Websites cannot connect to it, and it injects nothing into the pages you visit.</p>
      </Callout>
    </Section>

    <Section id="web" title="Web app">
      <p>Go to <Mono>antara.tech</Mono> and choose <b>Open wallet</b>, or open <Mono>antara.tech/app</Mono> directly. The web app is the same wallet. On the web, ANTARA&apos;s server also delivers the app&apos;s code, so the desktop app and the extension, whose code ships inside the build, give you more independence from ANTARA&apos;s server.</p>
    </Section>

    <Section id="sign-in" title="Sign in">
      <Steps label="Sign in">
        <Step title="Choose Sign in">Enter your email address and type the one-time code sent by Privy, ANTARA&apos;s sign-in provider.</Step>
        <Step title="Your wallets are created">ANTARA creates two wallets for you: a Solana wallet and an EVM wallet. The EVM address is the same on Ethereum, BNB Smart Chain, Robinhood Chain and Base.</Step>
        <Step title="Or connect a wallet you already use">You can also connect an external wallet. In the extension, external wallets are expected to connect through WalletConnect only (not yet verified).</Step>
      </Steps>
      <p>ANTARA never receives your private keys. Privy holds them and asks you to confirm each signature.</p>
    </Section>

    <Section id="fund" title="Fund your wallet">
      <Steps label="Fund your wallet">
        <Step title="Open Receive">Choose the network, then copy your address or scan its QR code.</Step>
        <Step title="Send from another wallet or an exchange">Send only assets on the network shown. A Solana address and an EVM address are not interchangeable.</Step>
        <Step title="Keep some SOL for fees">Solana fees and the vault&apos;s on-chain accounts are paid in SOL. ANTARA does not sponsor fees.</Step>
      </Steps>
      <p>Balances appear only once ANTARA has read them from the network. If a network cannot be read, it says so instead of showing zero.</p>
    </Section>

    <Section id="activate" title="Create your vault, step by step" lead="Open Vault in the sidebar (on a phone or in the side panel, the Vault tab at the bottom), or choose Create your vault on the Your vault card of your wallet. The screen tells you the next step; it follows this order.">
      <Steps label="Create your vault">
        <Step title="Use your ANTARA Solana wallet">Vaults are created only for the Solana wallet ANTARA made for your account, not for an external wallet. Keep some SOL in it for the fees.</Step>
        <Step title="Review the rules and the cost">The screen shows what creating a vault costs in SOL, read live from Solana. If your wallet holds too little SOL, it says so and offers Receive instead of Create. Then the app asks you to confirm that if you lose access to your ANTARA login, funds in this vault cannot be released.</Step>
        <Step title="Create the vault">Choose <b>Create vault</b>. Your wallet signs one transaction that creates the 2-of-2 Squads vault, and pays its on-chain account rent, the Squads program fee (when Squads charges one) and the network fee.</Step>
        <Step title="ANTARA registers it">ANTARA reads the new vault from Solana, checks that it is exactly the expected 2-of-2, and registers it to your account. If this is interrupted, choose <b>Finish activation</b>.</Step>
        <Step title="Add a passkey">Choose <b>Add a passkey</b> and use Windows Hello, Touch ID, Face ID, your phone or a security key. Do it in the same app within 15 minutes of activating. From another app it is refused while the 15-minute window is open, and afterwards it becomes a 7-day recovery change, so that someone with a stolen session cannot claim your vault first.</Step>
        <Step title="Deposit">Choose SOL or USDC and an amount, and deposit from your wallet. Send only SOL or Circle USDC on Solana to the vault address.</Step>
        <Step title="Add more layers (optional)">Open <b>Protection</b> and choose <b>Turn on</b> next to a layer. Safe Zones, Bluetooth and the Wi-Fi name are read by your device, so turning one of them on first sets up this browser or computer, in the same sheet (one extra passkey prompt). Turn on MFA with an authenticator app for the vault alone (optional; your regular wallet never asks for a code), and Limits with your own caps if you want them. Turning a layer on takes effect immediately.</Step>
      </Steps>
      <p>Button names can change as the app evolves; the vault screen always shows the next step.</p>
      <Callout tone="warn" title="Before you create a vault">
        <p>ANTARA&apos;s vault guardian is not switched on for antara.tech yet. Until it is, the Vault screen says &ldquo;Vault protection isn&apos;t switched on yet&rdquo; and no vault can be created. Read <DocLink to="/docs/vault#recovery">Recovery</DocLink> before you deposit: if you lose access to your ANTARA login, vault funds cannot be released.</p>
      </Callout>
    </Section>
  </>;
}
