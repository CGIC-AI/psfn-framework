import { describe, it, expect } from 'vitest';
import {
  inferImportedMemoryType,
  initializeImportedMemorySalience,
} from './types.js';

describe('memory import normalization policy', () => {
  it('infers type from relational text signals when explicit type is missing', () => {
    const inferred = inferImportedMemoryType({
      text: 'My partner prefers direct communication and quiet evenings.',
      tags: ['legacy-import'],
    });
    expect(inferred).toBe('relational');
  });

  it('biases salience by recency and criticality', () => {
    const now = Date.parse('2026-02-26T00:00:00.000Z');
    const staleLowPriority = initializeImportedMemorySalience({
      type: 'semantic',
      importance: 0.22,
      extractedAt: now - (420 * 24 * 60 * 60 * 1000),
      now,
    });
    const recentCritical = initializeImportedMemorySalience({
      type: 'boundary',
      importance: 0.91,
      tags: ['critical'],
      text: 'Do not disclose private details in public channels.',
      extractedAt: now - (2 * 24 * 60 * 60 * 1000),
      now,
    });

    expect(staleLowPriority).toBeLessThan(0.4);
    expect(recentCritical).toBeGreaterThan(0.85);
  });
});
