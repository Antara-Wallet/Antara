import { defineConfig } from '@playwright/test';

// Loads the unpacked hermetic builds in isolated, headless Chromium profiles.
// Build them first with npm run test:extension (scripts/extension-test.mjs), which
// also runs these tests; npm run test:extension:run reuses existing builds.
export default defineConfig({
  testDir: './tests/extension',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  outputDir: 'test-results/extension',
  reporter: 'list',
  projects: [
    // No VITE_PRIVY_APP_ID: PrivyProvider never mounts.
    { name: 'unconfigured', metadata: { dir: 'dist-extension-test/unconfigured', privy: false } },
    // Well-formed placeholder app ID: PrivyProvider mounts and calls auth.privy.io.
    { name: 'privy', metadata: { dir: 'dist-extension-test/privy', privy: true } },
  ],
});
