import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const origin = process.env.PSFN_SMOKE_FLEET_ORIGIN;
if (!origin || !/^https:\/\/(?:127\.0\.0\.1|localhost):\d+$/u.test(origin)) {
  throw new Error('Runtime browser tests require the disposable smoke HTTPS origin');
}
const evidenceRoot = process.env.PSFN_SMOKE_EVIDENCE_DIR
  ? resolve(process.env.PSFN_SMOKE_EVIDENCE_DIR, 'browser')
  : resolve(import.meta.dirname, 'test-results/runtime');

export default defineConfig({
  testDir: './runtime-e2e',
  outputDir: resolve(evidenceRoot, 'artifacts'),
  reporter: [['list'], ['json', { outputFile: resolve(evidenceRoot, 'results.json') }]],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: {
    baseURL: origin,
    ignoreHTTPSErrors: true,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
