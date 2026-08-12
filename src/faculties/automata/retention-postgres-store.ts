import type { QueryResult, QueryResultRow } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '../../shared/utils/types.js';
import { requireAutomataClass } from './registry-contract.js';
import type {
  AutomataRetentionAuditEvent,
  AutomataRetentionStorePort,
  AutomataSessionPurgeSurface,
} from './retention-contract.js';
import type {
  AutomataSessionClassification,
  ProtectedSessionOwnership,
  SessionClassification,
} from './session-classification.js';

export interface AutomataRetentionSqlPool {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

interface ClassificationRow extends QueryResultRow {
  companion_id: string;
  session_id: string;
  schema_version: number | string;
  ownership: string;
  classified_at_ms: number | string;
  run_id: string | null;
  automaton_class: string | null;
  worker_generation: number | string | null;
  retention_deadline_ms: number | string | null;
}

interface AuditEventRow extends QueryResultRow {
  companion_id: string;
  event_id: string;
  attempt_id: string;
  schema_version: number | string;
  session_id: string;
  run_id: string;
  automaton_class: string;
  worker_generation: number | string;
  event_kind: string;
  reason: string;
  occurred_at_ms: number | string;
  target_revision: string | null;
  surface_counts_json: unknown;
  preserved_reference_count: number | string | null;
  error_digest: string | null;
}

const classificationColumns = `
  companion_id, session_id, schema_version, ownership, classified_at_ms,
  run_id, automaton_class, worker_generation, retention_deadline_ms
`;

const auditColumns = `
  companion_id, event_id, attempt_id, schema_version, session_id, run_id,
  automaton_class, worker_generation, event_kind, reason, occurred_at_ms,
  target_revision, surface_counts_json, preserved_reference_count, error_digest
`;

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Automata retention row ${field} is invalid`);
  }
  return value.trim();
}

function integer(value: unknown, field: string, minimum = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Automata retention row ${field} is invalid`);
  }
  return parsed;
}

function nullableInteger(value: unknown, field: string): number | undefined {
  return value === null || value === undefined ? undefined : integer(value, field);
}

function protectedOwnership(value: string): ProtectedSessionOwnership {
  switch (value) {
    case 'companion':
    case 'free_time':
    case 'icp':
    case 'contact':
    case 'unknown':
      return value;
    default:
      throw new Error(`Unknown protected session ownership "${value}"`);
  }
}

function auditKind(value: string): AutomataRetentionAuditEvent['kind'] {
  switch (value) {
    case 'retained':
    case 'purge_started':
    case 'purged':
    case 'retryable_failure':
      return value;
    default:
      throw new Error(`Unknown automata retention audit kind "${value}"`);
  }
}

function auditReason(value: string): AutomataRetentionAuditEvent['reason'] {
  switch (value) {
    case 'eligible':
    case 'proof_missing':
    case 'target_mismatch':
    case 'generation_not_terminal':
    case 'run_not_terminal':
    case 'pending_work':
    case 'pending_handoff':
    case 'artifact_custody_pending':
    case 'promotion_receipt_missing':
    case 'review_pending':
    case 'retention_window_open':
    case 'shard_unfolded':
    case 'target_changed':
    case 'evidence_unresolvable':
    case 'purge_incomplete':
    case 'purge_failed':
    case 'already_purged':
      return value;
    default:
      throw new Error(`Unknown automata retention audit reason "${value}"`);
  }
}

function mapClassification(row: ClassificationRow): SessionClassification {
  const companionId = text(row.companion_id, 'companion_id');
  const sessionId = text(row.session_id, 'session_id');
  const classifiedAtMs = integer(row.classified_at_ms, 'classified_at_ms');
  if (integer(row.schema_version, 'schema_version', 1) !== 1) {
    throw new Error('Unknown automata retention classification schema version');
  }
  if (row.ownership !== 'automata') {
    if (
      row.run_id !== null
      || row.automaton_class !== null
      || row.worker_generation !== null
      || row.retention_deadline_ms !== null
    ) {
      throw new Error(`Protected session classification ${sessionId} contains automata fields`);
    }
    return {
      schemaVersion: 1,
      companionId,
      sessionId,
      ownership: protectedOwnership(row.ownership),
      classifiedAtMs,
    };
  }
  if (row.run_id === null || row.automaton_class === null) {
    throw new Error(`Automata session classification ${sessionId} is incomplete`);
  }
  const retentionDeadlineMs = nullableInteger(row.retention_deadline_ms, 'retention_deadline_ms');
  const workerGeneration = nullableInteger(row.worker_generation, 'worker_generation');
  if (retentionDeadlineMs === undefined || workerGeneration === undefined || workerGeneration < 1) {
    throw new Error(`Automata session classification ${sessionId} is incomplete`);
  }
  return {
    schemaVersion: 1,
    companionId,
    sessionId,
    ownership: 'automata',
    runId: text(row.run_id, 'run_id'),
    automatonClass: requireAutomataClass(row.automaton_class),
    workerGeneration,
    classifiedAtMs,
    retentionDeadlineMs,
  };
}

function classificationParams(record: SessionClassification): unknown[] {
  return [
    record.companionId,
    record.sessionId,
    record.schemaVersion,
    record.ownership,
    record.classifiedAtMs,
    record.ownership === 'automata' ? record.runId : null,
    record.ownership === 'automata' ? record.automatonClass : null,
    record.ownership === 'automata' ? record.workerGeneration : null,
    record.ownership === 'automata' ? record.retentionDeadlineMs : null,
  ];
}

function surfaceCounts(value: unknown): Partial<Record<AutomataSessionPurgeSurface, number>> | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Automata retention row surface_counts_json is invalid');
  const counts: Partial<Record<AutomataSessionPurgeSurface, number>> = {};
  for (const [surface, count] of Object.entries(value)) {
    switch (surface) {
      case 'journals':
      case 'journal_rolls':
      case 'channel_index':
      case 'transcript_projection':
      case 'turn_records':
      case 'redis_tail_pointers':
        counts[surface] = integer(count, `surface_counts_json.${surface}`);
        break;
      default:
        throw new Error(`Automata retention row has unknown purge surface "${surface}"`);
    }
  }
  return counts;
}

function mapAuditEvent(row: AuditEventRow): AutomataRetentionAuditEvent {
  const parsedCounts = surfaceCounts(row.surface_counts_json);
  const preservedReferenceCount = nullableInteger(
    row.preserved_reference_count,
    'preserved_reference_count',
  );
  if (integer(row.schema_version, 'schema_version', 1) !== 1) {
    throw new Error('Unknown automata retention audit schema version');
  }
  return {
    schemaVersion: 1,
    eventId: text(row.event_id, 'event_id'),
    attemptId: text(row.attempt_id, 'attempt_id'),
    companionId: text(row.companion_id, 'companion_id'),
    sessionId: text(row.session_id, 'session_id'),
    runId: text(row.run_id, 'run_id'),
    automatonClass: requireAutomataClass(row.automaton_class),
    workerGeneration: integer(row.worker_generation, 'worker_generation', 1),
    kind: auditKind(row.event_kind),
    reason: auditReason(row.reason),
    occurredAtMs: integer(row.occurred_at_ms, 'occurred_at_ms'),
    ...(row.target_revision ? { targetRevision: text(row.target_revision, 'target_revision') } : {}),
    ...(parsedCounts ? { removedCounts: parsedCounts } : {}),
    ...(preservedReferenceCount === undefined ? {} : { preservedReferenceCount }),
    ...(row.error_digest ? { errorDigest: text(row.error_digest, 'error_digest') } : {}),
  };
}

function auditParams(event: AutomataRetentionAuditEvent): unknown[] {
  return [
    event.companionId,
    event.eventId,
    event.attemptId,
    event.schemaVersion,
    event.sessionId,
    event.runId,
    event.automatonClass,
    event.workerGeneration,
    event.kind,
    event.reason,
    event.occurredAtMs,
    event.targetRevision ?? null,
    event.removedCounts ? JSON.stringify(event.removedCounts) : null,
    event.preservedReferenceCount ?? null,
    event.errorDigest ?? null,
  ];
}

/** Durable, append-only Postgres retention classification and audit adapter. */
export class PostgresAutomataRetentionStore implements AutomataRetentionStorePort {
  constructor(private readonly pool: AutomataRetentionSqlPool) {}

  async recordClassification(classification: SessionClassification): Promise<void> {
    const result = await this.pool.query(`
      INSERT INTO automata_session_classifications (${classificationColumns})
      VALUES (${classificationParams(classification).map((_, index) => `$${index + 1}`).join(', ')})
      ON CONFLICT (companion_id, session_id) DO NOTHING
      RETURNING session_id
    `, classificationParams(classification));
    if (result.rowCount === 1) return;
    const current = await this.pool.query<ClassificationRow>(`
      SELECT ${classificationColumns}
      FROM automata_session_classifications
      WHERE companion_id = $1 AND session_id = $2
    `, [classification.companionId, classification.sessionId]);
    const stored = current.rows[0];
    if (!stored || !isDeepStrictEqual(mapClassification(stored), classification)) {
      throw new Error(`Session classification is immutable for ${classification.sessionId}`);
    }
  }

  async listDueAutomataSessions(
    companionId: string,
    nowMs: number,
    limit: number,
  ): Promise<AutomataSessionClassification[]> {
    const result = await this.pool.query<ClassificationRow>(`
      SELECT ${classificationColumns}
      FROM automata_session_classifications AS classification
      WHERE classification.companion_id = $1
        AND classification.ownership = 'automata'
        AND classification.retention_deadline_ms <= $2
        AND NOT EXISTS (
          SELECT 1
          FROM automata_retention_audit_events AS audit
          WHERE audit.companion_id = classification.companion_id
            AND audit.session_id = classification.session_id
            AND audit.event_kind = 'purged'
        )
      ORDER BY classification.retention_deadline_ms, classification.session_id
      LIMIT $3
    `, [companionId, nowMs, limit]);
    return result.rows.map(row => {
      const mapped = mapClassification(row);
      if (mapped.ownership !== 'automata') {
        throw new Error(`Due-retention query returned protected session ${mapped.sessionId}`);
      }
      return mapped;
    });
  }

  async hasPurgeReceipt(companionId: string, sessionId: string): Promise<boolean> {
    const result = await this.pool.query<{ has_receipt: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM automata_retention_audit_events
        WHERE companion_id = $1 AND session_id = $2 AND event_kind = 'purged'
      ) AS has_receipt
    `, [companionId, sessionId]);
    return result.rows[0]?.has_receipt === true;
  }

  async appendAuditEvent(event: AutomataRetentionAuditEvent): Promise<void> {
    auditKind(event.kind);
    auditReason(event.reason);
    requireAutomataClass(event.automatonClass);
    if (event.targetRevision !== undefined) text(event.targetRevision, 'target_revision');
    if (event.removedCounts !== undefined) surfaceCounts(event.removedCounts);
    if (event.errorDigest !== undefined && !/^[0-9a-f]{64}$/u.test(event.errorDigest)) {
      throw new Error('Automata retention audit error_digest is invalid');
    }
    const result = await this.pool.query(`
      INSERT INTO automata_retention_audit_events (${auditColumns})
      VALUES (${auditParams(event).map((_, index) => `$${index + 1}`).join(', ')})
      ON CONFLICT (companion_id, event_id) DO NOTHING
      RETURNING event_id
    `, auditParams(event));
    if (result.rowCount === 1) return;
    const current = await this.pool.query<AuditEventRow>(`
      SELECT ${auditColumns}
      FROM automata_retention_audit_events
      WHERE companion_id = $1 AND event_id = $2
    `, [event.companionId, event.eventId]);
    const stored = current.rows[0];
    if (!stored || !isDeepStrictEqual(mapAuditEvent(stored), event)) {
      throw new Error(`Automata retention audit event ${event.eventId} is immutable`);
    }
  }
}
