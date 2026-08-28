import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseMessageAddressingMetadata } from '../../shared/contracts/message-addressing.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool, runPostgresMigrations } from '../postgres.js';
import { POSTGRES_TRANSCRIPT_MIGRATIONS } from '../postgres/migrations.js';
import {
  migratePostgresMessageAddressing,
  readPostgresSessionMessageAddressing,
} from './message-addressing-migration.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

async function createTenantPools(
  schemas: readonly string[],
): Promise<{ admin: Pool; pools: Pool[] }> {
  if (!harness) throw new Error('Postgres test harness is unavailable');
  const database = await harness.createDatabase();
  const admin = createPostgresPool(database.databaseUrl, {
    applicationName: 'message-addressing-migration-admin',
    allowExitOnIdle: true,
  });
  for (const schema of schemas) await admin.query(`CREATE SCHEMA "${schema}"`);
  const pools = schemas.map(schema => createPostgresPool(database.databaseUrl, {
    applicationName: `message-addressing-migration-${schema}`,
    allowExitOnIdle: true,
    schema,
  }));
  await Promise.all(pools.map((pool, index) => runPostgresMigrations(
    pool,
    POSTGRES_TRANSCRIPT_MIGRATIONS,
    { schema: schemas[index] },
  )));
  return { admin, pools };
}

async function insertProjectionRow(
  pool: Pool,
  input: {
    channelId: string;
    messageId: number;
    metadata: unknown;
    visibility?: string;
  },
): Promise<void> {
  await pool.query(`
    INSERT INTO session_messages_projection (
      channel_id, message_id, role, author_id, author_name, content,
      timestamp, channel_visibility, metadata_json
    ) VALUES ($1, $2, 'user', $3, $4, $5, $6, $7, $8::jsonb)
  `, [
    input.channelId,
    input.messageId,
    `author-${input.messageId}`,
    `Author ${input.messageId}`,
    `private fixture content ${input.messageId}`,
    input.messageId * 1_000,
    input.visibility ?? 'invite_only',
    JSON.stringify(input.metadata),
  ]);
}

function currentV2(channelId: string) {
  return parseMessageAddressingMetadata({
    schemaVersion: 2,
    source: 'discord',
    author: { authorId: 'author-current', authorName: 'Current Author' },
    observer: { authorId: 'observer-current', authorName: 'Current Observer' },
    mentionedTargets: [{ authorId: 'target-current', authorName: 'Current Target' }],
    channel: { scope: 'group', channelId },
    resolvedAddressee: {
      kind: 'participants',
      participants: [{
        authorId: 'target-current',
        authorName: 'Current Target',
        evidence: ['mention'],
      }],
    },
  });
}

describe('Postgres message addressing v1-to-v2 migration', () => {
  it('dry-runs and idempotently migrates mixed rows in three companion namespaces', async () => {
    const schemas = ['companion_astra', 'companion_boreal', 'companion_cyra'] as const;
    const { admin, pools } = await createTenantPools(schemas);
    try {
      for (let index = 0; index < pools.length; index += 1) {
        const pool = pools[index]!;
        const channelId = `discord-room-${index + 1}`;
        await insertProjectionRow(pool, {
          channelId,
          messageId: 1,
          metadata: {
            turn: { replyToMessageId: `reply-${index + 1}` },
            messageAddressing: {
              schemaVersion: 1,
              mentionedTargets: [{
                authorId: `target-${index + 1}`,
                authorName: `Target ${index + 1}`,
              }],
            },
          },
        });
        await insertProjectionRow(pool, {
          channelId,
          messageId: 2,
          metadata: { messageAddressing: currentV2(channelId) },
        });
        await insertProjectionRow(pool, {
          channelId,
          messageId: 3,
          visibility: 'private',
          metadata: {
            messageAddressing: {
              schemaVersion: 1,
              mentionedTargets: [{ authorId: 'ambiguous-target', authorName: 'Ambiguous Target' }],
            },
          },
        });

        const observer = {
          authorId: `observer-${index + 1}`,
          authorName: `Observer ${index + 1}`,
        };
        const dryRun = await migratePostgresMessageAddressing(pool, { mode: 'dry-run', observer });
        expect(dryRun).toMatchObject({ scanned: 3, migratedV1: 1, currentV2: 1 });
        expect(dryRun.quarantined.legacy_v1_ambiguous_channel_scope).toBe(1);
        expect(JSON.stringify(dryRun)).not.toContain('private fixture content');
        const beforeApply = await pool.query<{ version: string }>(`
          SELECT metadata_json -> 'messageAddressing' ->> 'schemaVersion' AS version
          FROM session_messages_projection WHERE message_id = 1
        `);
        expect(beforeApply.rows[0]?.version).toBe('1');

        const applied = await migratePostgresMessageAddressing(pool, { mode: 'apply', observer });
        expect(applied).toEqual({ ...dryRun, mode: 'apply' });
        const migrated = await readPostgresSessionMessageAddressing(pool, channelId, 1);
        expect(migrated).toMatchObject({
          schemaVersion: 2,
          source: 'discord',
          author: { authorId: 'author-1', authorName: 'Author 1' },
          observer,
          channel: { scope: 'group', channelId },
          replyTarget: { messageId: `reply-${index + 1}` },
        });
        expect(await readPostgresSessionMessageAddressing(pool, channelId, 3)).toBeNull();
        const quarantined = await pool.query<{ reason: string; content: string }>(`
          SELECT quarantine.reason, projection.content
          FROM session_message_addressing_quarantine quarantine
          JOIN session_messages_projection projection USING (channel_id, message_id)
        `);
        expect(quarantined.rows).toEqual([{
          reason: 'legacy_v1_ambiguous_channel_scope',
          content: 'private fixture content 3',
        }]);

        const repeated = await migratePostgresMessageAddressing(pool, { mode: 'apply', observer });
        expect(repeated).toMatchObject({ migratedV1: 0, currentV2: 2, unchanged: 1 });
      }
    } finally {
      await Promise.all(pools.map(pool => pool.end()));
      await admin.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('rolls back the tenant atomically when a persisted row update fails', async () => {
    const schema = 'companion_atomic';
    const { admin, pools: [pool] } = await createTenantPools([schema]);
    if (!pool) throw new Error('Atomic tenant pool is unavailable');
    try {
      for (const messageId of [1, 2]) {
        await insertProjectionRow(pool, {
          channelId: 'discord-atomic-room',
          messageId,
          metadata: {
            messageAddressing: {
              schemaVersion: 1,
              mentionedTargets: [{ authorId: `target-${messageId}`, authorName: `Target ${messageId}` }],
            },
          },
        });
      }
      await pool.query(`
        CREATE FUNCTION reject_second_addressing_update() RETURNS trigger AS $$
        BEGIN
          IF NEW.message_id = 2 AND NEW.metadata_json <> OLD.metadata_json THEN
            RAISE EXCEPTION 'forced atomic migration failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER reject_second_addressing_update
        BEFORE UPDATE ON session_messages_projection
        FOR EACH ROW EXECUTE FUNCTION reject_second_addressing_update();
      `);

      await expect(migratePostgresMessageAddressing(pool, {
        mode: 'apply',
        observer: { authorId: 'observer-atomic', authorName: 'Observer Atomic' },
      })).rejects.toThrow(/forced atomic migration failure/);
      const versions = await pool.query<{ version: string }>(`
        SELECT metadata_json -> 'messageAddressing' ->> 'schemaVersion' AS version
        FROM session_messages_projection ORDER BY message_id
      `);
      expect(versions.rows.map(row => row.version)).toEqual(['1', '1']);
      const receipts = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM session_message_addressing_quarantine
      `);
      expect(receipts.rows[0]?.count).toBe('0');
    } finally {
      await pool.end();
      await admin.end();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
