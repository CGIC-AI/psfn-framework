import type { Pool, QueryResultRow } from 'pg';
import { isRecord } from '../../shared/utils/types.js';
import {
  AUTOMATA_RUN_OUTCOMES,
  requireAutomataClass,
  requireAutomataRunStatus,
  type AutomataArtifactRef,
  type AutomataRunOutcome,
  type AutomataRunRecord,
  type AutomataRunStatus,
} from '../../faculties/automata/registry-contract.js';
import type { AutomataRunStorePort } from '../../faculties/automata/run-registry.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  queryRows,
} from '../postgres.js';
import { POSTGRES_AUTOMATA_RUN_MIGRATIONS } from './migrations.js';

interface AutomataRunRow extends QueryResultRow {
  companion_id: string;
  run_id: string;
  automaton_class: string;
  worker_id: string;
  worker_generation: number | string;
  task_id: string;
  task_label: string;
  task_summary: string;
  parent_run_id: string | null;
  source_run_id: string | null;
  session_ids_json: unknown;
  artifacts_json: unknown;
  status: string;
  status_reason: string;
  outcome: string | null;
  failure_reason: string | null;
  promotion_state: string;
  fold_state: string;
  created_at_ms: number | string;
  started_at_ms: number | string | null;
  finished_at_ms: number | string | null;
  retention_deadline_ms: number | string;
}

const RUN_COLUMNS = `
  companion_id, run_id, automaton_class, worker_id, worker_generation,
  task_id, task_label, task_summary, parent_run_id, source_run_id,
  session_ids_json, artifacts_json, status, status_reason, outcome, failure_reason,
  promotion_state, fold_state, created_at_ms, started_at_ms, finished_at_ms,
  retention_deadline_ms
`;

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Automata row ${field} is invalid`);
  return value.trim();
}

function integer(value: unknown, field: string, minimum = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`Automata row ${field} is invalid`);
  return parsed;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  return value === null || value === undefined ? undefined : integer(value, field);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Automata row ${field} must be an array`);
  return value.map((entry, index) => text(entry, `${field}[${index}]`));
}

function artifacts(value: unknown): AutomataArtifactRef[] {
  if (!Array.isArray(value)) throw new Error('Automata row artifacts_json must be an array');
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Automata row artifacts_json[${index}] is invalid`);
    const custody = entry.custody;
    if (custody !== 'pending' && custody !== 'durable' && custody !== 'discarded') {
      throw new Error(`Automata row artifacts_json[${index}].custody is invalid`);
    }
    return { kind: text(entry.kind, 'artifact.kind'), ref: text(entry.ref, 'artifact.ref'), custody };
  });
}

function parseOutcome(value: string | null): AutomataRunOutcome | undefined {
  if (value === null) return undefined;
  if (!(AUTOMATA_RUN_OUTCOMES as readonly string[]).includes(value)) {
    throw new Error(`Unknown automata run outcome "${value}".`);
  }
  return value as AutomataRunOutcome;
}

function mapRow(row: AutomataRunRow): AutomataRunRecord {
  const promotionState = row.promotion_state;
  if (!['not_requested', 'pending', 'promoted', 'rejected'].includes(promotionState)) {
    throw new Error(`Unknown automata promotion state "${promotionState}".`);
  }
  const foldState = row.fold_state;
  if (!['not_required', 'pending', 'folded', 'rejected'].includes(foldState)) {
    throw new Error(`Unknown automata fold state "${foldState}".`);
  }
  const outcome = parseOutcome(row.outcome);
  const startedAtMs = optionalInteger(row.started_at_ms, 'started_at_ms');
  const finishedAtMs = optionalInteger(row.finished_at_ms, 'finished_at_ms');
  return {
    companionId: text(row.companion_id, 'companion_id'),
    runId: text(row.run_id, 'run_id'),
    automatonClass: requireAutomataClass(row.automaton_class),
    workerId: text(row.worker_id, 'worker_id'),
    workerGeneration: integer(row.worker_generation, 'worker_generation', 1),
    taskId: text(row.task_id, 'task_id'),
    taskLabel: text(row.task_label, 'task_label'),
    taskSummary: text(row.task_summary, 'task_summary'),
    ...(row.parent_run_id ? { parentRunId: text(row.parent_run_id, 'parent_run_id') } : {}),
    ...(row.source_run_id ? { sourceRunId: text(row.source_run_id, 'source_run_id') } : {}),
    sessionIds: stringArray(row.session_ids_json, 'session_ids_json'),
    artifacts: artifacts(row.artifacts_json),
    status: requireAutomataRunStatus(row.status),
    statusReason: text(row.status_reason, 'status_reason'),
    ...(outcome ? { outcome } : {}),
    ...(row.failure_reason ? { failureReason: text(row.failure_reason, 'failure_reason') } : {}),
    promotionState: promotionState as AutomataRunRecord['promotionState'],
    foldState: foldState as AutomataRunRecord['foldState'],
    createdAtMs: integer(row.created_at_ms, 'created_at_ms'),
    ...(startedAtMs === undefined ? {} : { startedAtMs }),
    ...(finishedAtMs === undefined ? {} : { finishedAtMs }),
    retentionDeadlineMs: integer(row.retention_deadline_ms, 'retention_deadline_ms'),
  };
}

function rowParams(record: AutomataRunRecord): unknown[] {
  return [
    record.companionId,
    record.runId,
    record.automatonClass,
    record.workerId,
    record.workerGeneration,
    record.taskId,
    record.taskLabel,
    record.taskSummary,
    record.parentRunId ?? null,
    record.sourceRunId ?? null,
    JSON.stringify(record.sessionIds),
    JSON.stringify(record.artifacts),
    record.status,
    record.statusReason,
    record.outcome ?? null,
    record.failureReason ?? null,
    record.promotionState,
    record.foldState,
    record.createdAtMs,
    record.startedAtMs ?? null,
    record.finishedAtMs ?? null,
    record.retentionDeadlineMs,
  ];
}

export class PostgresAutomataRunStore implements AutomataRunStorePort {
  private constructor(
    private readonly pool: Pool,
    private readonly companionId: string,
  ) {}

  static async connect(
    databaseUrl: string,
    companionId: string,
    options: { schema?: string; role?: string } = {},
  ): Promise<PostgresAutomataRunStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-automata-run-registry',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    await ensurePostgresSchema(pool, POSTGRES_AUTOMATA_RUN_MIGRATIONS);
    return new PostgresAutomataRunStore(pool, text(companionId, 'companionId'));
  }

  async loadRetained(companionId: string, nowMs: number): Promise<AutomataRunRecord[]> {
    this.assertCompanion(companionId);
    const rows = await queryRows<AutomataRunRow>(this.pool, `
      SELECT ${RUN_COLUMNS}
      FROM automata_runs
      WHERE companion_id = $1 AND retention_deadline_ms > $2
      ORDER BY created_at_ms DESC, run_id ASC
    `, [this.companionId, nowMs]);
    return rows.map(mapRow);
  }

  async insert(record: AutomataRunRecord): Promise<void> {
    this.assertCompanion(record.companionId);
    await this.pool.query(`
      INSERT INTO automata_runs (${RUN_COLUMNS})
      VALUES (${rowParams(record).map((_, index) => `$${index + 1}`).join(', ')})
    `, rowParams(record));
  }

  async update(record: AutomataRunRecord, previousStatus: AutomataRunStatus): Promise<void> {
    this.assertCompanion(record.companionId);
    const result = await this.pool.query(`
      UPDATE automata_runs SET
        automaton_class = $3, worker_id = $4, worker_generation = $5,
        task_id = $6, task_label = $7, task_summary = $8,
        parent_run_id = $9, source_run_id = $10, session_ids_json = $11::jsonb,
        artifacts_json = $12::jsonb, status = $13, status_reason = $14,
        outcome = $15, failure_reason = $16, promotion_state = $17,
        fold_state = $18, created_at_ms = $19, started_at_ms = $20,
        finished_at_ms = $21, retention_deadline_ms = $22
      WHERE companion_id = $1 AND run_id = $2 AND status = $23
    `, [...rowParams(record), previousStatus]);
    if (result.rowCount !== 1) throw new Error(`Automata run "${record.runId}" changed concurrently.`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private assertCompanion(companionId: string): void {
    if (companionId !== this.companionId) throw new Error('Automata run store companion scope mismatch');
  }
}
