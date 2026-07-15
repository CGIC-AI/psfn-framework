import { describe, expect, it, vi } from 'vitest';
import type {
  ModelUsageData,
  ModelUsageGroup,
  ModelUsageQueryPort,
  ModelUsageTotals,
} from '../../../shared/telemetry/model-usage.js';
import { createToolUsageEvaluator } from './usage-evaluator.js';
import type { ToolUsageRanking } from './usage-ranking.js';

function metrics(calls: number, successfulCalls: number, failedCalls: number): ModelUsageTotals {
  return { calls, successfulCalls, failedCalls } as unknown as ModelUsageTotals;
}

function group(toolName: string, calls: number, successes: number, failures: number): ModelUsageGroup {
  return { dimensions: { toolName }, isOther: false, metrics: metrics(calls, successes, failures) };
}

function fakeQuery(groups: ModelUsageGroup[]): ModelUsageQueryPort {
  return {
    getUsageData: vi.fn(async () => ({ groups } as unknown as ModelUsageData)),
  };
}

const EXTENDED = ['repo', 'shell', 'world', 'library', 'north_star', 'beads', 'notify', 'vault'];

describe('createToolUsageEvaluator', () => {
  it('skips when the durable query port is unavailable (fail closed, no throw)', async () => {
    const applyRanking = vi.fn();
    const evaluator = createToolUsageEvaluator({
      getModelUsageQuery: () => null,
      getExtendedToolNames: () => EXTENDED,
      getPromotedExtendedTools: () => [],
      getPromotedExtendedToolsLimit: () => 4,
      applyRanking,
      usageWindow: 'month',
      minPinSuggestionInvocations: 5,
    });
    const result = await evaluator.evaluate();
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('usage_query_unavailable');
    expect(applyRanking).not.toHaveBeenCalled();
  });

  it('builds a ranking from durable groups (canonical tools only) and applies it', async () => {
    let applied: ToolUsageRanking | null = null;
    const evaluator = createToolUsageEvaluator({
      getModelUsageQuery: () => fakeQuery([
        group('repo', 12, 12, 0),
        group('vault', 20, 18, 2),
        group('not_a_real_tool', 99, 99, 0), // filtered out (non-canonical)
        group('shell', 4, 3, 1),
      ]),
      getExtendedToolNames: () => EXTENDED,
      getPromotedExtendedTools: () => [],
      getPromotedExtendedToolsLimit: () => 4,
      applyRanking: (r) => { applied = r; },
      usageWindow: 'month',
      minPinSuggestionInvocations: 5,
    });
    const result = await evaluator.evaluate();
    expect(result.status).toBe('evaluated');
    expect(applied).not.toBeNull();
    expect(applied!.rankedToolNames).toEqual(['vault', 'repo', 'shell']);
    expect(applied!.stats.has('not_a_real_tool')).toBe(false);
  });

  it('surfaces new pin suggestions through the memory writer exactly once (throttled)', async () => {
    const write = vi.fn(async () => ({ action: 'created' }));
    const deps = {
      getModelUsageQuery: () => fakeQuery([
        group('repo', 12, 12, 0),
        group('shell', 9, 9, 0),
      ]),
      getExtendedToolNames: () => EXTENDED,
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
      getModelUsageQuery: () => fakeQuery([group('repo', 12, 12, 0), group('shell', 9, 9, 0)]),
      getExtendedToolNames: () => EXTENDED,
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
      getModelUsageQuery: () => fakeQuery([group('repo', 12, 12, 0)]),
      getExtendedToolNames: () => EXTENDED,
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
