import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PurrMemory } from '../types.js';
import {
  computeRetrievalRecencyBoost,
  computeRetrievalScore,
} from './scoring.js';
import { selectWithinRelevanceAndTokenBudget } from './budget.js';

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1_000;

function makeMemory(
  id: string,
  overrides: Partial<PurrMemory & { similarity: number }> = {},
): PurrMemory & { similarity: number } {
  return {
    id,
    text: 'A contextually relevant memory with enough matching detail',
    type: 'semantic',
    importance: 0.8,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.8,
    sourceRef: `test:${id}`,
    provenanceRefs: [`session:${id}`],
    extractedAt: NOW,
    lastAccessed: NOW,
    accessCount: 1,
    tags: [],
    sensitivity: 'personal',
    similarity: 0.8,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('settings-owned retrieval scoring policy', () => {
  it('ranks a strongly matching two-year-old emotional landmark ahead of a fresh weak match', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const landmark = makeMemory('landmark', {
      type: 'emotional',
      emotionalValence: 0.9,
      formationVAD: { valence: 0.9, arousal: 0.9, dominance: 0.3 },
      importance: 0.95,
      salience: 1,
      similarity: 0.95,
      extractedAt: NOW - (2 * 365 * DAY_MS),
      lastAccessed: NOW - (2 * 365 * DAY_MS),
    });
    const freshWeakMatch = makeMemory('fresh', {
      importance: 0.5,
      salience: 0.6,
      similarity: 0.4,
    });

    const landmarkScore = computeRetrievalScore(landmark, 'contextually relevant memory', {
      moodCongruenceWeight: 0,
      taskKind: 'chat',
    });
    const freshScore = computeRetrievalScore(freshWeakMatch, 'contextually relevant memory', {
      moodCongruenceWeight: 0,
      taskKind: 'chat',
    });

    expect(landmarkScore.effectiveSalience).toBeGreaterThanOrEqual(0.565);
    expect(landmarkScore.score).toBeGreaterThan(freshScore.score);
    const ranked = [
      { memory: landmark, ...landmarkScore },
      { memory: freshWeakMatch, ...freshScore },
    ].sort((left, right) => right.score - left.score);
    const selection = selectWithinRelevanceAndTokenBudget(ranked, 10_000, 1);
    expect(selection.selected[0]?.memory.id).toBe('landmark');
  });

  it('floors default recency but preserves sharp temporal recency', () => {
    const twoYearsAgo = NOW - (2 * 365 * DAY_MS);

    expect(computeRetrievalRecencyBoost(twoYearsAgo, NOW, false)).toBe(0.35);
    expect(computeRetrievalRecencyBoost(twoYearsAgo, NOW, true)).toBeLessThan(0.01);
  });

  it('applies the procedural task prior only for deterministic task context', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const procedural = makeMemory('procedure', { type: 'procedural' });

    const casual = computeRetrievalScore(procedural, 'contextually relevant memory', {
      moodCongruenceWeight: 0,
      taskKind: 'chat',
    });
    const task = computeRetrievalScore(procedural, 'contextually relevant memory', {
      moodCongruenceWeight: 0,
      taskKind: 'maintenance',
    });

    expect(task.score / casual.score).toBeCloseTo(2, 10);
  });
});
