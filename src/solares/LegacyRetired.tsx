/**
 * Native replacement for the retired /legacy workspace. The desktop build no
 * longer grants the local keystore's signing, key-reveal or import commands, so
 * the old workspace could receive funds it can no longer spend. This notice is
 * shown instead; it creates no keystore and calls no native command.
 */
export default function LegacyRetired() {
  return <main style={{ height: '100%', overflowY: 'auto', background: '#050507', color: '#dceaff', padding: '48px max(24px, calc((100vw - 760px) / 2))', lineHeight: 1.8 }}>
    <a href="/" style={{ color: '#8fbfff', textDecoration: 'none' }}>← Return to ANTARA</a>
    <h1 style={{ fontFamily: 'var(--antara-display)', fontSize: 'clamp(28px,4vw,40px)', fontWeight: 400, lineHeight: 1.2, marginTop: 48 }}>The legacy desktop workspace is retired</h1>
    <p>Local keystore signing, key reveal and import are disabled in this desktop build. Do not send funds to addresses from the old local keystore or to its stealth addresses: this build cannot spend from them.</p>
    <p>Use the ANTARA wallet for Solana, Ethereum, BNB Smart Chain, Robinhood Chain and Base.</p>
  </main>;
}
