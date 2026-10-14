import { defineConfig } from '@playwright/test';
import { PARITY_GUARDIAN_SOLANA } from './tests/parity/keys';
import { PARITY_ORIGIN, PARITY_PORT } from './tests/parity/types';

/** The fixed fixture guardian pinned into the parity build (Keypair.fromSeed(fill(7))), for routes/vault.ts. */
export { PARITY_GUARDIAN_SOLANA };

/**
 * ARGUS-parity screenshot runner (docs/UI_ARGUS_PARITY.md section 10). Headless Chromium,
 * a fresh context per capture, every network request answered by tests/parity/routes or
 * aborted. The dev server gets fixture-only public values, so the developer's .env.local
 * (Privy app id, API base, RPC URLs) never reaches the page.
 *
 *   $env:PARITY_RUN='before'; npx.cmd playwright test -c playwright.parity.config.ts
 *   node tests/parity/sheet.mjs
 *
 * PARITY_PORT overrides the dev-server port (default 1426). The server is never reused.
 */
export default defineConfig({
  testDir: 'tests/parity',
  testMatch: 'run.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  outputDir: 'test-results/parity',
  globalSetup: './tests/parity/setup.ts',
  globalTeardown: './tests/parity/teardown.ts',
  reporter: 'list',
  use: {
    baseURL: PARITY_ORIGIN,
    browserName: 'chromium',
    headless: true,
    // Software WebGL so the planet can render without a GPU (headless only).
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${PARITY_PORT}`,
    url: PARITY_ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_PRIVY_APP_ID: '',
      VITE_PRIVY_CLIENT_ID: '',
      VITE_API_BASE: '',
      VITE_SOLANA_CLUSTER: 'mainnet-beta',
      VITE_SOLANA_RPC_URL: 'https://rpc.parity.invalid',
      VITE_SOLANA_WS_URL: 'wss://rpc.parity.invalid',
      VITE_ETHEREUM_RPC_URL: 'https://ethereum.rpc.parity.invalid',
      VITE_BSC_RPC_URL: 'https://bsc.rpc.parity.invalid',
      VITE_ROBINHOOD_RPC_URL: 'https://robinhood.rpc.parity.invalid',
      VITE_BASE_RPC_URL: 'https://base.rpc.parity.invalid',
      VITE_ANTARA_GUARDIAN_SOLANA: PARITY_GUARDIAN_SOLANA,
      VITE_COMMUNITY_URL: '',
      VITE_DESKTOP_DOWNLOAD_URL: '',
      VITE_UPDATE_MANIFEST_URL: '',
    },
  },
});
