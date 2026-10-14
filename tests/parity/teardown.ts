/**
 * Parity global teardown: folds every results/<surface>__<scenario>.json of this run
 * into artifacts/ui-parity/<run>/manifest.json (scenario order of manifest.ts, then
 * surface order), which sheet.mjs reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scenarios } from './manifest';
import { PARITY_OUT, PARITY_RUN, SURFACES, type ParityResult, type SurfaceId } from './types';

export default function teardown() {
  const runDir = path.join(PARITY_OUT, PARITY_RUN);
  const resultsDir = path.join(runDir, 'results');
  if (!fs.existsSync(resultsDir)) return;
  const order = new Map(scenarios.map((scenario, index) => [scenario.id, index]));
  const surfaceOrder = Object.keys(SURFACES) as SurfaceId[];
  const results = fs.readdirSync(resultsDir).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(resultsDir, name), 'utf8')) as ParityResult)
    .sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || surfaceOrder.indexOf(a.surface as SurfaceId) - surfaceOrder.indexOf(b.surface as SurfaceId));
  const count = (status: ParityResult['status']) => results.filter(result => result.status === status).length;
  const manifest = {
    run: PARITY_RUN,
    generatedAt: new Date().toISOString(),
    note: 'Headless captures with mocked routes and a fixture wallet. Not funded acceptance, not a real Privy login, not a real passkey, Bluetooth or location ceremony.',
    totals: { captured: count('captured'), skipped: count('skipped'), failed: count('failed'), findings: results.reduce((sum, result) => sum + result.findings.length, 0) },
    results,
  };
  fs.writeFileSync(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
