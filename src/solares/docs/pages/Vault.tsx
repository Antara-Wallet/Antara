import { DOC_ART } from '../art';
import { Callout, DocLink, Mono, PageHead, Section, StatusNote, Step, Steps, TableWrap, Tag } from '../components';

export default function Vault() {
  return <>
    <PageHead eyebrow="03 / VAULT" title="The vault" art={DOC_ART.vaultOrbit} artPosition="70% 55%"
      lead="A vault is a separate on-chain account you create from your wallet. Nothing leaves it without two signatures: yours, and a vote from ANTARA's guardian that it gives only when your layers pass." />

    <Section id="what" title="What the vault is">
      <p>On Solana, your vault is a <b>Squads v4</b> multisig. It holds SOL and USDC at its own address, separate from your wallet. You create it from your ANTARA Solana wallet, and you pay its on-chain account rent and the Squads program fee when you do.</p>
      <StatusNote />
    </Section>

    <Section id="two-of-two" title="Two signatures, every time">
      <TableWrap label="Vault members">
        <table>
          <thead><tr><th scope="col">Member</th><th scope="col">Can</th><th scope="col">Held by</th></tr></thead>
          <tbody>
            <tr><th scope="row">Your wallet</th><td>Propose, vote and execute</td><td>Privy, as your embedded wallet</td></tr>
            <tr><th scope="row">ANTARA guardian</th><td>Vote only</td><td>Privy, as an ANTARA server wallet</td></tr>
          </tbody>
        </table>
      </TableWrap>
      <ul className="adocs-list">
        <li><b>Threshold 2:</b> both members must approve every release.</li>
        <li><b>No configuration authority and no spending limits:</b> nobody can quietly change the members or let one member spend alone. The guardian never approves a change to the vault&apos;s configuration.</li>
        <li><b>No on-chain time lock:</b> once both approvals are in, your wallet can execute right away. Releases have no waiting period.</li>
        <li>Program: <Mono>SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf</Mono>, vault index 0.</li>
      </ul>
    </Section>

    <Section id="guardian" title="What the guardian can and cannot do">
      <div className="adocs-split">
        <div className="adocs-panel"><h3>It can</h3><ul className="adocs-list">
          <li>Add one vote to a release your wallet has already proposed and approved.</li>
          <li>Refuse to vote. If any check fails, it does nothing.</li>
        </ul></div>
        <div className="adocs-panel"><h3>It cannot</h3><ul className="adocs-list">
          <li>Start a transfer or execute one. Only your wallet can.</li>
          <li>Change the vault&apos;s members, threshold or settings.</li>
          <li>Approve a release to anyone but you, or above caps you set.</li>
        </ul></div>
      </div>
      <p>The guardian signs only one kind of transaction: a Squads vote on an existing proposal. Its Privy policy is designed to deny everything else by default. That the policy behaves this way live is a check still to be run before go-live.</p>
      <Callout tone="warn" title="The limit of this design">
        <p>The 2-of-2 is only as independent as ANTARA&apos;s server is from your wallet. Whether ANTARA&apos;s server could ever sign as your wallet has <b>not yet been verified</b>; it is a go-live check. Your layers are checked by ANTARA&apos;s server, so a compromised ANTARA server could skip them. Every app refuses a recipient it cannot see as yours; on the web, ANTARA&apos;s server also delivers that app&apos;s code.</p>
      </Callout>
    </Section>

    <Section id="activation" title="Create your vault">
      <p>Vault is one of the main places in the app: <b>Vault</b> in the sidebar, or the Vault tab at the bottom on a phone and in the side panel. Your wallet&apos;s <b>Your vault</b> card also has <b>Create your vault</b>. The app walks you through it: use your ANTARA Solana wallet, check the SOL it needs, choose <b>Create vault</b> and sign, let ANTARA verify and register the vault, then add a passkey and choose your layers. The full walkthrough is in <DocLink to="/docs/getting-started#activate">Getting started</DocLink>.</p>
      <p>The first passkey applies at once only from the app and session that activated the vault, within 15 minutes. From another app it is refused while the 15-minute window is open, and afterwards it becomes a 7-day recovery change, which you can cancel. Until a passkey is in force, deposits and releases are paused.</p>
    </Section>

    <Section id="deposit" title="Deposit">
      <p>Choose SOL or USDC and an amount, then <b>Deposit from your wallet</b>. The app shows the vault&apos;s verified deposit address only after the vault is registered, and reads the balance from Solana. Send only SOL or Circle USDC on Solana to it. USDC in the vault is supported on Solana mainnet only.</p>
    </Section>

    <Section id="release" title="Release" lead="Releases go only to your own wallets. Each step is either an on-chain transaction or a check you can see.">
      <Steps label="Release flow">
        <Step title="Choose what and where">Pick SOL or USDC, an amount and a recipient. Only your own Solana wallets are offered: linked to your ANTARA account and visible as yours on this device. Your ANTARA wallet is the default.</Step>
        <Step title="Review and sign the proposal">Check the full address. Your wallet signs one transaction that creates the release (exactly one transfer), opens the proposal and adds your approval.</Step>
        <Step title="ANTARA checks it">ANTARA reads the proposal fresh from Solana and checks: your registered vault, one plain SOL or USDC transfer, your own linked wallet, and every layer you turned on, including your caps if you set any.</Step>
        <Step title="Verify your layers">The app asks for what your layers need, including a code from your vault authenticator app if MFA is on, with the passkey last. Every reading is bound to this exact release, so it cannot be reused for another one.</Step>
        <Step title="The guardian votes">Only if everything passed. ANTARA never votes twice on the same release, so <b>Continue release</b> is safe to repeat.</Step>
        <Step title="Your wallet executes">The funds arrive in your wallet. From there you can send or swap them.</Step>
      </Steps>
      <p>To pay someone else from the vault, release to your own wallet first, then send from it.</p>
    </Section>

    <Section id="limits" title="Optional limits">
      <p>Limits is optional and off by default: ANTARA sets no cap on how much you release. If you want one, turn on Limits in the vault&apos;s settings and set your own caps for SOL and USDC, per release, per day, or both, at any positive amount. The guardian then refuses a release above them. Setting or tightening a cap applies at once; raising or removing one also applies at once but needs every layer you have on.</p>
      <p>The vault screen shows the caps you set, if any. Separately, ANTARA limits how often its guardian votes, to protect the SOL it pays in fees; this counts releases, not amounts. A release it refuses stays open on-chain with its rent; the app has no action to reject or close it yet.</p>
    </Section>

    <Section id="offline" title="If ANTARA is offline">
      <ul className="adocs-list">
        <li><b>Releases pause.</b> Without the guardian&apos;s vote nothing leaves the vault, so your funds stay where they are, on Solana.</li>
        <li><b>A release in progress can be continued</b> when ANTARA is back. Choose <b>Continue release</b>.</li>
        <li><b>Your wallet keys are not on ANTARA&apos;s server.</b> Privy holds them. Parts of the app that read from ANTARA&apos;s server, such as balances and swaps, wait until it is back.</li>
      </ul>
    </Section>

    <Section id="recovery" title="Recovery, honestly">
      <Callout tone="warn" title="There is no recovery owner in this version">
        <p>If you lose access to your ANTARA login, vault funds cannot be released. Your wallet is one of the two required signers, and the guardian can only vote. For the same reason, if ANTARA&apos;s guardian stopped working for good, nothing in this version could release vault funds. Keep in the vault only what you can accept that for.</p>
      </Callout>
      <ul className="adocs-list">
        <li><b>Lost a device a layer depends on</b> (a phone with your passkey or your vault authenticator app, a Bluetooth device, a home you moved out of)? You can waive that layer with a recovery change that takes <b>7 days</b> and can be cancelled until then.</li>
        <li><b>Someone with your session</b> could start the same kind of recovery. It takes 7 days, the vault shows a warning while it is pending, and you can cancel it. ANTARA sends no notifications, so check the app.</li>
        <li>Privy&apos;s account recovery may restore access to your wallet. It does not change the vault&apos;s two signers.</li>
      </ul>
    </Section>

    <Section id="evm" title="EVM vaults">
      <p><Tag tone="planned">Planned</Tag> A Safe 2-of-2 vault for EVM networks, built on the same model. It is not available yet. If you already use an independently owned Safe or Squads vault, you can open it from Settings; ANTARA checks its owners and threshold on-chain before showing it as verified.</p>
    </Section>
  </>;
}
