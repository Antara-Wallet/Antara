#!/usr/bin/env node
// Builds the two hermetic extension test variants and runs the headless tests:
//   dist-extension-test/unconfigured  no Privy app ID: PrivyProvider never mounts
//   dist-extension-test/privy         well-formed placeholder app ID: PrivyProvider
//                                     mounts and talks to auth.privy.io (the shipped shape)
// Builds use --mode extension-test, which reads no .env files, and this script
// strips every VITE_ variable from the environment, so local settings or keys
// cannot leak into, or change, what is tested.
//
//   npm run test:extension [-- <playwright args>]
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Placeholder only: well-formed (25 characters) so PrivyProvider mounts; Privy rejects it.
export const PLACEHOLDER_PRIVY_APP_ID = 'cm0000000000000000000test';
const VARIANTS = [
  { name: 'unconfigured', env: {} },
  { name: 'privy', env: { VITE_PRIVY_APP_ID: PLACEHOLDER_PRIVY_APP_ID } },
];

function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^VITE_/i.test(name)));
for (const variant of VARIANTS) {
  const out = `dist-extension-test/${variant.name}`;
  console.log(`\n[extension test] building ${out}`);
  run([join(root, 'node_modules/vite/bin/vite.js'), 'build', '-c', 'vite.extension.config.ts', '--mode', 'extension-test', '--logLevel', 'error'],
    { ...baseEnv, ...variant.env, ANTARA_EXTENSION_OUT_DIR: out });
  run([join(root, 'scripts/extension-check.mjs'), '--dir', out]);
}
run([join(root, 'node_modules/@playwright/test/cli.js'), 'test', '-c', 'playwright.extension.config.ts', ...process.argv.slice(2)]);
