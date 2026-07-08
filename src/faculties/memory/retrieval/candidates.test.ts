import { describe, expect, it } from 'vitest';
import type { MemoryStorePort } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import { collectRecentLexicalMemoryCandidates } from './candidates.js';

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
    listActiveMemories: async () => memories,
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
