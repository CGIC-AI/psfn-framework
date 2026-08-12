import {
  SENSITIVITY_LEVELS,
} from '../../../system/trust/types.js';
import {
  parseAutomataBusEvent,
  type AutomataBusEvent,
  type AutomataBusVerificationStatus,
} from '../../../faculties/automata/bus/contract.js';
import type {
  AutomataBusDisposition,
  AutomataBusEffectiveFinding,
} from '../../../faculties/automata/bus/current-state.js';
import {
  automataBusCurrentVerificationStatusSql,
  createAutomataBusPostgresParameters,
  requireAutomataBusNonEmptyString,
  requireAutomataBusPositiveInteger,
} from '../../../faculties/automata/bus/postgres-query-sql.js';
import type {
  AutomataBusSqlPool,
} from '../../../faculties/automata/bus/postgres-store.js';
import type {
  AutomataBusVectorIndexPort,
  AutomataBusVectorIndexState,
} from '../../../faculties/automata/bus/query-ports.js';
import type {
  AdminAutomataBusDegradationReason,
  AdminAutomataBusHealthSource,
  AdminAutomataBusReadInput,
  AdminAutomataBusReadPort,
} from './automata-service.js';

interface EventJsonRow {
  event_json: unknown;
}

interface LastEventRow {
  last_event_at: unknown;
}

interface EventExistsRow {
  event_exists: unknown;
}

interface PostgresAdminAutomataBusReadAdapterOptions {
  pool: AutomataBusSqlPool;
  vector: Pick<AutomataBusVectorIndexPort, 'readState'>;
  companionId: string;
  maxPageLimit: number;
  now?: () => Date;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function parsePersistedEvent(value: unknown): AutomataBusEvent {
  const parsed = parseAutomataBusEvent(value);
  if (parsed.status !== 'accepted') {
    throw new Error(`Invalid persisted Automata Bus event: ${parsed.issues.join('; ')}`);
  }
  return parsed.value;
}

function verificationStatus(event: AutomataBusEvent): AutomataBusVerificationStatus | undefined {
  if (event.type === 'finding') return event.body.verification.status;
  return event.body.replacement?.verification.status;
}

function eventMatches(event: AutomataBusEvent, input: AdminAutomataBusReadInput): boolean {
  return event.companionId === input.companionId
    && (input.classId === undefined || event.context.automatonClass === input.classId)
    && (input.runId === undefined || event.context.runId === input.runId)
    && (input.taskId === undefined || event.context.taskId === input.taskId)
    && (input.eventId === undefined || event.eventId === input.eventId)
    && (
      input.verificationStatus === undefined
      || verificationStatus(event) === input.verificationStatus
    );
}

function toEffectiveFinding(event: AutomataBusEvent): AutomataBusEffectiveFinding | null {
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
  if (event.body.relation === 'retracts' || event.body.replacement === undefined) return null;
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

function toDisposition(event: AutomataBusEvent): AutomataBusDisposition | null {
  if (event.type !== 'relation') return null;
  return {
    targetEventId: event.body.targetEventId,
    relation: event.body.relation,
    byEventId: event.eventId,
  };
}

function optionalInstant(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  const instant = value instanceof Date
    ? value.toISOString()
    : requireAutomataBusNonEmptyString(value, field);
  const timestamp = Date.parse(instant);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be a timestamp`);
  return new Date(timestamp).toISOString();
}

function unavailableVectorState(): AutomataBusVectorIndexState {
  return {
    indexState: 'unavailable',
    reindexState: 'required',
    modelIdentity: null,
    indexingLag: { pendingCount: 0 },
  };
}

function projectHealth(
  state: AutomataBusVectorIndexState,
  observedAt: string,
  lastEventAt: string | null,
): AdminAutomataBusHealthSource {
  const reasons: AdminAutomataBusDegradationReason[] = [];
  if (state.indexState === 'building') reasons.push('index_building');
  if (state.indexState === 'unavailable') reasons.push('index_unavailable');
  if (state.indexState === 'degraded' || state.indexingLag.pendingCount > 0) {
    reasons.push('index_lagging');
  }
  if (state.reindexState !== 'current') reasons.push('reindex_required');
  return {
    condition: reasons.length === 0 ? 'healthy' : 'degraded',
    freshness: lastEventAt === null ? 'unknown' : reasons.length === 0 ? 'fresh' : 'stale',
    observedAt,
    lastEventAt,
    indexState: state.indexState,
    reindexState: state.reindexState,
    pendingIndexCount: state.indexingLag.pendingCount,
    ...(state.indexingLag.oldestPendingAt
      ? { oldestPendingAt: state.indexingLag.oldestPendingAt }
      : {}),
    ...(state.indexingLag.lastFailureAt
      ? { lastIndexFailureAt: state.indexingLag.lastFailureAt }
      : {}),
    degradationReasons: [...new Set(reasons)],
  };
}

function appendFilters(
  alias: string,
  parameters: ReturnType<typeof createAutomataBusPostgresParameters>,
  input: AdminAutomataBusReadInput,
): string[] {
  const predicates = [
    `${alias}.companion_id = ${parameters.add(input.companionId)}`,
    `'operator' = ANY(${alias}.audiences)`,
    `${alias}.sensitivity = ANY(${parameters.add([...SENSITIVITY_LEVELS])}::text[])`,
  ];
  if (input.classId !== undefined) {
    predicates.push(`${alias}.event_json #>> '{context,automatonClass}' = ${parameters.add(input.classId)}`);
  }
  if (input.runId !== undefined) {
    predicates.push(`${alias}.event_json #>> '{context,runId}' = ${parameters.add(input.runId)}`);
  }
  if (input.taskId !== undefined) {
    predicates.push(`${alias}.event_json #>> '{context,taskId}' = ${parameters.add(input.taskId)}`);
  }
  if (input.eventId !== undefined) {
    predicates.push(`${alias}.event_id = ${parameters.add(input.eventId)}`);
  }
  if (input.verificationStatus !== undefined) {
    predicates.push(
      `${automataBusCurrentVerificationStatusSql(alias)} = ${parameters.add(input.verificationStatus)}`,
    );
  }
  return predicates;
}

export class PostgresAdminAutomataBusReadAdapter implements AdminAutomataBusReadPort {
  private readonly companionId: string;
  private readonly maxPageLimit: number;
  private readonly now: () => Date;

  constructor(private readonly options: PostgresAdminAutomataBusReadAdapterOptions) {
    this.companionId = requireAutomataBusNonEmptyString(options.companionId, 'companionId');
    this.maxPageLimit = requireAutomataBusPositiveInteger(options.maxPageLimit, 'maxPageLimit');
    this.now = options.now ?? (() => new Date());
  }

  async readPage(input: AdminAutomataBusReadInput): Promise<{
    companionId: string;
    events: readonly AutomataBusEvent[];
    currentFindings: readonly AutomataBusEffectiveFinding[];
    dispositions: readonly AutomataBusDisposition[];
    hasMore: boolean;
    eventIdMatched?: boolean;
    health: AdminAutomataBusHealthSource;
  }> {
    if (input.companionId !== this.companionId) {
      throw new Error('Automata Bus admin read companion scope mismatch');
    }
    const offset = requireNonNegativeInteger(input.offset, 'offset');
    const limit = requireAutomataBusPositiveInteger(input.limit, 'limit');
    if (offset + limit > this.maxPageLimit) {
      throw new Error(`Automata Bus admin page exceeds maxPageLimit (${this.maxPageLimit})`);
    }
    for (const [field, value] of [
      ['classId', input.classId],
      ['runId', input.runId],
      ['taskId', input.taskId],
      ['eventId', input.eventId],
    ] as const) {
      if (value !== undefined) requireAutomataBusNonEmptyString(value, field);
    }

    const eventParameters = createAutomataBusPostgresParameters();
    const eventPredicates = appendFilters('e', eventParameters, input);
    const eventLimit = eventParameters.add(limit + 1);
    const eventOffset = eventParameters.add(offset);
    const currentParameters = createAutomataBusPostgresParameters();
    const currentPredicates = appendFilters('c', currentParameters, input);
    const currentLimit = currentParameters.add(limit + 1);
    const currentOffset = currentParameters.add(offset);

    const [eventRows, currentRows, lastEventRows, vectorState] = await Promise.all([
      this.options.pool.query<EventJsonRow>(`
        SELECT e.event_json
        FROM automata_bus_events e
        WHERE ${eventPredicates.join('\n          AND ')}
        ORDER BY e.sequence DESC, e.event_id ASC
        LIMIT ${eventLimit}
        OFFSET ${eventOffset}
      `, eventParameters.values),
      this.options.pool.query<EventJsonRow>(`
        SELECT c.event_json
        FROM automata_bus_current_findings c
        WHERE ${currentPredicates.join('\n          AND ')}
        ORDER BY c.sequence DESC, c.event_id ASC
        LIMIT ${currentLimit}
        OFFSET ${currentOffset}
      `, currentParameters.values),
      this.options.pool.query<LastEventRow>(`
        SELECT MAX(occurred_at) AS last_event_at
        FROM automata_bus_events
        WHERE companion_id = $1
          AND 'operator' = ANY(audiences)
          AND sensitivity = ANY($2::text[])
      `, [this.companionId, [...SENSITIVITY_LEVELS]]),
      this.options.vector.readState().catch(() => unavailableVectorState()),
    ]);

    const parsedEvents = eventRows.rows.map(row => parsePersistedEvent(row.event_json));
    const parsedCurrentEvents = currentRows.rows.map(row => parsePersistedEvent(row.event_json));
    if (parsedEvents.some(event => !eventMatches(event, input))) {
      throw new Error('Automata Bus event query returned a row outside its requested scope');
    }
    if (parsedCurrentEvents.some(event => !eventMatches(event, input))) {
      throw new Error('Automata Bus current query returned a row outside its requested scope');
    }
    const events = parsedEvents.slice(0, limit);
    const currentFindings = parsedCurrentEvents
      .slice(0, limit)
      .map(toEffectiveFinding)
      .filter((finding): finding is AutomataBusEffectiveFinding => finding !== null);
    const dispositions = events
      .map(toDisposition)
      .filter((disposition): disposition is AutomataBusDisposition => disposition !== null)
      .slice(0, limit);
    let eventIdMatched: boolean | undefined;
    if (input.eventId !== undefined) {
      eventIdMatched = parsedEvents.some(candidate => candidate.eventId === input.eventId);
      if (!eventIdMatched) {
        const exists = await this.options.pool.query<EventExistsRow>(`
          SELECT EXISTS (
            SELECT 1
            FROM automata_bus_events e
            WHERE e.companion_id = $1
              AND e.event_id = $2
              AND 'operator' = ANY(e.audiences)
              AND e.sensitivity = ANY($3::text[])
          ) AS event_exists
        `, [this.companionId, input.eventId, [...SENSITIVITY_LEVELS]]);
        eventIdMatched = exists.rows[0]?.event_exists === true;
      }
    }
    const observedAt = this.now().toISOString();
    const lastEventAt = optionalInstant(lastEventRows.rows[0]?.last_event_at, 'last_event_at');
    return {
      companionId: this.companionId,
      events,
      currentFindings,
      dispositions,
      hasMore: parsedEvents.length > limit || parsedCurrentEvents.length > limit,
      ...(eventIdMatched === undefined ? {} : { eventIdMatched }),
      health: projectHealth(vectorState, observedAt, lastEventAt),
    };
  }
}
