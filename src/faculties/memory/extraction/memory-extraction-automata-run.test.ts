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
  beginMemoryExtractionAutomataRun,
  completeMemoryExtractionAutomataRun,
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
  it('registers and starts the exact run before worker formation, then completes idempotently', async () => {
    const runs = await registry();
    const input = {
      runId: 'memory-extraction:turn-1',
      taskId: 'room-1',
      sessionId: 'session-1',
      triggerReason: 'response_turn' as const,
      createdAtMs: 100,
    };

    await expect(beginMemoryExtractionAutomataRun(runs, input)).resolves.toEqual({
      runId: input.runId,
      execute: true,
    });
    expect(runs.getRun(input.runId)).toMatchObject({
      automatonClass: 'memory.extraction',
      taskId: input.taskId,
      sessionIds: [input.sessionId],
      status: 'running',
    });
    await expect(beginMemoryExtractionAutomataRun(runs, input)).resolves.toEqual({
      runId: input.runId,
      execute: true,
    });

    await completeMemoryExtractionAutomataRun(runs, input.runId, 200);
    await completeMemoryExtractionAutomataRun(runs, input.runId, 201);
    expect(runs.getRun(input.runId)?.status).toBe('completed');
    await expect(beginMemoryExtractionAutomataRun(runs, input)).resolves.toEqual({
      runId: input.runId,
      execute: false,
    });
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
    await beginMemoryExtractionAutomataRun(runs, input);
    await failMemoryExtractionAutomataRun(runs, input.runId, 'formation_failed', 200);

    expect(runs.getRun(input.runId)).toMatchObject({
      status: 'failed',
      statusReason: 'memory_extraction_failed',
      failureReason: 'formation_failed',
    });
    await expect(beginMemoryExtractionAutomataRun(runs, input)).rejects.toThrow(
      'terminal failed run',
    );
  });
});
