import { createHash } from 'node:crypto';

import {
  SENSITIVITY_LEVELS,
  sensitivityAtMost,
} from '../../../system/trust/types.js';
import {
  normalizeAutomataStringList,
  normalizeAutomataTimestamp,
} from '../validation.js';
import type { AutomataBusVerificationStatus } from './contract.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';
import {
  createEmbeddingUsageProvenance,
  embeddingUsageProvenanceFromRequestContext,
} from '../../../core/agent/embedding-usage-provenance.js';
import { RUNTIME_LANE_CLASSES } from '../../../shared/contracts/runtime-lanes.js';
import type {
  AutomataBusQueryAudience,
  AutomataBusCanonicalFinding,
  AutomataBusCanonicalFindingPort,
  AutomataBusEmbeddingIdentity,
  AutomataBusEmbeddingPort,
  AutomataBusIndexingLag,
  AutomataBusResultCachePort,
  AutomataBusScoredReference,
  AutomataBusSearchDiagnostics,
  AutomataBusSearchFilters,
  AutomataBusSemanticPath,
  AutomataBusVectorIndexPort,
  AutomataBusVectorIndexState,
  AutomataBusVisibility,
} from './query-ports.js';

export interface AutomataBusQueryPolicy {
  maxQueryChars: number;
  candidateLimit: number;
  maxSearchResults: number;
  maxBriefingItems: number;
  maxBriefingChars: number;
  maxBriefingClaimChars: number;
  resultCacheTtlMs: number;
  semanticWeight: number;
  lexicalWeight: number;
  exactFallbackEnabled: boolean;
}

export interface AutomataBusSearchInput {
  query: string;
  visibility: AutomataBusVisibility;
  filters?: AutomataBusSearchFilters;
  limit?: number;
  signal?: AbortSignal;
}

interface AutomataBusSearchResultItem extends AutomataBusCanonicalFinding {
  score: number;
  semanticScore?: number;
  lexicalScore?: number;
}

export interface AutomataBusSearchResult {
  results: AutomataBusSearchResultItem[];
  diagnostics: AutomataBusSearchDiagnostics;
}

export interface AutomataBusSpawnBriefing {
  text: string;
  itemCount: number;
  diagnostics: AutomataBusSearchDiagnostics;
}

interface AutomataBusQueryServiceOptions {
  canonical: AutomataBusCanonicalFindingPort;
  embeddings: AutomataBusEmbeddingPort;
  vector: AutomataBusVectorIndexPort;
  cache?: AutomataBusResultCachePort;
  policy: AutomataBusQueryPolicy;
}

interface NormalizedSearchInput {
  query: string;
  visibility: AutomataBusVisibility;
  filters: AutomataBusSearchFilters;
  limit: number;
  signal?: AbortSignal;
}

interface SemanticSearchResult {
  references: AutomataBusScoredReference[];
  path: AutomataBusSemanticPath;
  state: AutomataBusVectorIndexState;
}

const EMPTY_INDEXING_LAG: AutomataBusIndexingLag = { pendingCount: 0 };
const AUTOMATA_BUS_AUDIENCES: readonly AutomataBusQueryAudience[] = ['eligible-automata', 'operator'];
const AUTOMATA_BUS_VERIFICATION_STATUSES: readonly AutomataBusVerificationStatus[] = [
  'pending',
  'rejected',
  'verified',
];

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function validatePolicy(policy: AutomataBusQueryPolicy): void {
  requirePositiveInteger(policy.maxQueryChars, 'maxQueryChars');
  requirePositiveInteger(policy.candidateLimit, 'candidateLimit');
  requirePositiveInteger(policy.maxSearchResults, 'maxSearchResults');
  requirePositiveInteger(policy.maxBriefingItems, 'maxBriefingItems');
  requirePositiveInteger(policy.maxBriefingChars, 'maxBriefingChars');
  requirePositiveInteger(policy.maxBriefingClaimChars, 'maxBriefingClaimChars');
  requirePositiveInteger(policy.resultCacheTtlMs, 'resultCacheTtlMs');
  if (!Number.isFinite(policy.semanticWeight) || policy.semanticWeight < 0) {
    throw new Error('semanticWeight must be a non-negative finite number');
  }
  if (!Number.isFinite(policy.lexicalWeight) || policy.lexicalWeight < 0) {
    throw new Error('lexicalWeight must be a non-negative finite number');
  }
  if (policy.semanticWeight + policy.lexicalWeight <= 0) {
    throw new Error('at least one search weight must be positive');
  }
}

function normalizeRequired(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be non-empty`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  return normalized;
}

function normalizeFilters(filters: AutomataBusSearchFilters | undefined): AutomataBusSearchFilters {
  if (filters === undefined) return {};
  const occurredAfter = normalizeAutomataTimestamp(
    filters.occurredAfter,
    'filters.occurredAfter',
    normalizeRequired,
  );
  const occurredBefore = normalizeAutomataTimestamp(
    filters.occurredBefore,
    'filters.occurredBefore',
    normalizeRequired,
  );
  if (
    occurredAfter !== undefined
    && occurredBefore !== undefined
    && Date.parse(occurredAfter) > Date.parse(occurredBefore)
  ) {
    throw new Error('filters.occurredAfter must not be later than filters.occurredBefore');
  }
  if (filters.audiences?.some(audience => !AUTOMATA_BUS_AUDIENCES.includes(audience))) {
    throw new Error('filters.audiences contains an unknown audience');
  }
  if (filters.statuses?.some(status => !AUTOMATA_BUS_VERIFICATION_STATUSES.includes(status))) {
    throw new Error('filters.statuses contains an unknown status');
  }
  return {
    ...(filters.automatonClasses !== undefined
      ? {
          automatonClasses: normalizeAutomataStringList(
            filters.automatonClasses,
            'filters.automatonClasses',
            normalizeRequired,
          ),
        }
      : {}),
    ...(filters.taskIds !== undefined
      ? {
          taskIds: normalizeAutomataStringList(
            filters.taskIds,
            'filters.taskIds',
            normalizeRequired,
          ),
        }
      : {}),
    ...(filters.runIds !== undefined
      ? {
          runIds: normalizeAutomataStringList(
            filters.runIds,
            'filters.runIds',
            normalizeRequired,
          ),
        }
      : {}),
    ...(occurredAfter !== undefined ? { occurredAfter } : {}),
    ...(occurredBefore !== undefined ? { occurredBefore } : {}),
    ...(filters.audiences !== undefined
      ? { audiences: [...new Set(filters.audiences)].sort() as AutomataBusQueryAudience[] }
      : {}),
    ...(filters.statuses !== undefined
      ? { statuses: [...new Set(filters.statuses)].sort() as AutomataBusVerificationStatus[] }
      : {}),
  };
}

function normalizeVisibility(visibility: AutomataBusVisibility): AutomataBusVisibility {
  if (!AUTOMATA_BUS_AUDIENCES.includes(visibility.audience)) {
    throw new Error('visibility.audience is unknown');
  }
  if (!SENSITIVITY_LEVELS.includes(visibility.maxSensitivity)) {
    throw new Error('visibility.maxSensitivity is unknown');
  }
  return {
    companionId: normalizeRequired(visibility.companionId, 'visibility.companionId'),
    audience: visibility.audience,
    maxSensitivity: visibility.maxSensitivity,
  };
}

function score(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function modelIdentityMatches(
  left: AutomataBusEmbeddingIdentity,
  right: AutomataBusEmbeddingIdentity,
): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.dimensions === right.dimensions;
}

function unavailableIndexState(): AutomataBusVectorIndexState {
  return {
    indexState: 'unavailable',
    reindexState: 'required',
    modelIdentity: null,
    indexingLag: { ...EMPTY_INDEXING_LAG },
  };
}

function withinList(value: string, allowed: readonly string[] | undefined): boolean {
  return allowed === undefined || allowed.includes(value);
}

function isAuthorizedFinding(
  finding: AutomataBusCanonicalFinding,
  visibility: AutomataBusVisibility,
  filters: AutomataBusSearchFilters,
): boolean {
  if (finding.companionId !== visibility.companionId) return false;
  if (finding.audience !== visibility.audience) return false;
  if (!sensitivityAtMost(finding.sensitivity, visibility.maxSensitivity)) return false;
  if (!withinList(finding.automatonClass, filters.automatonClasses)) return false;
  if (!withinList(finding.taskId, filters.taskIds)) return false;
  if (!withinList(finding.runId, filters.runIds)) return false;
  if (!withinList(finding.audience, filters.audiences)) return false;
  if (!withinList(finding.verificationStatus, filters.statuses)) return false;
  if (filters.occurredAfter !== undefined && finding.occurredAt < filters.occurredAfter) return false;
  if (filters.occurredBefore !== undefined && finding.occurredAt > filters.occurredBefore) return false;
  return true;
}

function normalizeReferences(
  references: readonly AutomataBusScoredReference[],
  limit: number,
): AutomataBusScoredReference[] {
  const normalized: AutomataBusScoredReference[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const eventId = reference.eventId.trim();
    if (!eventId || seen.has(eventId)) continue;
    seen.add(eventId);
    normalized.push({
      eventId,
      ...(reference.semanticScore !== undefined ? { semanticScore: score(reference.semanticScore) } : {}),
      ...(reference.lexicalScore !== undefined ? { lexicalScore: score(reference.lexicalScore) } : {}),
    });
    if (normalized.length >= limit) break;
  }
  return normalized;
}

function mergeReferences(
  semantic: readonly AutomataBusScoredReference[],
  lexical: readonly AutomataBusScoredReference[],
  policy: AutomataBusQueryPolicy,
): AutomataBusScoredReference[] {
  const byId = new Map<string, AutomataBusScoredReference>();
  for (const reference of [...semantic, ...lexical]) {
    const existing = byId.get(reference.eventId) ?? { eventId: reference.eventId };
    byId.set(reference.eventId, {
      ...existing,
      ...(reference.semanticScore !== undefined ? { semanticScore: score(reference.semanticScore) } : {}),
      ...(reference.lexicalScore !== undefined ? { lexicalScore: score(reference.lexicalScore) } : {}),
    });
  }
  return [...byId.values()]
    .sort((left, right) => {
      const leftScore = score(left.semanticScore) * policy.semanticWeight
        + score(left.lexicalScore) * policy.lexicalWeight;
      const rightScore = score(right.semanticScore) * policy.semanticWeight
        + score(right.lexicalScore) * policy.lexicalWeight;
      return rightScore - leftScore || left.eventId.localeCompare(right.eventId);
    })
    .slice(0, policy.candidateLimit);
}

function buildCacheKey(
  input: NormalizedSearchInput,
  embeddingIdentity: AutomataBusEmbeddingIdentity,
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    query: input.query,
    visibility: input.visibility,
    filters: input.filters,
    embeddingIdentity,
  })).digest('hex');
  return `automata-bus:search:v1:${digest}`;
}

export class AutomataBusQueryService {
  private readonly canonical: AutomataBusCanonicalFindingPort;
  private readonly embeddings: AutomataBusEmbeddingPort;
  private readonly vector: AutomataBusVectorIndexPort;
  private readonly cache: AutomataBusResultCachePort | undefined;
  private readonly policy: AutomataBusQueryPolicy;

  constructor(options: AutomataBusQueryServiceOptions) {
    validatePolicy(options.policy);
    this.canonical = options.canonical;
    this.embeddings = options.embeddings;
    this.vector = options.vector;
    this.cache = options.cache;
    this.policy = { ...options.policy };
  }

  private normalizeInput(input: AutomataBusSearchInput): NormalizedSearchInput {
    const query = normalizeRequired(input.query, 'query');
    if (query.length > this.policy.maxQueryChars) {
      throw new Error(`query exceeds maxQueryChars (${this.policy.maxQueryChars})`);
    }
    const requestedLimit = input.limit ?? this.policy.maxSearchResults;
    requirePositiveInteger(requestedLimit, 'limit');
    return {
      query,
      visibility: normalizeVisibility(input.visibility),
      filters: normalizeFilters(input.filters),
      limit: Math.min(requestedLimit, this.policy.maxSearchResults),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    };
  }

  private async searchSemantic(input: NormalizedSearchInput): Promise<SemanticSearchResult> {
    let state: AutomataBusVectorIndexState;
    let approximateAllowed = false;
    try {
      state = await this.vector.readState();
      if (state.reindexState !== 'current') {
        return { references: [], path: 'reindex-required', state };
      }
      if (state.modelIdentity === null || !modelIdentityMatches(state.modelIdentity, this.embeddings.identity)) {
        return { references: [], path: 'model-mismatch', state };
      }
      approximateAllowed = state.indexState === 'ready';
    } catch {
      // Exact Postgres search still filters by the requested model identity, so
      // index-health loss need not remove semantic recall when fallback is enabled.
      state = unavailableIndexState();
    }

    let embedding: Float32Array;
    try {
      embedding = await this.embeddings.embed(input.query, {
        signal: input.signal,
        usageProvenance: embeddingUsageProvenanceFromRequestContext(getRequestContext())
          ?? createEmbeddingUsageProvenance({
          callType: 'background',
          purpose: 'automata_bus.query',
          service: 'automata_bus',
          process: 'semantic-query',
          runtimeLaneClass: RUNTIME_LANE_CLASSES.backgroundContinuation,
          workloadType: 'automata_bus_query',
          workloadId: 'semantic-query',
          }),
      });
      if (embedding.length !== this.embeddings.identity.dimensions) {
        return { references: [], path: 'embedding-unavailable', state };
      }
    } catch {
      return { references: [], path: 'embedding-unavailable', state };
    }
    const vectorInput = {
      embedding,
      modelIdentity: this.embeddings.identity,
      visibility: input.visibility,
      filters: input.filters,
      limit: this.policy.candidateLimit,
    };
    if (approximateAllowed) {
      try {
        const references = await this.vector.searchApproximate(vectorInput);
        return {
          references: normalizeReferences(
            references.map(reference => ({
              eventId: reference.eventId,
              semanticScore: reference.score,
            })),
            this.policy.candidateLimit,
          ),
          path: 'ann',
          state,
        };
      } catch {
        // Exact search below is the configured, bounded Postgres fallback.
      }
    }
    if (!this.policy.exactFallbackEnabled) {
      return {
        references: [],
        path: state.indexState === 'unavailable' ? 'index-state-unavailable' : 'exact-failed',
        state,
      };
    }
    try {
      const references = await this.vector.searchExact(vectorInput);
      return {
        references: normalizeReferences(
          references.map(reference => ({
            eventId: reference.eventId,
            semanticScore: reference.score,
          })),
          this.policy.candidateLimit,
        ),
        path: 'exact-fallback',
        state,
      };
    } catch {
      return { references: [], path: 'exact-failed', state };
    }
  }

  async search(input: AutomataBusSearchInput): Promise<AutomataBusSearchResult> {
    const normalized = this.normalizeInput(input);
    const cacheKey = buildCacheKey(normalized, this.embeddings.identity);
    let cacheState: AutomataBusSearchDiagnostics['cache'] = this.cache ? 'miss' : 'disabled';
    let references: AutomataBusScoredReference[] | null = null;
    if (this.cache) {
      try {
        const cached = await this.cache.get(cacheKey);
        if (cached !== null) {
          references = normalizeReferences(cached, this.policy.candidateLimit);
          cacheState = 'hit';
        }
      } catch {
        cacheState = 'error';
      }
    }

    let cachedIndexState: AutomataBusVectorIndexState | undefined;
    if (references !== null) {
      try {
        cachedIndexState = await this.vector.readState();
        if (
          cachedIndexState.reindexState !== 'current'
          || cachedIndexState.modelIdentity === null
          || !modelIdentityMatches(cachedIndexState.modelIdentity, this.embeddings.identity)
        ) {
          references = null;
          cacheState = 'miss';
        }
      } catch {
        references = null;
        cacheState = 'miss';
      }
    }

    let semantic: SemanticSearchResult = {
      references: [],
      path: 'index-state-unavailable',
      state: unavailableIndexState(),
    };
    if (references === null) {
      const [semanticResult, lexicalRaw] = await Promise.all([
        this.searchSemantic(normalized),
        this.canonical.searchLexical({
          query: normalized.query,
          visibility: normalized.visibility,
          filters: normalized.filters,
          limit: this.policy.candidateLimit,
        }),
      ]);
      semantic = semanticResult;
      const lexical = normalizeReferences(
        lexicalRaw.map(reference => ({
          eventId: reference.eventId,
          lexicalScore: reference.score,
        })),
        this.policy.candidateLimit,
      );
      references = mergeReferences(semantic.references, lexical, this.policy);
      if (this.cache) {
        try {
          await this.cache.set(cacheKey, references, this.policy.resultCacheTtlMs);
        } catch {
          cacheState = 'error';
        }
      }
    } else {
      semantic = {
        references: [],
        path: 'cache',
        state: cachedIndexState ?? unavailableIndexState(),
      };
    }

    const boundedReferences = references.slice(0, this.policy.candidateLimit);
    const canonicalRows = await this.canonical.getCurrentByEventIds({
      eventIds: boundedReferences.map(reference => reference.eventId),
      visibility: normalized.visibility,
      filters: normalized.filters,
    });
    const rowsById = new Map(canonicalRows.map(row => [row.eventId, row]));
    const results: AutomataBusSearchResultItem[] = [];
    const totalWeight = this.policy.semanticWeight + this.policy.lexicalWeight;
    for (const reference of boundedReferences) {
      const finding = rowsById.get(reference.eventId);
      if (!finding || !isAuthorizedFinding(finding, normalized.visibility, normalized.filters)) continue;
      results.push({
        ...finding,
        score: (
          score(reference.semanticScore) * this.policy.semanticWeight
          + score(reference.lexicalScore) * this.policy.lexicalWeight
        ) / totalWeight,
        ...(reference.semanticScore !== undefined ? { semanticScore: score(reference.semanticScore) } : {}),
        ...(reference.lexicalScore !== undefined ? { lexicalScore: score(reference.lexicalScore) } : {}),
      });
      if (results.length >= normalized.limit) break;
    }

    return {
      results,
      diagnostics: {
        cache: cacheState,
        semanticPath: semantic.path,
        indexState: semantic.state.indexState,
        reindexState: semantic.state.reindexState,
        modelIdentity: semantic.state.modelIdentity,
        indexingLag: { ...semantic.state.indexingLag },
      },
    };
  }

  async createSpawnBriefing(input: AutomataBusSearchInput): Promise<AutomataBusSpawnBriefing> {
    const search = await this.search({
      ...input,
      limit: Math.min(this.policy.maxBriefingItems, this.policy.maxSearchResults),
    });
    const header = 'Automata Bus briefing';
    let text = header.slice(0, this.policy.maxBriefingChars);
    let itemCount = 0;
    for (const result of search.results.slice(0, this.policy.maxBriefingItems)) {
      const claim = result.claim.length > this.policy.maxBriefingClaimChars
        ? `${result.claim.slice(0, Math.max(0, this.policy.maxBriefingClaimChars - 1))}…`
        : result.claim;
      const line = `\n- [${result.automatonClass}/${result.taskId}] ${claim}`;
      const remaining = this.policy.maxBriefingChars - text.length;
      if (remaining <= 1) break;
      text += line.slice(0, remaining);
      itemCount += 1;
      if (line.length > remaining) break;
    }
    return { text, itemCount, diagnostics: search.diagnostics };
  }
}
