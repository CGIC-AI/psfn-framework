import { describe, expect, it } from 'vitest';
import {
  buildToolUsageRanking,
  computeToolPinSuggestions,
  type ToolUsageStat,
} from './usage-ranking.js';

function stat(toolName: string, successes: number, failures = 0, invocations = successes + failures): ToolUsageStat {
  return { toolName, successes, failures, invocations };
}

describe('buildToolUsageRanking', () => {
  it('orders tools by successful usage, demoting higher failure counts on ties', () => {
    const ranking = buildToolUsageRanking(
      [
        stat('web', 3, 1),
        stat('vault', 10, 0),
        stat('repo', 3, 5), // same successes as web but more failures -> ranked after web
        stat('beads', 0, 0),
      ],
      1_000,
    );
    expect(ranking.rankedToolNames).toEqual(['vault', 'web', 'repo', 'beads']);
    expect(ranking.usageScore('vault')).toBe(10);
    expect(ranking.usageScore('unseen')).toBe(0);
  });

  it('compareWithinBand returns 0 for equal standing so the caller keeps its own tie-break', () => {
    const ranking = buildToolUsageRanking([stat('a', 5), stat('b', 5)], 0);
    expect(ranking.compareWithinBand('a', 'b')).toBe(0);
  });

  it('compareWithinBand ranks a more-used tool before a less-used one', () => {
    const ranking = buildToolUsageRanking([stat('a', 9), stat('b', 2)], 0);
    expect(ranking.compareWithinBand('a', 'b')).toBeLessThan(0);
    expect(ranking.compareWithinBand('b', 'a')).toBeGreaterThan(0);
  });

  it('is deterministic and derives purely from the supplied durable aggregates (restart-stable)', () => {
    const rows = [stat('vault', 4), stat('repo', 7), stat('web', 7, 2)];
    const first = buildToolUsageRanking(rows, 111).rankedToolNames;
    // A fresh ranking built from the same durable rows (e.g. after a process
    // restart re-reading model_usage_events) yields identical ordering.
    const second = buildToolUsageRanking([...rows].reverse(), 999).rankedToolNames;
    expect(first).toEqual(second);
    expect(first).toEqual(['repo', 'web', 'vault']);
  });

  it('clamps negative/NaN counts and de-duplicates repeated tool keys', () => {
    const ranking = buildToolUsageRanking(
      [
        { toolName: 'web', successes: -3, failures: Number.NaN, invocations: -1 },
        { toolName: 'web', successes: 4, failures: 1, invocations: 5 },
        { toolName: '  ', successes: 5, failures: 0, invocations: 5 },
      ],
      0,
    );
    expect(ranking.stats.get('web')).toEqual({ toolName: 'web', invocations: 5, successes: 4, failures: 1 });
    expect(ranking.stats.has('')).toBe(false);
  });
});

describe('computeToolPinSuggestions', () => {
  const ranking = buildToolUsageRanking(
    [stat('vault', 12), stat('repo', 8), stat('shell', 6), stat('beads', 1)],
    0,
  );

  it('suggests unpinned extended tools by usage, capped at free slots', () => {
    const suggestions = computeToolPinSuggestions({
      ranking,
      extendedToolNames: ['vault', 'repo', 'shell', 'beads'],
      alreadyPinned: [],
      slotLimit: 4,
      minInvocations: 5,
    });
    expect(suggestions.map(s => s.toolName)).toEqual(['vault', 'repo', 'shell']);
  });

  it('never re-suggests an already-pinned tool and respects remaining slots', () => {
    const suggestions = computeToolPinSuggestions({
      ranking,
      extendedToolNames: ['vault', 'repo', 'shell'],
      alreadyPinned: ['vault'],
      slotLimit: 2,
      minInvocations: 5,
    });
    // vault excluded (pinned); 1 free slot (limit 2 - 1 pinned) -> only top remaining.
    expect(suggestions.map(s => s.toolName)).toEqual(['repo']);
  });

  it('returns nothing when all slots are full', () => {
    const suggestions = computeToolPinSuggestions({
      ranking,
      extendedToolNames: ['repo', 'shell'],
      alreadyPinned: ['vault', 'beads'],
      slotLimit: 2,
      minInvocations: 1,
    });
    expect(suggestions).toEqual([]);
  });

  it('excludes tools below the successful-use threshold', () => {
    const suggestions = computeToolPinSuggestions({
      ranking,
      extendedToolNames: ['beads'],
      alreadyPinned: [],
      slotLimit: 4,
      minInvocations: 5,
    });
    expect(suggestions).toEqual([]);
  });
});
