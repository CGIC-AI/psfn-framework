import { describe, expect, it, vi } from 'vitest';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import type {
  MemoryStorePort,
  MemorySubjectAdminQuery,
} from '../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../faculties/memory/types.js';
import { createSelfStatusMemoryStatsProvider } from './self-status-memory-stats.js';

function memory(id: string, type: PurrMemory['type'], salience: number): PurrMemory {
  return {
    id,
    text: 'content must not reach self_status output',
    type,
    importance: 0.8,
    confidence: 0.9,
    emotionalValence: 0,
    salience,
    sourceRef: 'test:self-status',
    extractedAt: 1,
    lastAccessed: 1,
    accessCount: 0,
    tags: [],
    sensitivity: 'low',
    consentFlags: {},
  };
}

describe('self_status memory statistics provider', () => {
  it('uses only trusted runtime subject context and fails closed without it', async () => {
    const rawGetStats = vi.fn(async () => ({
      total: 99,
      byType: { semantic: 99 },
      avgSalience: 0.99,
    }));
    const authorizedMemories = [
      { ...memory('visible-semantic', 'semantic', 0.2), similarity: 0 },
      { ...memory('visible-procedural', 'procedural', 0.8), similarity: 0 },
    ];
    const aggregateAuthorizedMemorySubjects = vi.fn(async (input: MemorySubjectAdminQuery) => {
      if (input.selector.kind !== 'stats') throw new Error(`unexpected selector ${input.selector.kind}`);
      const byType: Record<string, number> = {};
      let salienceSum = 0;
      for (const authorized of authorizedMemories) {
        byType[authorized.type] = (byType[authorized.type] ?? 0) + 1;
        salienceSum += authorized.salience;
      }
      return {
        kind: 'stats' as const,
        stats: {
          total: authorizedMemories.length,
          byType,
          avgSalience: salienceSum / authorizedMemories.length,
        },
      };
    });
    const provider = createSelfStatusMemoryStatsProvider({
      getStats: rawGetStats,
      aggregateAuthorizedMemorySubjects,
    } as unknown as MemoryStorePort);

    await expect(provider()).resolves.toEqual({ total: 0, byType: {}, avgSalience: 0 });
    expect(aggregateAuthorizedMemorySubjects).not.toHaveBeenCalled();

    await expect(runWithRequestContext({
      viewerMemorySubjectContactId: 'contact-a',
    }, provider)).resolves.toEqual({
      total: 2,
      byType: { semantic: 1, procedural: 1 },
      avgSalience: 0.5,
    });
    // getStats now flows through the subject-authorized SQL aggregate (a27w.5).
    expect(aggregateAuthorizedMemorySubjects).toHaveBeenCalledWith(expect.objectContaining({
      authorization: expect.objectContaining({
        action: 'count',
        viewerContactIds: ['contact-a'],
      }),
      selector: { kind: 'stats' },
    }));
    expect(rawGetStats).not.toHaveBeenCalled();
  });
});
