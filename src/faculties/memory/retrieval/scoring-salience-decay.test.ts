import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateEffectiveMemorySalience } from '../decay.js';
import type { PurrMemory } from '../types.js';
import { computeRetrievalScore } from './scoring.js';

function makeMemory(overrides: Partial<PurrMemory> = {}): PurrMemory & { similarity: number } {
  return {
    id: 'lazy-decay-memory',
    text: 'A useful old memory',
    type: 'episodic',
    importance: 0.8,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 1,
    sourceRef: 'test:lazy-decay',
    extractedAt: 1_700_000_000_000,
    lastAccessed: 1_700_000_000_000,
    accessCount: 1,
    tags: [],
    similarity: 0.9,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('retrieval salience decay', () => {
  it('scores with live decay from lastAccessed instead of the stored salience snapshot', () => {
    const now = 1_700_000_000_000 + 30 * 24 * 60 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const memory = makeMemory();

    const result = computeRetrievalScore(memory, 'useful old memory', {
      moodCongruenceWeight: 0,
    });

    expect(calculateEffectiveMemorySalience(memory, now)).toBeCloseTo(0.5, 10);
    expect(result.effectiveSalience).toBeCloseTo(0.5, 10);
  });

  it('preserves stored salience when the decay timestamp is invalid', () => {
    vi.setSystemTime(new Date('2026-07-14T12:00:00.000Z'));
    const memory = makeMemory({
      salience: 0.73,
      lastAccessed: Number.NaN,
    });

    expect(calculateEffectiveMemorySalience(memory)).toBe(0.73);
    expect(computeRetrievalScore(memory, 'remember this', {
      moodCongruenceWeight: 0,
    }).effectiveSalience).toBe(0.73);
  });
});
