import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createPostgresPool,
  ensurePostgresSchemaExists,
  runPostgresMigrations,
} from '../postgres.js';
import { createPostgresIntentionPortsFromPool } from '../../core/intention/postgres-adapters.js';
import { PostgresActiveConcernStore } from '../../core/intention/postgres-adapters/concerns-adapter.js';
import { createIcpIntentionCandidateAdapter } from '../../core/icp/intention-candidate-adapter.js';
import { createIcpInitiationSourceRuntime } from '../../core/icp/initiation-source-runtime.js';
import type {
  IcpInitiationCandidate,
} from '../../core/icp/initiation-candidate.js';
import type { IcpInitiationCandidateStorePort } from '../../core/icp/autonomy-store-ports.js';
import {
  normalizeIntentionFollowUpActionPayload,
  pendingFollowUpsToPostTurnActionCandidates,
} from '../../core/intention/appraisal/action-translation.js';
import {
  COMPANION_CANDIDATE_QUEUED_TEXT,
  inferIcpInitiationCandidateActions,
  registerIcpInitiationCandidatePostTurnRuntime,
} from '../../core/tools/notify-companion-candidate.js';
import type { PostTurnActionHandler } from '../../core/agent/post-turn-action-runtime.js';
import {
  POSTGRES_CONTACT_MIGRATIONS,
  POSTGRES_INTENTION_MIGRATIONS,
} from './migrations.js';
import { bootstrapSharedSchema, ensureSharedSchema } from './shared-schema.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';

// The tenancy plumbing does not need pgvector; use the plain postgres image so
// this runs against a locally available base image and stays fast.
const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) {
    await harness.stop();
  }
}, INTEGRATION_TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) {
    throw new Error('Postgres integration harness is not available');
  }
  const database = await harness.createDatabase();
  return database.databaseUrl;
}

async function tableSchemas(pool: import('pg').Pool, table: string): Promise<string[]> {
  const result = await pool.query<{ table_schema: string }>(
    `SELECT table_schema FROM information_schema.tables WHERE table_name = $1 ORDER BY table_schema`,
    [table],
  );
  return result.rows.map(row => row.table_schema);
}

async function waitForBlockedActiveConcernQueries(
  pool: import('pg').Pool,
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%active_concerns%'
    `);
    if (Number(result.rows[0]?.count ?? 0) >= expectedCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expectedCount} blocked active-concern queries`);
}

function memoryCandidateStore(): IcpInitiationCandidateStorePort {
  const candidates = new Map<string, IcpInitiationCandidate>();
  return {
    async createCandidate(candidate) {
      const existing = candidates.get(candidate.candidateId);
      if (existing) return existing;
      candidates.set(candidate.candidateId, candidate);
      return candidate;
    },
    async getCandidate(candidateId) {
      return candidates.get(candidateId) ?? null;
    },
    async getCandidateByPendingFollowUpId(pendingFollowUpId) {
      return [...candidates.values()].find(
        candidate => candidate.pendingFollowUpId === pendingFollowUpId,
      ) ?? null;
    },
    async listCandidates() {
      return [...candidates.values()];
    },
    async transitionCandidate(input) {
      const current = candidates.get(input.candidateId);
      if (!current
        || current.status !== input.expectedStatus
        || current.revision !== input.expectedRevision) {
        throw new Error('candidate transition conflict');
      }
      const next: IcpInitiationCandidate = {
        ...current,
        status: input.status,
        revision: current.revision + 1,
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        ...(input.permitId ? { permitId: input.permitId } : {}),
        ...(input.deliveryDisposition
          ? { deliveryDisposition: input.deliveryDisposition }
          : {}),
        ...(input.retryAttempt !== undefined ? { retryAttempt: input.retryAttempt } : {}),
        ...(input.retryEligibleAtMs !== undefined
          ? { retryEligibleAtMs: input.retryEligibleAtMs }
          : {}),
      };
      if (input.status !== 'deferred' || input.clearRetryEligibility === true) {
        delete next.retryEligibleAtMs;
      }
      candidates.set(next.candidateId, next);
      return next;
    },
    async close() {},
  };
}

function recursiveRejectingSourceRuntime(input: {
  localCompanionId: string;
  peerCompanionId: string;
}) {
  const candidateStore = memoryCandidateStore();
  const consent = vi.fn().mockResolvedValue({ action: 'send' as const });
  const issuePermit = vi.fn();
  const peers = {
    resolveKnownPeer: vi.fn().mockResolvedValue({
      contactId: 'peer-contact',
      displayName: 'Peer',
      peerCompanionId: input.peerCompanionId,
    }),
    executeCompanionOutreach: vi.fn().mockResolvedValue({ disposition: 'delivered' as const }),
  };
  return {
    candidateStore,
    consent,
    issuePermit,
    peers,
    runtime: createIcpInitiationSourceRuntime({
      localCompanionId: input.localCompanionId,
      store: candidateStore,
      peers,
      gateway: {
        companionInitiationPreflight: vi.fn().mockImplementation(async ({ candidate }) => (
          candidate.rootInitiationId === candidate.candidateId
            ? { eligible: true as const }
            : {
                eligible: false as const,
                reasonCode: 'recursive_trigger' as const,
                reasonClass: 'terminal' as const,
              }
        )),
        companionIssueInitiationPermit: issuePermit,
      },
      consent: { evaluate: consent },
      isExternalCompanionAuthorized: () => true,
      now: () => Date.parse('2026-07-13T20:01:00.000Z'),
    }),
  };
}

describe('Postgres schema tenancy plumbing', () => {
  it(
    'serializes concurrent terminal concern writes into one immutable generation',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-concern-terminal-cas',
        allowExitOnIdle: true,
        max: 6,
        schema: 'companion_concern_terminal_cas',
      });
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, {
          schema: 'companion_concern_terminal_cas',
        });
        const seed = new PostgresActiveConcernStore(
          pool,
          () => new Date('2026-07-20T12:00:00.000Z'),
          () => 'concern-terminal-cas',
        );
        const created = await seed.create({ text: 'Serialize this terminal transition.' });
        const storeA = new PostgresActiveConcernStore(pool, () => new Date('2026-07-20T12:01:00.000Z'), () => 'unused-a');
        const storeB = new PostgresActiveConcernStore(pool, () => new Date('2026-07-20T12:02:00.000Z'), () => 'unused-b');

        const [left, right] = await Promise.all([
          storeA.resolveConcern(created.id, { outcome: 'winner-a' }),
          storeB.resolveConcern(created.id, { outcome: 'winner-b' }),
        ]);

        expect(left?.resolutionGenerationId).toEqual(expect.any(String));
        expect(right?.resolutionGenerationId).toBe(left?.resolutionGenerationId);
        expect(right?.resolvedAt).toBe(left?.resolvedAt);
        expect(right?.resolutionOutcome).toBe(left?.resolutionOutcome);

        await pool.query(
          `UPDATE active_concerns SET resolution_vad = $2::jsonb WHERE id = $1`,
          [created.id, JSON.stringify({ valence: 0, arousal: 3, dominance: 0 })],
        );
        await expect(seed.getById(created.id)).rejects.toThrow(/resolution_vad\.arousal/);
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'pins search_path to the companion schema and runs the migration chain inside it',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-tenancy-test',
        allowExitOnIdle: true,
        max: 1,
        schema: 'companion_a',
      });
      try {
        const searchPath = await pool.query<{ search_path: string }>('SHOW search_path');
        // Set via the libpq `options` param, Postgres reports it without spaces.
        expect(searchPath.rows[0]?.search_path.replace(/\s/g, '')).toBe('companion_a,extensions');

        await runPostgresMigrations(pool, POSTGRES_CONTACT_MIGRATIONS, { schema: 'companion_a' });

        // The contacts table exists in the companion schema, never in public.
        expect(await tableSchemas(pool, 'contacts')).toEqual(['companion_a']);
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'isolates identically-named tables across companion schemas',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const poolA = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-tenancy-a',
        allowExitOnIdle: true,
        max: 1,
        schema: 'companion_a',
      });
      const poolB = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-tenancy-b',
        allowExitOnIdle: true,
        max: 1,
        schema: 'companion_b',
      });
      try {
        await runPostgresMigrations(poolA, POSTGRES_CONTACT_MIGRATIONS, { schema: 'companion_a' });
        await runPostgresMigrations(poolB, POSTGRES_CONTACT_MIGRATIONS, { schema: 'companion_b' });

        const now = new Date().toISOString();
        await poolA.query(
          `INSERT INTO contacts (id, display_name, first_seen, last_seen) VALUES ($1, $2, $3, $3)`,
          ['contact-a', 'Companion A contact', now],
        );

        // Companion B's pool sees only its own (empty) schema — no crossover.
        const bRows = await poolB.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM contacts');
        expect(bRows.rows[0]?.count).toBe('0');

        const aRows = await poolA.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM contacts');
        expect(aRows.rows[0]?.count).toBe('1');

        // Both schemas physically hold their own contacts table.
        const inventory = await poolA.query<{ table_schema: string }>(
          `SELECT table_schema FROM information_schema.tables WHERE table_name = 'contacts' ORDER BY table_schema`,
        );
        expect(inventory.rows.map(r => r.table_schema)).toEqual(['companion_a', 'companion_b']);
      } finally {
        await poolA.end();
        await poolB.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'preserves pending follow-up ICP lineage across a PostgreSQL runtime restart',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-intention-lineage-restart',
        allowExitOnIdle: true,
        max: 1,
        schema: 'companion_lineage',
      });
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, {
          schema: 'companion_lineage',
        });
        const firstRuntime = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-13T20:00:00.000Z'),
          idFactory: () => 'follow-up-lineage',
        });
        const created = await firstRuntime.pendingFollowUpStore.enqueue({
          content: 'Reconsider reaching out to the peer.',
          priority: 'medium',
          timing: 'immediate',
          channelId: 'api:test',
          channelType: 'api',
          authorId: 'system:intention',
          authorName: 'Whisper',
          contactId: 'peer-contact',
          sourceMessageId: 'icp-origin-turn',
          originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        });
        expect(created).not.toBeNull();

        const restartedRuntime = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-13T20:01:00.000Z'),
        });
        const restartedFollowUp = await restartedRuntime.pendingFollowUpStore.peek(
          'follow-up-lineage',
        );
        expect(restartedFollowUp).toMatchObject({
          originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        });
        if (!restartedFollowUp) throw new Error('restarted follow-up is missing');
        const [resurfaceAction] = pendingFollowUpsToPostTurnActionCandidates([
          restartedFollowUp,
        ]);
        const generatedPayload = normalizeIntentionFollowUpActionPayload(
          resurfaceAction.payload,
        );
        if (!generatedPayload?.originIcpRootInitiationId) {
          throw new Error('generated follow-up lost ICP root lineage');
        }
        const source = recursiveRejectingSourceRuntime({
          localCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          peerCompanionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        });
        let handler: PostTurnActionHandler | undefined;
        registerIcpInitiationCandidatePostTurnRuntime({
          agentLoop: { registerPostTurnActionInferer: () => () => undefined },
          postTurnActions: {
            registerHandler: (_kind, callback) => {
              handler = callback;
              return () => undefined;
            },
          } as never,
          runtime: source.runtime,
          resolveOriginCatalogSource: () => 'extended',
          isExecutionAuthorized: () => true,
        });
        const candidateActions = inferIcpInitiationCandidateActions({
          message: {
            id: 'generated-follow-up-turn',
            channelId: generatedPayload.channelId,
            channelType: generatedPayload.channelType,
            authorId: generatedPayload.authorId,
            authorName: generatedPayload.authorName,
            content: generatedPayload.content,
            timestamp: new Date('2026-07-13T20:01:00.000Z'),
            routing: {
              originIcpRootInitiationId: generatedPayload.originIcpRootInitiationId,
            },
          },
          response: {} as never,
          turnMessages: [
            {
              role: 'assistant',
              content: [{
                type: 'toolCall',
                id: 'candidate-call',
                name: 'notify',
                arguments: {
                  action: 'consider',
                  target_kind: 'companion',
                  contact_id: 'peer-contact',
                  reason_summary: 'Reconsider outreach.',
                },
              }],
            } as never,
            {
              role: 'toolResult',
              toolCallId: 'candidate-call',
              toolName: 'notify',
              isError: false,
              content: [{ type: 'text', text: COMPANION_CANDIDATE_QUEUED_TEXT }],
            } as never,
          ],
          turnId: 'generated-follow-up-turn' as never,
          completedAt: Date.parse('2026-07-13T20:01:00.000Z'),
        }, 'extended');
        if (!handler || !candidateActions[0]) throw new Error('candidate action handler is missing');

        await expect(handler({
          id: 'candidate-action',
          kind: candidateActions[0].kind,
          payload: candidateActions[0].payload,
        })).resolves.toEqual({ detail: 'rejected:rejected' });
        expect(source.consent).not.toHaveBeenCalled();
        expect(source.issuePermit).not.toHaveBeenCalled();
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'preserves a pending follow-up ICP root across supersede and rejects relabeling atomically',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-follow-up-supersede-lineage',
        allowExitOnIdle: true,
        max: 1,
        schema: 'companion_follow_up_supersede',
      });
      const originalRoot = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, {
          schema: 'companion_follow_up_supersede',
        });
        const runtime = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-13T20:00:00.000Z'),
          idFactory: () => 'follow-up-supersede-lineage',
        });
        const created = await runtime.pendingFollowUpStore.enqueue({
          content: 'Check in about the peer outreach plan tomorrow.',
          priority: 'medium',
          timing: 'soon',
          channelId: 'api:test',
          channelType: 'api',
          authorId: 'system:intention',
          authorName: 'Whisper',
          contactId: 'peer-contact',
          sourceMessageId: 'rooted-source',
          originIcpRootInitiationId: originalRoot,
        });
        if (!created) throw new Error('rooted pending follow-up was not created');

        const unrootedSupersede = await runtime.pendingFollowUpStore.enqueue({
          content: 'Check in tomorrow about the peer outreach plan.',
          priority: 'high',
          timing: 'soon',
          channelId: 'api:test',
          channelType: 'api',
          authorId: 'system:intention',
          authorName: 'Whisper',
          contactId: 'peer-contact',
          sourceMessageId: 'unrooted-source',
        });
        expect(unrootedSupersede).toMatchObject({
          id: created.id,
          originIcpRootInitiationId: originalRoot,
          sourceMessageId: 'unrooted-source',
        });
        const beforeConflict = await runtime.pendingFollowUpStore.peek(created.id);

        await expect(runtime.pendingFollowUpStore.enqueue({
          content: 'Check in about the peer outreach plan tomorrow.',
          priority: 'low',
          timing: 'soon',
          channelId: 'api:test',
          channelType: 'api',
          authorId: 'system:intention',
          authorName: 'Whisper',
          contactId: 'peer-contact',
          sourceMessageId: 'conflicting-source',
          originIcpRootInitiationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        })).rejects.toThrow();
        await expect(runtime.pendingFollowUpStore.peek(created.id)).resolves.toEqual(beforeConflict);
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'rejects a conflicting ICP root before reopening a resolved PostgreSQL concern',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-concern-reopen-lineage',
        allowExitOnIdle: true,
        max: 1,
        schema: 'companion_concern_reopen',
      });
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, {
          schema: 'companion_concern_reopen',
        });
        const runtime = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-13T20:00:00.000Z'),
          idFactory: () => 'concern-reopen-lineage',
        });
        const created = await runtime.concernStore.create({
          text: 'Check the peer outreach plan.',
          contactId: 'peer-contact',
          createdAt: '2026-07-13T20:00:00.000Z',
          expiresAt: '2026-07-14T20:00:00.000Z',
          originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        });
        await runtime.concernStore.resolveConcern(created.id, {
          outcome: 'The outreach plan was handled.',
          resolvedAt: '2026-07-13T20:30:00.000Z',
          evidenceRefs: [{ kind: 'runtime', ref: 'resolved-before-conflict' }],
        });
        const beforeConflict = await runtime.concernStore.getById(created.id);
        expect(beforeConflict).toMatchObject({
          status: 'resolved',
          resolvedAt: '2026-07-13T20:30:00.000Z',
          resolutionOutcome: 'The outreach plan was handled.',
        });

        await expect(runtime.concernStore.create({
          text: 'Check on the peer outreach plan.',
          contactId: 'peer-contact',
          createdAt: '2026-07-13T21:00:00.000Z',
          expiresAt: '2026-07-14T21:00:00.000Z',
          reopenResolved: true,
          evidenceRefs: [{ kind: 'message', ref: 'new-conflicting-evidence' }],
          originIcpRootInitiationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        })).rejects.toThrow('conflicting ICP roots');
        await expect(runtime.concernStore.getById(created.id)).resolves.toEqual(beforeConflict);
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'clears the prior resolution VAD when a resolved PostgreSQL concern is reopened',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-concern-reopen-clears-vad',
        allowExitOnIdle: true,
        max: 1,
        schema: 'companion_concern_reopen_vad',
      });
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, {
          schema: 'companion_concern_reopen_vad',
        });
        const runtime = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-13T20:00:00.000Z'),
          idFactory: () => 'concern-reopen-clears-vad',
        });
        const created = await runtime.concernStore.create({
          text: 'Review the reopen VAD hygiene plan.',
          contactId: 'peer-contact',
          createdAt: '2026-07-13T20:00:00.000Z',
          expiresAt: '2026-07-14T20:00:00.000Z',
        });
        await runtime.concernStore.resolveConcern(created.id, {
          outcome: 'Resolved with a captured VAD snapshot.',
          resolvedAt: '2026-07-13T20:30:00.000Z',
          resolutionVAD: { valence: 0.42, arousal: -0.18, dominance: 0.27 },
          evidenceRefs: [{ kind: 'runtime', ref: 'resolved-with-vad' }],
        });
        const resolved = await runtime.concernStore.getById(created.id);
        expect(resolved).toMatchObject({
          status: 'resolved',
          resolutionVAD: { valence: 0.42, arousal: -0.18, dominance: 0.27 },
        });

        // Dedup-reopen must not carry the prior arc's resolution VAD forward:
        // a reawakened concern is active again and has no resolution snapshot.
        const reopened = await runtime.concernStore.create({
          text: 'Review the reopen VAD hygiene plan.',
          contactId: 'peer-contact',
          createdAt: '2026-07-13T21:00:00.000Z',
          expiresAt: '2026-07-14T21:00:00.000Z',
          reopenResolved: true,
          evidenceRefs: [{ kind: 'message', ref: 'reopen-clears-vad' }],
        });
        expect(reopened.id).toBe(created.id);
        expect(reopened.resolvedAt).toBeUndefined();
        expect(reopened.resolutionOutcome).toBeUndefined();
        expect(reopened.resolutionVAD).toBeUndefined();

        const afterReopen = await runtime.concernStore.getById(created.id);
        expect(afterReopen?.resolvedAt).toBeUndefined();
        expect(afterReopen?.resolutionOutcome).toBeUndefined();
        expect(afterReopen?.resolutionVAD).toBeUndefined();
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'rolls back a stale conflicting reopen after concurrent lineage lands under lock',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-concern-reopen-locked-conflict',
        allowExitOnIdle: true,
        max: 6,
        schema: 'companion_concern_locked_conflict',
      });
      const blocker = await pool.connect();
      let blockerOpen = false;
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, {
          schema: 'companion_concern_locked_conflict',
        });
        const runtime = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-13T20:00:00.000Z'),
          idFactory: () => 'concern-locked-conflict',
        });
        const created = await runtime.concernStore.create({
          text: 'Check the locked peer outreach plan.',
          contactId: 'peer-contact',
          createdAt: '2026-07-13T20:00:00.000Z',
          expiresAt: '2026-07-14T20:00:00.000Z',
        });
        await runtime.concernStore.resolveConcern(created.id, {
          outcome: 'Resolved before the concurrent lineage update.',
          resolvedAt: '2026-07-13T20:30:00.000Z',
          evidenceRefs: [{ kind: 'runtime', ref: 'resolved-before-locked-conflict' }],
        });

        await blocker.query('BEGIN');
        blockerOpen = true;
        await blocker.query('SELECT id FROM active_concerns WHERE id = $1 FOR UPDATE', [created.id]);
        const concurrentUpdate = await blocker.query<{ row_json: string }>(`
          UPDATE active_concerns
          SET origin_icp_root_initiation_id = $2
          WHERE id = $1
          RETURNING to_jsonb(active_concerns)::text AS row_json
        `, [created.id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
        const expectedRow = concurrentUpdate.rows[0]?.row_json;
        if (!expectedRow) throw new Error('concurrent lineage update did not return the row');

        const conflictingReopen = runtime.concernStore.create({
          text: 'Check on the locked peer outreach plan.',
          contactId: 'peer-contact',
          createdAt: '2026-07-13T21:00:00.000Z',
          expiresAt: '2026-07-14T21:00:00.000Z',
          reopenResolved: true,
          evidenceRefs: [{ kind: 'message', ref: 'stale-conflicting-reopen' }],
          originIcpRootInitiationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        });
        await waitForBlockedActiveConcernQueries(pool, 1);
        await blocker.query('COMMIT');
        blockerOpen = false;

        await expect(conflictingReopen).rejects.toThrow('conflicting ICP roots');
        const after = await pool.query<{ row_json: string }>(`
          SELECT to_jsonb(active_concerns)::text AS row_json
          FROM active_concerns
          WHERE id = $1
        `, [created.id]);
        expect(after.rows[0]?.row_json).toBe(expectedRow);
      } finally {
        if (blockerOpen) await blocker.query('ROLLBACK');
        blocker.release();
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'allows at most one ICP root to win a concurrent resolved-concern reopen',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-concern-reopen-two-roots',
        allowExitOnIdle: true,
        max: 7,
        schema: 'companion_concern_two_roots',
      });
      const blocker = await pool.connect();
      let blockerOpen = false;
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, {
          schema: 'companion_concern_two_roots',
        });
        const seedRuntime = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-13T20:00:00.000Z'),
          idFactory: () => 'concern-two-roots',
        });
        const created = await seedRuntime.concernStore.create({
          text: 'Check the two-root peer outreach plan.',
          contactId: 'peer-contact',
          createdAt: '2026-07-13T20:00:00.000Z',
          expiresAt: '2026-07-14T20:00:00.000Z',
        });
        await seedRuntime.concernStore.resolveConcern(created.id, {
          outcome: 'Resolved before two roots raced.',
          resolvedAt: '2026-07-13T20:30:00.000Z',
          evidenceRefs: [{ kind: 'runtime', ref: 'resolved-before-two-roots' }],
        });
        const runtimeA = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-13T21:00:00.000Z'),
          idFactory: () => 'unexpected-concern-a',
        });
        const runtimeB = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-13T21:00:00.000Z'),
          idFactory: () => 'unexpected-concern-b',
        });

        await blocker.query('BEGIN');
        blockerOpen = true;
        await blocker.query('SELECT id FROM active_concerns WHERE id = $1 FOR UPDATE', [created.id]);
        const reopen = (runtime: typeof runtimeA, root: string, evidenceRef: string) => (
          runtime.concernStore.create({
            text: 'Check on the two-root peer outreach plan.',
            contactId: 'peer-contact',
            createdAt: '2026-07-13T21:00:00.000Z',
            expiresAt: '2026-07-14T21:00:00.000Z',
            reopenResolved: true,
            evidenceRefs: [{ kind: 'message', ref: evidenceRef }],
            originIcpRootInitiationId: root,
          })
        );
        const operations = [
          reopen(runtimeA, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'root-a-evidence'),
          reopen(runtimeB, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'root-b-evidence'),
        ];
        await waitForBlockedActiveConcernQueries(pool, 2);
        await blocker.query('COMMIT');
        blockerOpen = false;

        const settled = await Promise.allSettled(operations);
        expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1);
        const finalConcern = await seedRuntime.concernStore.getById(created.id);
        expect(finalConcern).toMatchObject({
          id: created.id,
          status: 'active',
          originIcpRootInitiationId: expect.stringMatching(/^(aaaaaaaa|bbbbbbbb)-/),
        });
      } finally {
        if (blockerOpen) await blocker.query('ROLLBACK');
        blocker.release();
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'preserves a rooted active concern and all evidence across a queued unrooted merge',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-active-concern-rooted-unrooted-merge',
        allowExitOnIdle: true,
        max: 7,
        schema: 'companion_active_concern_rooted_unrooted',
      });
      const blocker = await pool.connect();
      let blockerOpen = false;
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, {
          schema: 'companion_active_concern_rooted_unrooted',
        });
        const now = () => new Date('2026-07-13T21:00:00.000Z');
        const seedStore = new PostgresActiveConcernStore(pool, now, () => 'active-merge-seed');
        const created = await seedStore.create({
          text: 'Preserve all evidence for the active peer outreach plan.',
          contactId: 'peer-contact',
          createdAt: '2026-07-13T20:00:00.000Z',
          expiresAt: '2026-07-14T20:00:00.000Z',
          evidenceRefs: [{ kind: 'runtime', ref: 'seed-evidence' }],
        });
        const rootedStore = new PostgresActiveConcernStore(pool, now, () => 'unexpected-rooted');
        const unrootedStore = new PostgresActiveConcernStore(pool, now, () => 'unexpected-unrooted');
        await Promise.all([rootedStore.hydrateCache(), unrootedStore.hydrateCache()]);

        await blocker.query('BEGIN');
        blockerOpen = true;
        await blocker.query('SELECT id FROM active_concerns WHERE id = $1 FOR UPDATE', [created.id]);
        const rootedMerge = rootedStore.create({
          text: created.text,
          contactId: 'peer-contact',
          createdAt: '2026-07-13T21:00:00.000Z',
          expiresAt: '2026-07-14T21:00:00.000Z',
          evidenceRefs: [{ kind: 'message', ref: 'rooted-merge-evidence' }],
          originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        });
        await waitForBlockedActiveConcernQueries(pool, 1);
        const unrootedMerge = unrootedStore.create({
          text: created.text,
          contactId: 'peer-contact',
          createdAt: '2026-07-13T21:00:01.000Z',
          expiresAt: '2026-07-14T21:00:01.000Z',
          evidenceRefs: [{ kind: 'message', ref: 'unrooted-merge-evidence' }],
        });
        await waitForBlockedActiveConcernQueries(pool, 2);
        await blocker.query('COMMIT');
        blockerOpen = false;

        await expect(Promise.all([rootedMerge, unrootedMerge])).resolves.toHaveLength(2);
        const finalConcern = await seedStore.getById(created.id);
        expect(finalConcern).toMatchObject({
          originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          evidenceRefs: expect.arrayContaining([
            { kind: 'runtime', ref: 'seed-evidence' },
            { kind: 'message', ref: 'rooted-merge-evidence' },
            { kind: 'message', ref: 'unrooted-merge-evidence' },
          ]),
        });
      } finally {
        if (blockerOpen) await blocker.query('ROLLBACK');
        blocker.release();
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'allows one active-concern root merge and leaves its winning row unchanged by the loser',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-active-concern-two-root-merge',
        allowExitOnIdle: true,
        max: 7,
        schema: 'companion_active_concern_two_roots',
      });
      const blocker = await pool.connect();
      let blockerOpen = false;
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, {
          schema: 'companion_active_concern_two_roots',
        });
        const now = () => new Date('2026-07-13T21:00:00.000Z');
        const seedStore = new PostgresActiveConcernStore(pool, now, () => 'active-two-roots-seed');
        const created = await seedStore.create({
          text: 'Serialize competing roots for the active outreach plan.',
          contactId: 'peer-contact',
          createdAt: '2026-07-13T20:00:00.000Z',
          expiresAt: '2026-07-14T20:00:00.000Z',
          evidenceRefs: [{ kind: 'runtime', ref: 'seed-two-root-evidence' }],
        });
        const storeA = new PostgresActiveConcernStore(pool, now, () => 'unexpected-root-a');
        const storeB = new PostgresActiveConcernStore(pool, now, () => 'unexpected-root-b');
        await Promise.all([storeA.hydrateCache(), storeB.hydrateCache()]);

        await blocker.query('BEGIN');
        blockerOpen = true;
        await blocker.query('SELECT id FROM active_concerns WHERE id = $1 FOR UPDATE', [created.id]);
        const mergeRoot = (
          store: PostgresActiveConcernStore,
          root: string,
          evidenceRef: string,
        ) => store.create({
          text: created.text,
          contactId: 'peer-contact',
          createdAt: '2026-07-13T21:00:00.000Z',
          expiresAt: '2026-07-14T21:00:00.000Z',
          evidenceRefs: [{ kind: 'message', ref: evidenceRef }],
          originIcpRootInitiationId: root,
        });
        const rootA = mergeRoot(
          storeA,
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'active-root-a-evidence',
        );
        await waitForBlockedActiveConcernQueries(pool, 1);
        const rootB = mergeRoot(
          storeB,
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          'active-root-b-evidence',
        );
        await waitForBlockedActiveConcernQueries(pool, 2);
        await blocker.query('COMMIT');
        blockerOpen = false;

        const settled = await Promise.allSettled([rootA, rootB]);
        const fulfilled = settled.filter(
          (result): result is PromiseFulfilledResult<Awaited<typeof rootA>> => result.status === 'fulfilled',
        );
        expect(fulfilled).toHaveLength(1);
        expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1);
        await expect(seedStore.getById(created.id)).resolves.toEqual(fulfilled[0]!.value);
      } finally {
        if (blockerOpen) await blocker.query('ROLLBACK');
        blocker.release();
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'rejects same-root outreach derived from a restarted PostgreSQL concern before consent',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-concern-lineage-restart',
        allowExitOnIdle: true,
        max: 1,
        schema: 'companion_concern_lineage',
      });
      const rootInitiationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const localCompanionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const peerCompanionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      try {
        await runPostgresMigrations(pool, POSTGRES_INTENTION_MIGRATIONS, {
          schema: 'companion_concern_lineage',
        });
        const firstRuntime = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-13T20:00:00.000Z'),
          idFactory: () => 'concern-lineage',
        });
        await firstRuntime.concernStore.create({
          text: 'Reconsider peer outreach after the conversation.',
          source: 'appraisal',
          contactId: 'peer-contact',
          expiresAt: '2026-07-14T20:00:00.000Z',
          originIcpRootInitiationId: rootInitiationId,
        });

        const restartedRuntime = createPostgresIntentionPortsFromPool(pool, {
          now: () => new Date('2026-07-13T20:01:00.000Z'),
        });
        const source = recursiveRejectingSourceRuntime({
          localCompanionId,
          peerCompanionId,
        });
        const adapter = createIcpIntentionCandidateAdapter({
          sourceRuntime: source.runtime,
          peers: source.peers,
          candidateStore: source.candidateStore,
          pendingFollowUpStore: restartedRuntime.pendingFollowUpStore,
          concernStore: restartedRuntime.concernStore,
          now: () => Date.parse('2026-07-13T20:01:00.000Z'),
        });

        await expect(adapter.submit({
          action: {
            id: 'concern-outreach-action',
            dedupeKey: 'intention.outbound_message:concern-lineage',
            sourceMessageId: 'generated-after-restart',
          },
          payload: {
            channelId: 'api:test',
            channelType: 'api',
            content: 'This draft must never bypass recursive-root policy.',
            concernIds: ['concern-lineage'],
          },
        })).resolves.toMatchObject({
          kind: 'submitted',
          result: { outcome: 'rejected', reasonCode: 'recursive_trigger' },
        });
        expect(source.consent).not.toHaveBeenCalled();
        expect(source.issuePermit).not.toHaveBeenCalled();
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'leaves search_path at the default and uses public when no schema is requested',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-tenancy-default',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        const searchPath = await pool.query<{ search_path: string }>('SHOW search_path');
        // pg default search_path; no companion schema injected.
        expect(searchPath.rows[0]?.search_path).toContain('public');
        expect(searchPath.rows[0]?.search_path).not.toContain('companion_');

        // With no schema requested, runPostgresMigrations runs the chain in the
        // default (public) schema exactly as today.
        await runPostgresMigrations(pool, POSTGRES_CONTACT_MIGRATIONS);
        expect(await tableSchemas(pool, 'contacts')).toEqual(['public']);
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'provisions the base shared world schema with its current version ledger',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      await bootstrapSharedSchema(databaseUrl);

      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-shared-verify',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        const schemaExists = await pool.query<{ schema_name: string }>(
          `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'shared'`,
        );
        expect(schemaExists.rows).toHaveLength(1);

        // The base shared chain owns presence. Optional pgvector-backed shared
        // wiki tables run through a separate migration list and are absent.
        const version = await pool.query<{ version: number; name: string }>(
          `SELECT version, name FROM shared.shared_schema_migrations ORDER BY version`,
        );
        expect(version.rows).toEqual([
          { version: 1, name: 'shared-schema-baseline' },
          { version: 2, name: 'companion-presence' },
          { version: 4, name: 'icp-autonomy-control-plane' },
          { version: 5, name: 'icp-autonomy-invalidation-fences' },
          { version: 6, name: 'icp-fatigue-turn-reservations' },
          { version: 7, name: 'icp-fatigue-delivery-fence' },
          { version: 9, name: 'companion-social-pot' },
          { version: 10, name: 'speaking-arbiter' },
          { version: 11, name: 'speaking-arbiter-charge-association' },
          { version: 12, name: 'icp-felt-impulse-initiation-source' },
          { version: 13, name: 'icp-operator-test-initiation-source' },
        ]);

        const sharedTables = await pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'shared' ORDER BY table_name`,
        );
        expect(sharedTables.rows.map(r => r.table_name)).toEqual([
          'companion_presence',
          'companion_social_pot',
          'icp_autonomy_invalidation_fences',
          'icp_availability_leases',
          'icp_conversation_episodes',
          'icp_fatigue_turn_reservations',
          'icp_initiation_permits',
          'shared_schema_migrations',
          'speaking_egress_leases',
          'speaking_episode_participation',
          'speaking_reservations',
          'speaking_room_episodes',
        ]);

        // Idempotent: re-running does not duplicate the ledger row.
        await ensureSharedSchema(pool);
        const versionAgain = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM shared.shared_schema_migrations`,
        );
        expect(versionAgain.rows[0]?.count).toBe('10');
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'creates a schema on demand via ensurePostgresSchemaExists and fails closed on a bad name',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-ensure-schema',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        await ensurePostgresSchemaExists(pool, 'companion_ondemand');
        const created = await pool.query<{ schema_name: string }>(
          `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'companion_ondemand'`,
        );
        expect(created.rows).toHaveLength(1);

        await expect(ensurePostgresSchemaExists(pool, 'bad; drop schema public')).rejects.toThrow();
      } finally {
        await pool.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
