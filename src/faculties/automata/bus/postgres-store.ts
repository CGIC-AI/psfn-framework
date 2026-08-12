import type { Pool } from 'pg';

import {
  SENSITIVITY_LEVELS,
  sensitivityAtMost,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import { isRecord } from '../../../shared/utils/types.js';
import {
  parseAutomataBusEvent,
  validateAutomataBusHistory,
  type AutomataBusEvent,
} from './contract.js';
import {
  projectAutomataBusCurrentState,
  type AutomataBusCurrentState,
  type AutomataBusEffectiveFinding,
} from './current-state.js';

export const AUTOMATA_BUS_AUDIENCES = ['eligible-automata', 'operator'] as const;
export type AutomataBusAudience = typeof AUTOMATA_BUS_AUDIENCES[number];

export interface AutomataBusSqlQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface AutomataBusSqlQueryable {
  query<Row>(text: string, values?: unknown[]): Promise<AutomataBusSqlQueryResult<Row>>;
}

export interface AutomataBusSqlClient extends AutomataBusSqlQueryable {
  release(): void;
}

export interface AutomataBusSqlPool extends AutomataBusSqlQueryable {
  connect(): Promise<AutomataBusSqlClient>;
}

export interface AppendAutomataBusEventInput {
  companionId: string;
  event: unknown;
  audiences: readonly AutomataBusAudience[];
  sensitivity: SensitivityLevel;
}

export interface AppendAutomataBusEventResult {
  event: AutomataBusEvent;
  inserted: boolean;
}

export interface AppendAllocatedAutomataBusEventInput {
  companionId: string;
  eventId: string;
  createEvent(sequence: number): unknown;
  audiences: readonly AutomataBusAudience[];
  sensitivity: SensitivityLevel;
}

export interface PostgresAutomataBusStoreOptions {
  /** Called inside the append transaction, after an idempotent replay check. */
  authorizeAppend?: (event: AutomataBusEvent) => Promise<void> | void;
}

export interface AutomataBusReadScope {
  companionId: string;
  audience: AutomataBusAudience;
  maxSensitivity: SensitivityLevel;
}

export interface AutomataBusCurrentFindingReadScope extends AutomataBusReadScope {
  eventIds: readonly string[];
}

export interface PersistedAutomataBusCurrentFinding {
  effectiveFinding: AutomataBusEffectiveFinding;
  audiences: readonly AutomataBusAudience[];
  sensitivity: SensitivityLevel;
}

interface AutomataBusEventRow {
  companion_id: unknown;
  event_id: unknown;
  sequence: unknown;
  audiences: unknown;
  sensitivity: unknown;
  event_json: unknown;
}

interface ParsedAutomataBusEventRow {
  companionId: string;
  eventId: string;
  sequence: number;
  audiences: AutomataBusAudience[];
  sensitivity: SensitivityLevel;
  event: AutomataBusEvent;
}

const APPEND_INPUT_KEYS = new Set(['companionId', 'event', 'audiences', 'sensitivity']);
const ALLOCATED_APPEND_INPUT_KEYS = new Set([
  'companionId',
  'eventId',
  'createEvent',
  'audiences',
  'sensitivity',
]);
const READ_SCOPE_KEYS = new Set(['companionId', 'audience', 'maxSensitivity']);
const CURRENT_FINDING_READ_SCOPE_KEYS = new Set([
  'companionId',
  'audience',
  'maxSensitivity',
  'eventIds',
]);

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function isAudience(value: unknown): value is AutomataBusAudience {
  return typeof value === 'string'
    && AUTOMATA_BUS_AUDIENCES.some(candidate => candidate === value);
}

function isSensitivity(value: unknown): value is SensitivityLevel {
  return typeof value === 'string'
    && SENSITIVITY_LEVELS.some(candidate => candidate === value);
}

function parseAudiences(value: unknown, label: string): AutomataBusAudience[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isAudience)) {
    throw new Error(`${label} must be a non-empty array of supported audiences`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return [...value].sort();
}

function positiveSafeInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function acceptedEvent(value: unknown, label: string): AutomataBusEvent {
  const parsed = parseAutomataBusEvent(value);
  if (parsed.status !== 'accepted') {
    throw new Error(`${label} ${parsed.status}: ${parsed.issues.join('; ')}`);
  }
  return parsed.value;
}

function parseEventRow(value: unknown): ParsedAutomataBusEventRow {
  if (!isRecord(value)) throw new Error('Invalid Automata Bus event row');
  const row = value as unknown as AutomataBusEventRow;
  const companionId = requireNonEmptyString(row.companion_id, 'Automata Bus row companion_id');
  const eventId = requireNonEmptyString(row.event_id, 'Automata Bus row event_id');
  const sequence = positiveSafeInteger(row.sequence, 'Automata Bus row sequence');
  const audiences = parseAudiences(row.audiences, 'Automata Bus row audiences');
  if (!isSensitivity(row.sensitivity)) throw new Error('Invalid Automata Bus row sensitivity');
  const event = acceptedEvent(row.event_json, 'Invalid persisted Automata Bus event');
  if (
    event.companionId !== companionId
    || event.eventId !== eventId
    || event.sequence !== sequence
  ) {
    throw new Error('Automata Bus row authority columns disagree with event_json');
  }
  return { companionId, eventId, sequence, audiences, sensitivity: row.sensitivity, event };
}

function parseAppendInput(input: AppendAutomataBusEventInput): {
  companionId: string;
  event: AutomataBusEvent;
  audiences: AutomataBusAudience[];
  sensitivity: SensitivityLevel;
} {
  if (!isRecord(input)) throw new Error('Automata Bus append input must be an object');
  assertExactKeys(input, APPEND_INPUT_KEYS, 'Automata Bus append input');
  const companionId = requireNonEmptyString(input.companionId, 'companionId');
  const event = acceptedEvent(input.event, 'Automata Bus event');
  if (event.companionId !== companionId) {
    throw new Error('Automata Bus event companionId does not match the append scope');
  }
  const audiences = parseAudiences(input.audiences, 'audiences');
  if (!isSensitivity(input.sensitivity)) throw new Error('sensitivity must be a supported level');
  return { companionId, event, audiences, sensitivity: input.sensitivity };
}

function parseAllocatedAppendInput(input: AppendAllocatedAutomataBusEventInput): {
  companionId: string;
  eventId: string;
  createEvent: (sequence: number) => unknown;
  audiences: AutomataBusAudience[];
  sensitivity: SensitivityLevel;
} {
  if (!isRecord(input)) throw new Error('Automata Bus allocated append input must be an object');
  assertExactKeys(input, ALLOCATED_APPEND_INPUT_KEYS, 'Automata Bus allocated append input');
  const companionId = requireNonEmptyString(input.companionId, 'companionId');
  const eventId = requireNonEmptyString(input.eventId, 'eventId');
  if (typeof input.createEvent !== 'function') throw new Error('createEvent must be a function');
  const audiences = parseAudiences(input.audiences, 'audiences');
  if (!isSensitivity(input.sensitivity)) throw new Error('sensitivity must be a supported level');
  return {
    companionId,
    eventId,
    createEvent: input.createEvent,
    audiences,
    sensitivity: input.sensitivity,
  };
}

function parseReadScope(input: AutomataBusReadScope): AutomataBusReadScope {
  if (!isRecord(input)) throw new Error('Automata Bus read scope must be an object');
  assertExactKeys(input, READ_SCOPE_KEYS, 'Automata Bus read scope');
  const companionId = requireNonEmptyString(input.companionId, 'companionId');
  if (!isAudience(input.audience)) throw new Error('audience must be supported');
  if (!isSensitivity(input.maxSensitivity)) throw new Error('maxSensitivity must be supported');
  return { companionId, audience: input.audience, maxSensitivity: input.maxSensitivity };
}

function parseCurrentFindingReadScope(
  input: AutomataBusCurrentFindingReadScope,
): AutomataBusCurrentFindingReadScope {
  if (!isRecord(input)) throw new Error('Automata Bus current-finding read scope must be an object');
  assertExactKeys(input, CURRENT_FINDING_READ_SCOPE_KEYS, 'Automata Bus current-finding read scope');
  const companionId = requireNonEmptyString(input.companionId, 'companionId');
  if (!isAudience(input.audience)) throw new Error('audience must be supported');
  if (!isSensitivity(input.maxSensitivity)) throw new Error('maxSensitivity must be supported');
  if (!Array.isArray(input.eventIds)) throw new Error('eventIds must be an array');
  const eventIds = input.eventIds.map((eventId, index) => (
    requireNonEmptyString(eventId, `eventIds[${index}]`)
  ));
  if (new Set(eventIds).size !== eventIds.length) throw new Error('eventIds must not contain duplicates');
  return {
    companionId,
    audience: input.audience,
    maxSensitivity: input.maxSensitivity,
    eventIds: [...eventIds].sort(),
  };
}

function samePersistedEvent(
  row: ParsedAutomataBusEventRow,
  event: AutomataBusEvent,
  audiences: readonly AutomataBusAudience[],
  sensitivity: SensitivityLevel,
): boolean {
  return JSON.stringify(row.event) === JSON.stringify(event)
    && JSON.stringify(row.audiences) === JSON.stringify(audiences)
    && row.sensitivity === sensitivity;
}

async function withTransaction<T>(
  pool: AutomataBusSqlPool,
  operation: (client: AutomataBusSqlClient) => Promise<T>,
  beginStatement = 'BEGIN',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(beginStatement);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Automata Bus append failed and transaction rollback also failed',
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

function requireValidHistoryRows(rows: readonly unknown[]): ParsedAutomataBusEventRow[] {
  const parsedRows = rows.map(parseEventRow);
  const events = parsedRows.map(row => row.event);
  const validated = validateAutomataBusHistory(events);
  if (validated.status !== 'accepted') {
    throw new Error(`Invalid persisted Automata Bus history (${validated.status}): ${validated.issues.join('; ')}`);
  }
  return parsedRows;
}

function effectiveFindingFromProjectionRow(row: ParsedAutomataBusEventRow): AutomataBusEffectiveFinding {
  const { event } = row;
  if (event.type === 'finding') {
    return {
      eventId: event.eventId,
      companionId: event.companionId,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      context: event.context,
      body: event.body,
      sourceEventType: 'finding',
    };
  }
  if (event.body.relation === 'retracts' || event.body.replacement === undefined) {
    throw new Error('Automata Bus current projection contains a relation without a replacement finding');
  }
  return {
    eventId: event.eventId,
    companionId: event.companionId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    context: event.context,
    body: event.body.replacement,
    sourceEventType: 'relation',
  };
}

function assertProjectionMatches(
  persisted: readonly AutomataBusEffectiveFinding[],
  reconstructed: readonly AutomataBusEffectiveFinding[],
): void {
  if (JSON.stringify(persisted) !== JSON.stringify(reconstructed)) {
    throw new Error('Automata Bus current projection does not match immutable history');
  }
}

function assertRowWithinScope(
  row: ParsedAutomataBusEventRow,
  scope: AutomataBusReadScope,
): void {
  if (
    row.companionId !== scope.companionId
    || !row.audiences.includes(scope.audience)
    || !sensitivityAtMost(row.sensitivity, scope.maxSensitivity)
  ) {
    throw new Error('Automata Bus database returned a row outside the requested visibility scope');
  }
}

export class PostgresAutomataBusStore {
  constructor(
    private readonly pool: AutomataBusSqlPool,
    private readonly options: PostgresAutomataBusStoreOptions = {},
  ) {}

  async append(input: AppendAutomataBusEventInput): Promise<AppendAutomataBusEventResult> {
    const { companionId, event, audiences, sensitivity } = parseAppendInput(input);
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [companionId]);
      const incumbent = await client.query<AutomataBusEventRow>(`
        SELECT companion_id, event_id, sequence, audiences, sensitivity, event_json
        FROM automata_bus_events
        WHERE companion_id = $1 AND event_id = $2
        FOR UPDATE
      `, [companionId, event.eventId]);
      return await this.appendLocked(client, {
        companionId,
        event,
        audiences,
        sensitivity,
      }, incumbent.rows[0]);
    });
  }

  /**
   * Allocates the canonical sequence and constructs the event while holding the
   * same companion-scoped database lock used for validation and persistence.
   */
  async appendAllocated(
    input: AppendAllocatedAutomataBusEventInput,
  ): Promise<AppendAutomataBusEventResult> {
    const { companionId, eventId, createEvent, audiences, sensitivity } =
      parseAllocatedAppendInput(input);
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [companionId]);
      const incumbent = await client.query<AutomataBusEventRow>(`
        SELECT companion_id, event_id, sequence, audiences, sensitivity, event_json
        FROM automata_bus_events
        WHERE companion_id = $1 AND event_id = $2
        FOR UPDATE
      `, [companionId, eventId]);
      const incumbentRow = incumbent.rows[0];
      const sequence = incumbentRow
        ? parseEventRow(incumbentRow).sequence
        : await this.nextSequenceLocked(client, companionId);
      const event = acceptedEvent(createEvent(sequence), 'Automata Bus allocated event');
      if (
        event.companionId !== companionId
        || event.eventId !== eventId
        || event.sequence !== sequence
      ) {
        throw new Error('Automata Bus allocated event identity does not match its locked allocation');
      }
      return await this.appendLocked(client, {
        companionId,
        event,
        audiences,
        sensitivity,
      }, incumbentRow);
    });
  }

  private async nextSequenceLocked(
    client: AutomataBusSqlClient,
    companionId: string,
  ): Promise<number> {
    const next = await client.query<{ next_sequence: unknown }>(`
      SELECT (COALESCE(MAX(sequence), 0) + 1)::bigint AS next_sequence
      FROM automata_bus_events
      WHERE companion_id = $1
    `, [companionId]);
    return positiveSafeInteger(next.rows[0]?.next_sequence, 'Automata Bus next sequence');
  }

  private async appendLocked(
    client: AutomataBusSqlClient,
    input: {
      companionId: string;
      event: AutomataBusEvent;
      audiences: AutomataBusAudience[];
      sensitivity: SensitivityLevel;
    },
    incumbentRow: AutomataBusEventRow | undefined,
  ): Promise<AppendAutomataBusEventResult> {
    const { companionId, event, audiences, sensitivity } = input;
    if (incumbentRow) {
      const existing = parseEventRow(incumbentRow);
      if (!samePersistedEvent(existing, event, audiences, sensitivity)) {
        throw new Error(`Automata Bus eventId ${event.eventId} was reused with different content`);
      }
      return { event: existing.event, inserted: false };
    }

    await this.options.authorizeAppend?.(event);

      const historyRows = await client.query<AutomataBusEventRow>(`
        SELECT companion_id, event_id, sequence, audiences, sensitivity, event_json
        FROM automata_bus_events
        WHERE companion_id = $1
        ORDER BY sequence ASC
        FOR UPDATE
      `, [companionId]);
      const historyRowsParsed = requireValidHistoryRows(historyRows.rows);
      const history = historyRowsParsed.map(row => row.event);
      const candidateHistory = validateAutomataBusHistory([...history, event]);
      if (candidateHistory.status !== 'accepted') {
        throw new Error(`Automata Bus append rejected: ${candidateHistory.issues.join('; ')}`);
      }
      if (event.type === 'relation') {
        const target = historyRowsParsed.find(row => row.eventId === event.body.targetEventId);
        if (
          target === undefined
          || target.sensitivity !== sensitivity
          || JSON.stringify(target.audiences) !== JSON.stringify(audiences)
        ) {
          throw new Error('Automata Bus relation visibility must exactly match its target');
        }
      }

      const inserted = await client.query<AutomataBusEventRow>(`
        INSERT INTO automata_bus_events (
          companion_id, event_id, sequence, schema_version, occurred_at, event_type,
          automaton_class, run_id, task_id, parent_run_id, audiences, sensitivity, event_json
        ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11::text[], $12, $13::jsonb)
        RETURNING companion_id, event_id, sequence, audiences, sensitivity, event_json
      `, [
        companionId,
        event.eventId,
        event.sequence,
        event.schemaVersion,
        event.occurredAt,
        event.type,
        event.context.automatonClass,
        event.context.runId,
        event.context.taskId,
        event.context.parentRunId ?? null,
        audiences,
        sensitivity,
        event,
      ]);
      if (inserted.rowCount !== 1 || inserted.rows.length !== 1) {
        throw new Error('Automata Bus append did not insert exactly one event');
      }
      if (event.type === 'relation') {
        const deleted = await client.query<AutomataBusEventRow>(`
          DELETE FROM automata_bus_current_findings
          WHERE companion_id = $1 AND event_id = $2
          RETURNING companion_id, event_id, sequence, audiences, sensitivity, event_json
        `, [companionId, event.body.targetEventId]);
        if (deleted.rowCount !== 1) {
          throw new Error('Automata Bus current projection target was not current');
        }
      }
      if (event.type === 'finding' || event.body.relation !== 'retracts') {
        const current = await client.query<AutomataBusEventRow>(`
          INSERT INTO automata_bus_current_findings (
            companion_id, event_id, sequence, audiences, sensitivity, event_json
          ) VALUES ($1, $2, $3, $4::text[], $5, $6::jsonb)
          RETURNING companion_id, event_id, sequence, audiences, sensitivity, event_json
        `, [companionId, event.eventId, event.sequence, audiences, sensitivity, event]);
        if (current.rowCount !== 1) {
          throw new Error('Automata Bus append did not materialize exactly one current finding');
        }
      }
      return { event: parseEventRow(inserted.rows[0]).event, inserted: true };
  }

  async readHistory(input: AutomataBusReadScope): Promise<AutomataBusEvent[]> {
    const scope = parseReadScope(input);
    return this.readHistoryFrom(this.pool, scope);
  }

  private async readHistoryFrom(
    queryable: AutomataBusSqlQueryable,
    scope: AutomataBusReadScope,
  ): Promise<AutomataBusEvent[]> {
    const allowedSensitivities = SENSITIVITY_LEVELS.filter(level => (
      sensitivityAtMost(level, scope.maxSensitivity)
    ));
    const rows = await queryable.query<AutomataBusEventRow>(`
      SELECT companion_id, event_id, sequence, audiences, sensitivity, event_json
      FROM automata_bus_events
      WHERE companion_id = $1
        AND $2 = ANY(audiences)
        AND sensitivity = ANY($3::text[])
      ORDER BY sequence ASC
    `, [scope.companionId, scope.audience, allowedSensitivities]);
    const parsedRows = requireValidHistoryRows(rows.rows);
    parsedRows.forEach(row => assertRowWithinScope(row, scope));
    return parsedRows.map(row => row.event);
  }

  async readCurrentFindingsByEventIds(
    input: AutomataBusCurrentFindingReadScope,
  ): Promise<PersistedAutomataBusCurrentFinding[]> {
    const scope = parseCurrentFindingReadScope(input);
    if (scope.eventIds.length === 0) return [];
    const allowedSensitivities = SENSITIVITY_LEVELS.filter(level => (
      sensitivityAtMost(level, scope.maxSensitivity)
    ));
    const rows = await this.pool.query<AutomataBusEventRow>(`
      SELECT companion_id, event_id, sequence, audiences, sensitivity, event_json
      FROM automata_bus_current_findings
      WHERE companion_id = $1
        AND event_id = ANY($2::text[])
        AND $3 = ANY(audiences)
        AND sensitivity = ANY($4::text[])
      ORDER BY sequence ASC
    `, [scope.companionId, scope.eventIds, scope.audience, allowedSensitivities]);
    return rows.rows.map(parseEventRow).map(row => {
      assertRowWithinScope(row, scope);
      if (!scope.eventIds.includes(row.eventId)) {
        throw new Error('Automata Bus database returned an unrequested current finding');
      }
      return {
        effectiveFinding: effectiveFindingFromProjectionRow(row),
        audiences: row.audiences,
        sensitivity: row.sensitivity,
      };
    });
  }

  async readCurrentState(input: AutomataBusReadScope): Promise<AutomataBusCurrentState> {
    const scope = parseReadScope(input);
    const allowedSensitivities = SENSITIVITY_LEVELS.filter(level => (
      sensitivityAtMost(level, scope.maxSensitivity)
    ));
    return withTransaction(this.pool, async (client) => {
      const history = await this.readHistoryFrom(client, scope);
      const currentRows = await client.query<AutomataBusEventRow>(`
        SELECT companion_id, event_id, sequence, audiences, sensitivity, event_json
        FROM automata_bus_current_findings
        WHERE companion_id = $1
          AND $2 = ANY(audiences)
          AND sensitivity = ANY($3::text[])
        ORDER BY sequence ASC
      `, [scope.companionId, scope.audience, allowedSensitivities]);
      const reconstructed = projectAutomataBusCurrentState(history);
      const persistedRows = currentRows.rows.map(parseEventRow);
      persistedRows.forEach(row => assertRowWithinScope(row, scope));
      const persisted = persistedRows.map(effectiveFindingFromProjectionRow);
      assertProjectionMatches(persisted, reconstructed.effectiveFindings);
      return { ...reconstructed, effectiveFindings: persisted };
    }, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }
}

export function createPostgresAutomataBusStore(pool: Pool): PostgresAutomataBusStore {
  return new PostgresAutomataBusStore(pool);
}
