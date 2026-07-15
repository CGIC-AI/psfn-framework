import { describe, expect, it } from 'vitest';
import {
  addCoveredIds,
  emptyCoverageRanges,
  isCoveredId,
  MAX_COVERAGE_INTERVALS,
} from './coverage-ranges.js';

describe('coverage-ranges', () => {
  it('reports membership only for added ids', () => {
    const covered = addCoveredIds(emptyCoverageRanges(), [1, 2, 3, 11, 12]);
    for (const id of [1, 2, 3, 11, 12]) expect(isCoveredId(covered, id)).toBe(true);
    for (const id of [0, 4, 5, 10, 13, 20]) expect(isCoveredId(covered, id)).toBe(false);
  });

  it('collapses only touching or overlapping intervals, never across a gap', () => {
    // 1-4 and 5-10 touch (4 and 5 adjacent) -> one interval; 11-20 stays split
    // by the 5-10 gap only until that gap is filled.
    let covered = addCoveredIds(emptyCoverageRanges(), [1, 2, 3, 4]);
    covered = addCoveredIds(covered, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(covered.intervals).toEqual([[1, 4], [11, 20]]);

    covered = addCoveredIds(covered, [5, 6, 7, 8, 9, 10]);
    expect(covered.intervals).toEqual([[1, 20]]);
  });

  it('preserves a genuine gap of a single missing id', () => {
    const covered = addCoveredIds(emptyCoverageRanges(), [1, 2, 4, 5]);
    expect(covered.intervals).toEqual([[1, 2], [4, 5]]);
    expect(isCoveredId(covered, 3)).toBe(false);
  });

  it('is idempotent for duplicate and overlapping ids', () => {
    let covered = addCoveredIds(emptyCoverageRanges(), [5, 6, 7]);
    const before = covered;
    covered = addCoveredIds(covered, [6, 7, 5]);
    covered = addCoveredIds(covered, [5, 6, 7, 8]);
    expect(before.intervals).toEqual([[5, 7]]);
    expect(covered.intervals).toEqual([[5, 8]]);
  });

  it('ignores non-safe-integer ids and returns the input unchanged', () => {
    const start = addCoveredIds(emptyCoverageRanges(), [1, 2]);
    const after = addCoveredIds(start, [Number.NaN, 1.5, Infinity]);
    // No safe integers added -> the exact same value is returned (no-op).
    expect(after).toBe(start);
    expect(after.intervals).toEqual([[1, 2]]);
  });

  it('bounds interval count under pathological non-contiguous flooding by dropping lowest', () => {
    // Every other id -> each is its own interval. Feed well past the cap.
    let covered = emptyCoverageRanges();
    const total = MAX_COVERAGE_INTERVALS + 50;
    for (let k = 0; k < total; k++) {
      covered = addCoveredIds(covered, [k * 2]);
    }
    expect(covered.intervals.length).toBeLessThanOrEqual(MAX_COVERAGE_INTERVALS);
    // Lowest coverage was dropped (may re-extract, deduplicated downstream);
    // the highest ids remain covered and no gap was bridged into coverage.
    const highestId = (total - 1) * 2;
    expect(isCoveredId(covered, highestId)).toBe(true);
    expect(isCoveredId(covered, 0)).toBe(false);
    // Odd ids were never covered: pruning never converted a gap to coverage.
    expect(isCoveredId(covered, highestId - 1)).toBe(false);
  });
});
