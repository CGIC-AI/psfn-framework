import { describe, expect, it } from 'vitest';
import {
  normalizeNarrativeMetacognitiveFlags,
  normalizeNarrativeSnapshotRef,
} from './narrative-context-normalization.js';

describe('narrative context normalization', () => {
  it('normalizes snapshot references and preserves context prefix in errors', () => {
    expect(normalizeNarrativeSnapshotRef('  internal-state-v1:abc  ', {
      contextPrefix: 'values journal',
    })).toBe('internal-state-v1:abc');
    expect(normalizeNarrativeSnapshotRef(undefined, {
      contextPrefix: 'values journal',
    })).toBeUndefined();
    expect(() => normalizeNarrativeSnapshotRef('   ', {
      contextPrefix: 'values journal',
    })).toThrow('values journal internalStateSnapshotRef must be a non-empty string when provided');
  });

  it('normalizes metacognitive flags and preserves context prefix in errors', () => {
    expect(normalizeNarrativeMetacognitiveFlags([{
      flag: '  uncertainty ',
      confidence: 0.123456,
      evidence: '  conflicting context  ',
    }], { contextPrefix: 'Reflection journal' })).toEqual([{
      flag: 'uncertainty',
      confidence: 0.1235,
      evidence: 'conflicting context',
    }]);

    expect(() => normalizeNarrativeMetacognitiveFlags('not-an-array', {
      contextPrefix: 'Reflection journal',
    })).toThrow('Reflection journal metacognitiveFlags must be an array when provided');
    expect(() => normalizeNarrativeMetacognitiveFlags([{ flag: '', confidence: 0.4 }], {
      contextPrefix: 'Reflection journal',
    })).toThrow('Reflection journal metacognitiveFlags[0].flag must be a non-empty string');
  });
});
