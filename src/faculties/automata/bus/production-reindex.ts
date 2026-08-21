import {
  SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import {
  parseAutomataBusEvent,
  type AutomataBusEvent,
} from './contract.js';
import {
  requireAutomataBusNonEmptyString,
  requireAutomataBusPositiveInteger,
} from './postgres-query-sql.js';
import type { AutomataBusSqlPool } from './postgres-store.js';
import type { AutomataBusProductionRuntime } from './production-runtime.js';
import type {
  AutomataBusCanonicalFinding,
  AutomataBusEmbeddingIdentity,
} from './query-ports.js';
import {
  AutomataBusReindexService,
  type AutomataBusReindexSourcePort,
} from './reindex-service.js';

interface AutomataBusReindexRow {
  companion_id: unknown;
  event_id: unknown;
  sequence: unknown;
  audiences: unknown;
  sensitivity: unknown;
  event_json: unknown;
}

function parseSensitivity(value: unknown): SensitivityLevel {
  if (typeof value !== 'string' || !SENSITIVITY_LEVELS.includes(value as SensitivityLevel)) {
    throw new Error('Automata Bus reindex row has invalid sensitivity');
  }
  return value as SensitivityLevel;
}

function parseSequence(value: unknown): number {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('Automata Bus reindex row has invalid sequence');
  }
  return parsed;
}

function parseSnapshotSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Automata Bus reindex snapshotSequence must be a non-negative safe integer');
  }
  return value;
}

function findingBody(event: AutomataBusEvent) {
  if (event.type === 'finding') return event.body;
  if (event.body.relation === 'retracts' || event.body.replacement === undefined) {
    throw new Error(`Automata Bus current projection contains invalid retraction "${event.eventId}"`);
  }
  return event.body.replacement;
}

function parseFinding(row: AutomataBusReindexRow, companionId: string): AutomataBusCanonicalFinding {
  const rowCompanionId = requireAutomataBusNonEmptyString(row.companion_id, 'row companion_id');
  const rowEventId = requireAutomataBusNonEmptyString(row.event_id, 'row event_id');
  const rowSequence = parseSequence(row.sequence);
  if (rowCompanionId !== companionId) {
    throw new Error('Automata Bus reindex received a cross-companion row');
  }
  if (!Array.isArray(row.audiences)
    || !row.audiences.every(value => typeof value === 'string')
    || !row.audiences.includes('eligible-automata')) {
    throw new Error('Automata Bus reindex row is not eligible for worker disclosure');
  }
  const parsed = parseAutomataBusEvent(row.event_json);
  if (parsed.status !== 'accepted') {
    throw new Error(`Invalid persisted Automata Bus reindex event: ${parsed.issues.join('; ')}`);
  }
  const event = parsed.value;
  if (event.companionId !== companionId
    || event.eventId !== rowEventId
    || event.sequence !== rowSequence) {
    throw new Error('Automata Bus reindex row authority columns disagree with event_json');
  }
  const body = findingBody(event);
  return {
    eventId: event.eventId,
    companionId: event.companionId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    automatonClass: event.context.automatonClass,
    taskId: event.context.taskId,
    runId: event.context.runId,
    claim: body.claim,
    provenance: body.provenance,
    verificationStatus: body.verification.status,
    audience: 'eligible-automata',
    sensitivity: parseSensitivity(row.sensitivity),
  };
}

export class PostgresAutomataBusReindexSource implements AutomataBusReindexSourcePort {
  private readonly companionId: string;
  private readonly maxFindings: number;

  constructor(private readonly options: {
    pool: AutomataBusSqlPool;
    companionId: string;
    maxFindings: number;
  }) {
    this.companionId = requireAutomataBusNonEmptyString(options.companionId, 'companionId');
    this.maxFindings = requireAutomataBusPositiveInteger(options.maxFindings, 'maxFindings');
  }

  async readCurrent(input: {
    companionId: string;
    limit: number;
    snapshotSequence: number;
  }): Promise<{
    companionId: string;
    findings: readonly AutomataBusCanonicalFinding[];
    hasMore: boolean;
  }> {
    if (input.companionId !== this.companionId) {
      throw new Error('Automata Bus reindex source companion scope mismatch');
    }
    const limit = requireAutomataBusPositiveInteger(input.limit, 'limit');
    const snapshotSequence = parseSnapshotSequence(input.snapshotSequence);
    if (limit > this.maxFindings) {
      throw new Error(`Automata Bus reindex source limit exceeds maxFindings (${this.maxFindings})`);
    }
    const rows = await this.options.pool.query<AutomataBusReindexRow>(`
      SELECT companion_id, event_id, sequence, audiences, sensitivity, event_json
      FROM automata_bus_current_findings
      WHERE companion_id = $1
        AND sequence <= $2
        AND 'eligible-automata' = ANY(audiences)
        AND sensitivity = ANY($3::text[])
      ORDER BY sequence ASC, event_id ASC
      LIMIT $4
    `, [this.companionId, snapshotSequence, [...SENSITIVITY_LEVELS], limit + 1]);
    const findings = rows.rows.slice(0, limit).map(row => parseFinding(row, this.companionId));
    return {
      companionId: this.companionId,
      findings,
      hasMore: rows.rows.length > limit,
    };
  }
}

export interface AutomataBusReindexProductionRuntime {
  vector: Pick<
    AutomataBusProductionRuntime['vector'],
    'beginReindex' | 'completeReindex' | 'failReindex'
  >;
  indexing: Pick<AutomataBusProductionRuntime['indexing'], 'indexCurrentFinding'>;
  describeComposition(): { embeddingIdentity: AutomataBusEmbeddingIdentity };
}

export function createProductionAutomataBusReindexService(options: {
  pool: AutomataBusSqlPool;
  runtime: AutomataBusReindexProductionRuntime;
  companionId: string;
  maxFindings: number;
}): AutomataBusReindexService {
  const companionId = requireAutomataBusNonEmptyString(options.companionId, 'companionId');
  const modelIdentity = options.runtime.describeComposition().embeddingIdentity;
  return new AutomataBusReindexService({
    companionId,
    maxFindings: options.maxFindings,
    source: new PostgresAutomataBusReindexSource({
      pool: options.pool,
      companionId,
      maxFindings: options.maxFindings,
    }),
    runtime: {
      begin: async input => await options.runtime.vector.beginReindex({
        ...input,
        modelIdentity,
      }),
      index: async finding => await options.runtime.indexing.indexCurrentFinding(finding),
      complete: async input => await options.runtime.vector.completeReindex({
        ...input,
        modelIdentity,
      }),
      fail: async input => await options.runtime.vector.failReindex({
        ...input,
        modelIdentity,
      }),
    },
  });
}
