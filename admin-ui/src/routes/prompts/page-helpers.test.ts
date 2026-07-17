import { describe, expect, it } from 'vitest';
import { buildStackEntries } from './page-helpers';

describe('prompt stack token counts', () => {
  it('uses backend-provided counts for fixed prompt previews without estimating locally', () => {
    const entries = buildStackEntries({
      constitutionPreviewText: 'constitution',
      constitutionTokenCount: 17,
      constitutionImmutableBlockCount: 1,
      northStarPreviewText: 'north star',
      northStarTokenCount: 9,
      northStarActiveCount: 1,
      northStarLimit: 3,
      sortedLayers: [],
      orderedRuntimeBlocks: [],
    });

    expect(entries.map(entry => entry.kind === 'fixed' ? entry.fixed.tokenCount : null))
      .toEqual([17, 9]);
  });
});
