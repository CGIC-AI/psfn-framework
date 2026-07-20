// Integration: a deterministic tool invocation recorded in a durable turn record
// must reach the tool-usage ranking (psfn-framework-b0yl.5 remediation).
//
// This drives the REAL filesystem turn-record store — the same durable JSONL
// path the runtime writes on every completed turn — then aggregates over it and
// runs the full evaluator, proving the actual-invocation signal (memory, repo)
// now feeds the ordering, which the old `model_usage_events` source never did.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemTurnRecordStorePort } from '../../../persistence/sessions/turn-records.js';
import type { TurnRecordStorePort } from '../../../persistence/sessions/turn-record-store-port.js';
import type { ToolCallOutcome, TurnRecord } from '../../../shared/contracts/runtime.js';
import {
  DUPLICATE_TOOL_CALL_SKIP_RESULT,
  SEQUENTIAL_DEPENDENCY_SKIP_RESULT,
} from '../../../shared/contracts/tool-call-outcome.js';
import { createTurnRecordToolUsageSource } from './turn-record-usage-source.js';
import { createToolUsageEvaluator, type ToolUsageEvaluatorEvent } from './usage-evaluator.js';

const CHANNEL_ID = 'chan-integration';

function buildTurnRecord(input: {
  startedAt: number;
  tools: Array<{
    toolName: string;
    outcome?: ToolCallOutcome;
    isError?: boolean;
    resultText?: string;
  }>;
  requestId: string;
}): TurnRecord {
  return {
    schemaVersion: 1,
    requestId: input.requestId,
    channelId: CHANNEL_ID,
    channelType: 'api',
    startedAt: input.startedAt,
    completedAt: input.startedAt + 10,
    status: 'completed',
    userMessage: { role: 'user', content: 'hi', timestamp: input.startedAt },
    toolCalls: input.tools.map(tool => ({
      toolName: tool.toolName,
      toolCallId: `${input.requestId}-${tool.toolName}`,
      ...(tool.outcome ? { outcome: tool.outcome } : {}),
      ...(tool.isError !== undefined ? { isError: tool.isError } : {}),
      ...(tool.resultText ? { resultText: tool.resultText } : {}),
    })),
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'test-model' },
    provenanceRefs: [],
  } as unknown as TurnRecord;
}

describe('turn-record tool usage source (durable, real store)', () => {
  let dir: string;
  let store: TurnRecordStorePort;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-usage-src-'));
    store = createFilesystemTurnRecordStorePort(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('aggregates actual per-tool invocations from durable turn records, windowed and canonical-filtered', () => {
    const now = Date.UTC(2026, 6, 15, 18, 0, 0);
    const todayStart = Date.UTC(2026, 6, 15, 1, 0, 0);
    const longAgo = now - 40 * 24 * 60 * 60 * 1000;

    // In-window: a deterministic tool (memory) + repo success + repo failure.
    store.appendTurnRecord(buildTurnRecord({
      startedAt: todayStart,
      requestId: 'req-in-1',
      tools: [{ toolName: 'memory' }, { toolName: 'repo', isError: false }],
    }));
    store.appendTurnRecord(buildTurnRecord({
      startedAt: todayStart + 5,
      requestId: 'req-in-2',
      // Non-canonical must be filtered; repo failure is the correction signal.
      tools: [
        { toolName: 'repo', outcome: 'execution_failure', isError: true },
        {
          toolName: 'repo',
          isError: true,
          resultText: DUPLICATE_TOOL_CALL_SKIP_RESULT,
        },
        {
          toolName: 'repo',
          isError: true,
          resultText: SEQUENTIAL_DEPENDENCY_SKIP_RESULT,
        },
        { toolName: 'repo', outcome: 'policy_denial', isError: true },
        { toolName: 'definitely_not_a_tool' },
      ],
    }));
    // Out-of-window record must not count.
    store.appendTurnRecord(buildTurnRecord({
      startedAt: longAgo,
      requestId: 'req-old',
      tools: [{ toolName: 'memory' }, { toolName: 'memory' }],
    }));

    const source = createTurnRecordToolUsageSource({
      listChannelKeys: () => [CHANNEL_ID],
      readRecentTurnRecords: (key, limit) => store.readRecentTurnRecords(key, limit),
      usageWindow: 'today',
      timezone: 'UTC',
    });

    const aggregate = source.aggregate(now);
    const byName = new Map(aggregate.stats.map(stat => [stat.toolName, stat]));

    expect(aggregate.sourceId).toBe('turn_records');
    // memory: one in-window success (the two out-of-window ones excluded).
    expect(byName.get('memory')).toEqual({ toolName: 'memory', invocations: 1, successes: 1, failures: 0 });
    // repo: skips/denials remain visible invocations but do not inflate failures.
    expect(byName.get('repo')).toEqual({ toolName: 'repo', invocations: 5, successes: 1, failures: 1 });
    // Non-canonical excluded.
    expect(byName.has('definitely_not_a_tool')).toBe(false);
    expect(aggregate.toolsWithData).toBe(2);
    expect(aggregate.channelsScanned).toBe(1);
    expect(aggregate.toolCallsCounted).toBe(6);
    expect(aggregate.truncated).toBe(false);
  });

  it('drives the full evaluator: a deterministic tool invocation reaches the applied ranking', async () => {
    const now = Date.UTC(2026, 6, 15, 18, 0, 0);
    const todayStart = Date.UTC(2026, 6, 15, 1, 0, 0);

    for (let i = 0; i < 6; i++) {
      store.appendTurnRecord(buildTurnRecord({
        startedAt: todayStart + i,
        requestId: `req-${i}`,
        tools: [{ toolName: 'memory' }, { toolName: 'repo' }],
      }));
    }

    const source = createTurnRecordToolUsageSource({
      listChannelKeys: () => [CHANNEL_ID],
      readRecentTurnRecords: (key, limit) => store.readRecentTurnRecords(key, limit),
      usageWindow: 'today',
      timezone: 'UTC',
    });

    let appliedRankedNames: string[] = [];
    const events: ToolUsageEvaluatorEvent[] = [];
    const evaluator = createToolUsageEvaluator({
      getUsageAggregateSource: () => source,
      getExtendedToolNames: () => ['repo', 'shell', 'vault'],
      getCatalogToolCount: () => 12,
      getPromotedExtendedTools: () => [],
      getPromotedExtendedToolsLimit: () => 4,
      applyRanking: (ranking) => { appliedRankedNames = [...ranking.rankedToolNames]; },
      usageWindow: 'today',
      minPinSuggestionInvocations: 5,
      now: () => now,
      onEvent: e => { events.push(e); },
    });

    const result = await evaluator.evaluate();
    expect(result.status).toBe('evaluated');
    const ranking = result.ranking;
    expect(ranking).toBeDefined();
    // The deterministic tools invoked in real durable turns are now ranked.
    expect(appliedRankedNames).toContain('memory');
    expect(appliedRankedNames).toContain('repo');
    expect(ranking!.stats.get('memory')).toMatchObject({ successes: 6 });
    expect(ranking!.stats.get('repo')).toMatchObject({ successes: 6 });

    const evaluated = events[0];
    expect(evaluated.outcome).toBe('evaluated');
    if (evaluated.outcome === 'evaluated') {
      expect(evaluated.dataSource).toBe('turn_records');
      expect(evaluated.toolsWithData).toBe(2);
      expect(evaluated.catalogToolCount).toBe(12);
    }

    // repo has 6 successful in-window invocations >= threshold 5 → pin suggestion.
    expect(result.suggestions.map(s => s.toolName)).toContain('repo');
  });

  it('flags truncation when the per-channel scan cap is smaller than the in-window history', () => {
    const now = Date.UTC(2026, 6, 15, 18, 0, 0);
    const todayStart = Date.UTC(2026, 6, 15, 1, 0, 0);
    for (let i = 0; i < 5; i++) {
      store.appendTurnRecord(buildTurnRecord({
        startedAt: todayStart + i,
        requestId: `req-${i}`,
        tools: [{ toolName: 'repo' }],
      }));
    }

    const source = createTurnRecordToolUsageSource({
      listChannelKeys: () => [CHANNEL_ID],
      readRecentTurnRecords: (key, limit) => store.readRecentTurnRecords(key, limit),
      usageWindow: 'today',
      timezone: 'UTC',
      maxTurnRecordsPerChannel: 2,
    });

    const aggregate = source.aggregate(now);
    // Only the newest 2 records read, all in-window → possibly more older → truncated.
    expect(aggregate.turnRecordsScanned).toBe(2);
    expect(aggregate.truncated).toBe(true);
    expect(aggregate.stats.find(s => s.toolName === 'repo')?.successes).toBe(2);
  });
});
