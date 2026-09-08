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

import type { Pool, QueryResultRow } from 'pg';
import {
  createPostgresPool,
  ensurePostgresSchema,
  queryOne,
  queryRows,
} from '../postgres.js';
import { POSTGRES_HUMAN_ESCALATION_MIGRATIONS } from './migrations.js';
import { requireSafeInteger as safeInteger } from './row-guards.js';
import {
  HUMAN_ESCALATION_LIMITS,
  HUMAN_ESCALATION_SCHEMA_VERSION,
  HUMAN_ESCALATION_STATES,
  validateHumanEscalationRecord,
  type HumanEscalationAttempt,
  type HumanEscalationAttemptClaim,
  type HumanEscalationDeliveryOutcome,
  type HumanEscalationFacts,
  type HumanEscalationKind,
  type HumanEscalationLedgerPort,
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

export class PostgresHumanEscalationStore implements HumanEscalationLedgerPort {
  private constructor(private readonly pool: Pool, private readonly ownsPool: boolean) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string; role?: string } = {},
  ): Promise<PostgresHumanEscalationStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-human-escalations',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    await ensurePostgresSchema(pool, POSTGRES_HUMAN_ESCALATION_MIGRATIONS);
    return new PostgresHumanEscalationStore(pool, true);
  }

  /** Test/embedding entry point: the caller owns the pool lifecycle. */
  static async fromPool(pool: Pool): Promise<PostgresHumanEscalationStore> {
    await ensurePostgresSchema(pool, POSTGRES_HUMAN_ESCALATION_MIGRATIONS);
    return new PostgresHumanEscalationStore(pool, false);
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
    return mapEscalationRow(row);
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
    if (claimed) return { claimed: true };
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
    return row ? mapEscalationRow(row) : null;
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
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
export function createGatewayHumanEscalationStore(config: {
  postgresDatabaseUrl?: string;
}): Promise<PostgresHumanEscalationStore> {
  const databaseUrl = config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('Human escalation ledger requires config.postgresDatabaseUrl');
  }
  return PostgresHumanEscalationStore.connect(databaseUrl);
}
