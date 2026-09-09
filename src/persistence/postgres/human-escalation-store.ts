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
import { POSTGRES_HUMAN_ESCALATION_MIGRATIONS, SHARED_SCHEMA_NAME } from './migrations.js';
import { assertSharedSchemaReady } from './shared-schema.js';
import {
  assertPostgresRelationColumns,
  type PostgresRelationRuntimePrivilege,
} from './relation-contract.js';
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
 * What the opener of the shared fleet ledger actually does with it (bead
 * psfn-framework-2xt9c). The gateway RAISES the fleet's system-owned
 * escalations; a companion's Garden ANSWERS them and never raises there.
 */
export type SharedHumanEscalationStoreAccess = 'answer' | 'raise';

/**
 * The ACLs each access mode's own statements need, proved at readiness.
 *
 * Read off the SQL, not off intent. The answer path updates an escalation and
 * then runs the retention ring over the rows a resolution just made evictable,
 * so it needs DELETE on `human_escalations` — which the previous SELECT+UPDATE
 * proof did not cover. The raise path additionally inserts escalations and
 * inserts, settles, and rings attempt rows. Attempt rows cascade with their
 * escalation, and PostgreSQL runs that referential action with the referencing
 * table's owner privileges, so the answer path needs no DELETE there.
 */
const SHARED_HUMAN_ESCALATION_PRIVILEGES: Readonly<Record<
  SharedHumanEscalationStoreAccess,
  { escalations: readonly PostgresRelationRuntimePrivilege[];
    attempts: readonly PostgresRelationRuntimePrivilege[]; }
>> = Object.freeze({
  answer: Object.freeze({
    escalations: Object.freeze(['SELECT', 'UPDATE', 'DELETE'] as const),
    attempts: Object.freeze(['SELECT'] as const),
  }),
  raise: Object.freeze({
    escalations: Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const),
    attempts: Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const),
  }),
});

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
  /**
   * Attempt keys this store has claimed FOR A CALLER THAT WILL SETTLE THEM, by
   * escalation.
   *
   * The ring below evicts by rank, and a rank cannot see that a row is still
   * being delivered on. Under a burst of concurrent raises against one
   * escalation, the claim that filled the cap would evict a sibling attempt
   * whose sink call is still in flight, and that caller's settle would then
   * fail with "not in the ledger" — turning a delivered notice into an
   * unrecorded one, which is exactly what pages a human twice.
   *
   * This is process-local by construction, and honestly so: it protects the
   * claims THIS store owns. In single-companion mode the gateway and the agent
   * both write this table, so a burst spanning both processes can still evict
   * the other process's in-flight attempt; closing that would need a settled
   * marker column, which is a schema change this bead does not carry.
   */
  private readonly inFlightAttempts = new Map<string, string>();

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

  /**
   * Open the FLEET-WIDE ledger in the shared schema (bead psfn-framework-e5r0s).
   *
   * Runs no DDL, for the same reason its health-stream sibling does not: the
   * shared chain is the migration authority's, and an ordinary runtime
   * credential has DML there but no CREATE. The gateway raises its escalations
   * here — system-owned faults, and companion-owned ones such as a pending
   * confirmation or a quarantine hold that name the companion they concern;
   * each companion's Garden reads and resolves them under its own tenant
   * credential, fenced to system-owned rows plus its own companion's, which is
   * what makes one operator surface able to answer a fault the gateway saw.
   */
  static async connectShared(
    databaseUrl: string,
    options: {
      role?: string;
      access?: SharedHumanEscalationStoreAccess;
      bounds: HumanEscalationLedgerBounds;
      onSaturated?: HumanEscalationLedgerSaturationReporter;
      now?: () => number;
    },
  ): Promise<PostgresHumanEscalationStore> {
    const bounds = requireHumanEscalationLedgerBounds(options.bounds);
    const privileges = SHARED_HUMAN_ESCALATION_PRIVILEGES[options.access ?? 'answer'];
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-fleet-human-escalations',
      allowExitOnIdle: true,
      schema: SHARED_SCHEMA_NAME,
      ...(options.role ? { role: options.role } : {}),
      max: 2,
    });
    try {
      await assertSharedSchemaReady(pool);
      await assertPostgresRelationColumns(pool, {
        schema: SHARED_SCHEMA_NAME,
        relation: 'human_escalations',
        columns: [
          'escalation_id', 'schema_version', 'kind', 'severity', 'owner_kind',
          'dedupe_key', 'source_ref', 'detail_path', 'state', 'raised_at_ms',
          'last_raised_at_ms', 'raise_count',
        ],
        // A companion's Garden must be able to ANSWER a system-owned
        // escalation, not merely read it, or the one place a human resolves
        // things is read-only for exactly the faults nobody else can see.
        privileges: privileges.escalations,
      });
      await assertPostgresRelationColumns(pool, {
        schema: SHARED_SCHEMA_NAME,
        relation: 'human_escalation_attempts',
        columns: ['idempotency_key', 'escalation_id', 'sink', 'outcome', 'attempted_at_ms'],
        privileges: privileges.attempts,
      });
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
  async claimAttempt(
    attempt: HumanEscalationAttempt,
    options: { awaitingSettlement?: boolean } = {},
  ): Promise<HumanEscalationAttemptClaim> {
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
      // Registered BEFORE the prune, so this claim's own ring pass already sees
      // it — and every sibling claim still awaiting its sink — as un-evictable.
      // A caller that claims a terminal outcome settles nothing and registers
      // nothing, so the ring keeps holding those to the cap exactly.
      if (options.awaitingSettlement === true) {
        this.inFlightAttempts.set(attempt.idempotencyKey, attempt.escalationId);
      }
      await this.pruneAttempts(attempt.escalationId);
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
   * Settle a claimed attempt with what the sink actually said, conditional on
   * the row still holding the provisional outcome this caller claimed it with
   * (bead psfn-framework-8nq3h).
   *
   * The row must already exist: settling a key nobody claimed would mean the
   * claim was skipped, which is exactly the path that pages twice. And the
   * `outcome = $3` predicate makes the write a compare-and-set in the database
   * rather than a read-then-write in the process, so a settle that lost a race
   * to a newer one cannot silently demote a proved `delivered` back to the
   * fail-closed provisional value it was claimed with. A missing row and a
   * moved row are distinguished by a second read, so the error names which
   * happened instead of guessing.
   */
  async settleAttempt(input: {
    idempotencyKey: string;
    expectedOutcome: HumanEscalationDeliveryOutcome;
    outcome: HumanEscalationDeliveryOutcome;
  }): Promise<void> {
    try {
      await this.settleClaimedAttempt(input);
    } finally {
      // Released even when the settle throws: the attempt is no longer in
      // flight either way, and a key that stayed registered would exempt a dead
      // row from the ring forever.
      this.inFlightAttempts.delete(input.idempotencyKey);
    }
  }

  private async settleClaimedAttempt(input: {
    idempotencyKey: string;
    expectedOutcome: HumanEscalationDeliveryOutcome;
    outcome: HumanEscalationDeliveryOutcome;
  }): Promise<void> {
    const row = await queryOne<AttemptRow>(this.pool, `
      UPDATE human_escalation_attempts
      SET outcome = $2
      WHERE idempotency_key = $1 AND outcome = $3
      RETURNING idempotency_key, escalation_id, sink, outcome, attempted_at_ms
    `, [input.idempotencyKey, input.outcome, input.expectedOutcome]);
    if (row) return;
    const existing = await this.findAttempt(input.idempotencyKey);
    if (!existing) {
      throw new Error(
        `Human escalation attempt ${input.idempotencyKey} is not in the ledger`,
      );
    }
    throw new Error(
      `Human escalation attempt ${input.idempotencyKey} holds outcome `
      + `${existing.outcome}, not the expected ${input.expectedOutcome}`,
    );
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
    this.inFlightAttempts.clear();
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
    // Ranked by ANSWER time, not raise time. A long-open escalation raised
    // before every row now in the ring is the OLDEST by raise time and the
    // NEWEST by answer time; ranking it by raise time would evict it in the
    // same statement that just recorded a human's decision about it. The
    // column is non-null for every non-open row by CHECK constraint, so this
    // ordering is total over exactly the rows this statement can see.
    await executeQuery(this.pool, `
      DELETE FROM human_escalations
      WHERE escalation_id IN (
        SELECT escalation_id
        FROM human_escalations
        WHERE kind = $1 AND state <> 'open'
        ORDER BY resolved_at_ms DESC, escalation_id DESC
        OFFSET $2
      )
    `, [kind, this.bounds.maxResolvedRowsPerKind]);
    await this.reportSaturation(kind);
  }

  /**
   * The attempt ring, taken where attempts are created rather than on the next
   * raise, so the bound holds exactly rather than one row late.
   *
   * Every attempt this store has claimed and not yet settled is excluded from
   * the candidates by NAME, not by its rank (bead psfn-framework-2xt9c). The
   * key just claimed was the only exclusion before, which held for one raise at
   * a time and broke under a burst: N concurrent claims against one escalation
   * each pruned to the cap, and each one's prune could evict a sibling whose
   * sink call had not answered yet — so that sibling's settle failed with "not
   * in the ledger" and a notice that WAS delivered stopped being recorded.
   *
   * The cap is therefore held against the settled rows only: with `k` attempts
   * in flight the ring keeps `cap - k` of the rest, so a burst wider than the
   * cap leaves the ledger momentarily above it and returns to the cap as the
   * settles land. Overshooting a bound is recoverable; deleting the record of a
   * page that already reached a human is not.
   */
  private async pruneAttempts(escalationId: string): Promise<void> {
    const inFlight = [...this.inFlightAttempts.entries()]
      .filter(([, owner]) => owner === escalationId)
      .map(([key]) => key);
    await executeQuery(this.pool, `
      DELETE FROM human_escalation_attempts
      WHERE idempotency_key IN (
        SELECT idempotency_key
        FROM human_escalation_attempts
        WHERE escalation_id = $1 AND idempotency_key <> ALL($3::text[])
        ORDER BY attempted_at_ms DESC, idempotency_key DESC
        OFFSET $2
      )
    `, [
      escalationId,
      Math.max(0, this.bounds.maxAttemptsPerEscalation - inFlight.length),
      inFlight,
    ]);
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
 * factory pins the tenant scope like its sibling stores.
 *
 * This is the SINGLE-COMPANION path, where both processes resolve to one table
 * and that one table is the whole operator view. A fleet uses
 * {@link createFleetSystemHumanEscalationStore} instead, because there they do
 * not (bead psfn-framework-e5r0s).
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

/**
 * Open the gateway's FLEET-WIDE escalation ledger in the shared schema
 * (bead psfn-framework-e5r0s).
 *
 * Same owner-file bounds and validation as its single-companion sibling; the
 * rows land where every companion's Garden can both read and answer them.
 */
export function createFleetSystemHumanEscalationStore(
  config: { postgresDatabaseUrl?: string },
  options: {
    bounds: HumanEscalationLedgerBounds;
    onSaturated?: HumanEscalationLedgerSaturationReporter;
  },
): Promise<PostgresHumanEscalationStore> {
  const databaseUrl = config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('Fleet system escalation ledger requires config.postgresDatabaseUrl');
  }
  return PostgresHumanEscalationStore.connectShared(databaseUrl, {
    access: 'raise',
    bounds: options.bounds,
    ...(options.onSaturated ? { onSaturated: options.onSaturated } : {}),
  });
}
