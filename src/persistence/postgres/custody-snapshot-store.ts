// ── Postgres per-turn custody snapshot store (psfn-framework-ccgdz.1) ──
//
// Durable home for the disclosure lineage the turn runtime already folds, so
// "which sources were admitted into the context that produced this egress?"
// survives the turn. Keyed by the lineage's own `generationContextRef`
// (`turn:<turnId>`) — no new identifier.
//
// The canonical record is the JSONB document; every read re-validates it
// through `validateCustodySnapshot`, which re-derives the closed vocabularies
// and identifier shapes, so a row edited in the database is a load failure and
// never a quiet custody claim.
//
// FIRST WRITE WINS. A recovered or replayed turn re-folds the same generation
// context at a new instant. Overwriting would replace the fold that actually
// produced the delivered reply with a later reconstruction, and throwing would
// turn a recovery into a turn failure. So the existing row is kept and the
// caller is handed `'duplicate'` (identical content) or `'diverged'` (different
// content) to surface — never swallowed, never overwritten.

import type { Pool, QueryResultRow } from 'pg';

import {
  custodySnapshotContentDigest,
  validateCustodySnapshot,
  type CustodySnapshot,
  type CustodySnapshotRecordOutcome,
  type CustodySnapshotStorePort,
} from '../../core/cogsec/disclosure/custody-snapshot.js';
import { createPostgresPool, ensurePostgresSchema, executeQuery, queryOne } from '../postgres.js';
import { POSTGRES_CUSTODY_SNAPSHOT_MIGRATIONS } from './migrations.js';

interface CustodySnapshotRow extends QueryResultRow {
  snapshot_json: unknown;
  content_sha256: string;
}

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_DAY =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

/**
 * The retention bound is operator-owned only. Booting a custody store without
 * a declared bound is the failure this refuses: an audit trail that grows
 * without an operator-declared horizon is not a bound, and a built-in default
 * would silently become one.
 */
function requireCustodySnapshotRetentionDays(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      'Custody snapshot store requires settings.json custodySnapshotRetentionDays',
    );
  }
  return value;
}

export class PostgresCustodySnapshotStore implements CustodySnapshotStorePort {
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
  ): Promise<PostgresCustodySnapshotStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'custody-snapshots',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    await ensurePostgresSchema(pool, POSTGRES_CUSTODY_SNAPSHOT_MIGRATIONS);
    // Retention is applied on the first write of each UTC day rather than at
    // connect: a store that is never written to has nothing to prune, and
    // startup must not depend on a bulk delete completing.
    return new PostgresCustodySnapshotStore(
      pool,
      true,
      requireCustodySnapshotRetentionDays(retentionDays) * MILLISECONDS_PER_DAY,
      options.now ?? Date.now,
    );
  }

  /** Test/embedding entry point: the caller owns the pool lifecycle. */
  static async fromPool(
    pool: Pool,
    retentionDays: number | undefined,
    options: { now?: () => number } = {},
  ): Promise<PostgresCustodySnapshotStore> {
    await ensurePostgresSchema(pool, POSTGRES_CUSTODY_SNAPSHOT_MIGRATIONS);
    return new PostgresCustodySnapshotStore(
      pool,
      false,
      requireCustodySnapshotRetentionDays(retentionDays) * MILLISECONDS_PER_DAY,
      options.now ?? Date.now,
    );
  }

  async record(snapshot: CustodySnapshot): Promise<CustodySnapshotRecordOutcome> {
    const validated = validateCustodySnapshot(snapshot);
    const contentSha256 = custodySnapshotContentDigest(validated);
    const inserted = await queryOne<CustodySnapshotRow>(this.pool, `
      INSERT INTO custody_snapshots (
        generation_context_ref, turn_id, request_sha256, classification,
        effective_sensitivity, source_count, has_unclassified_source,
        classifier_version, classified_at_ms, content_sha256, snapshot_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      ON CONFLICT (generation_context_ref) DO NOTHING
      RETURNING snapshot_json, content_sha256
    `, [
      validated.generationContextRef,
      validated.turnId,
      validated.requestId.digest,
      validated.classification,
      validated.effectiveSensitivity,
      validated.sourceCount,
      validated.hasUnclassifiedSource,
      validated.classifierVersion,
      validated.classifiedAtMs,
      contentSha256,
      JSON.stringify(validated),
    ]);
    if (inserted) {
      await this.pruneExpiredOncePerDay();
      return 'recorded';
    }
    const existing = await queryOne<CustodySnapshotRow>(
      this.pool,
      'SELECT snapshot_json, content_sha256 FROM custody_snapshots WHERE generation_context_ref = $1',
      [validated.generationContextRef],
    );
    if (!existing) {
      // The row was pruned between the insert attempt and this read. Retention
      // never silently eats a fresh write, so this is a real failure.
      throw new Error(
        `Custody snapshot ${validated.generationContextRef} vanished during recording`,
      );
    }
    return existing.content_sha256 === contentSha256 ? 'duplicate' : 'diverged';
  }

  async getByGenerationContextRef(ref: string): Promise<CustodySnapshot | null> {
    if (ref.trim().length === 0) {
      throw new Error('Custody snapshot store requires a non-empty generation context ref');
    }
    const row = await queryOne<CustodySnapshotRow>(
      this.pool,
      'SELECT snapshot_json, content_sha256 FROM custody_snapshots WHERE generation_context_ref = $1',
      [ref],
    );
    return row ? validateCustodySnapshot(row.snapshot_json) : null;
  }

  /**
   * Apply the operator-owned retention bound. Time-based rather than a row cap
   * so a busy hour cannot silently truncate an older audit trail (design §5).
   */
  async pruneExpired(): Promise<number> {
    const nowMs = this.now();
    this.lastPrunedDayBucket = Math.floor(nowMs / MILLISECONDS_PER_DAY);
    const result = await executeQuery(
      this.pool,
      'DELETE FROM custody_snapshots WHERE classified_at_ms < $1',
      [nowMs - this.retentionMs],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Retention is a horizon, not a per-write sweep: pruning once per UTC day is
   * enough to hold the bound and keeps the turn's hot path free of a delete on
   * every write. The bucket is a unit conversion, not a tuning value.
   */
  private async pruneExpiredOncePerDay(): Promise<void> {
    const dayBucket = Math.floor(this.now() / MILLISECONDS_PER_DAY);
    if (this.lastPrunedDayBucket === dayBucket) return;
    await this.pruneExpired();
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
