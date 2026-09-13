import { describe, expect, it } from 'vitest';

import {
  PRODUCTION_AUTOMATA_CLASSES,
  parseAutomataOwnerPolicy,
} from '../../automata/registry-contract.js';
import {
  AutomataRunRegistry,
  InMemoryAutomataRunStore,
} from '../../automata/run-registry.js';
import {
  createMemoryExtractionAutomataRunPort,
  failMemoryExtractionAutomataRun,
} from './memory-extraction-automata-run.js';

function automataPolicy() {
  return parseAutomataOwnerPolicy({
    schemaVersion: 1,
    bus: {
      eligibleClasses: PRODUCTION_AUTOMATA_CLASSES
        .filter(entry => entry.id !== 'memory.retrieval')
        .map(entry => entry.id),
      excludedClasses: ['memory.retrieval'],
      query: {
        maxQueryChars: 512,
        candidateLimit: 40,
        maxSearchResults: 20,
        maxBriefingItems: 8,
        maxBriefingChars: 4_000,
        maxBriefingClaimChars: 500,
        resultCacheEnabled: true,
        resultCacheTtlMs: 30_000,
        semanticWeight: 0.7,
        lexicalWeight: 0.3,
        exactFallbackEnabled: true,
        modelIdentityPolicy: 'configured-provider-strict',
      },
      reindex: { leaseDurationMs: 60_000 },
      reviewer: {
        enabled: true,
        cadenceMs: 60_000,
        model: 'gpt-5.4-nano',
        similarityThreshold: 0.9,
        maxFindingsPerRun: 100,
        maxNominationsPerRun: 80,
        maxCandidatesPerCluster: 8,
        maxClustersPerRun: 20,
        maxReviewsPerRun: 5,
        maxEvidenceRefsPerReview: 20,
        maxReviewInputChars: 24_000,
        maxDecisionReasonChars: 2_000,
        maxOutputTokens: 1_200,
        deadlineMs: 120_000,
        tokenCeiling: 4_000,
        costCeilingUsd: 0.25,
      },
      lessonProposal: { maxChangeChars: 4_000, maxSourceIds: 20 },
    },
    rawSessionRetentionMs: 30_000,
    retentionMs: { ephemeral: 1_000, standard: 10_000, extended: 20_000 },
    recentRunLimit: 25,
    operatorMutationLimit: 100,
  });
}

async function registry(): Promise<AutomataRunRegistry> {
  return await AutomataRunRegistry.hydrate({
    companionId: 'companion-a',
    policy: automataPolicy(),
    store: new InMemoryAutomataRunStore(),
    nowMs: 100,
  });
}

describe('memory extraction Automata run lifecycle', () => {
  it('recovers failed external attempts after retention hydration and terminalizes the bound retry', async () => {
    const store = new InMemoryAutomataRunStore();
    const hydrate = (nowMs: number) => AutomataRunRegistry.hydrate({
      companionId: 'companion-a', policy: automataPolicy(), store, nowMs,
    });
    const input = {
      runId: 'external-request-1', taskId: 'external-room', sessionId: 'external-session',
      triggerReason: 'external_conversation' as const, createdAtMs: 100,
    };
    const failure = {
      lifecycleState: 'failed' as const,
      outcome: 'blocked' as const,
      stateReason: 'memory_extraction_failed',
      failureReason: 'orchestration_failure',
    };
    let runs = await hydrate(100);
    const original = createMemoryExtractionAutomataRunPort(runs, input);
    await original.begin();
    await original.terminalize({ ...failure, atMs: 200 });

    runs = await hydrate(100_000);
    expect(runs.getRun(input.runId)).toBeNull();
    const retry = createMemoryExtractionAutomataRunPort(runs, { ...input, createdAtMs: 100_000 });
    const retried = await retry.begin();
    expect(retried).toMatchObject({ execute: true, attempt: 2 });
    expect(runs.getRun(retried.lineage.runId)).toMatchObject({
      sourceRunId: input.runId, status: 'running', workerGeneration: 2,
    });
    await retry.terminalize({ ...failure, atMs: 100_001 });
    const next = createMemoryExtractionAutomataRunPort(runs, { ...input, createdAtMs: 100_002 });
    const nextAttempt = await next.begin();
    expect(nextAttempt).toMatchObject({ execute: true, attempt: 3 });
    expect(runs.getRun(nextAttempt.lineage.runId)).toMatchObject({
      sourceRunId: retried.lineage.runId, status: 'running', workerGeneration: 3,
    });
    await next.terminalize({
      lifecycleState: 'completed', outcome: 'completed',
      stateReason: 'memory_extraction_completed', atMs: 100_003,
    });
    runs = await hydrate(200_000);
    const completed = createMemoryExtractionAutomataRunPort(runs, input);
    await expect(completed.begin()).resolves.toMatchObject({
      lineage: { runId: nextAttempt.lineage.runId }, execute: false, attempt: 3,
    });
    expect(runs.getRun(input.runId)?.status).toBe('failed');
    expect(runs.getRun(retried.lineage.runId)?.status).toBe('failed');
    expect(runs.getRun(nextAttempt.lineage.runId)?.status).toBe('completed');
  });

  it('does not retry cancelled external work or mismatched source lineage', async () => {
    const runs = await registry();
    const input = {
      runId: 'external-cancelled', taskId: 'room', sessionId: 'session',
      triggerReason: 'external_conversation' as const, createdAtMs: 100,
    };
    await createMemoryExtractionAutomataRunPort(runs, input).begin();
    await runs.transition(input.runId, { status: 'cancelled', reason: 'operator_cancelled', atMs: 101 });
    await expect(createMemoryExtractionAutomataRunPort(runs, input).begin())
      .rejects.toThrow('terminal cancelled run');
    await expect(createMemoryExtractionAutomataRunPort(runs, { ...input, sessionId: 'other-session' }).begin())
      .rejects.toThrow('lineage does not match');
    expect(runs.findByTask(input.taskId)).toHaveLength(1);
  });

  it('registers and starts the exact run before worker formation, then completes idempotently', async () => {
    const runs = await registry();
    const input = {
      runId: 'memory-extraction:turn-1',
      taskId: 'room-1',
      sessionId: 'session-1',
      triggerReason: 'response_turn' as const,
      createdAtMs: 100,
    };

    const port = createMemoryExtractionAutomataRunPort(runs, input);
    await expect(port.begin()).resolves.toMatchObject({
      companionId: 'companion-a',
      attempt: 1,
      execute: true,
      lineage: {
        automatonClass: 'memory.extraction',
        runId: input.runId,
        taskId: input.taskId,
        workerId: 'memory-extraction',
        sessionIds: [input.sessionId],
      },
    });
    expect(runs.getRun(input.runId)).toMatchObject({
      automatonClass: 'memory.extraction',
      taskId: input.taskId,
      sessionIds: [input.sessionId],
      status: 'running',
    });
    await expect(port.begin()).resolves.toMatchObject({ execute: true });

    await port.terminalize({
      lifecycleState: 'completed',
      outcome: 'completed',
      stateReason: 'memory_extraction_completed',
      atMs: 200,
    });
    await port.terminalize({
      lifecycleState: 'completed',
      outcome: 'completed',
      stateReason: 'memory_extraction_completed',
      atMs: 201,
    });
    expect(runs.getRun(input.runId)?.status).toBe('completed');
    // Restart: a re-entered terminal run is bound, never re-executed.
    await expect(port.begin()).resolves.toMatchObject({ execute: false });
  });

  it('terminalizes a non-retryable failure without masking the exact run', async () => {
    const runs = await registry();
    const input = {
      runId: 'memory-extraction:turn-2',
      taskId: 'room-2',
      sessionId: 'session-2',
      triggerReason: 'reflection_output' as const,
      createdAtMs: 100,
    };
    const port = createMemoryExtractionAutomataRunPort(runs, input);
    await port.begin();
    await failMemoryExtractionAutomataRun(runs, input.runId, 'formation_failed', 200);

    expect(runs.getRun(input.runId)).toMatchObject({
      status: 'failed',
      statusReason: 'memory_extraction_failed',
      failureReason: 'formation_failed',
    });
    await expect(port.begin()).rejects.toThrow('terminal failed run');
  });

  it('adopts an exact running background-work run instead of duplicating it', async () => {
    const runs = await registry();
    await runs.register({
      runId: 'request-1',
      automatonClass: 'memory.extraction',
      workerId: 'background-work:bgw_job-1',
      taskId: 'room-1',
      taskLabel: 'Memory extraction',
      taskSummary: 'Extract durable memory from a canonical source turn',
      sessionIds: ['room-1', 'channel-1'],
      createdAtMs: 100,
    });
    await runs.transition('request-1', {
      status: 'running',
      reason: 'background_work_claimed',
      atMs: 100,
    });

    const port = createMemoryExtractionAutomataRunPort(runs, {
      runId: 'request-1',
      taskId: 'room-1',
      sessionId: 'room-1',
      triggerReason: 'interval',
      createdAtMs: 101,
    });
    await expect(port.begin()).resolves.toMatchObject({
      execute: true,
      lineage: { workerId: 'background-work:bgw_job-1' },
    });
    expect(runs.getRun('request-1')).toMatchObject({
      workerId: 'background-work:bgw_job-1',
      status: 'running',
      statusReason: 'background_work_claimed',
    });
  });
});
