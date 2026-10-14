import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 45_000, fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:1425', browserName: 'chromium', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  // Disconnected-state checks must not inherit a developer's real Privy app, pinned vault guardian
  // (a local .env.local may pin one) or reuse their desktop server.
  webServer: [{ command: 'npm run dev -- --host 127.0.0.1 --port 1425', url: 'http://127.0.0.1:1425', env: { VITE_PRIVY_APP_ID: '', VITE_API_BASE: '', VITE_ANTARA_GUARDIAN_SOLANA: '' }, reuseExistingServer: false, timeout: 120_000 }],
  reporter: 'list',
});
