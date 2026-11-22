import { describe, expect, it, vi } from 'vitest';
import { createDefaultMemoryRetrievalPolicy } from '../../../system/config/memory-retrieval-policy.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import {
  collectRecentLexicalMemoryCandidates,
  fuseHybridMemoryCandidates,
} from './candidates.js';

function makeMemory(id: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text: 'The greenhouse irrigation schedule needs recalibrating tomorrow',
    type: 'semantic',
    importance: 0.7,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.6,
    sourceRef: `api:test:${id}`,
    extractedAt: Date.UTC(2026, 0, 5, 12, 0, 0),
    lastAccessed: Date.UTC(2026, 0, 5, 12, 0, 0),
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    ...overrides,
  };
}

function makeStore(memories: PurrMemory[]): MemoryStorePort {
  return {
    listActiveMemories: async options => memories.slice(
      options?.offset ?? 0,
      (options?.offset ?? 0) + (options?.limit ?? memories.length),
    ),
  } as unknown as MemoryStorePort;
}

describe('collectRecentLexicalMemoryCandidates only-scope filtering', () => {
  const contextText = 'greenhouse irrigation schedule recalibrating';

  it('requires both refs and tags for only-scope queries that specify both', async () => {
    const matchingBoth = makeMemory('scoped-both', {
      scopeRef: { kind: 'project', id: 'greenhouse' },
      scopeTags: ['project:greenhouse'],
    });
    const refOnly = makeMemory('scoped-ref-only', {
      scopeRef: { kind: 'project', id: 'greenhouse' },
      scopeTags: [],
    });
    const tagOnly = makeMemory('scoped-tag-only', {
      scopeTags: ['project:greenhouse'],
    });
    const unscoped = makeMemory('unscoped');

    const candidates = await collectRecentLexicalMemoryCandidates({
      memoryStore: makeStore([matchingBoth, refOnly, tagOnly, unscoped]),
      contextText,
      existingIds: new Set(),
      scopeQuery: {
        refs: [{ kind: 'project', id: 'greenhouse' }],
        tags: ['project:greenhouse'],
        mode: 'only',
      },
    });

    expect(candidates.map(candidate => candidate.id)).toEqual(['scoped-both']);
  });

  it('keeps single-dimension only-scope queries working', async () => {
    const refScoped = makeMemory('ref-scoped', {
      scopeRef: { kind: 'project', id: 'greenhouse' },
    });
    const other = makeMemory('other-scope', {
      scopeRef: { kind: 'project', id: 'atrium' },
    });

    const candidates = await collectRecentLexicalMemoryCandidates({
      memoryStore: makeStore([refScoped, other]),
      contextText,
      existingIds: new Set(),
      scopeQuery: {
        refs: [{ kind: 'project', id: 'greenhouse' }],
        mode: 'only',
      },
    });

    expect(candidates.map(candidate => candidate.id)).toEqual(['ref-scoped']);
  });

  it('does not scope-filter prefer-mode queries', async () => {
    const unscoped = makeMemory('prefer-unscoped');

    const candidates = await collectRecentLexicalMemoryCandidates({
      memoryStore: makeStore([unscoped]),
      contextText,
      existingIds: new Set(),
      scopeQuery: {
        refs: [{ kind: 'project', id: 'greenhouse' }],
        tags: ['project:greenhouse'],
        mode: 'prefer',
      },
    });

    expect(candidates.map(candidate => candidate.id)).toEqual(['prefer-unscoped']);
  });
});

describe('collectRecentLexicalMemoryCandidates bounded pagination', () => {
  const contextText = 'greenhouse irrigation schedule recalibrating';

  it('can recover a matching memory beyond the former newest-96 boundary', async () => {
    const memories = Array.from({ length: 120 }, (_, index) => makeMemory(
      `memory-${index}`,
      index === 110
        ? {}
        : { text: `Unrelated archive entry number ${index}`, tags: [] },
    ));

    const candidates = await collectRecentLexicalMemoryCandidates({
      memoryStore: makeStore(memories),
      contextText,
      existingIds: new Set(),
      scopeQuery: undefined,
    });

    expect(candidates.map(candidate => candidate.id)).toContain('memory-110');
  });

  it('reads deterministic ordered pages and never exceeds the configured scan bound', async () => {
    const memories = Array.from({ length: 200 }, (_, index) => makeMemory(
      `ordered-${index}`,
      index === 110
        ? {}
        : { text: `Unrelated archive entry number ${index}`, tags: [] },
    ));
    const listActiveMemories = vi.fn(async (options?: { limit?: number; offset?: number }) => (
      memories.slice(
        options?.offset ?? 0,
        (options?.offset ?? 0) + (options?.limit ?? memories.length),
      )
    ));
    const policy = createDefaultMemoryRetrievalPolicy();
    policy.lexicalAugment = {
      pageSize: 50,
      maxScan: 120,
      selectedLimit: 12,
      minOverlap: 2,
      baseSimilarity: 0.62,
    };

    const candidates = await collectRecentLexicalMemoryCandidates({
      memoryStore: { listActiveMemories } as unknown as MemoryStorePort,
      contextText,
      existingIds: new Set(),
      scopeQuery: undefined,
      memoryRetrievalPolicy: policy,
    });

    expect(listActiveMemories.mock.calls.map(([options]) => options)).toEqual([
      { limit: 50, offset: 0 },
      { limit: 50, offset: 50 },
      { limit: 20, offset: 100 },
    ]);
    expect(candidates.map(candidate => candidate.id)).toContain('ordered-110');
    expect(listActiveMemories).not.toHaveBeenCalledWith(expect.objectContaining({ offset: 120 }));
  });

  it('calibrates lexical-augment similarity to embedding scale so augment hits do not outrank stronger semantic hits (d5e0p.19)', async () => {
    const augmentMemory = makeMemory('augment-recent', {
      text: 'The greenhouse irrigation schedule needs recalibrating tomorrow morning',
      importance: 0.9,
      salience: 0.9,
    });
    const augmentCandidates = await collectRecentLexicalMemoryCandidates({
      memoryStore: makeStore([augmentMemory]),
      contextText,
      existingIds: new Set(),
      scopeQuery: undefined,
    });

    expect(augmentCandidates).toHaveLength(1);
    expect(augmentCandidates[0]?.retrievalChannel).toBe('lexical_augment');
    expect(augmentCandidates[0]?.similarity).toBeLessThanOrEqual(0.58);

    const strongSemantic = {
      ...makeMemory('semantic-strong', {
        text: 'Strong semantic match on irrigation pump pressure.',
      }),
      similarity: 0.72,
      retrievalChannel: 'embedding' as const,
    };
    const fused = fuseHybridMemoryCandidates({
      embedding: [strongSemantic],
      fts: [],
      lexicalAugment: augmentCandidates,
    });

    expect(fused.map(candidate => candidate.id)).toEqual(['semantic-strong', 'augment-recent']);
    expect(fused[0]?.similarity).toBe(0.72);
    expect(fused[1]?.retrievalChannel).toBe('lexical_augment');
  });
});
