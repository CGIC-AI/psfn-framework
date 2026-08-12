import type { AppCache } from '../../../shared/cache/types.js';
import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { AutomataBusQueryOwnerPolicy } from '../registry-contract.js';
import { AutomataBusIndexingService } from './indexing-service.js';
import { PostgresAutomataBusCanonicalFindingAdapter } from './postgres-canonical-query.js';
import {
  automataBusAnnIndexName,
} from './postgres-schema.js';
import type {
  AutomataBusSqlPool,
  PersistedAutomataBusCurrentFinding,
} from './postgres-store.js';
import { PostgresAutomataBusVectorIndexAdapter } from './postgres-vector-index.js';
import {
  normalizeAutomataBusEmbeddingIdentity,
} from './postgres-query-sql.js';
import type {
  AutomataBusCanonicalFindingPort,
  AutomataBusEmbeddingIdentity,
  AutomataBusEmbeddingPort,
} from './query-ports.js';
import {
  AutomataBusQueryService,
  type AutomataBusQueryPolicy,
} from './query-service.js';
import { createAutomataBusResultCache } from './result-cache.js';

export interface AutomataBusCanonicalHydrationStore {
  readCurrentFindingsByEventIds(input: {
    companionId: string;
    audience: 'eligible-automata' | 'operator';
    maxSensitivity: 'public' | 'personal' | 'intimate' | 'confidential';
    eventIds: readonly string[];
  }): Promise<PersistedAutomataBusCurrentFinding[]>;
}

interface AutomataBusProductionRuntimeComposition {
  embeddingIdentity: AutomataBusEmbeddingIdentity;
  resultCache: 'disabled' | 'memory' | 'redis' | 'unavailable';
  /** HNSW readiness is observed; unavailable ANN degrades to bounded exact search. */
  annLifecycle: 'readiness-reported';
  annIndexName: string;
}

export interface AutomataBusProductionRuntime {
  query: AutomataBusQueryService;
  indexing: AutomataBusIndexingService;
  canonical: AutomataBusCanonicalFindingPort;
  vector: PostgresAutomataBusVectorIndexAdapter;
  describeComposition(): AutomataBusProductionRuntimeComposition;
}

export interface CreateAutomataBusProductionRuntimeOptions {
  pool: AutomataBusSqlPool;
  store: AutomataBusCanonicalHydrationStore;
  companionId: string;
  /** The configured usage-accounted provider, or its accounted gateway RPC facade. */
  embeddingProvider: EmbeddingProviderPort;
  embeddingIdentity: AutomataBusEmbeddingIdentity;
  appCache?: AppCache;
  policy: AutomataBusQueryOwnerPolicy;
}

function createEmbeddingPort(
  provider: EmbeddingProviderPort,
  identityInput: AutomataBusEmbeddingIdentity,
): AutomataBusEmbeddingPort {
  const identity = normalizeAutomataBusEmbeddingIdentity(identityInput);
  if (provider.dims !== identity.dimensions) {
    throw new Error(
      `Automata Bus embedding dimension mismatch: provider exposes ${provider.dims}, `
      + `identity declares ${identity.dimensions}`,
    );
  }
  return {
    identity,
    embed: (text, options) => provider.embed(text, options),
  };
}

function toQueryPolicy(policy: AutomataBusQueryOwnerPolicy): AutomataBusQueryPolicy {
  return {
    maxQueryChars: policy.maxQueryChars,
    candidateLimit: policy.candidateLimit,
    maxSearchResults: policy.maxSearchResults,
    maxBriefingItems: policy.maxBriefingItems,
    maxBriefingChars: policy.maxBriefingChars,
    maxBriefingClaimChars: policy.maxBriefingClaimChars,
    resultCacheTtlMs: policy.resultCacheTtlMs,
    semanticWeight: policy.semanticWeight,
    lexicalWeight: policy.lexicalWeight,
    exactFallbackEnabled: policy.exactFallbackEnabled,
  };
}

export function createAutomataBusProductionRuntime(
  options: CreateAutomataBusProductionRuntimeOptions,
): AutomataBusProductionRuntime {
  const embeddings = createEmbeddingPort(options.embeddingProvider, options.embeddingIdentity);
  const canonical = new PostgresAutomataBusCanonicalFindingAdapter({
    pool: options.pool,
    store: options.store,
    maxCandidateLimit: options.policy.candidateLimit,
  });
  const vector = new PostgresAutomataBusVectorIndexAdapter(options.pool, {
    companionId: options.companionId,
    maxCandidateLimit: options.policy.candidateLimit,
  });
  const cache = options.policy.resultCacheEnabled && options.appCache
    ? createAutomataBusResultCache(options.appCache)
    : undefined;
  const query = new AutomataBusQueryService({
    canonical,
    embeddings,
    vector,
    ...(cache ? { cache } : {}),
    policy: toQueryPolicy(options.policy),
  });
  const indexing = new AutomataBusIndexingService({
    embeddings,
    vector,
    health: vector,
  });
  const composition: AutomataBusProductionRuntimeComposition = {
    embeddingIdentity: { ...embeddings.identity },
    resultCache: options.policy.resultCacheEnabled
      ? options.appCache?.backend ?? 'unavailable'
      : 'disabled',
    annLifecycle: 'readiness-reported',
    annIndexName: automataBusAnnIndexName(embeddings.identity.dimensions),
  };
  return {
    query,
    indexing,
    canonical,
    vector,
    describeComposition: () => ({
      ...composition,
      embeddingIdentity: { ...composition.embeddingIdentity },
    }),
  };
}
