import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresModelUsageStore } from './model-usage-store.js';

const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

async function withStore<T>(handler: (store: PostgresModelUsageStore, pool: Pool) => Promise<T>): Promise<T> {
  if (!harness) throw new Error('Postgres integration harness is unavailable');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'model-usage-private-telemetry-test',
    allowExitOnIdle: true,
    max: 2,
  });
  try {
    return await handler(new PostgresModelUsageStore(pool), pool);
  } finally {
    await pool.end();
  }
}

describe('PostgresModelUsageStore private telemetry', () => {
  it('retains aggregate cost while filtering private details and source correlation', async () => {
    await withStore(async (store) => {
      await store.recordUsageEvent({
        logicalCallId: 'visible-call',
        status: 'success',
        callKind: 'completion',
        callType: 'background',
        purpose: 'background',
        provider: 'litellm',
        model: 'visible-model',
        inputTokens: 10,
        outputTokens: 5,
        providerCostUsd: 0.1,
      });
      await store.recordUsageEvent({
        logicalCallId: 'private-call',
        status: 'success',
        callKind: 'completion',
        callType: 'background',
        purpose: 'background',
        telemetryVisibility: 'companion_private',
        turnId: 'source-turn',
        requestId: 'source-request',
        channelId: 'source-channel',
        provider: 'litellm',
        model: 'private-model',
        inputTokens: 20,
        outputTokens: 10,
        providerCostUsd: 0.5,
      });

      const aggregate = await store.getUsageData({ limit: 10 });
      const operator = await store.getUsageData({ limit: 10, telemetryVisibility: 'operator_visible' });
      const privateEvent = aggregate.recentEvents.find(event => event.logicalCallId === 'private-call');

      expect(aggregate.totals).toMatchObject({ calls: 2, totalTokens: 45, totalCostUsd: 0.6 });
      expect(operator.totals).toMatchObject({ calls: 1, totalTokens: 15, totalCostUsd: 0.1 });
      expect(operator.recentEvents.map(event => event.logicalCallId)).toEqual(['visible-call']);
      expect(privateEvent).toMatchObject({ telemetryVisibility: 'companion_private' });
      expect(privateEvent).not.toHaveProperty('turnId');
      expect(privateEvent).not.toHaveProperty('requestId');
      expect(privateEvent).not.toHaveProperty('channelId');
    });
  }, INTEGRATION_TIMEOUT_MS);
});
