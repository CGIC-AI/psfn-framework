import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { AppCache } from '../../../shared/cache/types.js';
import { AutomataBusIndexingService } from './indexing-service.js';
import {
  AutomataBusQueryService,
  type AutomataBusQueryPolicy,
} from './query-service.js';
import type {
  AutomataBusCanonicalFinding,
  AutomataBusCanonicalFindingPort,
  AutomataBusEmbeddingPort,
  AutomataBusIndexHealthPort,
  AutomataBusResultCachePort,
  AutomataBusVectorIndexPort,
  AutomataBusVectorIndexState,
} from './query-ports.js';
import { createAutomataBusResultCache } from './result-cache.js';

const MODEL = {
  provider: 'test-provider',
  model: 'test-model-v1',
  dimensions: 3,
} as const;

const READY_INDEX: AutomataBusVectorIndexState = {
  indexState: 'ready',
  reindexState: 'current',
  modelIdentity: MODEL,
  indexingLag: { pendingCount: 0 },
};

const POLICY: AutomataBusQueryPolicy = {
  maxQueryChars: 200,
  candidateLimit: 4,
  maxSearchResults: 2,
  maxBriefingItems: 2,
  maxBriefingChars: 130,
  maxBriefingClaimChars: 48,
  resultCacheTtlMs: 1_000,
  semanticWeight: 0.7,
  lexicalWeight: 0.3,
  exactFallbackEnabled: true,
};

function finding(
  eventId: string,
  overrides: Partial<AutomataBusCanonicalFinding> = {},
): AutomataBusCanonicalFinding {
  return {
    eventId,
    companionId: 'companion-a',
    sequence: 1,
    occurredAt: '2026-08-10T12:00:00.000Z',
    automatonClass: 'task-worker',
    taskId: 'task-a',
    runId: 'run-a',
    claim: `claim ${eventId}`,
    provenance: 'computed',
    verificationStatus: 'verified',
    audience: 'eligible-automata',
    sensitivity: 'personal',
    ...overrides,
  };
}

function createPorts(input: {
  findings?: readonly AutomataBusCanonicalFinding[];
  lexical?: readonly { eventId: string; score: number }[];
  approximate?: readonly { eventId: string; score: number }[];
  exact?: readonly { eventId: string; score: number }[];
  indexState?: AutomataBusVectorIndexState;
  cache?: AutomataBusResultCachePort;
} = {}): {
  canonical: AutomataBusCanonicalFindingPort;
  embeddings: AutomataBusEmbeddingPort;
  vector: AutomataBusVectorIndexPort;
} {
  const findings = input.findings ?? [];
  return {
    canonical: {
      searchLexical: vi.fn(async () => [...(input.lexical ?? [])]),
      getCurrentByEventIds: vi.fn(async ({ eventIds }) => (
        findings.filter(candidate => eventIds.includes(candidate.eventId))
      )),
    },
    embeddings: {
      identity: MODEL,
      embed: vi.fn(async () => new Float32Array([1, 0, 0])),
    },
    vector: {
      readState: vi.fn(async () => input.indexState ?? READY_INDEX),
      searchApproximate: vi.fn(async () => [...(input.approximate ?? [])]),
      searchExact: vi.fn(async () => [...(input.exact ?? [])]),
      upsert: vi.fn(async () => undefined),
    },
  };
}

function createService(
  ports: ReturnType<typeof createPorts>,
  cache?: AutomataBusResultCachePort,
): AutomataBusQueryService {
  return new AutomataBusQueryService({ ...ports, cache, policy: POLICY });
}

describe('AutomataBusQueryService', () => {
  it('bounds both retrieval paths and applies companion, filter, audience, and sensitivity gates before rendering', async () => {
    const candidates = [
      finding('allowed'),
      finding('too-sensitive', { sensitivity: 'confidential' }),
      finding('wrong-audience', { audience: 'operator' }),
      finding('wrong-companion', { companionId: 'companion-b' }),
      finding('wrong-class', { automatonClass: 'memory-retrieval' }),
      finding('too-old', { occurredAt: '2025-01-01T00:00:00.000Z' }),
    ];
    const ports = createPorts({
      findings: candidates,
      approximate: candidates.map((candidate, index) => ({
        eventId: candidate.eventId,
        score: 1 - index / 10,
      })),
      lexical: candidates.map((candidate, index) => ({
        eventId: candidate.eventId,
        score: 0.8 - index / 10,
      })),
    });
    const service = createService(ports);

    const result = await service.search({
      query: 'bounded knowledge',
      visibility: {
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      },
      filters: {
        automatonClasses: ['task-worker'],
        taskIds: ['task-a'],
        runIds: ['run-a'],
        occurredAfter: '2026-01-01T00:00:00.000Z',
        audiences: ['eligible-automata'],
        statuses: ['verified'],
      },
      limit: 100,
    });

    expect(ports.vector.searchApproximate).toHaveBeenCalledWith(expect.objectContaining({
      limit: POLICY.candidateLimit,
      visibility: expect.objectContaining({ companionId: 'companion-a' }),
    }));
    expect(ports.canonical.searchLexical).toHaveBeenCalledWith(expect.objectContaining({
      limit: POLICY.candidateLimit,
      visibility: expect.objectContaining({ maxSensitivity: 'personal' }),
    }));
    expect(ports.canonical.getCurrentByEventIds).toHaveBeenCalledWith(expect.objectContaining({
      eventIds: expect.any(Array),
      visibility: expect.objectContaining({ audience: 'eligible-automata' }),
    }));
    expect(result.results.map(item => item.eventId)).toEqual(['allowed']);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).not.toHaveProperty('embedding');
  });

  it('treats a cache miss or failure as acceleration loss and falls back to Postgres-backed paths', async () => {
    const ports = createPorts({
      findings: [finding('lexical')],
      lexical: [{ eventId: 'lexical', score: 0.8 }],
    });
    const cache: AutomataBusResultCachePort = {
      get: vi.fn(async () => { throw new Error('redis unavailable'); }),
      set: vi.fn(async () => { throw new Error('redis unavailable'); }),
    };

    const result = await createService(ports, cache).search({
      query: 'fallback',
      visibility: {
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      },
    });

    expect(ports.canonical.searchLexical).toHaveBeenCalledOnce();
    expect(ports.vector.searchApproximate).toHaveBeenCalledOnce();
    expect(result.results.map(item => item.eventId)).toEqual(['lexical']);
    expect(result.diagnostics.cache).toBe('error');
  });

  it('hydrates cache hits from canonical current findings and re-applies visibility before rendering', async () => {
    const ports = createPorts({
      findings: [
        finding('current'),
        finding('poisoned-cache-entry', { sensitivity: 'confidential' }),
      ],
    });
    const cache: AutomataBusResultCachePort = {
      get: vi.fn(async () => [
        { eventId: 'current', semanticScore: 0.9 },
        { eventId: 'poisoned-cache-entry', semanticScore: 1 },
      ]),
      set: vi.fn(async () => undefined),
    };

    const result = await createService(ports, cache).search({
      query: 'cached',
      visibility: {
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      },
    });

    expect(ports.vector.searchApproximate).not.toHaveBeenCalled();
    expect(ports.canonical.searchLexical).not.toHaveBeenCalled();
    expect(ports.canonical.getCurrentByEventIds).toHaveBeenCalledOnce();
    expect(result.results.map(item => item.eventId)).toEqual(['current']);
    expect(result.diagnostics.cache).toBe('hit');
    expect(result.diagnostics.semanticPath).toBe('cache');
  });

  it('falls back from ANN to bounded exact Postgres search, then lexical search', async () => {
    const ports = createPorts({
      findings: [finding('exact'), finding('lexical')],
      exact: [{ eventId: 'exact', score: 0.95 }],
      lexical: [{ eventId: 'lexical', score: 0.8 }],
    });
    vi.mocked(ports.vector.searchApproximate).mockRejectedValue(new Error('hnsw unavailable'));

    const result = await createService(ports).search({
      query: 'safe fallback',
      visibility: {
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      },
    });

    expect(ports.vector.searchExact).toHaveBeenCalledWith(expect.objectContaining({
      limit: POLICY.candidateLimit,
    }));
    expect(ports.canonical.searchLexical).toHaveBeenCalledOnce();
    expect(result.results.map(item => item.eventId)).toEqual(['exact', 'lexical']);
    expect(result.diagnostics.semanticPath).toBe('exact-fallback');
  });

  it('uses model-filtered exact Postgres search when index-health reads fail', async () => {
    const ports = createPorts({
      findings: [finding('exact')],
      exact: [{ eventId: 'exact', score: 0.95 }],
    });
    vi.mocked(ports.vector.readState).mockRejectedValue(new Error('index metadata unavailable'));

    const result = await createService(ports).search({
      query: 'health fallback',
      visibility: {
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      },
    });

    expect(ports.vector.searchApproximate).not.toHaveBeenCalled();
    expect(ports.vector.searchExact).toHaveBeenCalledWith(expect.objectContaining({
      modelIdentity: MODEL,
      limit: POLICY.candidateLimit,
    }));
    expect(result.results.map(item => item.eventId)).toEqual(['exact']);
    expect(result.diagnostics.semanticPath).toBe('exact-fallback');
    expect(result.diagnostics.indexState).toBe('unavailable');
  });

  it('keeps durable lexical findings available when embeddings fail', async () => {
    const ports = createPorts({
      findings: [finding('durable')],
      lexical: [{ eventId: 'durable', score: 0.9 }],
    });
    vi.mocked(ports.embeddings.embed).mockRejectedValue(new Error('embedding provider down'));

    const result = await createService(ports).search({
      query: 'durable truth',
      visibility: {
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      },
    });

    expect(ports.vector.searchApproximate).not.toHaveBeenCalled();
    expect(ports.vector.searchExact).not.toHaveBeenCalled();
    expect(result.results.map(item => item.eventId)).toEqual(['durable']);
    expect(result.diagnostics.semanticPath).toBe('embedding-unavailable');
  });

  it('never compares embeddings across model identity or incomplete reindex state', async () => {
    const ports = createPorts({
      findings: [finding('lexical')],
      lexical: [{ eventId: 'lexical', score: 0.9 }],
      indexState: {
        indexState: 'ready',
        reindexState: 'required',
        modelIdentity: { ...MODEL, model: 'old-model' },
        indexingLag: { pendingCount: 3, oldestPendingAt: '2026-08-10T10:00:00.000Z' },
      },
    });

    const result = await createService(ports).search({
      query: 'identity mismatch',
      visibility: {
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      },
    });

    expect(ports.embeddings.embed).not.toHaveBeenCalled();
    expect(ports.vector.searchApproximate).not.toHaveBeenCalled();
    expect(ports.vector.searchExact).not.toHaveBeenCalled();
    expect(result.diagnostics.semanticPath).toBe('reindex-required');
    expect(result.diagnostics.modelIdentity).toEqual({ ...MODEL, model: 'old-model' });
    expect(result.diagnostics.indexingLag.pendingCount).toBe(3);
  });

  it('bypasses cached scores while reindexing and rebuilds from canonical lexical state', async () => {
    const ports = createPorts({
      findings: [finding('current')],
      lexical: [{ eventId: 'current', score: 0.9 }],
      indexState: {
        indexState: 'building',
        reindexState: 'running',
        modelIdentity: MODEL,
        indexingLag: { pendingCount: 1 },
      },
    });
    const cache: AutomataBusResultCachePort = {
      get: vi.fn(async () => [{ eventId: 'stale', semanticScore: 1 }]),
      set: vi.fn(async () => undefined),
    };

    const result = await createService(ports, cache).search({
      query: 'reindexing',
      visibility: {
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      },
    });

    expect(ports.canonical.searchLexical).toHaveBeenCalledOnce();
    expect(ports.embeddings.embed).not.toHaveBeenCalled();
    expect(result.results.map(item => item.eventId)).toEqual(['current']);
    expect(result.diagnostics.semanticPath).toBe('reindex-required');
  });

  it('renders a bounded spawn briefing from already-authorized results', async () => {
    const longClaim = 'A'.repeat(200);
    const candidates = Array.from({ length: 8 }, (_, index) => finding(`item-${index}`, {
      claim: `${longClaim}-${index}`,
    }));
    const ports = createPorts({
      findings: candidates,
      lexical: candidates.map((candidate, index) => ({
        eventId: candidate.eventId,
        score: 1 - index / 100,
      })),
    });

    const briefing = await createService(ports).createSpawnBriefing({
      query: 'spawn task',
      visibility: {
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      },
    });

    expect(briefing.itemCount).toBeLessThanOrEqual(POLICY.maxBriefingItems);
    expect(briefing.text.length).toBeLessThanOrEqual(POLICY.maxBriefingChars);
    expect(briefing.text).not.toContain('Float32Array');
    expect(briefing.text).not.toContain('[1,0,0]');
  });
});

describe('AutomataBusIndexingService', () => {
  function healthPort(): AutomataBusIndexHealthPort {
    return {
      markIndexed: vi.fn(async () => undefined),
      markLagging: vi.fn(async () => undefined),
    };
  }

  it('records indexing lag without throwing away the durable finding when embedding fails', async () => {
    const ports = createPorts({ findings: [finding('durable')] });
    const health = healthPort();
    vi.mocked(ports.embeddings.embed).mockRejectedValue(new Error('provider unavailable'));
    const service = new AutomataBusIndexingService({
      embeddings: ports.embeddings,
      vector: ports.vector,
      health,
    });

    const result = await service.indexCurrentFinding(finding('durable'));

    expect(result.status).toBe('lagging');
    expect(result.modelIdentity).toEqual(MODEL);
    expect(ports.vector.upsert).not.toHaveBeenCalled();
    expect(health.markLagging).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'durable',
      stage: 'embedding',
      modelIdentity: MODEL,
    }));
  });

  it('surfaces a lag-health persistence failure instead of claiming lag was recorded', async () => {
    const ports = createPorts({ findings: [finding('durable-health-failure')] });
    const health = healthPort();
    vi.mocked(ports.embeddings.embed).mockRejectedValue(new Error('provider unavailable'));
    vi.mocked(health.markLagging).mockRejectedValue(new Error('lag health write failed'));
    const service = new AutomataBusIndexingService({
      embeddings: ports.embeddings,
      vector: ports.vector,
      health,
    });

    await expect(service.indexCurrentFinding(finding('durable-health-failure')))
      .rejects.toThrow('lag health write failed');

    expect(ports.vector.upsert).not.toHaveBeenCalled();
    expect(health.markLagging).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'durable-health-failure',
      stage: 'embedding',
    }));
  });

  it('writes derived vectors with explicit model identity and clears lag only after success', async () => {
    const ports = createPorts({ findings: [finding('indexed')] });
    const health = healthPort();
    const service = new AutomataBusIndexingService({
      embeddings: ports.embeddings,
      vector: ports.vector,
      health,
    });

    const result = await service.indexCurrentFinding(finding('indexed'));

    expect(result.status).toBe('indexed');
    expect(ports.vector.upsert).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'indexed',
      modelIdentity: MODEL,
      embedding: expect.any(Float32Array),
    }));
    expect(health.markIndexed).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'indexed',
      modelIdentity: MODEL,
    }));
  });

  it('surfaces an indexed-health persistence failure after retaining the derived vector', async () => {
    const ports = createPorts({ findings: [finding('indexed-health-failure')] });
    const health = healthPort();
    vi.mocked(health.markIndexed).mockRejectedValue(new Error('indexed health write failed'));
    const service = new AutomataBusIndexingService({
      embeddings: ports.embeddings,
      vector: ports.vector,
      health,
    });

    await expect(service.indexCurrentFinding(finding('indexed-health-failure')))
      .rejects.toThrow('indexed health write failed');

    expect(ports.vector.upsert).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'indexed-health-failure',
      modelIdentity: MODEL,
    }));
    expect(health.markIndexed).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'indexed-health-failure',
    }));
  });
});

describe('Automata Bus query isolation', () => {
  it('does not import or call the ordinary companion memory retrieval lane', () => {
    const sourceFiles = [
      'query-ports.ts',
      'query-service.ts',
      'indexing-service.ts',
      'result-cache.ts',
    ];
    for (const file of sourceFiles) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/faculties\/memory\/(?:retrieval|active-context)/u);
      expect(source).not.toContain('searchMemories');
    }
  });
});

describe('createAutomataBusResultCache', () => {
  it('stores only scored references with the configured Redis/AppCache TTL', async () => {
    let storedValue = '';
    const cache: AppCache = {
      backend: 'redis',
      name: 'test-redis',
      get: vi.fn(async () => storedValue || null),
      set: vi.fn(async (_key, value) => { storedValue = value; }),
      delete: vi.fn(async () => false),
      invalidatePrefix: vi.fn(async () => 0),
      getStats: () => ({ hits: 0, misses: 0, sets: 0, deletes: 0, invalidations: 0, errors: 0 }),
    };
    const resultCache = createAutomataBusResultCache(cache);

    await resultCache.set('key', [{ eventId: 'event-a', semanticScore: 0.9 }], 1_000);

    expect(cache.set).toHaveBeenCalledWith(
      'key',
      '[{"eventId":"event-a","semanticScore":0.9}]',
      { ttlMs: 1_000 },
    );
    expect(storedValue).not.toContain('claim');
    expect(storedValue).not.toContain('embedding');
    await expect(resultCache.get('key')).resolves.toEqual([
      { eventId: 'event-a', semanticScore: 0.9 },
    ]);
  });

  it('rejects poisoned cache fields so the query service can fall back to Postgres', async () => {
    const cache: AppCache = {
      backend: 'redis',
      name: 'test-redis',
      get: vi.fn(async () => '[{"eventId":"event-a","semanticScore":0.9,"claim":"poison"}]'),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => false),
      invalidatePrefix: vi.fn(async () => 0),
      getStats: () => ({ hits: 0, misses: 0, sets: 0, deletes: 0, invalidations: 0, errors: 0 }),
    };

    await expect(createAutomataBusResultCache(cache).get('key'))
      .rejects.toThrow('unknown fields');
  });
});
