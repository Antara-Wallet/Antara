import type { ReactNode } from 'react';
import { PageHead, Section, Tag, type TagTone } from '../components';

function Item({ title, tone, label, children }: { title: string; tone: TagTone; label: string; children: ReactNode }) {
  return <li className="adocs-road-item"><div><strong>{title}</strong><Tag tone={tone}>{label}</Tag></div><p>{children}</p></li>;
}

export default function Roadmap() {
  return <>
    <PageHead eyebrow="07 / ROADMAP" title="Roadmap" lead="What is built, what has to happen before it goes live, and what comes next. No dates are promised." />

    <Section id="built" title="Built, not live yet">
      <ol className="adocs-road">
        <Item title="Solana vault (Squads 2-of-2)" tone="built" label="Built">Vault creation, deposits, releases to your own wallets, optional limits and the guardian service, with automated tests.</Item>
        <Item title="Six security layers" tone="built" label="Built">Biometrics, MFA (the vault&apos;s own optional authenticator app), Safe Zones, Wi-Fi, Bluetooth and optional Limits. Changes apply at once once your current layers pass; only the lost-device recovery waits 7 days.</Item>
        <Item title="Wallet on five networks" tone="built" label="Built">Desktop, Chrome extension and web, with Relay swaps.</Item>
      </ol>
    </Section>

    <Section id="go-live" title="Before go-live">
      <ol className="adocs-road">
        <Item title="Switch on the guardian" tone="progress" label="Owner step">Provision the guardian wallet and its policy, then turn on paired vaults on the server.</Item>
        <Item title="Prove the guardian policy" tone="progress" label="Owner step">Confirm live that the guardian can sign only Squads votes.</Item>
        <Item title="Prove the server cannot sign as you" tone="progress" label="Owner step">Confirm that ANTARA&apos;s server cannot use your session to sign with your wallet.</Item>
        <Item title="Funded and hardware acceptance" tone="progress" label="Not done">A release with real funds, and hands-on tests of passkeys, location, Wi-Fi and Bluetooth on real devices.</Item>
      </ol>
    </Section>

    <Section id="planned" title="Planned">
      <ol className="adocs-road">
        <Item title="EVM vault" tone="planned" label="Planned">A Safe 2-of-2 vault on EVM networks, on the same wallet, vault and layers model.</Item>
        <Item title="Gas sponsorship" tone="planned" label="Planned">Network fees paid for you on selected actions. Not built; you pay fees today.</Item>
        <Item title="Swaps from any token" tone="planned" label="Planned">Today swaps are paid from the network&apos;s funding stablecoin only.</Item>
        <Item title="Cross-network swaps into BNB Smart Chain and Robinhood Chain" tone="planned" label="Planned">Routes from another network into these two are not offered yet.</Item>
        <Item title="Website connections" tone="planned" label="Pending provider">Letting websites request accounts or signatures from ANTARA. Off until our wallet provider confirms in writing that its terms allow it.</Item>
        <Item title="Chrome Web Store listing" tone="planned" label="Planned">Install the extension from the store instead of loading it yourself.</Item>
        <Item title="Signed Windows installer" tone="planned" label="Planned">A signed download for ANTARA Desktop instead of building it from source.</Item>
      </ol>
    </Section>
  </>;
}
