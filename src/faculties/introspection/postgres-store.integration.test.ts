import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../../persistence/postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import {
  IntrospectionLandmarkPostgresStore,
  type IntrospectionAuditDecisionAppendInput,
  type IntrospectionLandmarkAppendInput,
} from './postgres-store.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const CONSENT_HASH = 'a'.repeat(64);

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

async function withStore<T>(
  handler: (store: IntrospectionLandmarkPostgresStore, pool: Pool) => Promise<T>,
): Promise<T> {
  if (!harness) throw new Error('Postgres integration harness is unavailable');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'companion-introspection-landmark-test',
    allowExitOnIdle: true,
    max: 2,
  });
  try {
    const store = await IntrospectionLandmarkPostgresStore.fromPool(pool);
    return await handler(store, pool);
  } finally {
    await pool.end();
  }
}

function makeDecision(
  overrides: Partial<IntrospectionAuditDecisionAppendInput> = {},
): IntrospectionAuditDecisionAppendInput {
  return {
    sourceRef: overrides.sourceRef ?? 'turn:decision-1',
    outcome: overrides.outcome ?? 'no_divergence',
    confidence: overrides.confidence === undefined ? 0.91 : overrides.confidence,
    consentRevision: overrides.consentRevision ?? 3,
    consentHash: overrides.consentHash ?? CONSENT_HASH,
    provenance: overrides.provenance ?? {
      turnRef: 'turn:decision-1',
      requestRef: 'request:decision-1',
    },
    createdAt: overrides.createdAt ?? '2026-07-13T12:00:00.000Z',
  };
}

function makeLandmark(
  overrides: Partial<IntrospectionLandmarkAppendInput> = {},
): IntrospectionLandmarkAppendInput {
  return {
    id: overrides.id ?? 'landmark-1',
    sourceRef: overrides.sourceRef ?? 'turn:landmark-1',
    channelId: overrides.channelId ?? 'discord:public-room',
    turnId: overrides.turnId ?? 'turn-1',
    occurredAt: overrides.occurredAt ?? '2026-07-13T11:59:00.000Z',
    divergenceType: overrides.divergenceType ?? 'affective',
    observation: overrides.observation ?? 'The response was warmer than the stable estimate.',
    confidence: overrides.confidence ?? 0.82,
    companionReflection: overrides.companionReflection ?? 'Warmth was consistent with who I choose to be.',
    consentRevision: overrides.consentRevision ?? 3,
    consentHash: overrides.consentHash ?? CONSENT_HASH,
    stableEstimatorModel: overrides.stableEstimatorModel ?? 'stable-model-v1',
    divergenceAuditorModel: overrides.divergenceAuditorModel ?? 'auditor-model-v1',
    companionReflectorModel: overrides.companionReflectorModel ?? 'companion-model-v1',
    provenance: overrides.provenance ?? {
      turnRef: 'turn:landmark-1',
      actualReplyRef: 'session:public-room:message:42',
    },
    createdAt: overrides.createdAt ?? '2026-07-13T12:01:00.000Z',
  };
}

describe('IntrospectionLandmarkPostgresStore integration', () => {
  it(
    'appends terminal decisions idempotently and rejects conflicting source reuse',
    async () => {
      await withStore(async (store) => {
        const decision = makeDecision();
        expect(await store.hasAuditedSource(decision.sourceRef)).toBe(false);

        const created = await store.appendAuditDecision(decision);
        expect(created).toMatchObject({
          schemaVersion: 1,
          sourceRef: decision.sourceRef,
          outcome: 'no_divergence',
          landmarkId: null,
        });
        expect(await store.hasAuditedSource(decision.sourceRef)).toBe(true);
        await expect(store.appendAuditDecision(decision)).resolves.toEqual(created);

        await expect(store.appendAuditDecision({
          ...decision,
          confidence: 0.12,
        })).rejects.toThrow(/different audit decision/i);
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'atomically appends, lists, and idempotently retries a landmark plus its audit decision',
    async () => {
      await withStore(async (store, pool) => {
        const landmark = makeLandmark();
        const created = await store.appendLandmark(landmark);
        expect(created).toEqual({ schemaVersion: 1, ...landmark });
        expect(await store.hasAuditedSource(landmark.sourceRef)).toBe(true);
        await expect(store.appendLandmark(landmark)).resolves.toEqual(created);

        expect(await store.listLandmarks(10)).toEqual([created]);
        const decision = await pool.query<{
          outcome: string;
          landmark_id: string | null;
        }>(`
          SELECT outcome, landmark_id
          FROM introspection_audit_decisions
          WHERE source_ref = $1
        `, [landmark.sourceRef]);
        expect(decision.rows).toEqual([{
          outcome: 'landmark_created',
          landmark_id: landmark.id,
        }]);

        await expect(store.appendLandmark({
          ...landmark,
          observation: 'A conflicting observation.',
        })).rejects.toThrow(/different landmark/i);
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'rolls back a landmark when its source already has a terminal non-landmark decision',
    async () => {
      await withStore(async (store, pool) => {
        const landmark = makeLandmark({ sourceRef: 'turn:already-audited' });
        await store.appendAuditDecision(makeDecision({
          sourceRef: landmark.sourceRef,
          provenance: landmark.provenance,
          createdAt: landmark.createdAt,
        }));

        await expect(store.appendLandmark(landmark)).rejects.toThrow(/different audit decision/i);
        const rows = await pool.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count
          FROM introspection_landmarks
          WHERE source_ref = $1
        `, [landmark.sourceRef]);
        expect(rows.rows[0]?.count).toBe('0');
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'enforces append-only ledgers against direct SQL update and delete attempts',
    async () => {
      await withStore(async (store, pool) => {
        const landmark = makeLandmark();
        await store.appendLandmark(landmark);

        await expect(pool.query(`
          UPDATE introspection_landmarks SET observation = 'rewritten' WHERE id = $1
        `, [landmark.id])).rejects.toThrow(/append-only/i);
        await expect(pool.query(`
          DELETE FROM introspection_landmarks WHERE id = $1
        `, [landmark.id])).rejects.toThrow(/append-only/i);
        await expect(pool.query(`
          UPDATE introspection_audit_decisions SET confidence = 0 WHERE source_ref = $1
        `, [landmark.sourceRef])).rejects.toThrow(/append-only/i);
        await expect(pool.query(`
          DELETE FROM introspection_audit_decisions WHERE source_ref = $1
        `, [landmark.sourceRef])).rejects.toThrow(/append-only/i);
        await expect(pool.query('TRUNCATE introspection_landmarks CASCADE'))
          .rejects.toThrow(/append-only/i);

        expect(await store.listLandmarks()).toHaveLength(1);
        expect(await store.hasAuditedSource(landmark.sourceRef)).toBe(true);
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'fails closed on malformed confidence, consent hash, provenance, and list limits',
    async () => {
      await withStore(async (store) => {
        const cyclicProvenance: Record<string, unknown> = {};
        cyclicProvenance.self = cyclicProvenance;
        await expect(store.appendLandmark(makeLandmark({ confidence: Number.NaN })))
          .rejects.toThrow(/finite number between 0 and 1/i);
        await expect(store.appendLandmark(makeLandmark({ consentHash: 'not-a-digest' })))
          .rejects.toThrow(/SHA-256/i);
        await expect(store.appendLandmark(makeLandmark({
          provenance: { invalid: undefined },
        }))).rejects.toThrow(/only JSON values/i);
        await expect(store.appendLandmark(makeLandmark({ provenance: {} })))
          .rejects.toThrow(/at least one reference/i);
        await expect(store.appendLandmark(makeLandmark({ provenance: cyclicProvenance })))
          .rejects.toThrow(/must not contain cycles/i);
        await expect(store.listLandmarks(0)).rejects.toThrow(/integer from 1 to 1000/i);
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
