// Settings › About (docs/UI_ARGUS_PARITY.md 6.16, ARGUS "ARGUS-1 · Version"): facts about
// this build and surface only. The guardian line is the public key pinned at build time;
// it never says the guardian is switched on (only the server can, after sign-in).
import type { MouseEvent } from 'react';
import { detectRuntime, extensionSurface } from '../../platform';
import { navigate } from '../../lib/nav';
import { API_URL, PAIRED_GUARDIAN_SOLANA, SOLANA_CLUSTER } from '../wallet/config';
import { SettingsSection } from './SettingsParts';
import { apiHostLabel, guardianLabel, surfaceLabel } from './settingsModel';

export function AboutPanel() {
  const runtime = detectRuntime();
  const facts: { label: string; value: string; title?: string; mono?: boolean }[] = [
    { label: 'Surface', value: surfaceLabel(runtime, extensionSurface()) },
    { label: 'API', value: apiHostLabel(API_URL) },
    { label: 'Solana cluster', value: SOLANA_CLUSTER, mono: true },
    { label: 'Vault guardian', value: guardianLabel(PAIRED_GUARDIAN_SOLANA), title: PAIRED_GUARDIAN_SOLANA || undefined, mono: !!PAIRED_GUARDIAN_SOLANA },
  ];
  const openDocs = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    navigate('/docs');
  };
  return (
    <SettingsSection id="set-about" title="About">
      <div className="set-about">
        <p className="set-about-name"><img src="/antara/app-icon-192.png" width="32" height="32" alt="" aria-hidden="true" /><span>ANTARA</span></p>
        <dl className="set-facts">
          {facts.map(fact => (
            <div key={fact.label} className="set-fact">
              <dt>{fact.label}</dt>
              <dd className={fact.mono ? 'ui-mono' : undefined} title={fact.title}>{fact.value}</dd>
            </div>
          ))}
        </dl>
        {/* The extension bundles no documentation pages; the web app and desktop app serve /docs. */}
        {runtime !== 'extension' && <a className="ui-btn-text set-docs" href="/docs" onClick={openDocs}>Documentation <span aria-hidden="true">↗</span></a>}
      </div>
    </SettingsSection>
  );
}
