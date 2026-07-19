import { describe, expect, it, vi } from 'vitest';
import { createToolUsageEvaluator, type ToolUsageEvaluatorEvent } from './usage-evaluator.js';
import type {
  ToolUsageAggregate,
  ToolUsageAggregateSource,
} from './turn-record-usage-source.js';
import type { ToolUsageRanking, ToolUsageStat } from './usage-ranking.js';

function stat(toolName: string, invocations: number, successes: number, failures: number): ToolUsageStat {
  return { toolName, invocations, successes, failures };
}

function fakeAggregate(stats: ToolUsageStat[]): ToolUsageAggregate {
  return {
    sourceId: 'turn_records',
    stats,
    toolsWithData: stats.length,
    channelsScanned: 1,
    turnRecordsScanned: stats.reduce((sum, s) => sum + s.invocations, 0),
    toolCallsCounted: stats.reduce((sum, s) => sum + s.invocations, 0),
    windowSinceMs: 0,
    windowUntilMs: 1,
    truncated: false,
  };
}

function fakeSource(stats: ToolUsageStat[]): ToolUsageAggregateSource {
  return {
    sourceId: 'turn_records',
    aggregate: vi.fn(() => fakeAggregate(stats)),
  };
}

const EXTENDED = ['repo', 'shell', 'world', 'north_star', 'beads', 'notify', 'vault'];
const CATALOG_SIZE = EXTENDED.length + 4;

describe('createToolUsageEvaluator', () => {
  it('skips when the durable usage source is unavailable (fail closed, no throw)', async () => {
    const applyRanking = vi.fn();
    const events: ToolUsageEvaluatorEvent[] = [];
    const evaluator = createToolUsageEvaluator({
      getUsageAggregateSource: () => null,
      getExtendedToolNames: () => EXTENDED,
      getCatalogToolCount: () => CATALOG_SIZE,
      getPromotedExtendedTools: () => [],
      getPromotedExtendedToolsLimit: () => 4,
      applyRanking,
      usageWindow: 'month',
      minPinSuggestionInvocations: 5,
      onEvent: e => { events.push(e); },
    });
    const result = await evaluator.evaluate();
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('usage_source_unavailable');
    expect(applyRanking).not.toHaveBeenCalled();
    expect(events).toEqual([{ outcome: 'skipped', reason: 'usage_source_unavailable' }]);
  });

  it('builds a ranking from the durable aggregate and applies it', async () => {
    let applied: ToolUsageRanking | null = null;
    const events: ToolUsageEvaluatorEvent[] = [];
    const evaluator = createToolUsageEvaluator({
      getUsageAggregateSource: () => fakeSource([
        stat('repo', 12, 12, 0),
        stat('vault', 20, 18, 2),
        stat('shell', 4, 3, 1),
      ]),
      getExtendedToolNames: () => EXTENDED,
      getCatalogToolCount: () => CATALOG_SIZE,
      getPromotedExtendedTools: () => [],
      getPromotedExtendedToolsLimit: () => 4,
      applyRanking: (r) => { applied = r; },
      usageWindow: 'month',
      minPinSuggestionInvocations: 5,
      onEvent: e => { events.push(e); },
    });
    const result = await evaluator.evaluate();
    expect(result.status).toBe('evaluated');
    expect(applied).not.toBeNull();
    expect(applied!.rankedToolNames).toEqual(['vault', 'repo', 'shell']);
    // Coverage telemetry makes the data source and sparseness explicit.
    const evaluated = events[0];
    expect(evaluated.outcome).toBe('evaluated');
    if (evaluated.outcome === 'evaluated') {
      expect(evaluated.dataSource).toBe('turn_records');
      expect(evaluated.toolsWithData).toBe(3);
      expect(evaluated.catalogToolCount).toBe(CATALOG_SIZE);
      expect(evaluated.rankedToolCount).toBe(3);
    }
  });

  it('emits a visibly-sparse aggregate (toolsWithData 0) rather than a confident wrong ranking', async () => {
    const events: ToolUsageEvaluatorEvent[] = [];
    const evaluator = createToolUsageEvaluator({
      getUsageAggregateSource: () => fakeSource([]),
      getExtendedToolNames: () => EXTENDED,
      getCatalogToolCount: () => CATALOG_SIZE,
      getPromotedExtendedTools: () => [],
      getPromotedExtendedToolsLimit: () => 4,
      applyRanking: vi.fn(),
      usageWindow: 'month',
      minPinSuggestionInvocations: 5,
      onEvent: e => { events.push(e); },
    });
    const result = await evaluator.evaluate();
    expect(result.status).toBe('evaluated');
    expect(result.ranking?.rankedToolNames).toEqual([]);
    expect(result.suggestions).toEqual([]);
    const evaluated = events[0];
    if (evaluated.outcome === 'evaluated') {
      expect(evaluated.toolsWithData).toBe(0);
      expect(evaluated.rankedToolCount).toBe(0);
      expect(evaluated.catalogToolCount).toBe(CATALOG_SIZE);
    }
  });

  it('surfaces new pin suggestions through the memory writer exactly once (throttled)', async () => {
    const write = vi.fn(async () => ({ action: 'created' }));
    const deps = {
      getUsageAggregateSource: () => fakeSource([
        stat('repo', 12, 12, 0),
        stat('shell', 9, 9, 0),
      ]),
      getExtendedToolNames: () => EXTENDED,
      getCatalogToolCount: () => CATALOG_SIZE,
      getPromotedExtendedTools: () => [] as string[],
      getPromotedExtendedToolsLimit: () => 4,
      applyRanking: vi.fn(),
      getMemoryWriter: () => ({ write } as never),
      usageWindow: 'month' as const,
      minPinSuggestionInvocations: 5,
    };
    const evaluator = createToolUsageEvaluator(deps);

    const first = await evaluator.evaluate();
    expect(first.suggestions.map(s => s.toolName)).toEqual(['repo', 'shell']);
    expect(first.newlySuggested).toEqual(['repo', 'shell']);
    expect(write).toHaveBeenCalledTimes(2);

    // Second run with the same durable data must not re-write the same suggestions.
    const second = await evaluator.evaluate();
    expect(second.suggestions.map(s => s.toolName)).toEqual(['repo', 'shell']);
    expect(second.newlySuggested).toEqual([]);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('never suggests an already-pinned tool and records suggestions as autonomous-action memories', async () => {
    const write = vi.fn(async () => ({ action: 'created' }));
    const evaluator = createToolUsageEvaluator({
      getUsageAggregateSource: () => fakeSource([stat('repo', 12, 12, 0), stat('shell', 9, 9, 0)]),
      getExtendedToolNames: () => EXTENDED,
      getCatalogToolCount: () => CATALOG_SIZE,
      getPromotedExtendedTools: () => ['repo'],
      getPromotedExtendedToolsLimit: () => 4,
      applyRanking: vi.fn(),
      getMemoryWriter: () => ({ write } as never),
      usageWindow: 'month',
      minPinSuggestionInvocations: 5,
    });
    const result = await evaluator.evaluate();
    expect(result.suggestions.map(s => s.toolName)).toEqual(['shell']);
    const writtenMemory = write.mock.calls[0]?.[0] as { tags: string[] };
    expect(writtenMemory.tags).toContain('autonomous_action');
    expect(writtenMemory.tags).toContain('pin_suggestion');
  });

  it('does not swallow a memory-write failure and retries the unrecorded suggestion next run', async () => {
    const write = vi.fn()
      .mockRejectedValueOnce(new Error('memory backend down'))
      .mockResolvedValue({ action: 'created' });
    const evaluator = createToolUsageEvaluator({
      getUsageAggregateSource: () => fakeSource([stat('repo', 12, 12, 0)]),
      getExtendedToolNames: () => EXTENDED,
      getCatalogToolCount: () => CATALOG_SIZE,
      getPromotedExtendedTools: () => [],
      getPromotedExtendedToolsLimit: () => 4,
      applyRanking: vi.fn(),
      getMemoryWriter: () => ({ write } as never),
      usageWindow: 'month',
      minPinSuggestionInvocations: 5,
    });
    await expect(evaluator.evaluate()).rejects.toThrow('memory backend down');
    // The failed suggestion was not recorded in the throttle set, so it retries.
    const retry = await evaluator.evaluate();
    expect(retry.newlySuggested).toEqual(['repo']);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
