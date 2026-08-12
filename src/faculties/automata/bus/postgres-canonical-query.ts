import { sensitivityAtMost } from '../../../system/trust/types.js';
import {
  automataBusAudienceFilterAllowsScope,
  automataBusCurrentClaimSql,
  appendAutomataBusCurrentFindingPredicates,
  createAutomataBusPostgresParameters,
  normalizeAutomataBusPostgresQuery,
  parseAutomataBusSearchEventId,
  parseAutomataBusSearchScore,
  requireAutomataBusNonEmptyString,
  requireAutomataBusPositiveInteger,
} from './postgres-query-sql.js';
import type {
  AutomataBusSqlQueryable,
  PersistedAutomataBusCurrentFinding,
  PostgresAutomataBusStore,
} from './postgres-store.js';
import type {
  AutomataBusCanonicalFinding,
  AutomataBusCanonicalFindingPort,
  AutomataBusCanonicalHydrationInput,
  AutomataBusCanonicalSearchInput,
  AutomataBusSearchFilters,
  AutomataBusVisibility,
} from './query-ports.js';

interface AutomataBusLexicalSearchRow {
  event_id: unknown;
  score: unknown;
}

interface PostgresAutomataBusCanonicalFindingAdapterOptions {
  pool: AutomataBusSqlQueryable;
  store: Pick<PostgresAutomataBusStore, 'readCurrentFindingsByEventIds'>;
  maxCandidateLimit: number;
}

function includes(value: string, values: readonly string[] | undefined): boolean {
  return values === undefined || values.includes(value);
}

function findingMatches(
  finding: AutomataBusCanonicalFinding,
  visibility: AutomataBusVisibility,
  filters: AutomataBusSearchFilters,
): boolean {
  if (finding.companionId !== visibility.companionId) return false;
  if (finding.audience !== visibility.audience) return false;
  if (!sensitivityAtMost(finding.sensitivity, visibility.maxSensitivity)) return false;
  if (!includes(finding.automatonClass, filters.automatonClasses)) return false;
  if (!includes(finding.taskId, filters.taskIds)) return false;
  if (!includes(finding.runId, filters.runIds)) return false;
  if (!includes(finding.audience, filters.audiences)) return false;
  if (!includes(finding.verificationStatus, filters.statuses)) return false;
  if (filters.occurredAfter !== undefined && finding.occurredAt < filters.occurredAfter) return false;
  if (filters.occurredBefore !== undefined && finding.occurredAt > filters.occurredBefore) return false;
  return true;
}

function mapPersistedFinding(
  row: PersistedAutomataBusCurrentFinding,
  visibility: AutomataBusVisibility,
): AutomataBusCanonicalFinding | null {
  const finding = row.effectiveFinding;
  if (
    finding.companionId !== visibility.companionId
    || !row.audiences.includes(visibility.audience)
    || !sensitivityAtMost(row.sensitivity, visibility.maxSensitivity)
  ) {
    return null;
  }
  return {
    eventId: finding.eventId,
    companionId: finding.companionId,
    sequence: finding.sequence,
    occurredAt: finding.occurredAt,
    automatonClass: finding.context.automatonClass,
    taskId: finding.context.taskId,
    runId: finding.context.runId,
    claim: finding.body.claim,
    provenance: finding.body.provenance,
    verificationStatus: finding.body.verification.status,
    audience: visibility.audience,
    sensitivity: row.sensitivity,
  };
}

export class PostgresAutomataBusCanonicalFindingAdapter implements AutomataBusCanonicalFindingPort {
  private readonly pool: AutomataBusSqlQueryable;
  private readonly store: Pick<PostgresAutomataBusStore, 'readCurrentFindingsByEventIds'>;
  private readonly maxCandidateLimit: number;

  constructor(options: PostgresAutomataBusCanonicalFindingAdapterOptions) {
    this.pool = options.pool;
    this.store = options.store;
    this.maxCandidateLimit = requireAutomataBusPositiveInteger(
      options.maxCandidateLimit,
      'maxCandidateLimit',
    );
  }

  async searchLexical(input: AutomataBusCanonicalSearchInput): Promise<readonly {
    eventId: string;
    score: number;
  }[]> {
    const queryText = requireAutomataBusNonEmptyString(input.query, 'query');
    const query = normalizeAutomataBusPostgresQuery(
      input.visibility,
      input.filters,
      input.limit,
      this.maxCandidateLimit,
    );
    if (!automataBusAudienceFilterAllowsScope(query.visibility, query.filters)) return [];

    const parameters = createAutomataBusPostgresParameters();
    const predicates = appendAutomataBusCurrentFindingPredicates(parameters, query);
    const lexicalQuery = parameters.add(queryText);
    const limit = parameters.add(query.limit);
    const claim = automataBusCurrentClaimSql('c');
    const rows = await this.pool.query<AutomataBusLexicalSearchRow>(`
      WITH lexical_candidates AS (
        SELECT
          c.event_id,
          c.sequence,
          to_tsvector('simple', ${claim}) AS document
        FROM automata_bus_current_findings c
        WHERE ${predicates.join('\n          AND ')}
      )
      SELECT
        event_id,
        LEAST(1.0, ts_rank_cd(document, plainto_tsquery('simple', ${lexicalQuery}))) AS score
      FROM lexical_candidates
      WHERE document @@ plainto_tsquery('simple', ${lexicalQuery})
      ORDER BY score DESC, sequence DESC, event_id ASC
      LIMIT ${limit}
    `, parameters.values);
    return rows.rows.map(row => ({
      eventId: parseAutomataBusSearchEventId(row.event_id),
      score: parseAutomataBusSearchScore(row.score),
    }));
  }

  async getCurrentByEventIds(
    input: AutomataBusCanonicalHydrationInput,
  ): Promise<readonly AutomataBusCanonicalFinding[]> {
    const eventIds = input.eventIds.map((eventId, index) => (
      requireAutomataBusNonEmptyString(eventId, `eventIds[${index}]`)
    ));
    if (new Set(eventIds).size !== eventIds.length) {
      throw new Error('eventIds must not contain duplicates');
    }
    if (eventIds.length > this.maxCandidateLimit) {
      throw new Error(`eventIds exceeds maxCandidateLimit (${this.maxCandidateLimit})`);
    }
    const query = normalizeAutomataBusPostgresQuery(
      input.visibility,
      input.filters,
      Math.max(1, eventIds.length),
      this.maxCandidateLimit,
    );
    if (eventIds.length === 0 || !automataBusAudienceFilterAllowsScope(query.visibility, query.filters)) {
      return [];
    }
    const rows = await this.store.readCurrentFindingsByEventIds({
      companionId: query.visibility.companionId,
      audience: query.visibility.audience,
      maxSensitivity: query.visibility.maxSensitivity,
      eventIds: [...eventIds].sort(),
    });
    return rows
      .map(row => mapPersistedFinding(row, query.visibility))
      .filter((finding): finding is AutomataBusCanonicalFinding => finding !== null)
      .filter(finding => findingMatches(finding, query.visibility, query.filters));
  }
}
