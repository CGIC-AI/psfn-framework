import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMProviderPort } from '../agent/contracts.js';
import { ParentTurnContinuationBudgetExceededError } from '../agent/turn-limits.js';
import { EventBus } from '../../shared/event-bus.js';
import {
  resolveReflectionDailyJournalsDir,
  resolveReflectionMetacognitionJournalPath,
  resolveReflectionPolicyPath,
} from '../../persistence/layout.js';
import { ReflectionMetacognitionJournalStore } from '../../persistence/journals/reflection-metacognition-journal.js';
import { ReflectionDailyJournalStore } from '../../persistence/journals/reflection-substrate.js';
import { ReflectionPolicyStore } from './reflection-policy.js';
import type { ReflectionAgent } from './reflection-runtime-contracts.js';
import { Scheduler } from './scheduler.js';
import { createReflectionTemplateRuntime } from './reflection-template-runtime.js';

describe('createReflectionTemplateRuntime failure resilience', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('journals a flagged degraded reflection when optional evidence grounding exhausts the parent turn', async () => {
    tempDir = createDailyReflectionDataDir('reflection-template-runtime-resilience-');
    const llmProvider: LLMProviderPort = {
      stream: vi.fn(async () => ({
        content: '',
        toolCalls: [],
        model: 'mock-stream',
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'stop',
      })),
      complete: vi.fn(async () => ({
        content: 'A bounded reflection still completed from the starter evidence.',
        toolCalls: [],
        model: 'mock-reasoning',
        inputTokens: 12,
        outputTokens: 18,
        stopReason: 'stop',
      })),
    };
    const handleMessage = vi.fn<ReflectionAgent['handleMessage']>(async () => {
      throw new ParentTurnContinuationBudgetExceededError({
        schemaVersion: 1,
        reason: 'wall_clock_limit',
        promptEntries: 3,
        maxPromptEntries: 36,
        elapsedMs: 300_000,
        maxWallTimeMs: 300_000,
      });
    });
    const runtime = createReflectionTemplateRuntime({
      scheduler: createScheduler(),
      agentLoop: {
        handleMessage,
        getCurrentAuthoritativeSystemPrompt: () => [
          '<immutable_human_safety_amendments>test policy</immutable_human_safety_amendments>',
          '<identity>test identity</identity>',
          '<runtime_emotional_affect>test affect</runtime_emotional_affect>',
        ].join('\n\n'),
      },
      dataDir: tempDir,
      runtimeOptions: { llmProvider },
    });

    const result = await runtime.runTemplateNow('daily-review', { deferIfBusy: false });

    expect(result.reflection).toBe('A bounded reflection still completed from the starter evidence.');
    expect(handleMessage).toHaveBeenCalledOnce();
    const metacognitionEntries = new ReflectionMetacognitionJournalStore(
      resolveReflectionMetacognitionJournalPath(tempDir),
    ).listRecent({ limit: 1 });
    expect(metacognitionEntries[0]).toMatchObject({
      kind: 'reflection_run',
      templateId: 'daily-review',
      reflection: 'A bounded reflection still completed from the starter evidence.',
      metacognitiveFlags: [
        expect.objectContaining({
          flag: 'reflection_evidence_grounding_degraded',
          confidence: 1,
        }),
      ],
    });
    const dailyEntries = new ReflectionDailyJournalStore(
      resolveReflectionDailyJournalsDir(tempDir),
    ).listRecent({ limit: 1 });
    expect(dailyEntries[0]?.tags).toEqual(expect.arrayContaining([
      'degraded',
      'evidence-grounding-unavailable',
    ]));
    expect(dailyEntries[0]?.prompt).toContain('[Evidence Grounding Degraded]');
  });

  it('degrades on an upstream idle timeout during optional evidence grounding', async () => {
    tempDir = createDailyReflectionDataDir('reflection-template-runtime-upstream-timeout-');
    const llmProvider = createSuccessfulDeliberationProvider();
    const runtime = createReflectionTemplateRuntime({
      scheduler: createScheduler(),
      agentLoop: {
        handleMessage: vi.fn(async () => {
          throw new Error('litellm.Timeout Upstream idle timeout exceeded');
        }),
        getCurrentAuthoritativeSystemPrompt: authoritativeSystemPrompt,
      },
      dataDir: tempDir,
      runtimeOptions: { llmProvider },
    });

    await expect(runtime.runTemplateNow('daily-review', { deferIfBusy: false }))
      .resolves.toMatchObject({ reflection: 'Reflection completed.' });
  });

  it('fails closed when optional evidence grounding raises an unknown error', async () => {
    tempDir = createDailyReflectionDataDir('reflection-template-runtime-fail-closed-');
    const llmProvider = createSuccessfulDeliberationProvider();
    const runtime = createReflectionTemplateRuntime({
      scheduler: createScheduler(),
      agentLoop: {
        handleMessage: vi.fn(async () => {
          throw new Error('reflection policy contract is malformed');
        }),
        getCurrentAuthoritativeSystemPrompt: authoritativeSystemPrompt,
      },
      dataDir: tempDir,
      runtimeOptions: { llmProvider },
    });

    await expect(runtime.runTemplateNow('daily-review', { deferIfBusy: false }))
      .rejects.toThrow('reflection policy contract is malformed');
    expect(llmProvider.complete).not.toHaveBeenCalled();
  });

  it('leaves a failed scheduled reflection on the scheduler task for Garden polling', async () => {
    tempDir = createDailyReflectionDataDir(
      'reflection-template-runtime-scheduler-failure-',
      'standard',
    );
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_700_000_000_000);
    const scheduler = createScheduler();
    createReflectionTemplateRuntime({
      scheduler,
      agentLoop: {
        handleMessage: vi.fn(async () => {
          throw new Error('upstream reflection generation timed out');
        }),
      },
      dataDir: tempDir,
    });

    nowSpy.mockReturnValue(1_700_000_000_000 + (2 * 24 * 60 * 60_000));
    await scheduler.tick();

    expect(scheduler.getTask('reflection:daily-review')).toMatchObject({
      state: 'idle',
      lastOutcome: 'failed',
      lastError: 'Error: upstream reflection generation timed out',
      lastErrorAt: 1_700_172_800_000,
    });
  });

  it('leaves a failed deferred scheduled reflection on its one-shot task for Garden polling', async () => {
    tempDir = createDailyReflectionDataDir(
      'reflection-template-runtime-deferred-failure-',
      'standard',
    );
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_700_000_000_000);
    const scheduler = createScheduler();
    const handleMessage = vi.fn<ReflectionAgent['handleMessage']>()
      .mockRejectedValueOnce(new Error('Agent is already processing another prompt'))
      .mockRejectedValueOnce(new Error('deferred upstream reflection generation timed out'));
    createReflectionTemplateRuntime({
      scheduler,
      agentLoop: {
        handleMessage,
        waitForIdle: vi.fn(async () => undefined),
      },
      dataDir: tempDir,
    });

    nowSpy.mockReturnValue(1_700_000_000_000 + (2 * 24 * 60 * 60_000));
    await scheduler.tick();
    const deferredTask = scheduler.listTasks().find(
      task => task.id.startsWith('reflection-run:deferred:scheduled:daily-review:'),
    );
    expect(deferredTask).toBeDefined();

    nowSpy.mockReturnValue((deferredTask?.runAt ?? 0) + 1);
    await scheduler.tick();

    expect(scheduler.getTask(deferredTask?.id ?? '')).toMatchObject({
      state: 'complete',
      lastOutcome: 'failed',
      lastError: 'Error: deferred upstream reflection generation timed out',
      lastErrorAt: (deferredTask?.runAt ?? 0) + 1,
    });
  });
});

function createScheduler(): Scheduler {
  return new Scheduler(new EventBus(), {
    tickIntervalMs: 100,
    heartbeatIntervalMs: 1_000,
  });
}

function createDailyReflectionDataDir(
  prefix: string,
  mode: 'standard' | 'deliberation' = 'deliberation',
): string {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  const policyStore = new ReflectionPolicyStore(resolveReflectionPolicyPath(dataDir));
  const policy = policyStore.load();
  const dailyTemplate = policy.templates.find(template => template.id === 'daily-review');
  if (!dailyTemplate) {
    throw new Error('daily-review template missing from defaults');
  }
  dailyTemplate.mode = mode;
  dailyTemplate.internalStateInput = false;
  policyStore.save(policy);
  return dataDir;
}

function createSuccessfulDeliberationProvider(): LLMProviderPort {
  return {
    stream: vi.fn(async () => ({
      content: '',
      toolCalls: [],
      model: 'mock-stream',
      inputTokens: 0,
      outputTokens: 0,
      stopReason: 'stop',
    })),
    complete: vi.fn(async () => ({
      content: 'Reflection completed.',
      toolCalls: [],
      model: 'mock-reasoning',
      inputTokens: 12,
      outputTokens: 18,
      stopReason: 'stop',
    })),
  };
}

function authoritativeSystemPrompt(): string {
  return [
    '<immutable_human_safety_amendments>test policy</immutable_human_safety_amendments>',
    '<identity>test identity</identity>',
    '<runtime_emotional_affect>test affect</runtime_emotional_affect>',
  ].join('\n\n');
}
