import { describe, expect, it, vi } from 'vitest';
import {
  advanceExtractionWatermarkForCoverage,
  evaluateExtractionTrigger,
  evaluateExtractionTriggerForSnapshot,
  resetLastExtractionCount,
} from './runtime-helpers.js';
import type { SessionEntry } from '../../../core/session/types.js';

const { countMessageTokens } = vi.hoisted(() => ({
  countMessageTokens: vi.fn(() => 101),
}));

vi.mock('../../../primitives/llm/tokens.js', () => ({
  countMessageTokens,
}));

describe('evaluateExtractionTrigger', () => {
  it('excludes system and tool roles when counting trigger tokens', () => {
    resetLastExtractionCount();
    countMessageTokens.mockClear();

    const trigger = evaluateExtractionTrigger(
      'api:test',
      {
        getMessageCount: () => 2,
        getRecentMessages: () => [
          { role: 'system', content: 'Agent performed self-check.' },
          { role: 'tool', content: '[Tool result: search_logs] Found 3 matching log entries.' },
          { role: 'user', content: 'Please summarize the findings.' },
        ],
      } as never,
      {
        extractionInterval: 10,
        extractionThresholdPct: 50,
        defaultContextWindow: 200,
        modelRoster: {
          chat: {
            contextWindow: 200,
          },
        },
      } as never,
      10,
    );

    expect(trigger).not.toBeNull();
    expect(countMessageTokens).toHaveBeenCalledTimes(1);
    expect(countMessageTokens).toHaveBeenCalledWith([
      { role: 'user', content: 'Please summarize the findings.' },
    ]);
  });

  it('evaluates threshold tokens and counts from the exact bounded snapshot', () => {
    resetLastExtractionCount();
    countMessageTokens.mockClear();

    const trigger = evaluateExtractionTriggerForSnapshot(
      'api:delayed-b',
      [
        { id: 3, role: 'system', content: 'Internal note outside extraction counting.' },
        { id: 4, role: 'user', content: 'Exact fenced B content.' },
      ] as never,
      {
        extractionInterval: 10,
        extractionThresholdPct: 50,
        defaultContextWindow: 200,
        modelRoster: { chat: { contextWindow: 200 } },
      } as never,
      10,
    );

    expect(trigger).toMatchObject({
      triggerReason: 'context_threshold',
      currentCount: 1,
      lastCount: 0,
      totalTokens: 101,
      tokenBudget: 100,
    });
    expect(countMessageTokens).toHaveBeenCalledWith([
      { role: 'user', content: 'Exact fenced B content.' },
    ]);
  });
});

describe('noncontiguous durable extraction coverage', () => {
  // Isolate the interval/coverage axis: a runtimeConfig of null skips the
  // token-threshold branch entirely, so trigger decisions turn only on the
  // exact uncovered id count.
  function userEntry(id: number): SessionEntry {
    return { id, channelId: 'ch', role: 'user', content: `m${id}`, timestamp: id } as SessionEntry;
  }
  function userRange(lowInclusive: number, highInclusive: number): SessionEntry[] {
    const entries: SessionEntry[] = [];
    for (let id = lowInclusive; id <= highInclusive; id++) entries.push(userEntry(id));
    return entries;
  }

  it('keeps a lower gap triggerable after a later high snapshot advances coverage', () => {
    resetLastExtractionCount();
    const channelId = 'api:gap-loss';

    // B (ids 1-4) then a later, out-of-order J (ids 11-20) both succeed.
    advanceExtractionWatermarkForCoverage(channelId, userRange(1, 4));
    advanceExtractionWatermarkForCoverage(channelId, userRange(11, 20));

    // Delayed C-E snapshot for the untouched gap 5-10 must still report six
    // uncovered entries and trigger — the single-max watermark reported zero.
    const trigger = evaluateExtractionTriggerForSnapshot(channelId, userRange(5, 10), null, 6);
    expect(trigger).not.toBeNull();
    expect(trigger?.triggerReason).toBe('interval');
    expect((trigger?.currentCount ?? 0) - (trigger?.lastCount ?? 0)).toBe(6);
  });

  it('marks the reprocessed gap covered so it is not extracted twice', () => {
    resetLastExtractionCount();
    const channelId = 'api:exactly-once';

    advanceExtractionWatermarkForCoverage(channelId, userRange(1, 4));
    advanceExtractionWatermarkForCoverage(channelId, userRange(11, 20));
    expect(evaluateExtractionTriggerForSnapshot(channelId, userRange(5, 10), null, 6)).not.toBeNull();

    // After the gap snapshot is consumed, re-evaluating the same range yields
    // zero uncovered entries and no trigger.
    advanceExtractionWatermarkForCoverage(channelId, userRange(5, 10));
    expect(evaluateExtractionTriggerForSnapshot(channelId, userRange(5, 10), null, 6)).toBeNull();
  });

  it('preserves gaps under overlapping, duplicate, and retried snapshots', () => {
    resetLastExtractionCount();
    const channelId = 'api:permutations';

    advanceExtractionWatermarkForCoverage(channelId, userRange(1, 4));
    advanceExtractionWatermarkForCoverage(channelId, userRange(11, 20));
    // Duplicate/retried high snapshot must not double-count or bridge the gap.
    advanceExtractionWatermarkForCoverage(channelId, userRange(11, 20));

    // A snapshot overlapping covered ids (3,4) plus the gap (5,6) counts only
    // the two genuinely uncovered entries.
    const overlap = evaluateExtractionTriggerForSnapshot(channelId, userRange(3, 6), null, 2);
    expect(overlap).not.toBeNull();
    expect((overlap?.currentCount ?? 0) - (overlap?.lastCount ?? 0)).toBe(2);
  });
});
