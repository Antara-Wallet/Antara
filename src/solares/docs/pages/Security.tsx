import type { ReactNode } from 'react';
import { DOC_ART } from '../art';
import { Callout, DocLink, Kind, PageHead, Section, StatusNote, TableWrap, Tag, type LayerKind, type TagTone } from '../components';

interface LayerCardProps {
  id: string;
  name: string;
  kinds: LayerKind[];
  status: { tone: TagTone; label: string }[];
  checks: ReactNode;
  surfaces: { desktop: ReactNode; extension: ReactNode; web: ReactNode } | string;
  rules: ReactNode;
  caveat: ReactNode;
}

function LayerCard({ id, name, kinds, status, checks, surfaces, rules, caveat }: LayerCardProps) {
  return <article className="adocs-layer" id={id} aria-labelledby={`${id}-title`}>
    <header>
      <h3 id={`${id}-title`}>{name}<a className="adocs-anchor" href={`#${id}`} aria-label={`Link to ${name}`}>#</a></h3>
      <div className="adocs-layer-tags">{kinds.map(kind => <Kind key={kind} kind={kind} />)}{status.map(item => <Tag key={item.label} tone={item.tone}>{item.label}</Tag>)}</div>
    </header>
    <dl>
      <div><dt>What it checks</dt><dd>{checks}</dd></div>
      <div><dt>Where it works</dt><dd>{typeof surfaces === 'string' ? surfaces : <ul className="adocs-surfaces">
        <li><b>Desktop</b><span>{surfaces.desktop}</span></li>
        <li><b>Extension</b><span>{surfaces.extension}</span></li>
        <li><b>Web</b><span>{surfaces.web}</span></li>
      </ul>}</dd></div>
      <div><dt>On, off and recovery</dt><dd>{rules}</dd></div>
      <div className="adocs-layer-caveat"><dt>Keep in mind</dt><dd>{caveat}</dd></div>
    </dl>
  </article>;
}

export default function Security() {
  return <>
    <PageHead eyebrow="04 / SECURITY LAYERS" title="Security layers" art={DOC_ART.sanctuary} artPosition="72% 40%"
      lead="Layers are rules around your vault. ANTARA's guardian adds its vote to a release only after every layer you turned on passes for that exact release. They never slow down your regular wallet." />

    <Section id="how" title="How layers work">
      <ul className="adocs-list">
        <li><b>They apply to vault releases only.</b> Deposits, and everything in your regular wallet, are not checked.</li>
        <li><b>Every layer you turn on must pass.</b> A missing or unreadable signal is a failure, never a pass.</li>
        <li><b>Evidence is bound to one release.</b> Each check uses a single-use challenge that expires after 5 minutes and is tied to that exact transaction, amount and recipient.</li>
        <li><b>Repeated failures lock the vault&apos;s checks</b> for 15 minutes after 5 failed attempts in 15 minutes.</li>
      </ul>
      <StatusNote />
    </Section>

    <Section id="kinds" title="Three kinds of check" lead="Each layer carries a label that says what kind of evidence it is. The labels are part of the product, not fine print.">
      <TableWrap label="Kinds of check">
        <table>
          <thead><tr><th scope="col">Label</th><th scope="col">Meaning</th><th scope="col">Layers</th></tr></thead>
          <tbody>
            <tr><th scope="row"><Kind kind="cryptographic" /></th><td>ANTARA verifies a signature or a code, or the guardian enforces the rule itself. For MFA, ANTARA&apos;s server checks the 6-digit code from your vault&apos;s own authenticator app.</td><td>Biometrics, MFA, Limits</td></tr>
            <tr><th scope="row"><Kind kind="server-observed" /></th><td>ANTARA&apos;s server observes it directly.</td><td>Wi-Fi (trusted network)</td></tr>
            <tr><th scope="row"><Kind kind="device-reported" /></th><td>Your trusted device reports the signal and signs it. ANTARA cannot verify the reading itself.</td><td>Safe Zones, Bluetooth, Wi-Fi name on Desktop</td></tr>
          </tbody>
        </table>
      </TableWrap>
    </Section>

    <Section id="layers" title="The six layers">
      <div className="adocs-layers">
        <LayerCard id="biometrics" name="Biometrics" kinds={['cryptographic']} status={[{ tone: 'required', label: 'Required' }, { tone: 'notlive', label: 'Not live yet' }]}
          checks={<>A passkey for <code className="adocs-mono">antara.tech</code>: Windows Hello, Touch ID, Face ID, a phone or a security key. Your device verifies you, with a fingerprint, your face or the device PIN, and signs this exact release. ANTARA checks the signature. ANTARA never receives biometric data.</>}
          surfaces={{ desktop: 'Windows Hello and phone passkeys, through Windows itself.', extension: 'In a full Chrome tab (the side panel cannot show the prompt reliably yet).', web: 'In the page, in browsers that support passkeys.' }}
          rules={<>Required to finish activating a vault and for every release. A vault always keeps at least one passkey: add another before removing one. Up to 5 passkeys. Lost them all? Add a new one through a 7-day recovery change.</>}
          caveat={<>A synced passkey works on any device signed in to your passkey provider. A passkey saved in Chrome&apos;s Google Password Manager cannot be used by ANTARA Desktop. On Windows, the passkey binds your approval to the exact release, but it cannot prove which program on your computer asked for it.</>} />

        <LayerCard id="mfa" name="MFA" kinds={['cryptographic']} status={[{ tone: 'neutral', label: 'Optional' }, { tone: 'notlive', label: 'Not live yet' }]}
          checks={<>A 6-digit code from an authenticator app (TOTP) that you add to this vault alone. While MFA is on, you type a code for every release and ANTARA&apos;s server checks it against your vault&apos;s authenticator, for that exact release. Each code works once. This is not your Privy sign-in, and your regular wallet never asks for it.</>}
          surfaces="In every app. To turn it on, scan the QR code (or type the key) into an authenticator app on your phone, then type a code to confirm. ANTARA’s server checks every code."
          rules={<>Off until you add an authenticator app. Adding one turns MFA on immediately and needs your passkey and a code from the new app. One authenticator app per vault. Turning MFA off applies at once and needs a code and every other layer you have on. Lost the app? Waive MFA with a 7-day recovery change.</>}
          caveat={<>The authenticator&apos;s secret is stored encrypted on ANTARA&apos;s server, so a compromised ANTARA server could read it. Anyone holding the authenticator app can produce codes.</>} />

        <LayerCard id="geolocation" name="Safe Zones" kinds={['device-reported']} status={[{ tone: 'neutral', label: 'Optional' }, { tone: 'notlive', label: 'Not live yet' }]}
          checks={<>Your trusted device reports where it is and signs the reading. The reading must fall inside one of your safe zones (up to 3, each with a radius from 100 m to 50 km), with an accuracy of at most half the radius. ANTARA never shows a place&apos;s center back, and a refusal never says how far away you were.</>}
          surfaces={{ desktop: 'Windows location. Only a fix this computer measured counts: not the Windows default location, not an IP-based or Remote Desktop fix. Windows 11 only.', extension: 'Chrome’s location, allowed when you install the extension. The browser does not say where a reading came from, so ANTARA cannot refuse a default or spoofed location here; only ANTARA Desktop applies the measured-location rule.', web: 'Your browser’s location prompt. The browser does not say where a reading came from, so ANTARA cannot refuse a default or spoofed location here; only ANTARA Desktop applies the measured-location rule.' }}
          rules={<>Adding the first place turns it on immediately. Adding another place while it is on, or turning it off, also applies at once, but needs every layer you have on.</>}
          caveat={<>A modified device or location spoofing can fake this signal. Plan travel ahead: adding a new place needs every layer you have on, so add it while you can still pass them.</>} />

        <LayerCard id="wifi" name="Wi-Fi" kinds={['server-observed', 'device-reported']} status={[{ tone: 'neutral', label: 'Optional' }, { tone: 'notlive', label: 'Not live yet' }]}
          checks={<><b>Trusted network:</b> ANTARA&apos;s server checks the public internet address your request comes from against networks you trusted (up to 3). <b>Desktop only, optional:</b> ANTARA Desktop also reports the Wi-Fi name and access point it is connected to.</>}
          surfaces={{ desktop: 'Trusted network, plus the Wi-Fi name and access point if you choose. Windows 11 (24H2 and later) asks for location access, because it treats Wi-Fi names as location data.', extension: 'Trusted network only. Browsers cannot read Wi-Fi names.', web: 'Trusted network only.' }}
          rules={<>Adding the first network turns it on immediately; so do adding the first Wi-Fi name and requiring it. Adding further networks, Wi-Fi names or access points, no longer requiring the Wi-Fi name, or turning Wi-Fi off also applies at once, but needs every layer you have on. If you require the Wi-Fi name, releases can be approved only from ANTARA Desktop.</>}
          caveat={<>Anyone on the same network, or a VPN that exits there, shares that public address. The Wi-Fi name is reported by your device; ANTARA cannot verify it.</>} />

        <LayerCard id="bluetooth" name="Bluetooth" kinds={['device-reported']} status={[{ tone: 'neutral', label: 'Optional' }, { tone: 'notlive', label: 'Not live yet' }]}
          checks={<>A Bluetooth device you trusted (up to 3) must be present when you approve. Distance is never measured.</>}
          surfaces={{ desktop: 'The device must be connected to this computer. Classic Bluetooth devices only; Bluetooth Low Energy-only devices are not listed.', extension: 'You pick your device from the ones Chrome finds nearby, in a full tab. Only Bluetooth Low Energy devices that are advertising nearby appear, so a paired phone or headset may not be listed.', web: 'The same chooser, in Chrome and Edge. Not in Safari or Firefox. Only Bluetooth Low Energy devices that are advertising nearby appear, so a paired phone or headset may not be listed.' }}
          rules={<>Adding the first device turns it on immediately. Adding another device, or turning it off, also applies at once, but needs every layer you have on. ANTARA Desktop and Chrome identify devices differently, so add your device in each app you approve from. While Bluetooth is on, an app with no Bluetooth device of its own cannot pass it: adding a new app needs a 7-day recovery that waives Bluetooth, and adding that app&apos;s device may need another. Add every app you will approve from before you turn Bluetooth on.</>}
          caveat={<>Being connected or nearby is not proof of who holds the device.</>} />

        <LayerCard id="limits" name="Limits" kinds={['cryptographic']} status={[{ tone: 'neutral', label: 'Optional' }, { tone: 'notlive', label: 'Not live yet' }]}
          checks={<>Caps you set yourself: an amount of SOL or USDC per release, per day, or both. While Limits is on, the guardian refuses a release above your caps. ANTARA sets no cap of its own.</>}
          surfaces="In every app. The guardian enforces it before it votes."
          rules={<>Off until you set a cap, at any positive amount. Setting a cap or lowering one applies at once. Raising or removing a cap, or turning Limits off, also applies at once, but needs every layer you have on. See <DocLink to="/docs/vault#limits">optional limits</DocLink>.</>}
          caveat={<>Without caps, someone who controls your wallet and passes your other layers, including your vault authenticator code if MFA is on, can release everything in the vault to your own wallets.</>} />
      </div>
    </Section>

    <Section id="devices" title="Trusted devices">
      <p>Device-reported readings are signed with a key created on your device for this vault, up to 5 devices per vault. ANTARA cannot export it, but it is stored in the app&apos;s or browser&apos;s profile, not in secure hardware. A reading from a device you have not trusted is refused. Adding a device is a change like any other: it applies at once, and once a device-reported layer is on it needs every layer you have on. The app adds this device for you only as the announced first step of turning on or adding to a layer that reads from it; any other change that needs a reading from a device you have not set up stops before any prompt and asks you first.</p>
    </Section>

    <Section id="changes" title="Turning layers on and off">
      <TableWrap label="Change rules">
        <table>
          <thead><tr><th scope="col">Change</th><th scope="col">What you must pass</th><th scope="col">Takes effect</th></tr></thead>
          <tbody>
            <tr><th scope="row">Turn a layer on, or tighten it</th><td>Your session and your passkey (turning on MFA also needs a code from the new authenticator app)</td><td>Immediately</td></tr>
            <tr><th scope="row">Turn a layer off, loosen it, or add a place, network, device or passkey to a layer that is on</th><td>Every layer you have on</td><td>Immediately</td></tr>
            <tr><th scope="row">Recovery: skip a layer you can no longer satisfy</th><td>Every other layer you have on</td><td>After 7 days, cancelable until then</td></tr>
          </tbody>
        </table>
      </TableWrap>
      <p>While a recovery change is pending, the vault shows a warning and you can cancel it. ANTARA sends no email or push notifications about pending changes, so check the app.</p>
    </Section>

    <Section id="where" title="Which layer works where">
      <TableWrap label="Layers per app">
        <table>
          <thead><tr><th scope="col">Layer</th><th scope="col">Desktop</th><th scope="col">Extension</th><th scope="col">Web</th></tr></thead>
          <tbody>
            <tr><th scope="row">Biometrics</th><td>Yes</td><td>Full tab</td><td>Yes</td></tr>
            <tr><th scope="row">MFA</th><td>Yes</td><td>Yes</td><td>Yes</td></tr>
            <tr><th scope="row">Safe Zones</th><td>Yes (Windows 11), measured fixes only</td><td>Yes, browser location</td><td>Yes, browser location</td></tr>
            <tr><th scope="row">Wi-Fi, trusted network</th><td>Yes</td><td>Yes</td><td>Yes</td></tr>
            <tr><th scope="row">Wi-Fi name</th><td>Yes</td><td>No</td><td>No</td></tr>
            <tr><th scope="row">Bluetooth</th><td>Connected classic devices</td><td>Chrome chooser (Bluetooth Low Energy), full tab</td><td>Chrome and Edge chooser (Bluetooth Low Energy)</td></tr>
            <tr><th scope="row">Limits</th><td>Yes</td><td>Yes</td><td>Yes</td></tr>
          </tbody>
        </table>
      </TableWrap>
    </Section>

    <Section id="cannot" title="What layers cannot do">
      <Callout tone="warn" title="Read this before you rely on a layer">
        <ul className="adocs-list">
          <li><b>They do not protect your regular wallet.</b> Only vault releases are checked.</li>
          <li><b>They are checked by ANTARA&apos;s server.</b> A compromised ANTARA server could skip them.</li>
          <li><b>Device-reported signals can be faked</b> by a modified device or by malware on your trusted device. Such malware could also ask you for a passkey approval.</li>
          <li><b>The trusted network is shared</b> by everyone on that network and by any VPN that exits there.</li>
          <li><b>No layer measures distance,</b> and none can tell who is holding a device.</li>
          <li><b>A stolen session can start a recovery.</b> Someone holding your session, who also passes any other layers you have on, can add a passkey through a 7-day recovery. The vault shows a warning and you can cancel it until then, but ANTARA sends no notifications, so check the app.</li>
          <li><b>They cannot bring back a lost login.</b> Without your ANTARA login, vault funds cannot be released.</li>
          <li><b>Not yet proven with real funds or hardware.</b> Funded and hands-on hardware acceptance have not been completed, and ANTARA has not been audited.</li>
        </ul>
      </Callout>
    </Section>
  </>;
}
