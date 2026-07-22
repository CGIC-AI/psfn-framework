import { describe, expect, it } from 'vitest';
import { normalizeRuntimeFallbackProvenance } from './runtime-fallback-provenance.js';

describe('normalizeRuntimeFallbackProvenance', () => {
  it('accepts the current runtime_nonfabricating_notice strategy', () => {
    expect(
      normalizeRuntimeFallbackProvenance({
        schemaVersion: 1,
        authoredBy: 'runtime',
        model: 'runtime-fallback',
        strategy: 'runtime_nonfabricating_notice',
      }),
    ).toEqual({
      schemaVersion: 1,
      authoredBy: 'runtime',
      model: 'runtime-fallback',
      strategy: 'runtime_nonfabricating_notice',
    });
  });

  it('still normalizes historical records written with the legacy datetime-refusal strategy', () => {
    // The datetime-contradiction guard no longer writes this strategy, but turn
    // records persisted before that change must remain readable rather than
    // throwing on normalization.
    expect(
      normalizeRuntimeFallbackProvenance({
        schemaVersion: 1,
        authoredBy: 'runtime',
        model: 'runtime-fallback',
        strategy: 'runtime_datetime_contradiction_refusal',
      }).strategy,
    ).toBe('runtime_datetime_contradiction_refusal');
  });

  it('rejects an unknown strategy', () => {
    expect(() =>
      normalizeRuntimeFallbackProvenance({
        schemaVersion: 1,
        authoredBy: 'runtime',
        model: 'runtime-fallback',
        strategy: 'not_a_real_strategy',
      }),
    ).toThrow(/strategy is invalid/);
  });
});
