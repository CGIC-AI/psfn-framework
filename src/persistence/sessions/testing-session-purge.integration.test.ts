import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../postgres.js';
import { createDefaultPostgresSessionAdapters } from './postgres-adapters.js';
import { SessionStore } from './store.js';
import { purgeTestingSession, type SessionProjectionPurgePort } from './testing-session-purge.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

describe('testing-session purge with PostgreSQL projection', () => {
  it('removes the journal, index, message rows, and drift row', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const database = await harness.createDatabase();
    const pool = createPostgresPool(database.databaseUrl, {
      applicationName: 'testing-session-purge-integration',
      allowExitOnIdle: true,
      max: 2,
    });
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-testing-session-purge-pg-'));
    try {
      const adapters = await createDefaultPostgresSessionAdapters(database.databaseUrl, {
        sessionsDir,
        pool,
      });
      const sessionId = 'api:testing:postgres-purge';
      const store = new SessionStore(sessionsDir, {
        transcriptProjection: adapters.transcriptProjection,
        transcriptSearch: adapters.transcriptSearch,
        sessionArchivePort: adapters.sessionArchivePort,
        turnRecordStore: adapters.turnRecordStore,
        turnRecordEligibilityFence: adapters.turnRecordEligibilityFence,
      });
      store.append({
        channelId: sessionId,
        role: 'user',
        content: 'exercise projection purge',
        timestamp: 1_000,
      });
      adapters.transcriptProjection.markProjectionDrift(sessionId, 'integration fixture');
      await adapters.transcriptProjection.flushPendingWrites?.();

      expect((await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM session_messages_projection WHERE channel_id = $1',
        [sessionId],
      )).rows[0]?.count).toBe('1');
      expect((await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM session_projection_drift WHERE channel_id = $1',
        [sessionId],
      )).rows[0]?.count).toBe('1');

      await purgeTestingSession({
        sessionsDir,
        sessionId,
        projection: adapters.transcriptProjection as SessionProjectionPurgePort,
      });

      expect(new SessionStore(sessionsDir).listChannels()).toEqual([]);
      expect((await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM session_messages_projection WHERE channel_id = $1',
        [sessionId],
      )).rows[0]?.count).toBe('0');
      expect((await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM session_projection_drift WHERE channel_id = $1',
        [sessionId],
      )).rows[0]?.count).toBe('0');
    } finally {
      await pool.end();
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  }, INTEGRATION_TIMEOUT_MS);
});
