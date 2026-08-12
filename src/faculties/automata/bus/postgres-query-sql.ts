import {
  SENSITIVITY_LEVELS,
  sensitivityAtMost,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import {
  normalizeAutomataStringList,
  normalizeAutomataTimestamp,
} from '../validation.js';
import {
  AUTOMATA_BUS_AUDIENCES,
  type AutomataBusAudience,
} from './postgres-store.js';
import type { AutomataBusVerificationStatus } from './contract.js';
import type {
  AutomataBusEmbeddingIdentity,
  AutomataBusSearchFilters,
  AutomataBusVisibility,
} from './query-ports.js';

const VERIFICATION_STATUSES: readonly AutomataBusVerificationStatus[] = [
  'pending',
  'rejected',
  'verified',
];

interface NormalizedAutomataBusPostgresQuery {
  visibility: AutomataBusVisibility;
  filters: AutomataBusSearchFilters;
  limit: number;
}

export interface AutomataBusPostgresParameters {
  values: unknown[];
  add(value: unknown): string;
}

export function createAutomataBusPostgresParameters(): AutomataBusPostgresParameters {
  const values: unknown[] = [];
  return {
    values,
    add(value) {
      values.push(value);
      return `$${values.length}`;
    },
  };
}

export function requireAutomataBusNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function requireAutomataBusPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function isAudience(value: unknown): value is AutomataBusAudience {
  return typeof value === 'string' && AUTOMATA_BUS_AUDIENCES.some(candidate => candidate === value);
}

function isSensitivity(value: unknown): value is SensitivityLevel {
  return typeof value === 'string' && SENSITIVITY_LEVELS.some(candidate => candidate === value);
}

function isVerificationStatus(value: unknown): value is AutomataBusVerificationStatus {
  return typeof value === 'string' && VERIFICATION_STATUSES.some(candidate => candidate === value);
}

export function normalizeAutomataBusPostgresQuery(
  visibility: AutomataBusVisibility,
  filters: AutomataBusSearchFilters,
  requestedLimit: number,
  maxCandidateLimit: number,
): NormalizedAutomataBusPostgresQuery {
  const companionId = requireAutomataBusNonEmptyString(visibility.companionId, 'visibility.companionId');
  if (!isAudience(visibility.audience)) throw new Error('visibility.audience is unsupported');
  if (!isSensitivity(visibility.maxSensitivity)) {
    throw new Error('visibility.maxSensitivity is unsupported');
  }
  const maxLimit = requireAutomataBusPositiveInteger(maxCandidateLimit, 'maxCandidateLimit');
  const limit = Math.min(
    requireAutomataBusPositiveInteger(requestedLimit, 'limit'),
    maxLimit,
  );
  const occurredAfter = normalizeAutomataTimestamp(
    filters.occurredAfter,
    'filters.occurredAfter',
    requireAutomataBusNonEmptyString,
  );
  const occurredBefore = normalizeAutomataTimestamp(
    filters.occurredBefore,
    'filters.occurredBefore',
    requireAutomataBusNonEmptyString,
  );
  if (
    occurredAfter !== undefined
    && occurredBefore !== undefined
    && occurredAfter > occurredBefore
  ) {
    throw new Error('filters.occurredAfter must not be later than filters.occurredBefore');
  }
  if (filters.audiences?.some(audience => !isAudience(audience))) {
    throw new Error('filters.audiences contains an unsupported audience');
  }
  if (filters.statuses?.some(status => !isVerificationStatus(status))) {
    throw new Error('filters.statuses contains an unsupported status');
  }
  return {
    visibility: {
      companionId,
      audience: visibility.audience,
      maxSensitivity: visibility.maxSensitivity,
    },
    filters: {
      ...(filters.automatonClasses !== undefined
        ? {
            automatonClasses: normalizeAutomataStringList(
              filters.automatonClasses,
              'filters.automatonClasses',
              requireAutomataBusNonEmptyString,
            ),
          }
        : {}),
      ...(filters.taskIds !== undefined
        ? {
            taskIds: normalizeAutomataStringList(
              filters.taskIds,
              'filters.taskIds',
              requireAutomataBusNonEmptyString,
            ),
          }
        : {}),
      ...(filters.runIds !== undefined
        ? {
            runIds: normalizeAutomataStringList(
              filters.runIds,
              'filters.runIds',
              requireAutomataBusNonEmptyString,
            ),
          }
        : {}),
      ...(occurredAfter !== undefined ? { occurredAfter } : {}),
      ...(occurredBefore !== undefined ? { occurredBefore } : {}),
      ...(filters.audiences !== undefined
        ? { audiences: [...new Set(filters.audiences)].sort() }
        : {}),
      ...(filters.statuses !== undefined
        ? { statuses: [...new Set(filters.statuses)].sort() }
        : {}),
    },
    limit,
  };
}

function automataBusAllowedSensitivities(maximum: SensitivityLevel): SensitivityLevel[] {
  return SENSITIVITY_LEVELS.filter(level => sensitivityAtMost(level, maximum));
}

export function automataBusCurrentClaimSql(alias = 'c'): string {
  return `COALESCE(
    ${alias}.event_json #>> '{body,replacement,claim}',
    ${alias}.event_json #>> '{body,claim}'
  )`;
}

export function automataBusCurrentVerificationStatusSql(alias = 'c'): string {
  return `COALESCE(
    ${alias}.event_json #>> '{body,replacement,verification,status}',
    ${alias}.event_json #>> '{body,verification,status}'
  )`;
}

export function appendAutomataBusCurrentFindingPredicates(
  parameters: AutomataBusPostgresParameters,
  query: Pick<NormalizedAutomataBusPostgresQuery, 'visibility' | 'filters'>,
  alias = 'c',
): string[] {
  const predicates = [
    `${alias}.companion_id = ${parameters.add(query.visibility.companionId)}`,
    `${parameters.add(query.visibility.audience)} = ANY(${alias}.audiences)`,
    `${alias}.sensitivity = ANY(${parameters.add(
      automataBusAllowedSensitivities(query.visibility.maxSensitivity),
    )}::text[])`,
  ];
  const { filters } = query;
  if (filters.automatonClasses !== undefined) {
    predicates.push(
      `${alias}.event_json #>> '{context,automatonClass}' = ANY(${parameters.add(filters.automatonClasses)}::text[])`,
    );
  }
  if (filters.taskIds !== undefined) {
    predicates.push(
      `${alias}.event_json #>> '{context,taskId}' = ANY(${parameters.add(filters.taskIds)}::text[])`,
    );
  }
  if (filters.runIds !== undefined) {
    predicates.push(
      `${alias}.event_json #>> '{context,runId}' = ANY(${parameters.add(filters.runIds)}::text[])`,
    );
  }
  if (filters.occurredAfter !== undefined) {
    predicates.push(
      `(${alias}.event_json ->> 'occurredAt')::timestamptz >= ${parameters.add(filters.occurredAfter)}::timestamptz`,
    );
  }
  if (filters.occurredBefore !== undefined) {
    predicates.push(
      `(${alias}.event_json ->> 'occurredAt')::timestamptz <= ${parameters.add(filters.occurredBefore)}::timestamptz`,
    );
  }
  if (filters.audiences !== undefined) {
    predicates.push(`${alias}.audiences && ${parameters.add(filters.audiences)}::text[]`);
  }
  if (filters.statuses !== undefined) {
    predicates.push(
      `${automataBusCurrentVerificationStatusSql(alias)} = ANY(${parameters.add(filters.statuses)}::text[])`,
    );
  }
  return predicates;
}

export function automataBusAudienceFilterAllowsScope(
  visibility: AutomataBusVisibility,
  filters: AutomataBusSearchFilters,
): boolean {
  return filters.audiences === undefined || filters.audiences.includes(visibility.audience);
}

export function normalizeAutomataBusEmbeddingIdentity(
  identity: AutomataBusEmbeddingIdentity,
): AutomataBusEmbeddingIdentity {
  return {
    provider: requireAutomataBusNonEmptyString(identity.provider, 'modelIdentity.provider'),
    model: requireAutomataBusNonEmptyString(identity.model, 'modelIdentity.model'),
    dimensions: requireAutomataBusPositiveInteger(identity.dimensions, 'modelIdentity.dimensions'),
  };
}

export function encodeAutomataBusEmbedding(
  embedding: Float32Array,
  identity: AutomataBusEmbeddingIdentity,
): string {
  if (embedding.length !== identity.dimensions) {
    throw new Error(
      `Automata Bus embedding dimension mismatch: expected ${identity.dimensions}, got ${embedding.length}`,
    );
  }
  const values = Array.from(embedding, value => Number(value));
  if (values.some(value => !Number.isFinite(value))) {
    throw new Error('Automata Bus embedding values must be finite');
  }
  return `[${values.join(',')}]`;
}

export function parseAutomataBusSearchScore(value: unknown): number {
  const parsed = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new Error('Automata Bus search score must be finite');
  }
  return Math.max(0, Math.min(1, parsed));
}

export function parseAutomataBusSearchEventId(value: unknown): string {
  return requireAutomataBusNonEmptyString(value, 'Automata Bus search event_id');
}
