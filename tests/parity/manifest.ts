/**
 * Every parity scenario, concatenated from the per-area modules (docs/UI_ARGUS_PARITY.md
 * 10.2). Areas add entries only in their own `scenarios/<name>.ts`; this file only
 * lists the modules and checks ids and surfaces.
 */
import { entries as shell } from './scenarios/shell';
import { entries as home } from './scenarios/home';
import { entries as sendReceive } from './scenarios/send-receive';
import { entries as addressBook } from './scenarios/address-book';
import { entries as swap } from './scenarios/swap';
import { entries as vault } from './scenarios/vault';
import { entries as settings } from './scenarios/settings';
import { entries as activity } from './scenarios/activity';
import { DEFAULT_SURFACES, SURFACES, type ParityScenario, type SurfaceId } from './types';

export const scenarios: readonly ParityScenario[] = [...shell, ...home, ...sendReceive, ...addressBook, ...swap, ...vault, ...settings, ...activity];

const seen = new Set<string>();
for (const scenario of scenarios) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.id)) throw new Error(`Parity scenario id "${scenario.id}" must be lowercase words joined by hyphens.`);
  if (seen.has(scenario.id)) throw new Error(`Duplicate parity scenario id "${scenario.id}".`);
  seen.add(scenario.id);
  for (const surface of scenario.surfaces ?? []) if (!(surface in SURFACES)) throw new Error(`Unknown surface "${surface}" in "${scenario.id}".`);
}

export function surfacesFor(scenario: ParityScenario): readonly SurfaceId[] {
  return scenario.surfaces ?? DEFAULT_SURFACES;
}
