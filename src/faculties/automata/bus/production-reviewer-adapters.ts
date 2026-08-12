import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { buildLLMWorkSpec, completeWithWorkSpec } from '../../../primitives/llm/work-spec.js';
import { isRecord } from '../../../shared/utils/types.js';
import { SENSITIVITY_LEVELS } from '../../../system/trust/types.js';
import type { AutomataRunRegistry } from '../run-registry.js';
import {
  type AutomataBusEvent,
  type AutomataBusFindingBody,
} from './contract.js';
import type {
  AutomataBusAudience,
  AutomataBusSqlPool,
} from './postgres-store.js';
import type { PostgresAutomataBusRuntimeStore } from './runtime-store.js';
import type {
  AutomataBusReviewerNominationPort,
  AutomataBusReviewerScope,
} from './reviewer-candidates.js';
import type {
  AutomataBusReviewerFindingPort,
  AutomataBusReviewerHealth,
  AutomataBusReviewerModelPort,
  AutomataBusReviewerMutationPort,
  AutomataBusReviewerOutcome,
  AutomataBusReviewerOutcomeCounts,
  AutomataBusReviewerOutcomePort,
  AutomataBusReviewerOutcomeStatus,
} from './reviewer-service.js';
import { CanonicalAutomataBusWriter } from './production-worker-adapter.js';

interface PairNominationRow {
  left_event_id: unknown;
  right_event_id: unknown;
  similarity_score: unknown;
  total_nominations: unknown;
}

interface SingletonNominationRow {
  event_id: unknown;
  kind: unknown;
  total_nominations: unknown;
}

interface FindingCountRow {
  finding_count: unknown;
}

const REVIEWER_CLASS = 'scheduler.automata_bus_reviewer' as const;
const OUTCOME_SOURCE = 'automata-bus-review-outcome' as const;
const OUTCOME_STATUSES = new Set<AutomataBusReviewerOutcomeStatus>([
  'applied',
  'no-change',
  'uncertain',
  'partial',
  'failed',
  'stale',
]);

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Automata Bus reviewer ${field} must be a non-empty string`);
  }
  return value.trim();
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Automata Bus reviewer ${field} must be a non-negative safe integer`);
  }
  return parsed;
}

function unitScore(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error('Automata Bus reviewer similarity score must be in [0,1]');
  }
  return parsed;
}

function assertScope(companionId: string, scope: AutomataBusReviewerScope): void {
  if (scope.companionId !== companionId) {
    throw new Error('Automata Bus reviewer scope does not match its runtime authority');
  }
}

/** Bounded pgvector + provenance nomination. It returns references only. */
export class PostgresAutomataBusReviewerNominationAdapter implements AutomataBusReviewerNominationPort {
  constructor(private readonly options: {
    pool: AutomataBusSqlPool;
    companionId: string;
  }) {}

  async nominate(input: Parameters<AutomataBusReviewerNominationPort['nominate']>[0]): Promise<unknown> {
    assertScope(this.options.companionId, input.scope);
    const findingCountRows = await this.options.pool.query<FindingCountRow>(`
      SELECT COUNT(*)::bigint AS finding_count
      FROM (
        SELECT c.event_id
        FROM automata_bus_current_findings c
        WHERE c.companion_id = $1
          AND 'operator' = ANY(c.audiences)
          AND c.event_json #>> '{context,automatonClass}' <> $3
        ORDER BY c.sequence DESC, c.event_id ASC
        LIMIT $2
      ) bounded
    `, [this.options.companionId, input.maxFindings, REVIEWER_CLASS]);
    const pairLimit = Math.max(1, Math.floor(input.maxNominations / 2));
    const pairRows = await this.options.pool.query<PairNominationRow>(`
      WITH bounded AS (
        SELECT c.event_id, c.sequence
        FROM automata_bus_current_findings c
        WHERE c.companion_id = $1
          AND 'operator' = ANY(c.audiences)
          AND c.event_json #>> '{context,automatonClass}' <> $5
        ORDER BY c.sequence DESC, c.event_id ASC
        LIMIT $2
      ), pairs AS (
        SELECT
          left_vector.event_id AS left_event_id,
          right_vector.event_id AS right_event_id,
          GREATEST(0.0, LEAST(1.0, 1 - (left_vector.embedding <=> right_vector.embedding))) AS similarity_score
        FROM bounded left_finding
        JOIN bounded right_finding
          ON right_finding.event_id > left_finding.event_id
        JOIN automata_bus_finding_vectors left_vector
          ON left_vector.companion_id = $1
          AND left_vector.event_id = left_finding.event_id
        JOIN automata_bus_finding_vectors right_vector
          ON right_vector.companion_id = left_vector.companion_id
          AND right_vector.event_id = right_finding.event_id
          AND right_vector.provider = left_vector.provider
          AND right_vector.model = left_vector.model
          AND right_vector.dimensions = left_vector.dimensions
        WHERE 1 - (left_vector.embedding <=> right_vector.embedding) >= $3
      )
      SELECT *, COUNT(*) OVER ()::bigint AS total_nominations
      FROM pairs
      ORDER BY similarity_score DESC, left_event_id ASC, right_event_id ASC
      LIMIT $4
    `, [
      this.options.companionId,
      input.maxFindings,
      input.similarityThreshold,
      pairLimit,
      REVIEWER_CLASS,
    ]);
    const pairNominations = pairRows.rows.flatMap(row => {
      const eventIds = [
        requiredText(row.left_event_id, 'left event id'),
        requiredText(row.right_event_id, 'right event id'),
      ];
      const similarityScore = unitScore(row.similarity_score);
      return [
        { kind: 'duplicate' as const, eventIds, similarityScore },
        { kind: 'contradiction' as const, eventIds, similarityScore },
      ];
    }).slice(0, input.maxNominations);
    const remaining = Math.max(0, input.maxNominations - pairNominations.length);
    const singletonRows = remaining === 0
      ? { rows: [] as SingletonNominationRow[] }
      : await this.options.pool.query<SingletonNominationRow>(`
          WITH bounded AS (
            SELECT c.event_id, c.sequence, c.event_json
            FROM automata_bus_current_findings c
            WHERE c.companion_id = $1
              AND 'operator' = ANY(c.audiences)
              AND c.event_json #>> '{context,automatonClass}' <> $4
            ORDER BY c.sequence DESC, c.event_id ASC
            LIMIT $2
          ), nominated AS (
            SELECT event_id, 'orphan-provenance'::text AS kind
            FROM bounded
            WHERE jsonb_array_length(COALESCE(
                    event_json #> '{body,evidence}',
                    event_json #> '{body,replacement,evidence}',
                    '[]'::jsonb
                  )) = 0
              AND jsonb_array_length(event_json #> '{context,artifactRefs}') = 0
            UNION ALL
            SELECT event_id, 'stale-evidence'::text AS kind
            FROM bounded
            WHERE COALESCE(
                    event_json #>> '{body,verification,status}',
                    event_json #>> '{body,replacement,verification,status}'
                  ) = 'rejected'
               OR EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements(COALESCE(
                   event_json #> '{body,evidence}',
                   event_json #> '{body,replacement,evidence}',
                   '[]'::jsonb
                 )) evidence
                 JOIN automata_bus_events historical
                   ON historical.companion_id = $1
                  AND historical.event_id = evidence ->> 'reference'
                 LEFT JOIN automata_bus_current_findings current_reference
                   ON current_reference.companion_id = historical.companion_id
                  AND current_reference.event_id = historical.event_id
                 WHERE current_reference.event_id IS NULL
               )
          )
          SELECT *, COUNT(*) OVER ()::bigint AS total_nominations
          FROM nominated
          ORDER BY kind ASC, event_id ASC
          LIMIT $3
        `, [this.options.companionId, input.maxFindings, remaining, REVIEWER_CLASS]);
    const singletons = singletonRows.rows.map(row => {
      if (row.kind !== 'stale-evidence' && row.kind !== 'orphan-provenance') {
        throw new Error('Automata Bus reviewer database returned an invalid candidate kind');
      }
      return { kind: row.kind, eventIds: [requiredText(row.event_id, 'event id')] };
    });
    const pairTotal = pairRows.rows[0]
      ? nonNegativeInteger(pairRows.rows[0].total_nominations, 'pair nomination count')
      : 0;
    const singletonTotal = singletonRows.rows[0]
      ? nonNegativeInteger(singletonRows.rows[0].total_nominations, 'singleton nomination count')
      : 0;
    const totalNominations = pairTotal * 2 + singletonTotal;
    const findingsScanned = findingCountRows.rows[0]
      ? nonNegativeInteger(findingCountRows.rows[0].finding_count, 'finding count')
      : 0;
    return {
      nominations: [...pairNominations, ...singletons],
      totalNominations,
      findingsScanned,
      hasMore: totalNominations > pairNominations.length + singletons.length,
    };
  }
}

export function createAutomataBusReviewerFindingAdapter(options: {
  store: PostgresAutomataBusRuntimeStore;
  companionId: string;
}): AutomataBusReviewerFindingPort {
  return {
    loadCurrent: async input => {
      assertScope(options.companionId, input.scope);
      return await options.store.readCurrentFindingsByEventIds({
        companionId: options.companionId,
        audience: 'operator',
        maxSensitivity: input.scope.maxSensitivity,
        eventIds: input.eventIds,
      });
    },
  };
}

function reviewerPrompt(input: Parameters<AutomataBusReviewerModelPort['review']>[0]): string {
  return JSON.stringify({
    cluster: input.cluster,
    findings: input.findings,
    requiredEnvelope: {
      status: 'complete | partial | failed',
      decision: {
        outcome: 'relation | no-change | uncertain',
        targetEventId: 'required for relation',
        relation: 'corrects | retracts | supersedes',
        reason: 'required',
        evidenceRefs: ['must cite references present in inspected findings'],
        replacement: 'required finding body for corrects/supersedes',
      },
    },
  });
}

export function createAutomataBusReviewerModelAdapter(options: {
  llmProvider: LLMProviderPort;
}): AutomataBusReviewerModelPort {
  return {
    review: async input => {
      const response = await completeWithWorkSpec(
        options.llmProvider,
        {
          systemPrompt: [
            'You are the offline Automata Bus evidence reviewer.',
            'Similarity is nomination only. Inspect the original claims and evidence.',
            'Return strict JSON only. Never rewrite prompts or mutate state directly.',
            'If evidence is incomplete, return uncertain, partial, or failed; do not propose a relation.',
          ].join('\n'),
          messages: [{ role: 'user', content: reviewerPrompt(input) }],
        },
        buildLLMWorkSpec({
          purpose: input.work.purpose,
          durable: input.work.durable,
          maxOutputTokens: input.work.maxOutputTokens,
          deadlineMs: input.work.deadlineMs,
          tokenCeiling: input.work.tokenCeiling,
          costCeilingUsd: input.work.costCeilingUsd,
          cancellation: input.work.cancellation,
          retryPolicy: input.work.retryPolicy,
          correlation: {
            requestId: `${input.reviewerRunId}:${input.cluster.clusterId}`,
            channelId: 'internal:automata-bus-reviewer',
            callType: 'scheduled',
            purpose: 'automata.bus.review',
            originType: 'scheduled',
            originStage: 'automata.bus.review',
          },
        }),
        {
          ...(input.signal ? { signal: input.signal } : {}),
          modelHint: { slotKey: input.work.model, maxTokens: input.work.maxOutputTokens },
        },
      );
      return JSON.parse(response.content) as unknown;
    },
  };
}

function reviewerRun(
  registry: AutomataRunRegistry,
  companionId: string,
  runId: string,
) {
  const run = registry.getRun(runId);
  if (!run || run.companionId !== companionId || run.automatonClass !== REVIEWER_CLASS) {
    throw new Error('Automata Bus reviewer mutation requires its authoritative registered run');
  }
  return run;
}

export function createAutomataBusReviewerMutationAdapter(options: {
  companionId: string;
  registry: AutomataRunRegistry;
  store: PostgresAutomataBusRuntimeStore;
  writer: CanonicalAutomataBusWriter;
}): AutomataBusReviewerMutationPort {
  return {
    appendRelation: async input => {
      assertScope(options.companionId, input.scope);
      const run = reviewerRun(options.registry, options.companionId, input.reviewerRunId);
      const [target] = await options.store.readCurrentFindingsByEventIds({
        companionId: options.companionId,
        audience: 'operator',
        maxSensitivity: input.scope.maxSensitivity,
        eventIds: [input.targetEventId],
      });
      if (!target) return { status: 'stale', reason: 'Relation target is no longer current' };
      if (
        target.sensitivity !== input.sensitivity
        || JSON.stringify([...target.audiences].sort()) !== JSON.stringify([...input.audiences].sort())
      ) {
        throw new Error('Automata Bus reviewer relation visibility drifted from its target');
      }
      const citation = `Evidence: ${input.evidenceRefs.join(', ')}`;
      const appended = await options.writer.append({
        eventId: input.idempotencyKey,
        occurredAt: new Date(run.createdAtMs).toISOString(),
        run,
        type: 'relation',
        body: {
          targetEventId: input.targetEventId,
          relation: input.relation,
          reason: `${input.reason}\n${citation}`,
          ...(input.replacement ? { replacement: input.replacement } : {}),
        },
        audiences: input.audiences,
        sensitivity: input.sensitivity,
      });
      return {
        status: appended.inserted ? 'appended' : 'replayed',
        eventId: appended.event.eventId,
      };
    },
  };
}

function parseOutcome(event: AutomataBusEvent): AutomataBusReviewerOutcome | null {
  if (event.type !== 'finding' || event.body.source !== OUTCOME_SOURCE) return null;
  let value: unknown;
  try {
    value = JSON.parse(event.body.claim);
  } catch {
    throw new Error(`Automata Bus reviewer outcome ${event.eventId} has invalid JSON`);
  }
  if (!isRecord(value) || typeof value.status !== 'string' || !OUTCOME_STATUSES.has(
    value.status as AutomataBusReviewerOutcomeStatus,
  )) {
    throw new Error(`Automata Bus reviewer outcome ${event.eventId} is invalid`);
  }
  if (!Array.isArray(value.eventIds) || !Array.isArray(value.evidenceRefs)) {
    throw new Error(`Automata Bus reviewer outcome ${event.eventId} references are invalid`);
  }
  return value as unknown as AutomataBusReviewerOutcome;
}

function emptyOutcomeCounts(): AutomataBusReviewerOutcomeCounts {
  return { applied: 0, noChange: 0, uncertain: 0, partial: 0, failed: 0, stale: 0 };
}

function incrementOutcome(
  counts: AutomataBusReviewerOutcomeCounts,
  status: AutomataBusReviewerOutcomeStatus,
): void {
  if (status === 'no-change') counts.noChange += 1;
  else counts[status] += 1;
}

export function createAutomataBusReviewerOutcomeAdapter(options: {
  companionId: string;
  registry: AutomataRunRegistry;
  store: PostgresAutomataBusRuntimeStore;
  writer: CanonicalAutomataBusWriter;
}): AutomataBusReviewerOutcomePort {
  const readOutcomes = async (scope: AutomataBusReviewerScope): Promise<AutomataBusReviewerOutcome[]> => {
    assertScope(options.companionId, scope);
    const history = await options.store.readHistory({
      companionId: options.companionId,
      audience: 'operator',
      maxSensitivity: scope.maxSensitivity,
    });
    return history.map(parseOutcome).filter((outcome): outcome is AutomataBusReviewerOutcome => outcome !== null);
  };
  return {
    findHandledClusterIds: async input => {
      const requested = new Set(input.clusterIds);
      return [...new Set((await readOutcomes(input.scope))
        .map(outcome => outcome.clusterId)
        .filter(clusterId => requested.has(clusterId)))];
    },
    record: async outcome => {
      const run = reviewerRun(options.registry, options.companionId, outcome.reviewerRunId);
      const evidenceRefs = [...new Set([...outcome.eventIds, ...outcome.evidenceRefs])];
      const body: AutomataBusFindingBody = {
        claim: JSON.stringify(outcome),
        provenance: 'computed',
        evidence: evidenceRefs.map(reference => ({
          kind: 'artifact',
          reference,
          summary: 'Inspected reviewer outcome evidence',
        })),
        verification: { status: 'verified', by: REVIEWER_CLASS, evidenceRefs },
        source: OUTCOME_SOURCE,
      };
      await options.writer.append({
        eventId: outcome.attemptId,
        occurredAt: outcome.occurredAt,
        run,
        type: 'finding',
        body,
        audiences: ['operator'] satisfies readonly AutomataBusAudience[],
        sensitivity: SENSITIVITY_LEVELS.at(-1)!,
      });
    },
    readHealth: async input => {
      const outcomes = (await readOutcomes(input.scope)).slice(-input.maxOutcomes);
      const counts = emptyOutcomeCounts();
      outcomes.forEach(outcome => incrementOutcome(counts, outcome.status));
      const degraded = counts.failed > 0 || counts.partial > 0;
      const health: AutomataBusReviewerHealth = {
        status: degraded ? 'degraded' : 'healthy',
        pendingClusters: 0,
        ...(outcomes.at(-1)?.occurredAt ? { lastRunAt: outcomes.at(-1)!.occurredAt } : {}),
        outcomes: counts,
      };
      return health;
    },
  };
}
