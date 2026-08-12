import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresPool } from '../../../persistence/postgres.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import type { AutomataBusEvent } from './contract.js';
import { PostgresAutomataBusCanonicalFindingAdapter } from './postgres-canonical-query.js';
import {
  AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS,
  buildAutomataBusAnnIndexStatement,
} from './postgres-schema.js';
import { createPostgresAutomataBusStore } from './postgres-store.js';
import { PostgresAutomataBusVectorIndexAdapter } from './postgres-vector-index.js';
import type { AutomataBusCanonicalFinding } from './query-ports.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const TENANT_SCHEMA = 'automata_adapter_test';
const MODEL = { provider: 'test-provider', model: 'test-model', dimensions: 3 } as const;
const VISIBILITY = {
  companionId: 'companion-a',
  audience: 'eligible-automata' as const,
  maxSensitivity: 'personal' as const,
};

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

function finding(
  eventId: string,
  sequence: number,
  overrides: Partial<AutomataBusEvent> = {},
): AutomataBusEvent {
  return {
    schemaVersion: 1,
    eventId,
    companionId: 'companion-a',
    sequence,
    occurredAt: new Date(Date.UTC(2026, 7, 11, 12, sequence)).toISOString(),
    mustUnderstand: [],
    context: {
      automatonClass: 'task-worker',
      runId: 'run-a',
      taskId: 'task-a',
      sessionIds: [`session-${sequence}`],
      artifactRefs: [`artifact:${eventId}`],
    },
    type: 'finding',
    body: {
      claim: `Deterministic ordering for ${eventId}`,
      provenance: 'computed',
      evidence: [{
        kind: 'artifact',
        reference: `artifact:${eventId}`,
        summary: 'Focused adapter proof',
      }],
      verification: { status: 'pending' },
    },
    ...overrides,
  } as AutomataBusEvent;
}

function canonical(event: AutomataBusEvent, audience: 'eligible-automata' | 'operator'): AutomataBusCanonicalFinding {
  if (event.type !== 'finding') throw new Error('integration fixture must be a finding');
  return {
    eventId: event.eventId,
    companionId: event.companionId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    automatonClass: event.context.automatonClass,
    runId: event.context.runId,
    taskId: event.context.taskId,
    claim: event.body.claim,
    provenance: event.body.provenance,
    verificationStatus: event.body.verification.status,
    audience,
    sensitivity: audience === 'operator' ? 'confidential' : 'personal',
  };
}

async function createTenantPool(): Promise<Pool> {
  if (!harness) throw new Error('Postgres integration harness is unavailable');
  const database = await harness.createDatabase();
  const admin = createPostgresPool(database.databaseUrl, { max: 1 });
  try {
    await admin.query('CREATE EXTENSION vector WITH SCHEMA extensions');
    await admin.query(`CREATE SCHEMA ${TENANT_SCHEMA}`);
  } finally {
    await admin.end();
  }
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'automata-bus-query-adapter-integration',
    schema: TENANT_SCHEMA,
    max: 2,
  });
  for (const statement of AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
  return pool;
}

describe('Automata Bus concrete Postgres query adapters', () => {
  it('keeps canonical visibility authoritative across lexical, ANN, exact, lag, and correction paths', async () => {
    const pool = await createTenantPool();
    try {
      const store = createPostgresAutomataBusStore(pool);
      const visible = finding('visible', 1);
      const operatorOnly = finding('operator-only', 2);
      const wrongRun = finding('wrong-run', 3, {
        context: {
          ...finding('wrong-run', 3).context,
          runId: 'run-b',
        },
      });
      await store.append({
        companionId: 'companion-a',
        event: visible,
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      });
      await store.append({
        companionId: 'companion-a',
        event: operatorOnly,
        audiences: ['operator'],
        sensitivity: 'confidential',
      });
      await store.append({
        companionId: 'companion-a',
        event: wrongRun,
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      });

      const canonicalAdapter = new PostgresAutomataBusCanonicalFindingAdapter({
        pool,
        store,
        maxCandidateLimit: 8,
      });
      const vectorAdapter = new PostgresAutomataBusVectorIndexAdapter(pool, {
        companionId: 'companion-a',
        maxCandidateLimit: 8,
      });
      await vectorAdapter.upsert({
        ...canonical(visible, 'eligible-automata'),
        embedding: new Float32Array([1, 0, 0]),
        modelIdentity: MODEL,
      });
      await vectorAdapter.upsert({
        ...canonical(operatorOnly, 'operator'),
        embedding: new Float32Array([1, 0, 0]),
        modelIdentity: MODEL,
      });
      await vectorAdapter.upsert({
        ...canonical(wrongRun, 'eligible-automata'),
        embedding: new Float32Array([1, 0, 0]),
        modelIdentity: MODEL,
      });
      await pool.query(buildAutomataBusAnnIndexStatement(MODEL.dimensions));
      await vectorAdapter.setState({
        modelIdentity: MODEL,
        indexState: 'ready',
        reindexState: 'current',
      });

      const filters = { runIds: ['run-a'], statuses: ['pending'] as const };
      await expect(canonicalAdapter.searchLexical({
        query: 'deterministic ordering',
        visibility: VISIBILITY,
        filters,
        limit: 8,
      })).resolves.toEqual([expect.objectContaining({ eventId: 'visible' })]);
      await expect(vectorAdapter.searchApproximate({
        embedding: new Float32Array([1, 0, 0]),
        modelIdentity: MODEL,
        visibility: VISIBILITY,
        filters,
        limit: 8,
      })).resolves.toEqual([expect.objectContaining({ eventId: 'visible' })]);
      await expect(vectorAdapter.searchExact({
        embedding: new Float32Array([1, 0, 0]),
        modelIdentity: MODEL,
        visibility: VISIBILITY,
        filters,
        limit: 8,
      })).resolves.toEqual([expect.objectContaining({ eventId: 'visible' })]);
      await expect(canonicalAdapter.getCurrentByEventIds({
        eventIds: ['visible', 'operator-only', 'wrong-run'],
        visibility: VISIBILITY,
        filters,
      })).resolves.toEqual([expect.objectContaining({ eventId: 'visible' })]);

      await vectorAdapter.markLagging({
        eventId: 'visible',
        companionId: 'companion-a',
        stage: 'embedding',
        modelIdentity: MODEL,
      });
      await expect(vectorAdapter.readState()).resolves.toEqual(expect.objectContaining({
        indexingLag: expect.objectContaining({ pendingCount: 1 }),
      }));
      await vectorAdapter.markIndexed({
        eventId: 'visible',
        companionId: 'companion-a',
        modelIdentity: MODEL,
      });
      await expect(vectorAdapter.readState()).resolves.toEqual(expect.objectContaining({
        indexingLag: { pendingCount: 0 },
      }));

      const correction: AutomataBusEvent = {
        ...finding('correction', 4),
        mustUnderstand: ['finding-relations-v1'],
        type: 'relation',
        body: {
          targetEventId: 'visible',
          relation: 'corrects',
          reason: 'A stronger focused check replaced the first finding.',
          replacement: {
            claim: 'Corrected deterministic ordering',
            provenance: 'computed',
            evidence: [{
              kind: 'artifact',
              reference: 'artifact:correction',
              summary: 'Correction proof',
            }],
            verification: { status: 'pending' },
          },
        },
      };
      await store.append({
        companionId: 'companion-a',
        event: correction,
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      });
      const staleVector = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM automata_bus_finding_vectors
        WHERE companion_id = $1 AND event_id = $2
      `, ['companion-a', 'visible']);
      expect(staleVector.rows).toEqual([{ count: '0' }]);
    } finally {
      await pool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
