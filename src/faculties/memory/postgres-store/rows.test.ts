import { describe, it, expect } from 'vitest';
import { toMemoryRow, fromMemoryRow } from './rows.js';
import type { PurrMemory } from '../types.js';

function baseMemory(overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    text: 'a memory',
    type: 'emotional',
    importance: 0.5,
    confidence: 0.8,
    emotionalValence: -0.4,
    salience: 0.5,
    sourceRef: 'tool:memory_write',
    extractedAt: 1000,
    lastAccessed: 1000,
    accessCount: 1,
    tags: [],
    sensitivity: 'personal',
    ...overrides,
  };
}

describe('memory row emotional_texture round-trip (031.11.1)', () => {
  it('persists and restores the multi-signal emotional texture', () => {
    const memory = baseMemory({
      formationVAD: { valence: -0.4, arousal: 0.3, dominance: 0.1 },
      emotionalTexture: { discrete: { love: 0.7, sadness: 0.55 }, confidence: 0.82 },
    });
    const row = toMemoryRow(memory);
    expect(row.emotional_texture).toEqual({ discrete: { love: 0.7, sadness: 0.55 }, confidence: 0.82 });
    const restored = fromMemoryRow(row);
    expect(restored.emotionalTexture).toEqual({ discrete: { love: 0.7, sadness: 0.55 }, confidence: 0.82 });
    // The VAD vector still round-trips independently.
    expect(restored.formationVAD).toEqual({ valence: -0.4, arousal: 0.3, dominance: 0.1 });
  });

  it('encodes a null texture column and restores it as undefined when absent', () => {
    const row = toMemoryRow(baseMemory());
    expect(row.emotional_texture).toBeNull();
    expect(fromMemoryRow(row).emotionalTexture).toBeUndefined();
  });

  it('restores undefined from a legacy row missing the column entirely', () => {
    const row = { ...toMemoryRow(baseMemory()) } as Record<string, unknown>;
    delete row.emotional_texture;
    expect(fromMemoryRow(row as never).emotionalTexture).toBeUndefined();
  });
});
