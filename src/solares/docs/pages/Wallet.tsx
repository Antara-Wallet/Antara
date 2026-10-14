import { SUPPORTED_NETWORKS } from '../../networks';
import { DOC_ART } from '../art';
import { Callout, DocLink, Mono, PageHead, Section, Step, Steps, TableWrap } from '../components';

export default function Wallet() {
  return <>
    <PageHead eyebrow="02 / WALLET" title="Your regular wallet" art={DOC_ART.earthObsidian} artPosition="center 35%"
      lead="The everyday side of ANTARA: one account, five networks, and no vault layers or delays on your everyday wallet." />

    <Section id="what" title="What the wallet is">
      <p>When you sign in, ANTARA creates a Solana wallet and an EVM wallet for you through Privy. They are ordinary wallets that you control: Privy holds the keys and asks you to confirm every signature, and ANTARA never receives them. None of the vault&apos;s security layers or change delays apply to it; those belong to the <DocLink to="/docs/vault">vault</DocLink>. The wallet has a few safety rules of its own, such as acknowledging Relay&apos;s terms before every swap.</p>
      <Callout title="No MFA on your wallet">
        <p>Your regular wallet never asks for an MFA code. MFA in ANTARA is an optional authenticator app that belongs to your vault alone, and it is checked only when you release from the vault. ANTARA does not use Privy&apos;s wallet MFA.</p>
      </Callout>
      <p>The app has five main places: <b>Wallet</b>, <b>Vault</b>, <b>Swap</b>, <b>Activity</b> and <b>Protection</b>, in the sidebar on a desktop and in the tabs at the bottom on a phone or in the side panel. Settings is at the bottom of the sidebar, or behind the gear. On the Wallet screen, Receive, Send, Swap and Vault sit inside your balance card, your tokens are listed below it, and the <b>Your vault</b> card shows your vault&apos;s state, with <b>Create your vault</b> until you have one. A balance ANTARA could not read shows a muted 0.00 with the reason beside it, never as a real zero.</p>
    </Section>

    <Section id="networks" title="Networks and stablecoins" lead="Solana comes first. Each network has one pinned funding stablecoin, which is what swaps are paid from.">
      <TableWrap label="Supported networks">
        <table>
          <thead><tr><th scope="col">Network</th><th scope="col">Native coin</th><th scope="col">Funding stablecoin</th><th scope="col">Issuer and precision</th></tr></thead>
          <tbody>
            {SUPPORTED_NETWORKS.map(network => <tr key={network.key}>
              <th scope="row">{network.name}</th>
              <td>{network.native.symbol}</td>
              <td><b>{network.funding.label}</b><br /><small>{network.funding.name}</small></td>
              <td>{network.funding.issuer}, {network.funding.decimals} decimals<br /><Mono>{network.funding.address}</Mono></td>
            </tr>)}
          </tbody>
        </table>
      </TableWrap>
      <ul className="adocs-list">
        <li><b>BNB Smart Chain:</b> Binance-Peg USDC is a bridged token issued by Binance, not Circle, with 18 decimals instead of 6. ANTARA always labels it &ldquo;USDC (Binance-Peg)&rdquo;.</li>
        <li><b>Robinhood Chain:</b> there is no Circle USDC on this network. ANTARA uses USDG (Paxos Global Dollar) and never calls it USDC.</li>
        <li>Arbitrum and Polygon are no longer supported anywhere in ANTARA.</li>
      </ul>
    </Section>

    <Section id="receive" title="Receive">
      <Steps label="Receive">
        <Step title="Open Receive and pick the network">Your Solana address is used only on Solana. Your EVM address is the same on Ethereum, BNB Smart Chain, Robinhood Chain and Base.</Step>
        <Step title="Share the address or its QR code">Copy the full address or let the sender scan the QR code.</Step>
        <Step title="Check the network with the sender">Assets sent on a network ANTARA does not support may not appear in the wallet.</Step>
      </Steps>
    </Section>

    <Section id="send" title="Send">
      <p>Send a network&apos;s native coin or its funding stablecoin to any address. Before you sign, ANTARA simulates the transfer, estimates the network fee and shows the complete recipient address. One transfer, no token allowance. Your wallet then asks you to sign that exact transfer.</p>
      <ul className="adocs-list">
        <li>If the network fee or your wallet changed, ANTARA asks you to review again.</li>
        <li>If the outcome is unknown, ANTARA does not retry on its own. Check Activity and your wallet before trying again.</li>
        <li>Sending spends from your wallet only. Vault balances stay in the vault until you release them.</li>
      </ul>
    </Section>

    <Section id="swap" title="Swap" lead="Swaps are routed by Relay and paid from the network's funding stablecoin: USDC, USDC (Binance-Peg) on BNB Smart Chain, or USDG on Robinhood Chain.">
      <Steps label="Swap">
        <Step title="Pick what you want to receive">Search for a token by name or contract address. Swaps stay on the same network by default; you can also receive on another network, except that routes from another network into BNB Smart Chain or Robinhood Chain are not offered yet.</Step>
        <Step title="Review every term">The review shows the exact amount and stablecoin you pay, the expected output and the minimum if filled, the receiving wallet, the fill window, every refund destination, the slippage, the network-fee limit and a 90-second quote countdown.</Step>
        <Step title="Acknowledge and confirm">Confirm swap stays disabled until you tick: &ldquo;I understand this swap relies on Relay and I could receive less than I deposited, or nothing.&rdquo; Changing anything clears the review.</Step>
      </Steps>
      <Callout tone="warn" title="Relay's terms, disclosed before you confirm">
        <p>Your stablecoin is held in Relay&apos;s depository until Relay fills or refunds the order, which can take <b>up to 7 days</b>. A refund goes to your own wallet, but its amount is not guaranteed: it can be reduced by network fees, not sent at all if it is smaller than the fee, or be nothing. Only swap an amount you can afford to lose. ANTARA cannot recover an order for you in the app.</p>
      </Callout>
      <ul className="adocs-list">
        <li><b>Receiving wallet:</b> your own wallet, linked to your ANTARA account. A swap to any other wallet is refused, and refunds go only to your own wallets.</li>
        <li><b>Amount:</b> ANTARA sets no swap cap. Max uses your whole balance. The only bound is a protocol sanity check of 100,000 units of the funding stablecoin in a single swap.</li>
      </ul>
      <p>If ANTARA cannot read its swap settings, swaps stay disabled. To swap vault funds, release them to your wallet first: quotes expire within seconds and are never put inside a vault release.</p>
    </Section>

    <Section id="activity" title="Activity">
      <p>Activity lists your sends and swaps with links to the network explorer. A swap shows its fill window, and &ldquo;Not filled&rdquo; appears only when there is evidence of your deposit. Saved records for networks ANTARA no longer supports stay readable but are not tracked. Activity is saved on this device and app only: another computer, browser or ANTARA app does not show it.</p>
    </Section>

    <Section id="not-protected" title="What the wallet does not protect">
      <p>Funds in your wallet are protected by your sign-in and by Privy, not by the vault&apos;s layers. Anyone who controls your wallet can send what is in it. Keep what you want to protect in the <DocLink to="/docs/vault">vault</DocLink>.</p>
    </Section>
  </>;
}
