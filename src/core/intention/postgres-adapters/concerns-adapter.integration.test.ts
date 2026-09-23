import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresPool, ensurePostgresSchema, ensurePostgresSchemaExists } from '../../../persistence/postgres.js';
import { POSTGRES_INTENTION_MIGRATIONS } from '../../../persistence/postgres/migrations.js';
import { PostgresActiveConcernStore } from './concerns-adapter.js';

const HOUR = 3_600_000;

describe('Postgres concern candidate promotion (vcq8v.5)', () => {
  let harness: PostgresTestHarness;
  beforeAll(async () => { harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE }); });
  afterAll(async () => { await harness.stop(); });

  it('restarts a promoted candidate\'s lifetime so it is live after review', async () => {
    const database = await harness.createDatabase();
    const pool = createPostgresPool(database.databaseUrl, { schema: 'companion_a' });
    try {
      await ensurePostgresSchemaExists(pool, 'companion_a');
      await ensurePostgresSchema(pool, POSTGRES_INTENTION_MIGRATIONS);
      const now = Date.parse('2026-09-23T15:00:00.000Z');
      let counter = 0;
      const store = new PostgresActiveConcernStore(pool, () => new Date(now), () => `concern-${++counter}`);
      const candidate = await store.create({
        text: 'Ask Mo how the interview went',
        priority: 'low',
        source: 'appraisal',
        status: 'candidate',
        createdAt: new Date(now - 20 * HOUR).toISOString(),
        contactId: 'contact-human',
        evidenceRefs: [{ kind: 'message', ref: 'msg-1' }],
        candidateReviewSnapshot: {
          schemaVersion: 1,
          title: 'Interview',
          summary: 'Mo has an interview on Tuesday.',
          followUpHint: 'possible_follow_up',
          channelId: '123456789012345678',
          triggerReason: 'response_turn',
          sourceRef: 'session:123456789012345678:1',
          sourceMessageIds: [1],
          conversationContext: [],
          relatedMemoryContext: [],
        },
      });
      expect(Date.parse(candidate.expiresAt)).toBeLessThan(now);

      const promoted = await store.transitionConcernStatus(candidate.id, {
        status: 'active',
        evidenceRefs: [{ kind: 'message', ref: 'msg-2' }],
      });
      expect(promoted).toMatchObject({ status: 'active' });
      expect(Date.parse(promoted!.expiresAt)).toBe(now + 8 * HOUR);
      expect(store.snapshotActiveConcerns('contact-human').map(concern => concern.id)).toEqual([candidate.id]);
    } finally {
      await pool.end();
    }
  });
});
