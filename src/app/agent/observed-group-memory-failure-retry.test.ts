import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../core/session/types.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { createDefaultGroupMemorySettings, type GroupMemorySettings } from '../../system/config/group-memory-config.js';
import type { ObservedGroupExtractionOptions } from '../../faculties/memory/extraction.js';
import { ExtractionIntegrityError } from '../../faculties/memory/extraction/integrity-error.js';
import { ModelBudgetExceededError } from '../../primitives/llm/model-budget.js';
import {
  GROUP_MEMORY_POLICY_VERSION,
  JsonGroupMemoryWatermarkStore,
} from '../../faculties/memory/extraction/group-ranges.js';
import {
  ObservedGroupMemoryScheduler,
  type GroupMemoryRangeFailureEvent,
} from '../../faculties/memory/extraction/group-observed-scheduler.js';
import { ObservedGroupMemoryLane, registerGroupMemoryFailureRetrySweep } from './observed-group-memory-lane.js';

// psfn-framework-d5e0p.15: a failed group-memory range in a quiet room is
// retried on a bounded backoff without new traffic, keeps its root cause, and
// stops (raising a terminal event) after the owner-file attempt cap. Real JSON
// watermark store on disk, real scheduler, real lane and sweep registration;
// only the transcript reader and the LLM-backed extractor are stand-ins.

const CHANNEL = 'discord-room';
const START_MS = Date.parse('2026-05-04T08:00:00.000Z');
const MINUTE_MS = 60_000;

function entry(id: number): SessionEntry {
  return {
    id,
    channelId: CHANNEL,
    role: 'user',
    content: `room chatter ${id}`,
    authorId: `user-${id % 3}`,
    authorName: `User ${id % 3}`,
    timestamp: START_MS - (10 - id) * MINUTE_MS,
  };
}

function observed(id: string): SubstrateMessage {
  return {
    id,
    channelId: CHANNEL,
    channelType: 'discord',
    authorId: 'user-1',
    authorName: 'User One',
    content: 'hello',
    timestamp: new Date(START_MS),
    routing: { source: 'discord', responseMode: 'observe' },
  };
}

function groupSettings(): GroupMemorySettings {
  const defaults = createDefaultGroupMemorySettings();
  return {
    ...defaults,
    memoryMode: 'group',
    onlineExtraction: {
      ...defaults.onlineExtraction,
      observedMessageTriggerCount: 2,
      maxMessagesPerChunk: 10,
      chunkOverlapMessages: 0,
      cooldownMs: 0,
    },
    salience: { ...defaults.salience, minCandidateScore: 10, neighboringContextMessages: 0 },
  };
}

function reader(entries: SessionEntry[]) {
  return {
    getRecent: (_channelId: string, limit: number) => entries.slice(-limit),
    getLastEntry: () => entries.at(-1),
    getEntriesAfter: (_channelId: string, afterId: number, limit: number) => (
      entries.filter(item => item.id > afterId).slice(0, limit)
    ),
    getEntriesInRange: (_channelId: string, startId: number, endId: number) => (
      entries.filter(item => item.id >= startId && item.id <= endId)
    ),
  };
}

function orchestrationFailure(rootCause: string): ExtractionIntegrityError {
  return new ExtractionIntegrityError(
    'Extraction orchestration failed',
    { stage: 'orchestration', channelId: CHANNEL, triggerReason: 'backlog_lag' },
    new Error(rootCause),
  );
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(options: { maxAttempts: number; failWith: () => Error | null }) {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-group-retry-'));
  dirs.push(dir);
  const filePath = join(dir, 'group-memory-watermarks.json');
  const clock = { now: START_MS };
  const failures: GroupMemoryRangeFailureEvent[] = [];
  const calls: ObservedGroupExtractionOptions[] = [];
  const failureRetry = { maxAttempts: options.maxAttempts, baseDelayMinutes: 15, sweepIntervalMinutes: 5 };
  const scheduler = new ObservedGroupMemoryScheduler({
    groupMemory: groupSettings(),
    sessionReader: reader([1, 2, 3, 4].map(entry)),
    watermarkStore: new JsonGroupMemoryWatermarkStore(filePath),
    memoryExtractor: {
      extractObservedGroupRange: async (call) => {
        calls.push(call);
        const failure = options.failWith();
        if (failure) throw failure;
        return true;
      },
      getPendingExtractionPromise: () => null,
    },
    failureRetry,
    onRangeFailure: event => failures.push(event),
    nowMs: () => clock.now,
  });
  const audit = { append: vi.fn() };
  const lane = new ObservedGroupMemoryLane({ scheduler, audit, log: { warn: vi.fn() } });
  const tasks = new Map<string, { intervalMs?: number; handler: () => Promise<void> | void }>();
  registerGroupMemoryFailureRetrySweep({
    getTask: (id: string) => tasks.get(id) as never,
    register: ((task: { id: string; intervalMs?: number; handler: () => Promise<void> | void }) => {
      tasks.set(task.id, task);
    }) as never,
  }, lane, failureRetry);
  const sweepTask = tasks.get('memory.group-extraction-failure-retry');
  if (!sweepTask) throw new Error('retry sweep was not registered');
  return {
    filePath,
    clock,
    failures,
    calls,
    lane,
    audit,
    sweepTask,
    sweep: async () => { await sweepTask.handler(); },
    reload: () => new JsonGroupMemoryWatermarkStore(filePath).get(CHANNEL),
  };
}

describe('observed group-memory failure retry (psfn-framework-d5e0p.15)', () => {
  it('retries a failed range in a quiet room on its backoff and records the root cause', async () => {
    let failing = true;
    const h = harness({ maxAttempts: 6, failWith: () => (failing ? orchestrationFailure('provider returned 503') : null) });

    await h.lane.enqueue(observed('m-1'));

    const failed = h.reload();
    expect(failed).toMatchObject({
      status: 'failed',
      coveredUpToMessageId: 0,
      consecutiveFailureCount: 1,
      nextFailureRetryAt: START_MS + 15 * MINUTE_MS,
      lastFailure: {
        startMessageId: 1,
        endMessageId: 4,
        error: 'Extraction orchestration failed <- caused by: provider returned 503',
      },
    });
    expect(h.failures).toEqual([
      { channelId: CHANNEL, attemptCount: 1, maxAttempts: 6, terminal: false, timestamp: START_MS },
    ]);
    expect(h.sweepTask.intervalMs).toBe(5 * MINUTE_MS);

    // Inside the backoff neither the sweep nor new traffic re-runs the range.
    h.clock.now = START_MS + 5 * MINUTE_MS;
    await h.sweep();
    await h.lane.enqueue(observed('m-2'));
    expect(h.calls).toHaveLength(1);

    // No new traffic: the sweep alone retries once the backoff elapsed.
    failing = false;
    h.clock.now = START_MS + 16 * MINUTE_MS;
    await h.sweep();

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toMatchObject({ channelId: CHANNEL, triggerReason: 'backlog_lag', backfill: true });
    const recovered = h.reload();
    expect(recovered).toMatchObject({ status: 'processed', coveredUpToMessageId: 4, failureCount: 1 });
    expect(recovered.consecutiveFailureCount).toBeUndefined();
    expect(recovered.nextFailureRetryAt).toBeUndefined();
    expect(h.audit.append).toHaveBeenCalledWith('memory.group_observed.scheduled', expect.objectContaining({
      channelId: CHANNEL,
      retry: true,
      triggerReason: 'backlog_lag',
    }));

    // Nothing is left due.
    h.clock.now += 24 * 60 * MINUTE_MS;
    await h.sweep();
    expect(h.calls).toHaveLength(2);
  });

  it('gives a failed record written before bounded retry a fresh budget immediately', async () => {
    const h = harness({ maxAttempts: 6, failWith: () => null });
    // The pre-fix shape: wrapper-only error, a large retry count, no retry state.
    writeFileSync(h.filePath, JSON.stringify({
      schemaVersion: 1,
      records: {
        [`${GROUP_MEMORY_POLICY_VERSION}:${CHANNEL}`]: {
          schemaVersion: 1,
          channelId: CHANNEL,
          policyVersion: GROUP_MEMORY_POLICY_VERSION,
          coveredUpToMessageId: 0,
          updatedAt: START_MS - 30 * 24 * 60 * MINUTE_MS,
          status: 'failed',
          processedSpanCount: 0,
          skippedSpanCount: 0,
          failureCount: 12,
          lastFailure: {
            startMessageId: 1,
            endMessageId: 3,
            entryCount: 3,
            recordedAt: START_MS - 30 * 24 * 60 * MINUTE_MS,
            error: 'Extraction orchestration failed',
            retryCount: 12,
          },
        },
      },
    }));

    await h.sweep();

    expect(h.calls).toHaveLength(1);
    expect(h.reload()).toMatchObject({ status: 'processed', coveredUpToMessageId: 4, failureCount: 12 });
  });

  it('stops timed retries after the attempt cap with one terminal event, durably', async () => {
    const h = harness({ maxAttempts: 3, failWith: () => orchestrationFailure('schema rejected the extraction') });

    await h.lane.enqueue(observed('m-1'));
    // Backoff 15 then 30 minutes; sweep every 5 minutes for ten hours.
    for (let minute = 5; minute <= 600; minute += 5) {
      h.clock.now = START_MS + minute * MINUTE_MS;
      await h.sweep();
    }

    expect(h.calls).toHaveLength(3);
    expect(h.failures.map(event => [event.attemptCount, event.terminal])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    const exhausted = h.reload();
    expect(exhausted).toMatchObject({
      status: 'failed',
      coveredUpToMessageId: 0,
      consecutiveFailureCount: 3,
      failureRetryExhaustedAt: START_MS + 45 * MINUTE_MS,
      lastFailure: { error: 'Extraction orchestration failed <- caused by: schema rejected the extraction' },
    });
    const persisted = JSON.parse(readFileSync(h.filePath, 'utf8')) as {
      records: Record<string, { failureRetryExhaustedAt?: number }>;
    };
    expect(Object.values(persisted.records)[0]?.failureRetryExhaustedAt).toBe(START_MS + 45 * MINUTE_MS);

    // Live traffic may still try after the capped backoff, without a second terminal event.
    h.clock.now = START_MS + 45 * MINUTE_MS + 61 * MINUTE_MS;
    await h.lane.enqueue(observed('m-2'));
    expect(h.calls).toHaveLength(4);
    expect(h.failures.at(-1)).toMatchObject({ attemptCount: 4, terminal: false });
    expect(h.failures.filter(event => event.terminal)).toHaveLength(1);
  });
});

// psfn-framework-zwwo0: a model-budget refusal is decided before any model call
// is dispatched, so it must not consume the range's bounded attempts.
function budgetRefusal(): ExtractionIntegrityError {
  return new ExtractionIntegrityError(
    'Extraction orchestration failed',
    { stage: 'orchestration', channelId: CHANNEL, triggerReason: 'backlog_lag' },
    new ModelBudgetExceededError({
      timestampMs: START_MS,
      reason: 'daily_budget_exceeded',
      purpose: 'extraction',
      provider: 'test-provider',
      model: 'test-model',
      service: 'extraction',
      process: 'memory.extraction',
      estimatedRequestCostUsd: 0.1,
      budget: {
        dayKey: '2026-05-04',
        monthKey: '2026-05',
        dailySpentUsd: 6,
        dailyLimitUsd: 5,
        monthlySpentUsd: 6,
        monthlyLimitUsd: 5,
        dailyUnknownCostAttempts: 0,
        monthlyUnknownCostAttempts: 0,
      },
    }),
  );
}

describe('observed group-memory retry under a model-budget block (psfn-framework-zwwo0)', () => {
  it('defers a refused range in a quiet room without consuming attempts and extracts it once admitted', async () => {
    let refusing = true;
    const h = harness({ maxAttempts: 2, failWith: () => (refusing ? budgetRefusal() : null) });

    await h.lane.enqueue(observed('m-1'));
    for (let minute = 5; minute <= 120; minute += 5) {
      h.clock.now = START_MS + minute * MINUTE_MS;
      await h.sweep();
    }

    // The sweep keeps re-probing the deferred range, and none of those refusals
    // was recorded as a failure.
    expect(h.calls.length).toBeGreaterThan(2);
    expect(h.failures).toEqual([]);
    const deferred = h.reload();
    expect(deferred.status).not.toBe('failed');
    expect(deferred.consecutiveFailureCount).toBeUndefined();
    expect(deferred.coveredUpToMessageId).toBe(0);

    refusing = false;
    h.clock.now += 5 * MINUTE_MS;
    await h.sweep();

    expect(h.reload()).toMatchObject({ status: 'processed', coveredUpToMessageId: 4 });
    const callsAfterRecovery = h.calls.length;
    h.clock.now += 60 * MINUTE_MS;
    await h.sweep();
    expect(h.calls).toHaveLength(callsAfterRecovery);
  });

  it('keeps a genuine failure count across refusals and stops at the cap', async () => {
    const outcomes: Array<() => Error> = [
      () => orchestrationFailure('schema rejected the extraction'),
      budgetRefusal,
      budgetRefusal,
      budgetRefusal,
      () => orchestrationFailure('schema rejected the extraction'),
    ];
    const h = harness({ maxAttempts: 2, failWith: () => (outcomes.shift() ?? budgetRefusal)() });

    await h.lane.enqueue(observed('m-1'));
    for (let minute = 5; minute <= 600; minute += 5) {
      h.clock.now = START_MS + minute * MINUTE_MS;
      await h.sweep();
      if (h.failures.some(event => event.terminal)) break;
    }

    expect(h.failures.map(event => [event.attemptCount, event.terminal])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(h.reload()).toMatchObject({
      status: 'failed',
      consecutiveFailureCount: 2,
      lastFailure: { error: 'Extraction orchestration failed <- caused by: schema rejected the extraction' },
    });
    expect(h.reload().failureRetryExhaustedAt).toBeDefined();
  });
});
