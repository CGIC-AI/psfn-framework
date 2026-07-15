/**
 * Exact noncontiguous coverage of processed session-entry ids for extraction
 * interval accounting.
 *
 * Coverage is stored as a sorted list of disjoint, non-adjacent inclusive
 * integer intervals `[start, end]`. A single maximum "covered up to" id is
 * insufficient: bounded durable jobs can execute out of order, so a later
 * high-id snapshot (e.g. ids 11-20) must never prove that an unprocessed lower
 * gap (e.g. ids 5-10) was already consumed. Representing the exact covered id
 * set makes gap membership unambiguous regardless of arrival order.
 *
 * Only proven-contiguous coverage collapses: two intervals merge only when they
 * touch or overlap (`start <= previousEnd + 1`), never across a real uncovered
 * gap.
 */

export type CoverageInterval = readonly [number, number];

export interface CoverageRanges {
  readonly intervals: readonly CoverageInterval[];
}

/**
 * Upper bound on stored intervals. Contiguous coverage collapses to a single
 * interval, so this ceiling is only approached under pathological out-of-order
 * id flooding (e.g. only odd ids ever arrive). When exceeded we drop the
 * lowest-id intervals: forgetting old coverage can at worst cause a bounded
 * re-extraction — deduplicated by the downstream memory writer — and never
 * converts an uncovered gap into coverage, so no memory is lost. Pruning is a
 * one-directional safety valve, not the primary dedupe mechanism.
 */
export const MAX_COVERAGE_INTERVALS = 128;

export function emptyCoverageRanges(): CoverageRanges {
  return { intervals: [] };
}

/**
 * True when `id` falls inside a covered interval. Binary search over the
 * sorted disjoint interval list.
 */
export function isCoveredId(coverage: CoverageRanges, id: number): boolean {
  const { intervals } = coverage;
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const interval = intervals[mid]!;
    if (id < interval[0]) {
      hi = mid - 1;
    } else if (id > interval[1]) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

/**
 * Returns coverage extended with every safe-integer id in `ids`. Contiguous or
 * overlapping intervals collapse; genuine gaps are preserved. If the merged
 * interval count exceeds `maxIntervals`, the lowest intervals are dropped
 * (bounded memory) without ever bridging a gap. The input coverage is not
 * mutated; a new value is returned. Non-integer ids are ignored.
 */
export function addCoveredIds(
  coverage: CoverageRanges,
  ids: Iterable<number>,
  maxIntervals: number = MAX_COVERAGE_INTERVALS,
): CoverageRanges {
  const merged: Array<[number, number]> = coverage.intervals.map(
    ([start, end]) => [start, end],
  );
  let added = false;
  for (const id of ids) {
    if (!Number.isSafeInteger(id)) continue;
    merged.push([id, id]);
    added = true;
  }
  if (!added) return coverage;

  merged.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

  const collapsed: Array<[number, number]> = [];
  for (const [start, end] of merged) {
    const lastIndex = collapsed.length - 1;
    const last = lastIndex >= 0 ? collapsed[lastIndex]! : undefined;
    // Merge only touching/overlapping intervals: `start <= last[1] + 1` keeps a
    // real uncovered gap (a missing integer between end and start) separate.
    if (last && start <= last[1] + 1) {
      if (end > last[1]) last[1] = end;
    } else {
      collapsed.push([start, end]);
    }
  }

  const pruned = collapsed.length > maxIntervals
    ? collapsed.slice(collapsed.length - maxIntervals)
    : collapsed;

  return { intervals: pruned.map(([start, end]) => [start, end] as const) };
}
