import { describe, expect, it } from 'vitest';
import type { PurrMemory } from '../types.js';
import { resolveGuaranteedSelectionFloor, selectWithinRelevanceAndTokenBudget } from './budget.js';
import type { ScoredMemory } from './types.js';
import { createDefaultMemoryRetrievalPolicy } from '../../../system/config/memory-retrieval-policy.js';

function scored(
  id: string,
  type: PurrMemory['type'],
  score: number,
  retrievalChannel?: 'embedding' | 'fts' | 'lexical_augment',
): ScoredMemory {
  return {
    memory: {
      id,
      text: `Short ${type} memory ${id}`,
      type,
      importance: 0.8,
      confidence: 0.9,
      emotionalValence: 0,
      salience: 0.8,
      sourceRef: `test:${id}`,
      extractedAt: 1,
      lastAccessed: 1,
      accessCount: 0,
      tags: [],
      sensitivity: 'personal',
      similarity: 0.8,
      ...(retrievalChannel ? { retrievalChannel } : {}),
    },
    baseScore: score,
    evidenceSupport: 1,
    contradictionPenaltyMultiplier: 1,
    explicitlyQueried: false,
    lowConfidenceSingleSourceSuppressed: false,
    quietPreferenceSuppressed: false,
    preferenceContextBoost: 1,
    evidenceSourceCount: 1,
    privacyRisk: 0,
    privacyPenalty: 0,
    privacyBreakdown: {
      sensitivity: 0,
      tagBoost: 0,
      sourceContextAdjustment: 0,
      consentBoost: 0,
    },
    retrievalModeExcluded: false,
    score,
  };
}

describe('score-guaranteed selection floor honours the owned policy', () => {
  it('uses the default scoreGuaranteeMinK when no override is provided', () => {
    // Default MEMORY_RETRIEVAL_MIN_ITEMS is lower than the guarantee, so a
    // rescued set lifts the floor up to scoreGuaranteeMinK (default 3).
    expect(resolveGuaranteedSelectionFloor(10, 1)).toBe(3);
  });

  it('honours a tuned scoreGuaranteeMinK from the memory retrieval policy', () => {
    const policy = createDefaultMemoryRetrievalPolicy();
    policy.scoreGuaranteeMinK = 6;
    expect(resolveGuaranteedSelectionFloor(10, 1, policy)).toBe(6);
    // No rescue → guarantee does not apply regardless of the tuned value.
    expect(resolveGuaranteedSelectionFloor(10, 0, policy)).toBeLessThan(6);
  });
});

describe('memory retrieval selection caps', () => {
  it('caps reflections and procedurals at two without starving later eligible engrams', () => {
    const ranked = [
      scored('reflection-1', 'reflection', 1),
      scored('reflection-2', 'reflection', 0.99),
      scored('reflection-3', 'reflection', 0.98),
      scored('procedural-1', 'procedural', 0.97),
      scored('procedural-2', 'procedural', 0.96),
      scored('procedural-3', 'procedural', 0.95),
      scored('emotional-landmark', 'emotional', 0.94),
      scored('episodic-landmark', 'episodic', 0.93),
    ];

    const result = selectWithinRelevanceAndTokenBudget(ranked, 10_000, 3);
    const selectedTypes = result.selected.map(item => item.memory.type);

    expect(selectedTypes.filter(type => type === 'reflection')).toHaveLength(2);
    expect(selectedTypes.filter(type => type === 'procedural')).toHaveLength(2);
    expect(result.selected.map(item => item.memory.id)).toContain('emotional-landmark');
    expect(result.selected.map(item => item.memory.id)).toContain('episodic-landmark');
  });

  it('enforces caps even while satisfying the minimum selection floor', () => {
    const ranked = [
      scored('reflection-1', 'reflection', 1),
      scored('reflection-2', 'reflection', 0.99),
      scored('reflection-3', 'reflection', 0.98),
      scored('semantic-1', 'semantic', 0.4),
    ];

    const result = selectWithinRelevanceAndTokenBudget(ranked, 0, 3);

    expect(result.selected.map(item => item.memory.id)).toEqual([
      'reflection-1',
      'reflection-2',
      'semantic-1',
    ]);
    expect(result.selectionCapSkippedCount).toBe(1);
    expect(result.selectionCapSkippedByType).toEqual({ reflection: 1 });
  });

  it('prevents an augment-topped or reflection-capped outlier from crushing semantic recall and counts cap skips (d5e0p.19)', () => {
    const ranked = [
      scored('augment-top', 'reflection', 0.95, 'lexical_augment'),
      scored('reflection-2', 'reflection', 0.82, 'embedding'),
      scored('reflection-3', 'reflection', 0.78, 'embedding'),
      scored('reflection-4', 'reflection', 0.74, 'embedding'),
      scored('semantic-1', 'semantic', 0.16, 'embedding'),
      scored('semantic-2', 'semantic', 0.12, 'embedding'),
      scored('semantic-3', 'semantic', 0.08, 'embedding'),
      scored('semantic-4', 'semantic', 0.05, 'embedding'),
    ];

    const result = selectWithinRelevanceAndTokenBudget(ranked, 10_000, 1);

    expect(result.selectionCapSkippedCount).toBe(2);
    expect(result.selectionCapSkippedByType).toEqual({ reflection: 2 });
    const selectedIds = result.selected.map(item => item.memory.id);
    expect(selectedIds).toContain('semantic-1');
    expect(selectedIds).toContain('semantic-2');
    expect(selectedIds).toContain('semantic-3');
    expect(selectedIds).toContain('semantic-4');
  });
});
