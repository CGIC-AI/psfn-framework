import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: '/tmp/psfn-companion-ui-playwright-results',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    headless: true,
  },
});
