import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createPostgresPool,
  ensurePostgresSchemaExists,
  runPostgresMigrations,
} from '../postgres.js';
import { createPostgresIntentionPortsFromPool } from '../../core/intention/postgres-adapters.js';
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
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';

// The tenancy plumbing does not need pgvector; use the plain postgres image so
// this runs against a locally available base image and stays fast.
const TEST_IMAGE = 'postgres:16-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
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
      };
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
    consent,
    issuePermit,
    peers,
    runtime: createIcpInitiationSourceRuntime({
      localCompanionId: input.localCompanionId,
      store: memoryCandidateStore(),
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
        expect(searchPath.rows[0]?.search_path.replace(/\s/g, '')).toBe('companion_a,public');

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
          resolveOriginActivationSource: () => 'extended_loaded',
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
        }, 'extended_loaded');
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
        ]);

        const sharedTables = await pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'shared' ORDER BY table_name`,
        );
        expect(sharedTables.rows.map(r => r.table_name)).toEqual([
          'companion_presence',
          'icp_autonomy_invalidation_fences',
          'icp_availability_leases',
          'icp_conversation_episodes',
          'icp_initiation_permits',
          'shared_schema_migrations',
        ]);

        // Idempotent: re-running does not duplicate the ledger row.
        await ensureSharedSchema(pool);
        const versionAgain = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM shared.shared_schema_migrations`,
        );
        expect(versionAgain.rows[0]?.count).toBe('4');
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
