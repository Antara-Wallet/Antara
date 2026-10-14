import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

// Tauri owns this development helper. Packaged applications use a deployed API.
const root = fileURLToPath(new URL('../', import.meta.url));
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
  clearInterval(keepAlive);
}
const keepAlive = setInterval(() => {}, 60_000);
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

async function running(url, valid) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    const text = await response.text();
    if (!response.ok || !valid(text)) throw new Error(`Port at ${url} belongs to another application. Stop that application or configure a different development port.`);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Port at ')) throw error;
    return false;
  }
}
function start(name, args, cwd) {
  console.log(`[ANTARA desktop] Starting ${name}.`);
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true });
  children.add(child);
  child.once('error', error => { console.error(`[ANTARA desktop] ${name}: ${error.message}`); stop(1); });
  child.once('exit', code => {
    children.delete(child);
    if (!stopping) { console.error(`[ANTARA desktop] ${name} exited (${code}).`); stop(code || 1); }
  });
}
try {
  if (await running('http://127.0.0.1:8787/api/solares/wallet/config', text => {
    try { const data = JSON.parse(text); return typeof data.configured === 'boolean' && ['mainnet-beta', 'devnet'].includes(data.solanaCluster); } catch { return false; }
  })) console.log('[ANTARA desktop] Reusing the running ANTARA API on port 8787.');
  else {
    const loader = join(root, 'server/node_modules/tsx/dist/loader.mjs');
    await access(loader);
    start('local API', ['--import', pathToFileURL(loader).href, 'src/index.ts'], join(root, 'server'));
  }
  if (await running('http://127.0.0.1:1420', text => text.includes('/@vite/client') && /ANTARA/i.test(text))) console.log('[ANTARA desktop] Reusing the running ANTARA frontend on port 1420.');
  else {
    const vite = join(root, 'node_modules/vite/bin/vite.js');
    await access(vite);
    start('frontend', [vite, '--host', '127.0.0.1'], root);
  }
} catch (error) {
  console.error(`[ANTARA desktop] ${error instanceof Error ? error.message : String(error)}`);
  console.error('Install dependencies with npm ci and npm --prefix server ci before launching.');
  stop(1);
}
