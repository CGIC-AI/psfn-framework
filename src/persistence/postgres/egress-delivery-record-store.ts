// ── Postgres egress delivery record store (psfn-framework-ccgdz.6) ──
//
// The sibling of `custody-snapshot-store.ts`. The custody snapshot proves which
// sources were admitted into a generation; this store records what was then
// released — or held — on the strength of that proof, so "which sources
// contributed to this egress?" and "was this egress ever authorized?" survive
// the turn.
//
// The canonical record is the JSONB document; every read re-validates it
// through `validateEgressDeliveryRecord`, so a row edited in the database is a
// load failure and never a quiet delivery claim.
//
// FIRST WRITE WINS on the composite `(generation context, attempt)` key, the
// same posture as custody snapshots: a retried egress attempt must not rewrite
// the decision the bytes actually left under. An identical re-write reports
// `'duplicate'`; a different one reports `'diverged'` for the caller to surface.

import type { Pool, QueryResultRow } from 'pg';

import {
  egressDeliveryRecordContentDigest,
  validateEgressDeliveryRecord,
  type EgressDeliveryRecord,
  type EgressDeliveryRecordOutcome,
  type EgressDeliveryRecordStorePort,
} from '../../core/cogsec/disclosure/egress-delivery-record.js';
import { createPostgresPool, ensurePostgresSchema, executeQuery, queryOne, queryRows } from '../postgres.js';
import { POSTGRES_EGRESS_DELIVERY_RECORD_MIGRATIONS } from './migrations.js';

interface EgressDeliveryRecordRow extends QueryResultRow {
  record_json: unknown;
  record_sha256: string;
}

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_DAY =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

/**
 * Retention is operator-owned only, and it is deliberately the SAME horizon as
 * the custody snapshots (`settings.json` `custodySnapshotRetentionDays`): a
 * delivery record that outlives the snapshot it cites becomes an unresolvable
 * claim, and a snapshot that outlives its deliveries hides what was released.
 */
function requireEgressDeliveryRetentionDays(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      'Egress delivery record store requires settings.json custodySnapshotRetentionDays',
    );
  }
  return value;
}

export class PostgresEgressDeliveryRecordStore implements EgressDeliveryRecordStorePort {
  private lastPrunedDayBucket: number | null = null;

  private constructor(
    private readonly pool: Pool,
    private readonly ownsPool: boolean,
    private readonly retentionMs: number,
    private readonly now: () => number,
  ) {}

  static async connect(
    databaseUrl: string,
    retentionDays: number | undefined,
    options: { schema?: string; role?: string; now?: () => number } = {},
  ): Promise<PostgresEgressDeliveryRecordStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'egress-delivery-records',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    await ensurePostgresSchema(pool, POSTGRES_EGRESS_DELIVERY_RECORD_MIGRATIONS);
    return new PostgresEgressDeliveryRecordStore(
      pool,
      true,
      requireEgressDeliveryRetentionDays(retentionDays) * MILLISECONDS_PER_DAY,
      options.now ?? Date.now,
    );
  }

  /** Test/embedding entry point: the caller owns the pool lifecycle. */
  static async fromPool(
    pool: Pool,
    retentionDays: number | undefined,
    options: { now?: () => number } = {},
  ): Promise<PostgresEgressDeliveryRecordStore> {
    await ensurePostgresSchema(pool, POSTGRES_EGRESS_DELIVERY_RECORD_MIGRATIONS);
    return new PostgresEgressDeliveryRecordStore(
      pool,
      false,
      requireEgressDeliveryRetentionDays(retentionDays) * MILLISECONDS_PER_DAY,
      options.now ?? Date.now,
    );
  }

  async record(record: EgressDeliveryRecord): Promise<EgressDeliveryRecordOutcome> {
    const validated = validateEgressDeliveryRecord(record);
    const recordSha256 = egressDeliveryRecordContentDigest(validated);
    // Prune BEFORE the insert so a failing retention sweep cannot surface as a
    // failed write after the row is already committed, which would make a
    // recorded egress read as unrecorded.
    await this.pruneExpiredOncePerDay();
    const inserted = await queryOne<EgressDeliveryRecordRow>(this.pool, `
      INSERT INTO egress_delivery_records (
        delivery_ref, generation_context_ref, turn_id, owner_kind, owner_companion_id,
        surface, disposition, enforcement_posture, attempt_sha256, content_sha256,
        destination_kind, outcome, decision_allowed, hold_reason, custody_snapshot_ref,
        source_count, has_unclassified_source, effective_sensitivity, recorded_at_ms,
        record_sha256, record_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb
      )
      ON CONFLICT (delivery_ref) DO NOTHING
      RETURNING record_json, record_sha256
    `, [
      validated.deliveryRef,
      validated.generationContextRef,
      validated.turnId,
      validated.owner.kind,
      validated.owner.kind === 'companion' ? validated.owner.companionId : null,
      validated.surface,
      validated.disposition,
      validated.enforcementPosture,
      validated.attempt.digest,
      validated.contentSha256,
      validated.destination?.kind ?? null,
      validated.outcome,
      validated.decisionAllowed,
      validated.holdReason ?? null,
      validated.custodySnapshotRef ?? null,
      validated.sourceCount,
      validated.hasUnclassifiedSource,
      validated.effectiveSensitivity,
      validated.recordedAtMs,
      recordSha256,
      JSON.stringify(validated),
    ]);
    if (inserted) return 'recorded';
    const existing = await queryOne<EgressDeliveryRecordRow>(
      this.pool,
      'SELECT record_json, record_sha256 FROM egress_delivery_records WHERE delivery_ref = $1',
      [validated.deliveryRef],
    );
    if (!existing) {
      // The row was pruned between the insert attempt and this read. Retention
      // never silently eats a fresh write, so this is a real failure.
      throw new Error(
        `Egress delivery record ${validated.deliveryRef} vanished during recording`,
      );
    }
    return existing.record_sha256 === recordSha256 ? 'duplicate' : 'diverged';
  }

  async getByDeliveryRef(deliveryRef: string): Promise<EgressDeliveryRecord | null> {
    if (deliveryRef.trim().length === 0) {
      throw new Error('Egress delivery record store requires a non-empty delivery ref');
    }
    const row = await queryOne<EgressDeliveryRecordRow>(
      this.pool,
      'SELECT record_json, record_sha256 FROM egress_delivery_records WHERE delivery_ref = $1',
      [deliveryRef],
    );
    return row ? validateEgressDeliveryRecord(row.record_json) : null;
  }

  async listByGenerationContextRef(ref: string): Promise<readonly EgressDeliveryRecord[]> {
    if (ref.trim().length === 0) {
      throw new Error('Egress delivery record store requires a non-empty generation context ref');
    }
    const rows = await queryRows<EgressDeliveryRecordRow>(
      this.pool,
      `SELECT record_json, record_sha256 FROM egress_delivery_records
       WHERE generation_context_ref = $1
       ORDER BY recorded_at_ms ASC, delivery_ref ASC`,
      [ref],
    );
    return rows.map(row => validateEgressDeliveryRecord(row.record_json));
  }

  /** Time-based retention, matching the custody snapshots' own horizon. */
  async pruneExpired(): Promise<number> {
    const nowMs = this.now();
    this.lastPrunedDayBucket = Math.floor(nowMs / MILLISECONDS_PER_DAY);
    const result = await executeQuery(
      this.pool,
      'DELETE FROM egress_delivery_records WHERE recorded_at_ms < $1',
      [nowMs - this.retentionMs],
    );
    return result.rowCount ?? 0;
  }

  private async pruneExpiredOncePerDay(): Promise<void> {
    const dayBucket = Math.floor(this.now() / MILLISECONDS_PER_DAY);
    if (this.lastPrunedDayBucket === dayBucket) return;
    await this.pruneExpired();
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
