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
import { purgeTestingSession } from './testing-session-purge.js';

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
      await companionPool.query(`
        CREATE TABLE l2_memories (
          id TEXT PRIMARY KEY,
          text TEXT NOT NULL,
          type TEXT NOT NULL,
          importance DOUBLE PRECISION NOT NULL,
          confidence DOUBLE PRECISION NOT NULL,
          emotional_valence DOUBLE PRECISION NOT NULL,
          salience DOUBLE PRECISION NOT NULL,
          salience_decay_anchor_at BIGINT NOT NULL,
          source_ref TEXT NOT NULL,
          source_type TEXT NOT NULL,
          provenance_json JSONB NOT NULL,
          extracted_at BIGINT NOT NULL,
          last_accessed BIGINT NOT NULL,
          access_count INTEGER NOT NULL,
          tags JSONB NOT NULL,
          scope_tags JSONB NOT NULL,
          provenance_refs JSONB NOT NULL,
          sensitivity TEXT NOT NULL,
          consent_flags JSONB NOT NULL
        );
        CREATE TABLE recent_contact_shapes (
          schema_version INTEGER NOT NULL,
          contact_id TEXT PRIMARY KEY,
          summary_text TEXT NOT NULL,
          source_memory_ids JSONB NOT NULL,
          confidence_score DOUBLE PRECISION NOT NULL,
          novelty_score DOUBLE PRECISION NOT NULL,
          updated_at BIGINT NOT NULL,
          fresh_until BIGINT NOT NULL
        );
        CREATE TABLE memory_links (
          id1 TEXT NOT NULL,
          id2 TEXT NOT NULL,
          link_type TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          PRIMARY KEY (id1, id2)
        );
        CREATE TABLE l2_memory_maintenance_reviews (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          subject_memory_id TEXT NOT NULL,
          candidate_memory_ids JSONB NOT NULL,
          state_json JSONB NOT NULL,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `);
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
      const neighboringSessionId = 'api:testing:postgres-purge-neighbor';
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

      await companionPool.query(`
        INSERT INTO l2_memories (
          id, text, type, importance, confidence, emotional_valence,
          salience, salience_decay_anchor_at, source_ref, source_type,
          provenance_json, extracted_at, last_accessed, access_count,
          tags, scope_tags, provenance_refs, sensitivity, consent_flags
        ) VALUES
          (
            'memory-testing-session', 'testing memory', 'semantic', 0.9, 0.95, 0,
            0.9, 1000, 'testing-source', 'turn',
            $1::jsonb, 1000, 1000, 1,
            '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'personal', '{}'::jsonb
          ),
          (
            'memory-neighbor-session', 'neighbor memory', 'semantic', 0.9, 0.95, 0,
            0.9, 1000, 'neighbor-source', 'turn',
            $2::jsonb, 1000, 1000, 1,
            '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'personal', '{}'::jsonb
          )
      `, [
        JSON.stringify({ channelId: sessionId, sessionId }),
        JSON.stringify({ channelId: neighboringSessionId, sessionId: neighboringSessionId }),
      ]);
      await companionPool.query(`
        INSERT INTO recent_contact_shapes (
          schema_version, contact_id, summary_text, source_memory_ids,
          confidence_score, novelty_score, updated_at, fresh_until
        ) VALUES
          (1, 'contact-testing', 'derived from testing', '["memory-testing-session"]'::jsonb, 0.9, 1, 1000, 2000),
          (1, 'contact-neighbor', 'derived from neighbor', '["memory-neighbor-session"]'::jsonb, 0.9, 1, 1000, 2000)
      `);
      await companionPool.query(`
        INSERT INTO memory_links (id1, id2, link_type, created_at)
        VALUES ('memory-neighbor-session', 'memory-testing-session', 'related', 1000)
      `);
      await companionPool.query(`
        INSERT INTO l2_memory_maintenance_reviews (
          id, kind, status, subject_memory_id, candidate_memory_ids,
          state_json, created_at, updated_at
        ) VALUES
          (
            'review-testing', 'near_duplicate', 'pending',
            'memory-testing-session', '["memory-neighbor-session"]'::jsonb,
            '{}'::jsonb, 1000, 1000
          ),
          (
            'review-neighbor', 'near_duplicate', 'pending',
            'memory-neighbor-session', '[]'::jsonb,
            '{}'::jsonb, 1000, 1000
          )
      `);

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

      const report = await purgeTestingSession({
        sessionsDir,
        sessionId,
        database: adapters.sessionPurge,
      });

      expect(report.database).toEqual({
        removedProjectionRows: 2,
        removedMemoryRows: 1,
        removedContactProfileRows: 1,
        removedMemoryLinkRows: 1,
        removedMaintenanceReviewRows: 1,
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
      expect((await companionPool.query<{ id: string }>(
        'SELECT id FROM l2_memories ORDER BY id',
      )).rows).toEqual([{ id: 'memory-neighbor-session' }]);
      expect((await companionPool.query<{ contact_id: string }>(
        'SELECT contact_id FROM recent_contact_shapes ORDER BY contact_id',
      )).rows).toEqual([{ contact_id: 'contact-neighbor' }]);
      expect((await companionPool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM memory_links',
      )).rows[0]?.count).toBe('0');
      expect((await companionPool.query<{ id: string }>(
        'SELECT id FROM l2_memory_maintenance_reviews ORDER BY id',
      )).rows).toEqual([{ id: 'review-neighbor' }]);
    } finally {
      await Promise.all([adminPool.end(), companionPool.end(), publicPool.end()]);
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  }, INTEGRATION_TIMEOUT_MS);
});
