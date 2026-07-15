import { describe, expect, it } from 'vitest';
import type { PurrMemory } from '../types.js';
import { selectWithinRelevanceAndTokenBudget } from './budget.js';
import type { ScoredMemory } from './types.js';

function scored(id: string, type: PurrMemory['type'], score: number): ScoredMemory {
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
  });
});
