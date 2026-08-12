import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { EmbeddingProviderPort } from '../../../shared/contracts/embedding-provider.js';
import type { AppCache } from '../../../shared/cache/types.js';
import { loadAutomataPolicySeedDefaults } from '../../../system/config/automata-policy-config.js';
import type {
  AutomataBusSqlClient,
  AutomataBusSqlPool,
  PersistedAutomataBusCurrentFinding,
} from './postgres-store.js';
import {
  createAutomataBusProductionRuntime,
  type AutomataBusCanonicalHydrationStore,
} from './production-runtime.js';

function pool(): AutomataBusSqlPool {
  const client: AutomataBusSqlClient = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: vi.fn(async () => client),
  };
}

function store(): AutomataBusCanonicalHydrationStore {
  return {
    readCurrentFindingsByEventIds: vi.fn(async (): Promise<PersistedAutomataBusCurrentFinding[]> => []),
  };
}

function embeddings(dims = 3): EmbeddingProviderPort {
  return {
    dims,
    embed: vi.fn(async () => new Float32Array(dims)),
    embedBatch: vi.fn(async texts => texts.map(() => new Float32Array(dims))),
  };
}

function cache(backend: AppCache['backend']): AppCache {
  return {
    backend,
    name: 'test-cache',
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => false),
    invalidatePrefix: vi.fn(async () => 0),
    getStats: () => ({ hits: 0, misses: 0, sets: 0, deletes: 0, invalidations: 0, errors: 0 }),
  };
}

describe('createAutomataBusProductionRuntime', () => {
  it('binds the configured embedding identity and reports optional cache/ANN lifecycle honestly', () => {
    const policy = loadAutomataPolicySeedDefaults().bus.query;
    const configured = createAutomataBusProductionRuntime({
      pool: pool(),
      store: store(),
      companionId: 'companion-a',
      embeddingProvider: embeddings(),
      embeddingIdentity: { provider: 'api', model: 'embedding-v1', dimensions: 3 },
      appCache: cache('redis'),
      policy,
    });
    expect(configured.describeComposition()).toEqual({
      embeddingIdentity: { provider: 'api', model: 'embedding-v1', dimensions: 3 },
      resultCache: 'redis',
      annLifecycle: 'readiness-reported',
      annIndexName: 'automata_bus_finding_vectors_hnsw_3',
    });

    const missingCache = createAutomataBusProductionRuntime({
      pool: pool(),
      store: store(),
      companionId: 'companion-a',
      embeddingProvider: embeddings(),
      embeddingIdentity: { provider: 'api', model: 'embedding-v1', dimensions: 3 },
      policy,
    });
    expect(missingCache.describeComposition().resultCache).toBe('unavailable');
  });

  it('fails closed when the configured provider and declared identity differ', () => {
    expect(() => createAutomataBusProductionRuntime({
      pool: pool(),
      store: store(),
      companionId: 'companion-a',
      embeddingProvider: embeddings(2),
      embeddingIdentity: { provider: 'api', model: 'embedding-v1', dimensions: 3 },
      policy: loadAutomataPolicySeedDefaults().bus.query,
    })).toThrow('dimension mismatch');
  });

  it('does not import or invoke the ordinary memory retrieval path', () => {
    const sources = [
      'src/faculties/automata/bus/production-runtime.ts',
      'src/faculties/automata/bus/query-service.ts',
      'src/faculties/automata/bus/indexing-service.ts',
    ].map(path => readFileSync(path, 'utf8')).join('\n');
    expect(sources).not.toMatch(/faculties\/memory\/retrieval|MemoryRetriever|\.retrieve\(/u);
  });
});
