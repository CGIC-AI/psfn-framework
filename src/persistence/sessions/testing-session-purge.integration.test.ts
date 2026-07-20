import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { resolveSessionsDir } from '../layout.js';
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
  it('purges the live-shaped companion schema while leaving public projection rows untouched', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const database = await harness.createDatabase();
    const adminPool = createPostgresPool(database.databaseUrl, {
      applicationName: 'testing-session-purge-integration-admin',
      allowExitOnIdle: true,
      max: 2,
    });
    const schema = 'companion_testing_session_purge';
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const companionPool = createPostgresPool(database.databaseUrl, {
      applicationName: 'testing-session-purge-integration-companion',
      allowExitOnIdle: true,
      max: 2,
      schema,
    });
    const publicPool = createPostgresPool(database.databaseUrl, {
      applicationName: 'testing-session-purge-integration-public',
      allowExitOnIdle: true,
      max: 2,
      schema: 'public',
    });
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'psfn-testing-session-purge-live-pg-'));
    const systemDataDir = join(runtimeRoot, 'system-data');
    const companionDataDir = join(runtimeRoot, 'companions', 'fixture');
    const sessionsDir = resolveSessionsDir(companionDataDir);
    const publicSessionsDir = join(runtimeRoot, 'public-fixture-sessions');
    mkdirSync(join(systemDataDir, 'state', 'sessions'), { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(publicSessionsDir, { recursive: true });
    try {
      const adapters = await createDefaultPostgresSessionAdapters(database.databaseUrl, {
        sessionsDir,
        pool: companionPool,
        schema,
      });
      const publicAdapters = await createDefaultPostgresSessionAdapters(database.databaseUrl, {
        sessionsDir: publicSessionsDir,
        pool: publicPool,
        schema: 'public',
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
      const publicStore = new SessionStore(publicSessionsDir, {
        transcriptProjection: publicAdapters.transcriptProjection,
        transcriptSearch: publicAdapters.transcriptSearch,
        sessionArchivePort: publicAdapters.sessionArchivePort,
        turnRecordStore: publicAdapters.turnRecordStore,
        turnRecordEligibilityFence: publicAdapters.turnRecordEligibilityFence,
      });
      publicStore.append({
        channelId: sessionId,
        role: 'user',
        content: 'public projection must remain untouched',
        timestamp: 1_000,
      });
      publicAdapters.transcriptProjection.markProjectionDrift(sessionId, 'public control fixture');
      await adapters.transcriptProjection.flushPendingWrites?.();
      await publicAdapters.transcriptProjection.flushPendingWrites?.();

      expect((await adminPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "${schema}".session_messages_projection WHERE channel_id = $1`,
        [sessionId],
      )).rows[0]?.count).toBe('1');
      expect((await adminPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "${schema}".session_projection_drift WHERE channel_id = $1`,
        [sessionId],
      )).rows[0]?.count).toBe('1');
      expect((await adminPool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM public.session_messages_projection WHERE channel_id = $1',
        [sessionId],
      )).rows[0]?.count).toBe('1');

      await purgeTestingSession({
        sessionsDir,
        sessionId,
        projection: adapters.transcriptProjection as SessionProjectionPurgePort,
      });

      expect(new SessionStore(sessionsDir).listChannels()).toEqual([]);
      expect((await adminPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "${schema}".session_messages_projection WHERE channel_id = $1`,
        [sessionId],
      )).rows[0]?.count).toBe('0');
      expect((await adminPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "${schema}".session_projection_drift WHERE channel_id = $1`,
        [sessionId],
      )).rows[0]?.count).toBe('0');
      expect((await adminPool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM public.session_messages_projection WHERE channel_id = $1',
        [sessionId],
      )).rows[0]?.count).toBe('1');
      expect((await adminPool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM public.session_projection_drift WHERE channel_id = $1',
        [sessionId],
      )).rows[0]?.count).toBe('1');
    } finally {
      await Promise.all([adminPool.end(), companionPool.end(), publicPool.end()]);
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  }, INTEGRATION_TIMEOUT_MS);
});
