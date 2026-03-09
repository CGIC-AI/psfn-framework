import { defineConfig } from 'vitest/config';

const DEFAULT_INCLUDE = ['src/**/*.test.ts'];
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
  if (profile === PHASE_V_AUTONOMY_SMOKE_PROFILE) {
    return PHASE_V_AUTONOMY_SMOKE_INCLUDE;
  }
  return DEFAULT_INCLUDE;
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: resolveVitestInclude(),
    testTimeout: 10_000,
  },
});
