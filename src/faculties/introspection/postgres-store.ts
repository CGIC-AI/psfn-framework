import type { Pool, PoolClient } from 'pg';
import {
  createPostgresPool,
  ensurePostgresSchema,
  queryOne,
  queryRows,
  withPostgresClient,
} from '../../persistence/postgres.js';
import { POSTGRES_INTROSPECTION_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import type {
  IntrospectionAuditDecisionAppendInput,
  IntrospectionAuditPersistencePort,
  IntrospectionLandmarkAppendInput,
} from './contracts.js';
import {
  INTROSPECTION_LANDMARK_SCHEMA_VERSION,
  MAX_INTROSPECTION_LANDMARK_LIST_LIMIT,
  mapDecisionRow,
  mapLandmarkRow,
  normalizeDecisionInput,
  normalizeIntrospectionSourceRef,
  normalizeLandmarkInput,
  sameDecision,
  sameLandmark,
  type IntrospectionAuditDecisionRecord,
  type IntrospectionAuditDecisionRow,
  type IntrospectionLandmarkRecord,
  type IntrospectionLandmarkRow,
} from './postgres-store-records.js';

export type {
  IntrospectionAuditDecisionAppendInput,
  IntrospectionLandmarkAppendInput,
} from './contracts.js';
export {
  INTROSPECTION_LANDMARK_SCHEMA_VERSION,
  type IntrospectionAuditDecisionRecord,
  type IntrospectionAuditOutcome,
  type IntrospectionLandmarkRecord,
} from './postgres-store-records.js';

async function selectLandmarkBySource(
  client: PoolClient,
  sourceRef: string,
): Promise<IntrospectionLandmarkRecord | null> {
  const result = await client.query<IntrospectionLandmarkRow>(`
    SELECT
      id, schema_version, source_ref, channel_id, turn_id, occurred_at,
      divergence_type, observation, confidence, companion_reflection,
      consent_revision, consent_hash, stable_estimator_model,
      divergence_auditor_model, companion_reflector_model, provenance_json,
      created_at
    FROM introspection_landmarks
    WHERE source_ref = $1
  `, [sourceRef]);
  return result.rows[0] ? mapLandmarkRow(result.rows[0]) : null;
}

async function selectDecisionBySource(
  client: PoolClient,
  sourceRef: string,
): Promise<IntrospectionAuditDecisionRecord | null> {
  const result = await client.query<IntrospectionAuditDecisionRow>(`
    SELECT
      source_ref, schema_version, outcome, confidence, landmark_id,
      consent_revision, consent_hash, provenance_json, created_at
    FROM introspection_audit_decisions
    WHERE source_ref = $1
  `, [sourceRef]);
  return result.rows[0] ? mapDecisionRow(result.rows[0]) : null;
}

/**
 * Companion-schema Postgres ledger for introspection audit decisions and the
 * resulting private landmarks. The public API contains no mutation or delete
 * operation; database triggers enforce that boundary even for direct SQL.
 */
export class IntrospectionLandmarkPostgresStore implements IntrospectionAuditPersistencePort {
  private constructor(
    private readonly pool: Pool,
    private readonly ownsPool: boolean,
  ) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string } = {},
  ): Promise<IntrospectionLandmarkPostgresStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-introspection-landmarks',
      allowExitOnIdle: true,
      schema: options.schema,
    });
    try {
      await ensurePostgresSchema(pool, POSTGRES_INTROSPECTION_MIGRATIONS);
      return new IntrospectionLandmarkPostgresStore(pool, true);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  static async fromPool(pool: Pool): Promise<IntrospectionLandmarkPostgresStore> {
    await ensurePostgresSchema(pool, POSTGRES_INTROSPECTION_MIGRATIONS);
    return new IntrospectionLandmarkPostgresStore(pool, false);
  }

  /**
   * Atomically append a landmark and its `landmark_created` audit decision.
   * An exact retry returns the original row; a conflicting reuse of the
   * source reference fails closed.
   */
  async appendLandmark(input: IntrospectionLandmarkAppendInput): Promise<IntrospectionLandmarkRecord> {
    const landmark = normalizeLandmarkInput(input);
    return await withPostgresClient(this.pool, async (client) => {
      const inserted = await client.query<IntrospectionLandmarkRow>(`
        INSERT INTO introspection_landmarks (
          id, schema_version, source_ref, channel_id, turn_id, occurred_at,
          divergence_type, observation, confidence, companion_reflection,
          consent_revision, consent_hash, stable_estimator_model,
          divergence_auditor_model, companion_reflector_model, provenance_json,
          created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13,
          $14, $15, $16::jsonb,
          $17
        )
        ON CONFLICT (source_ref) DO NOTHING
        RETURNING
          id, schema_version, source_ref, channel_id, turn_id, occurred_at,
          divergence_type, observation, confidence, companion_reflection,
          consent_revision, consent_hash, stable_estimator_model,
          divergence_auditor_model, companion_reflector_model, provenance_json,
          created_at
      `, [
        landmark.id,
        landmark.schemaVersion,
        landmark.sourceRef,
        landmark.channelId,
        landmark.turnId,
        landmark.occurredAt,
        landmark.divergenceType,
        landmark.observation,
        landmark.confidence,
        landmark.companionReflection,
        landmark.consentRevision,
        landmark.consentHash,
        landmark.stableEstimatorModel,
        landmark.divergenceAuditorModel,
        landmark.companionReflectorModel,
        JSON.stringify(landmark.provenance),
        landmark.createdAt,
      ]);

      const persisted = inserted.rows[0]
        ? mapLandmarkRow(inserted.rows[0])
        : await selectLandmarkBySource(client, landmark.sourceRef);
      if (!persisted || !sameLandmark(persisted, landmark)) {
        throw new Error(
          `Introspection sourceRef ${JSON.stringify(landmark.sourceRef)} already has a different landmark`,
        );
      }

      const expectedDecision: IntrospectionAuditDecisionRecord = {
        schemaVersion: INTROSPECTION_LANDMARK_SCHEMA_VERSION,
        sourceRef: landmark.sourceRef,
        outcome: 'landmark_created',
        confidence: landmark.confidence,
        landmarkId: landmark.id,
        consentRevision: landmark.consentRevision,
        consentHash: landmark.consentHash,
        provenance: landmark.provenance,
        createdAt: landmark.createdAt,
      };
      const insertedDecision = await client.query<IntrospectionAuditDecisionRow>(`
        INSERT INTO introspection_audit_decisions (
          source_ref, schema_version, outcome, confidence, landmark_id,
          consent_revision, consent_hash, provenance_json, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        ON CONFLICT (source_ref) DO NOTHING
        RETURNING
          source_ref, schema_version, outcome, confidence, landmark_id,
          consent_revision, consent_hash, provenance_json, created_at
      `, [
        expectedDecision.sourceRef,
        expectedDecision.schemaVersion,
        expectedDecision.outcome,
        expectedDecision.confidence,
        expectedDecision.landmarkId,
        expectedDecision.consentRevision,
        expectedDecision.consentHash,
        JSON.stringify(expectedDecision.provenance),
        expectedDecision.createdAt,
      ]);
      const persistedDecision = insertedDecision.rows[0]
        ? mapDecisionRow(insertedDecision.rows[0])
        : await selectDecisionBySource(client, landmark.sourceRef);
      if (!persistedDecision || !sameDecision(persistedDecision, expectedDecision)) {
        throw new Error(
          `Introspection sourceRef ${JSON.stringify(landmark.sourceRef)} already has a different audit decision`,
        );
      }
      return persisted;
    });
  }

  /** Append a terminal non-landmark outcome so the scheduler never re-audits it. */
  async appendAuditDecision(
    input: IntrospectionAuditDecisionAppendInput,
  ): Promise<IntrospectionAuditDecisionRecord> {
    const decision = normalizeDecisionInput(input);
    return await withPostgresClient(this.pool, async (client) => {
      const inserted = await client.query<IntrospectionAuditDecisionRow>(`
        INSERT INTO introspection_audit_decisions (
          source_ref, schema_version, outcome, confidence, landmark_id,
          consent_revision, consent_hash, provenance_json, created_at
        ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7::jsonb, $8)
        ON CONFLICT (source_ref) DO NOTHING
        RETURNING
          source_ref, schema_version, outcome, confidence, landmark_id,
          consent_revision, consent_hash, provenance_json, created_at
      `, [
        decision.sourceRef,
        decision.schemaVersion,
        decision.outcome,
        decision.confidence,
        decision.consentRevision,
        decision.consentHash,
        JSON.stringify(decision.provenance),
        decision.createdAt,
      ]);
      const persisted = inserted.rows[0]
        ? mapDecisionRow(inserted.rows[0])
        : await selectDecisionBySource(client, decision.sourceRef);
      if (!persisted || !sameDecision(persisted, decision)) {
        throw new Error(
          `Introspection sourceRef ${JSON.stringify(decision.sourceRef)} already has a different audit decision`,
        );
      }
      return persisted;
    });
  }

  async hasAuditedSource(sourceRef: string): Promise<boolean> {
    const normalizedSourceRef = normalizeIntrospectionSourceRef(sourceRef);
    const row = await queryOne<{ audited: boolean }>(this.pool, `
      SELECT EXISTS (
        SELECT 1 FROM introspection_audit_decisions WHERE source_ref = $1
      ) AS audited
    `, [normalizedSourceRef]);
    if (!row || typeof row.audited !== 'boolean') {
      throw new Error('Postgres returned an invalid introspection audit existence result');
    }
    return row.audited;
  }

  async listLandmarks(limit = 100): Promise<IntrospectionLandmarkRecord[]> {
    if (
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > MAX_INTROSPECTION_LANDMARK_LIST_LIMIT
    ) {
      throw new Error(
        `Introspection landmark list limit must be an integer from 1 to ${MAX_INTROSPECTION_LANDMARK_LIST_LIMIT}`,
      );
    }
    const rows = await queryRows<IntrospectionLandmarkRow>(this.pool, `
      SELECT
        id, schema_version, source_ref, channel_id, turn_id, occurred_at,
        divergence_type, observation, confidence, companion_reflection,
        consent_revision, consent_hash, stable_estimator_model,
        divergence_auditor_model, companion_reflector_model, provenance_json,
        created_at
      FROM introspection_landmarks
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `, [limit]);
    return rows.map(mapLandmarkRow);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
