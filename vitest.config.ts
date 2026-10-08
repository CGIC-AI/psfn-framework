import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const DEFAULT_INCLUDE = ['src/**/*.test.ts', 'scripts/**/*.test.ts'];
const UNIT_INCLUDE = ['src/**/*.test.ts'];
const SCRIPT_INCLUDE = ['scripts/**/*.test.ts'];
const POSTGRES_HARNESS_TESTS = [
  'src/faculties/memory/migration.test.ts',
  'src/faculties/wiki/pgvector-projection.test.ts',
  'src/persistence/postgres/icp-shared-autonomy-store.test.ts',
  'src/persistence/postgres/model-usage-store.test.ts',
  'src/persistence/postgres/runtime-readiness.test.ts',
  'src/persistence/postgres/tenant-pool-scope.test.ts',
  'src/test-support/postgres-test-harness.test.ts',
];
const INTEGRATION_INCLUDE = ['src/**/*.integration.test.ts', ...POSTGRES_HARNESS_TESTS];
const PHASE_V_AUTONOMY_SMOKE_PROFILE = 'phase-v-autonomy-smoke';
const PHASE_V_AUTONOMY_SMOKE_INCLUDE = [
  'src/core/agent/substrate-agent.test.ts',
  'src/app/agent/gateway-message-handlers.test.ts',
  'src/core/tools/session.test.ts',
  'src/faculties/shards/manager.test.ts',
  'src/channels/discord/adapter.test.ts',
  'src/channels/telegram/adapter.test.ts',
];

function resolveVitestInclude(): string[] {
  const profile = process.env.PSFN_VITEST_PROFILE?.trim().toLowerCase() ?? '';
  if (profile === 'integration') return INTEGRATION_INCLUDE;
  if (profile === 'unit') return UNIT_INCLUDE;
  if (profile === 'scripts') return SCRIPT_INCLUDE;
  if (profile === PHASE_V_AUTONOMY_SMOKE_PROFILE) {
    return PHASE_V_AUTONOMY_SMOKE_INCLUDE;
  }
  return DEFAULT_INCLUDE;
}

function resolveVitestExclude(): string[] {
  const profile = process.env.PSFN_VITEST_PROFILE?.trim().toLowerCase() ?? '';
  if (profile === 'unit') return INTEGRATION_INCLUDE;
  return [];
}

const include = resolveVitestInclude();
// Vitest can succeed on a surviving subset after a listed file moves. Exact
// profile entries must all exist so a smaller suite cannot claim full proof.
for (const path of include.filter(path => !path.includes('*'))) {
  if (!existsSync(new URL(path, import.meta.url))) {
    throw new Error(`Missing test profile entry: ${path}`);
  }
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include,
    exclude: resolveVitestExclude(),
    setupFiles: ['./src/test-support/fleet-auth-persistence-boundary.ts'],
    testTimeout: 10_000,
  },
});
