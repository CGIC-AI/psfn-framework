// ── Postgres human escalation ledger (bead psfn-framework-bznbn) ──
//
// The durable half of the human escalation control plane. Two properties are
// the whole point of it being durable rather than in-process:
//
//   * A condition a human has already been asked about stays asked. A restart
//     re-reads the open row instead of re-raising every open escalation, which
//     is precisely the alert storm an in-memory-only plane produces during a
//     crash loop.
//   * A delivery attempt that already happened cannot happen twice. The
//     attempts table's PRIMARY KEY is the caller's idempotency key, so the
//     idempotency guarantee is the database's, not a map's.
//
// Every read goes back through `validateHumanEscalationRecord`: a row written
// by a newer schema version, hand-edited, or corrupted fails loudly here rather
// than reaching an operator surface as a half-typed object.
//
// It is also BOUNDED (bead psfn-framework-yu03d), and the shape of that bound
// is the interesting part. The health-event stream beside it is a plain ring:
// every write deletes past the cap, because an observation nobody read is safe
// to lose. A row here is a question this runtime asked a person, so a plain
// ring would silently retract an unanswered question. Every eviction statement
// below therefore carries `state <> 'open'` in its own WHERE clause — an open
// escalation is not merely ranked last, it is structurally not a candidate —
// and the open half is reported onto the health stream rather than trimmed,
// because the only thing that shrinks it is a human answering.

import type { Pool, QueryResultRow } from 'pg';
import {
  createPostgresPool,
  ensurePostgresSchema,
  executeQuery,
  queryOne,
  queryRows,
} from '../postgres.js';
import { POSTGRES_HUMAN_ESCALATION_MIGRATIONS } from './migrations.js';
import { requireSafeInteger as safeInteger } from './row-guards.js';
import {
  HUMAN_ESCALATION_LIMITS,
  HUMAN_ESCALATION_SCHEMA_VERSION,
  HUMAN_ESCALATION_STATES,
  requireHumanEscalationLedgerBounds,
  validateHumanEscalationRecord,
  type HumanEscalationAttempt,
  type HumanEscalationAttemptClaim,
  type HumanEscalationDeliveryOutcome,
  type HumanEscalationFacts,
  type HumanEscalationKind,
  type HumanEscalationLedgerBounds,
  type HumanEscalationLedgerPort,
  type HumanEscalationLedgerSaturation,
  type HumanEscalationListQuery,
  type HumanEscalationRecord,
  type HumanEscalationResolution,
  type HumanEscalationState,
} from '../../shared/escalation/contracts.js';

interface EscalationRow extends QueryResultRow {
  escalation_id: string;
  schema_version: number;
  kind: string;
  severity: string;
  owner_kind: string;
  owner_companion_id: string | null;
  dedupe_key: string;
  source_ref: string;
  detail_path: string;
  labels_json: unknown;
  evidence_json: unknown;
  state: string;
  resolution_reason: string | null;
  resolved_by: string | null;
  resolved_at_ms: string | number | null;
  raised_at_ms: string | number;
  last_raised_at_ms: string | number;
  last_notified_at_ms: string | number | null;
  raise_count: string | number;
}

interface AttemptRow extends QueryResultRow {
  idempotency_key: string;
  escalation_id: string;
  sink: string;
  outcome: string;
  attempted_at_ms: string | number;
}

interface StateCountRow extends QueryResultRow {
  state: string;
  total: string | number;
}

interface OpenCountRow extends QueryResultRow {
  total: string | number;
}

const ESCALATION_COLUMNS = `
  escalation_id, schema_version, kind, severity, owner_kind, owner_companion_id,
  dedupe_key, source_ref, detail_path, labels_json, evidence_json, state,
  resolution_reason, resolved_by, resolved_at_ms, raised_at_ms, last_raised_at_ms,
  last_notified_at_ms, raise_count
`;

function mapEscalationRow(row: EscalationRow): HumanEscalationRecord {
  return validateHumanEscalationRecord({
    schemaVersion: row.schema_version,
    escalationId: row.escalation_id,
    kind: row.kind,
    severity: row.severity,
    owner: row.owner_companion_id === null
      ? { kind: row.owner_kind }
      : { kind: row.owner_kind, companionId: row.owner_companion_id },
    dedupeKey: row.dedupe_key,
    sourceRef: row.source_ref,
    labels: row.labels_json,
    evidence: row.evidence_json,
    detailPath: row.detail_path,
    state: row.state,
    resolution: row.resolution_reason === null
      ? null
      : {
          state: row.state,
          reason: row.resolution_reason,
          actor: row.resolved_by,
          resolvedAtMs: safeInteger(row.resolved_at_ms ?? '', 'resolved_at_ms'),
        },
    raisedAtMs: safeInteger(row.raised_at_ms, 'raised_at_ms'),
    lastRaisedAtMs: safeInteger(row.last_raised_at_ms, 'last_raised_at_ms'),
    lastNotifiedAtMs: row.last_notified_at_ms === null
      ? null
      : safeInteger(row.last_notified_at_ms, 'last_notified_at_ms'),
    raiseCount: safeInteger(row.raise_count, 'raise_count'),
  });
}

function mapAttemptRow(row: AttemptRow): HumanEscalationAttempt {
  return {
    idempotencyKey: row.idempotency_key,
    escalationId: row.escalation_id,
    sink: row.sink as HumanEscalationAttempt['sink'],
    outcome: row.outcome as HumanEscalationAttempt['outcome'],
    attemptedAtMs: safeInteger(row.attempted_at_ms, 'attempted_at_ms'),
  };
}

function normalizeListLimit(limit: number): number {
  if (!Number.isSafeInteger(limit)
    || limit < 1
    || limit > HUMAN_ESCALATION_LIMITS.maxListLimit) {
    throw new Error(
      'Human escalation list limit must be an integer in '
      + `[1, ${String(HUMAN_ESCALATION_LIMITS.maxListLimit)}]`,
    );
  }
  return limit;
}

/**
 * How the ledger reports that it is holding as many unanswered questions of one
 * kind as the owner file admits. Deliberately a callback rather than a health
 * emitter dependency: the store owns storage, and the entrypoint that already
 * knows this process's health-event source owns what a health event looks like.
 */
export type HumanEscalationLedgerSaturationReporter = (
  saturation: HumanEscalationLedgerSaturation,
) => void;

export interface PostgresHumanEscalationStoreOptions {
  schema?: string;
  role?: string;
  /** Owner-file ledger bounds; required, with no built-in fallback. */
  bounds: HumanEscalationLedgerBounds;
  onSaturated?: HumanEscalationLedgerSaturationReporter;
  now?: () => number;
}

export class PostgresHumanEscalationStore implements HumanEscalationLedgerPort {
  private constructor(
    private readonly pool: Pool,
    private readonly bounds: HumanEscalationLedgerBounds,
    private readonly onSaturated: HumanEscalationLedgerSaturationReporter | null,
    private readonly now: () => number,
    private readonly ownsPool: boolean,
  ) {}

  static async connect(
    databaseUrl: string,
    options: PostgresHumanEscalationStoreOptions,
  ): Promise<PostgresHumanEscalationStore> {
    const bounds = requireHumanEscalationLedgerBounds(options.bounds);
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-human-escalations',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    try {
      await ensurePostgresSchema(pool, POSTGRES_HUMAN_ESCALATION_MIGRATIONS);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
    return new PostgresHumanEscalationStore(
      pool,
      bounds,
      options.onSaturated ?? null,
      options.now ?? (() => Date.now()),
      true,
    );
  }

  /** Test/embedding entry point: the caller owns the pool lifecycle. */
  static async fromPool(
    pool: Pool,
    options: Omit<PostgresHumanEscalationStoreOptions, 'schema' | 'role'>,
  ): Promise<PostgresHumanEscalationStore> {
    const bounds = requireHumanEscalationLedgerBounds(options.bounds);
    await ensurePostgresSchema(pool, POSTGRES_HUMAN_ESCALATION_MIGRATIONS);
    return new PostgresHumanEscalationStore(
      pool,
      bounds,
      options.onSaturated ?? null,
      options.now ?? (() => Date.now()),
      false,
    );
  }

  /**
   * One statement, so a concurrent raise from the gateway and the agent about
   * the same condition can never produce two escalations for it. Reopening
   * clears the resolution on purpose: the runtime restating a condition is
   * newer evidence than a human having previously closed it, and an operator
   * seeing it return is the honest outcome.
   */
  async openOrReopen(facts: HumanEscalationFacts): Promise<HumanEscalationRecord> {
    const row = await queryOne<EscalationRow>(this.pool, `
      INSERT INTO human_escalations (
        escalation_id, schema_version, kind, severity, owner_kind, owner_companion_id,
        dedupe_key, source_ref, detail_path, labels_json, evidence_json, state,
        raised_at_ms, last_raised_at_ms, raise_count
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, 'open',
        $11, $11, 1
      )
      ON CONFLICT (kind, dedupe_key) DO UPDATE SET
        severity = EXCLUDED.severity,
        source_ref = EXCLUDED.source_ref,
        detail_path = EXCLUDED.detail_path,
        labels_json = EXCLUDED.labels_json,
        evidence_json = EXCLUDED.evidence_json,
        state = 'open',
        resolution_reason = NULL,
        resolved_by = NULL,
        resolved_at_ms = NULL,
        last_raised_at_ms = GREATEST(human_escalations.last_raised_at_ms, EXCLUDED.last_raised_at_ms),
        raise_count = human_escalations.raise_count + 1
      RETURNING ${ESCALATION_COLUMNS}
    `, [
      HUMAN_ESCALATION_SCHEMA_VERSION,
      facts.kind,
      facts.severity,
      facts.owner.kind,
      facts.owner.kind === 'companion' ? facts.owner.companionId : null,
      facts.dedupeKey,
      facts.sourceRef,
      facts.detailPath,
      JSON.stringify(facts.labels),
      JSON.stringify(facts.evidence),
      facts.raisedAtMs,
    ]);
    if (!row) {
      throw new Error('Human escalation ledger returned no row for an upserted escalation');
    }
    const record = mapEscalationRow(row);
    await this.enforceBounds(record.kind);
    return record;
  }

  async findByCondition(
    kind: HumanEscalationKind,
    dedupeKey: string,
  ): Promise<HumanEscalationRecord | null> {
    const row = await queryOne<EscalationRow>(
      this.pool,
      `SELECT ${ESCALATION_COLUMNS} FROM human_escalations WHERE kind = $1 AND dedupe_key = $2`,
      [kind, dedupeKey],
    );
    return row ? mapEscalationRow(row) : null;
  }

  async findAttempt(idempotencyKey: string): Promise<HumanEscalationAttempt | null> {
    const row = await queryOne<AttemptRow>(
      this.pool,
      `SELECT idempotency_key, escalation_id, sink, outcome, attempted_at_ms
       FROM human_escalation_attempts WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return row ? mapAttemptRow(row) : null;
  }

  /**
   * The PRIMARY KEY is the idempotency guarantee, and this is where it is
   * taken — before a sink is reached, never after. Two overlapping raises about
   * one condition both find no prior attempt and both open the same escalation;
   * exactly one of them wins this insert, and the loser is handed the winner's
   * row instead of a second page.
   *
   * The conflicting row is read back in a SEPARATE statement on purpose. A
   * single `INSERT ... ON CONFLICT DO NOTHING` combined with a `SELECT` in one
   * CTE would evaluate the select against the statement's own snapshot, which
   * cannot see a row the concurrent transaction committed after that snapshot
   * was taken — and would then report neither a claim nor an owner.
   */
  async claimAttempt(attempt: HumanEscalationAttempt): Promise<HumanEscalationAttemptClaim> {
    const claimed = await queryOne<AttemptRow>(this.pool, `
      INSERT INTO human_escalation_attempts (
        idempotency_key, escalation_id, sink, outcome, attempted_at_ms
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key, escalation_id, sink, outcome, attempted_at_ms
    `, [
      attempt.idempotencyKey,
      attempt.escalationId,
      attempt.sink,
      attempt.outcome,
      attempt.attemptedAtMs,
    ]);
    if (claimed) {
      await this.pruneAttempts(attempt.escalationId, attempt.idempotencyKey);
      return { claimed: true };
    }
    const existing = await this.findAttempt(attempt.idempotencyKey);
    if (!existing) {
      throw new Error(
        `Human escalation attempt ${attempt.idempotencyKey} could neither be claimed nor read back`,
      );
    }
    return { claimed: false, existing };
  }

  /**
   * Settle a claimed attempt with what the sink actually said. The row must
   * already exist: settling a key nobody claimed would mean the claim was
   * skipped, which is exactly the path that pages twice.
   */
  async settleAttempt(
    idempotencyKey: string,
    outcome: HumanEscalationDeliveryOutcome,
  ): Promise<void> {
    const row = await queryOne<AttemptRow>(this.pool, `
      UPDATE human_escalation_attempts
      SET outcome = $2
      WHERE idempotency_key = $1
      RETURNING idempotency_key, escalation_id, sink, outcome, attempted_at_ms
    `, [idempotencyKey, outcome]);
    if (!row) {
      throw new Error(`Human escalation attempt ${idempotencyKey} is not in the ledger`);
    }
  }

  async markNotified(escalationId: string, notifiedAtMs: number): Promise<void> {
    const row = await queryOne<EscalationRow>(this.pool, `
      UPDATE human_escalations
      SET last_notified_at_ms = GREATEST(COALESCE(last_notified_at_ms, 0), $2)
      WHERE escalation_id = $1
      RETURNING ${ESCALATION_COLUMNS}
    `, [escalationId, notifiedAtMs]);
    if (!row) {
      throw new Error(`Human escalation ${escalationId} is not in the ledger`);
    }
  }

  async list(query: HumanEscalationListQuery): Promise<HumanEscalationRecord[]> {
    const limit = normalizeListLimit(query.limit);
    const states = query.states === undefined ? null : [...query.states];
    const rows = await queryRows<EscalationRow>(this.pool, `
      SELECT ${ESCALATION_COLUMNS}
      FROM human_escalations
      WHERE $1::text[] IS NULL OR state = ANY($1::text[])
      ORDER BY last_raised_at_ms DESC, escalation_id DESC
      LIMIT $2
    `, [states, limit]);
    return rows.map(mapEscalationRow);
  }

  async countByState(): Promise<Readonly<Record<HumanEscalationState, number>>> {
    const rows = await queryRows<StateCountRow>(
      this.pool,
      'SELECT state, COUNT(*)::bigint AS total FROM human_escalations GROUP BY state',
    );
    const counts: Record<HumanEscalationState, number> = {
      open: 0,
      acknowledged: 0,
      resolved: 0,
      dismissed: 0,
    };
    for (const row of rows) {
      if (!(HUMAN_ESCALATION_STATES as readonly string[]).includes(row.state)) {
        throw new Error(`Human escalation ledger holds an unknown state ${row.state}`);
      }
      counts[row.state as HumanEscalationState] = safeInteger(row.total, 'total');
    }
    return counts;
  }

  async getById(escalationId: string): Promise<HumanEscalationRecord | null> {
    const row = await queryOne<EscalationRow>(
      this.pool,
      `SELECT ${ESCALATION_COLUMNS} FROM human_escalations WHERE escalation_id = $1`,
      [escalationId],
    );
    return row ? mapEscalationRow(row) : null;
  }

  /**
   * Conditional on the state the operator was looking at. Two Garden tabs open
   * on the same escalation cannot both claim it: the second UPDATE matches no
   * row and the caller answers 409 rather than overwriting the first decision.
   */
  async applyResolution(input: {
    escalationId: string;
    expectedState: HumanEscalationState;
    resolution: HumanEscalationResolution;
  }): Promise<HumanEscalationRecord | null> {
    const row = await queryOne<EscalationRow>(this.pool, `
      UPDATE human_escalations
      SET state = $3, resolution_reason = $4, resolved_by = $5, resolved_at_ms = $6
      WHERE escalation_id = $1 AND state = $2
      RETURNING ${ESCALATION_COLUMNS}
    `, [
      input.escalationId,
      input.expectedState,
      input.resolution.state,
      input.resolution.reason,
      input.resolution.actor,
      input.resolution.resolvedAtMs,
    ]);
    if (!row) return null;
    const record = mapEscalationRow(row);
    // An answered escalation is the only thing that ever ENTERS the evictable
    // half, so this is the second and last place the bounds can be crossed.
    await this.enforceBounds(record.kind);
    return record;
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  /**
   * The bound, applied after every write that can grow the ledger.
   *
   * Three statements, and the ordering matters only for cost: expiry first so
   * the per-kind ring has less to rank. Every one of them names
   * `state <> 'open'` (or an attempt row, which belongs to an escalation rather
   * than to a person) in its own WHERE clause. That is the invariant this whole
   * method exists for: an unanswered escalation is not ranked last and spared,
   * it is never selected at all, so no reordering, clock skew, or cap value can
   * make it a deletion candidate. Attempts cascade with their escalation.
   */
  private async enforceBounds(kind: HumanEscalationKind): Promise<void> {
    const cutoffMs = this.now() - this.bounds.resolvedRetentionMs;
    if (cutoffMs > 0) {
      await executeQuery(this.pool, `
        DELETE FROM human_escalations
        WHERE state <> 'open' AND resolved_at_ms IS NOT NULL AND resolved_at_ms < $1
      `, [cutoffMs]);
    }
    await executeQuery(this.pool, `
      DELETE FROM human_escalations
      WHERE escalation_id IN (
        SELECT escalation_id
        FROM human_escalations
        WHERE kind = $1 AND state <> 'open'
        ORDER BY last_raised_at_ms DESC, escalation_id DESC
        OFFSET $2
      )
    `, [kind, this.bounds.maxResolvedRowsPerKind]);
    await this.reportSaturation(kind);
  }

  /**
   * The attempt ring, taken where attempts are created rather than on the next
   * raise, so the bound holds exactly rather than one row late.
   *
   * The key just claimed is excluded from the candidates by name, not by its
   * rank: the caller settles that row once the sink answers, and an eviction
   * racing that settle would turn a delivered notice into "not in the ledger".
   * A claim whose escalation is already at the cap therefore evicts the OLDEST
   * attempt instead of itself, whatever a caller-supplied timestamp claims.
   */
  private async pruneAttempts(escalationId: string, claimedKey: string): Promise<void> {
    await executeQuery(this.pool, `
      DELETE FROM human_escalation_attempts
      WHERE idempotency_key IN (
        SELECT idempotency_key
        FROM human_escalation_attempts
        WHERE escalation_id = $1 AND idempotency_key <> $3
        ORDER BY attempted_at_ms DESC, idempotency_key DESC
        OFFSET $2
      )
    `, [escalationId, Math.max(0, this.bounds.maxAttemptsPerEscalation - 1), claimedKey]);
  }

  /**
   * The open half has no eviction, so the only honest thing to do at the cap is
   * to say so. Content-free by construction: the report carries this kind, the
   * count, and the cap — the same three numbers an operator needs to decide
   * whether to answer some escalations or raise the bound.
   */
  private async reportSaturation(kind: HumanEscalationKind): Promise<void> {
    if (!this.onSaturated) return;
    const row = await queryOne<OpenCountRow>(
      this.pool,
      `SELECT COUNT(*)::bigint AS total FROM human_escalations WHERE kind = $1 AND state = 'open'`,
      [kind],
    );
    const openRows = row ? safeInteger(row.total, 'total') : 0;
    if (openRows < this.bounds.maxOpenRowsPerKind) return;
    this.onSaturated({
      kind,
      openRows,
      maxOpenRowsPerKind: this.bounds.maxOpenRowsPerKind,
    });
  }
}

/**
 * Open the gateway process's escalation ledger from runtime config.
 *
 * Deliberately unpinned to any companion tenant schema, matching the gateway's
 * health stream and every other unconditional gateway store: the gateway
 * credential owns its own default search_path and holds no companion tenant
 * role. Companion-owned escalations are raised by the agent process, whose
 * factory pins the tenant scope like its sibling stores — which is also why the
 * Garden attention surface reads the agent's ledger and says so.
 */
export function createGatewayHumanEscalationStore(
  config: { postgresDatabaseUrl?: string },
  options: {
    bounds: HumanEscalationLedgerBounds;
    onSaturated?: HumanEscalationLedgerSaturationReporter;
  },
): Promise<PostgresHumanEscalationStore> {
  const databaseUrl = config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('Human escalation ledger requires config.postgresDatabaseUrl');
  }
  return PostgresHumanEscalationStore.connect(databaseUrl, {
    bounds: options.bounds,
    ...(options.onSaturated ? { onSaturated: options.onSaturated } : {}),
  });
}
