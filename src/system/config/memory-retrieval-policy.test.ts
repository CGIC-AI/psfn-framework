import { describe, expect, it } from 'vitest';
import {
  MEMORY_POLICY_TYPES,
  createDefaultMemoryRetrievalPolicy,
  isProceduralTaskContext,
  normalizeMemoryRetrievalPolicy,
  resolveMemoryRetrievalPrior,
  resolveMemorySalienceFloor,
} from './memory-retrieval-policy.js';

describe('memory retrieval policy', () => {
  it('encodes the complete operator-approved matrix', () => {
    const policy = createDefaultMemoryRetrievalPolicy();

    expect(Object.keys(policy.typePolicies)).toEqual([...MEMORY_POLICY_TYPES]);
    expect(Object.fromEntries(MEMORY_POLICY_TYPES.map(type => [
      type,
      policy.typePolicies[type].halfLifeDays,
    ]))).toEqual({
      episodic: 30,
      semantic: 120,
      emotional: 365,
      procedural: 14,
      boundary: 365,
      reflection: 90,
      relational: 180,
    });
    expect(Object.fromEntries(MEMORY_POLICY_TYPES.map(type => [
      type,
      policy.typePolicies[type].retrievalPrior,
    ]))).toEqual({
      episodic: 1,
      semantic: 1,
      emotional: 1.3,
      procedural: 0.6,
      boundary: 1.6,
      reflection: 0.9,
      relational: 1.15,
    });
    expect(policy).toMatchObject({
      proceduralTaskRetrievalPrior: 1.2,
      selectionCaps: { reflection: 2, procedural: 2 },
      nonTemporalRecencyFloor: 0.35,
      lexicalAugment: { pageSize: 256, maxScan: 2_048, selectedLimit: 12 },
      emotionalIntensityPersistenceMaxMultiplier: 6,
    });
    expect(resolveMemorySalienceFloor(policy, 'emotional', -1)).toBe(0.6);
    expect(resolveMemorySalienceFloor(policy, 'emotional', 0.9)).toBeCloseTo(0.565, 10);
    expect(resolveMemorySalienceFloor(policy, 'relational', 0.49)).toBe(0.05);
    expect(resolveMemorySalienceFloor(policy, 'relational', -0.5)).toBe(0.5);
    expect(resolveMemorySalienceFloor(policy, 'boundary', 0)).toBe(0.5);
  });

  it('returns independent defaults and a normalized independent copy', () => {
    const first = createDefaultMemoryRetrievalPolicy();
    const second = createDefaultMemoryRetrievalPolicy();
    first.typePolicies.emotional.halfLifeDays = 1;

    expect(second.typePolicies.emotional.halfLifeDays).toBe(365);
    const normalized = normalizeMemoryRetrievalPolicy(second);
    normalized.selectionCaps.reflection = 7;
    expect(second.selectionCaps.reflection).toBe(2);
  });

  it('fails closed on partial, unknown, and out-of-range policy data', () => {
    expect(() => normalizeMemoryRetrievalPolicy({
      nonTemporalRecencyFloor: 0.35,
    })).toThrow(/missing typePolicies/);

    const unknown = createDefaultMemoryRetrievalPolicy() as unknown as Record<string, unknown>;
    unknown.legacyHalfLife = 14;
    expect(() => normalizeMemoryRetrievalPolicy(unknown)).toThrow(/unknown legacyHalfLife/);

    const partialType = createDefaultMemoryRetrievalPolicy();
    delete (partialType.typePolicies.procedural as Partial<
      typeof partialType.typePolicies.procedural
    >).retrievalPrior;
    expect(() => normalizeMemoryRetrievalPolicy(partialType)).toThrow(
      /typePolicies\.procedural: missing retrievalPrior/,
    );

    const invalidPage = createDefaultMemoryRetrievalPolicy();
    invalidPage.lexicalAugment.pageSize = 501;
    expect(() => normalizeMemoryRetrievalPolicy(invalidPage)).toThrow(
      /lexicalAugment\.pageSize/,
    );
  });

  it('uses only deterministic caller task kinds for the procedural task prior', () => {
    const policy = createDefaultMemoryRetrievalPolicy();

    expect(isProceduralTaskContext('maintenance')).toBe(true);
    expect(isProceduralTaskContext('research')).toBe(true);
    expect(isProceduralTaskContext('analysis')).toBe(true);
    expect(isProceduralTaskContext('chat')).toBe(false);
    expect(isProceduralTaskContext(undefined)).toBe(false);
    expect(resolveMemoryRetrievalPrior(policy, 'procedural', 'work')).toBe(1.2);
    expect(resolveMemoryRetrievalPrior(policy, 'procedural', 'analysis')).toBe(1.2);
    expect(resolveMemoryRetrievalPrior(policy, 'procedural', 'chat')).toBe(0.6);
    expect(resolveMemoryRetrievalPrior(policy, 'emotional', 'work')).toBe(1.3);
  });
});
