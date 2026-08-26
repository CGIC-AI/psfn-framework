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
  'src/agent/substrate-agent.test.ts',
  'src/agent-main/gateway-message-handlers.test.ts',
  'src/tools/session.test.ts',
  'src/shards/manager.test.ts',
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

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: resolveVitestInclude(),
    exclude: resolveVitestExclude(),
    setupFiles: ['./src/test-support/fleet-auth-persistence-boundary.ts'],
    testTimeout: 10_000,
  },
});
