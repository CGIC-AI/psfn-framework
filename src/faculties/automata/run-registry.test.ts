import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_AUTOMATA_CLASSES,
  parseAutomataOwnerPolicy,
} from './registry-contract.js';
import { AutomataRunRegistry, InMemoryAutomataRunStore } from './run-registry.js';

function policy() {
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
    },
    retentionMs: { ephemeral: 1_000, standard: 10_000, extended: 20_000 },
    recentRunLimit: 25,
    operatorMutationLimit: 100,
  });
}

describe('AutomataRunRegistry', () => {
  it('hydrates retained active and recent runs and preserves task-to-session discovery', async () => {
    const store = new InMemoryAutomataRunStore();
    const first = await AutomataRunRegistry.hydrate({ companionId: 'companion-a', policy: policy(), store, nowMs: 100 });
    await first.register({
      runId: 'run-active',
      automatonClass: 'subagent.bounded',
      workerId: 'subagent-1',
      taskId: 'task-active',
      taskLabel: 'active task',
      taskSummary: 'inspect active state',
      sessionIds: ['subagent:subagent-1'],
      createdAtMs: 100,
    });
    await first.transition('run-active', { status: 'running', reason: 'agent_initialized', atMs: 125 });
    await first.register({
      runId: 'run-recent',
      automatonClass: 'subagent.bounded',
      workerId: 'subagent-2',
      taskId: 'task-recent',
      taskLabel: 'recent task',
      taskSummary: 'inspect recent state',
      sessionIds: ['subagent:subagent-2'],
      createdAtMs: 150,
    });
    await first.transition('run-recent', { status: 'running', reason: 'agent_initialized', atMs: 160 });
    await first.transition('run-recent', { status: 'completed', reason: 'completed', outcome: 'completed', atMs: 175 });

    const restarted = await AutomataRunRegistry.hydrate({ companionId: 'companion-a', policy: policy(), store, nowMs: 200 });

    expect(restarted.getRun('run-active')?.status).toBe('running');
    expect(restarted.getRun('run-recent')?.status).toBe('completed');
    expect(restarted.findByTask('task-recent')[0]?.sessionIds).toEqual(['subagent:subagent-2']);
  });

  it('fails closed on unknown class, status, and transition', async () => {
    const registry = await AutomataRunRegistry.hydrate({
      companionId: 'companion-a',
      policy: policy(),
      store: new InMemoryAutomataRunStore(),
    });
    await expect(registry.register({
      runId: 'unknown-class',
      automatonClass: 'not.registered',
      workerId: 'worker',
      taskId: 'task',
      taskLabel: 'task',
      taskSummary: 'task',
    })).rejects.toThrow('Unknown automata class');
    await registry.register({
      runId: 'run-1',
      automatonClass: 'subagent.bounded',
      workerId: 'subagent-1',
      taskId: 'task-1',
      taskLabel: 'task',
      taskSummary: 'task',
    });
    await expect(registry.transition('run-1', { status: 'paused', reason: 'bad' }))
      .rejects.toThrow('Unknown automata run status');
    await expect(registry.transition('run-1', { status: 'completed', reason: 'skip' }))
      .rejects.toThrow('queued -> completed');
  });

  it('keeps terminal retries and linked work-product references idempotent across hydration', async () => {
    const store = new InMemoryAutomataRunStore();
    const registry = await AutomataRunRegistry.hydrate({
      companionId: 'companion-a',
      policy: policy(),
      store,
      nowMs: 100,
    });
    await registry.register({
      runId: 'run-terminal',
      automatonClass: 'subagent.bounded',
      workerId: 'worker-terminal',
      taskId: 'task-terminal',
      taskLabel: 'Trace storage lineage',
      taskSummary: 'Inspect exact durable evidence references',
      parentRunId: 'run-parent',
      sourceRunId: 'run-root',
      sessionIds: ['subagent:worker-terminal', 'session-parent'],
      createdAtMs: 100,
    });
    await registry.transition('run-terminal', { status: 'running', reason: 'agent_initialized', atMs: 110 });
    const terminal = {
      status: 'completed',
      reason: 'completed',
      outcome: 'completed',
      atMs: 120,
    } as const;
    await registry.transition('run-terminal', terminal);
    await expect(registry.transition('run-terminal', { ...terminal, atMs: 999 })).resolves.toMatchObject({
      status: 'completed',
      finishedAtMs: 120,
    });
    const refs = [{ kind: 'automata_bus_handoff', ref: 'handoff:terminal', custody: 'durable' }] as const;
    await registry.linkArtifacts('run-terminal', refs);
    await registry.linkArtifacts('run-terminal', refs);

    const restarted = await AutomataRunRegistry.hydrate({
      companionId: 'companion-a',
      policy: policy(),
      store,
      nowMs: 125,
    });
    expect(restarted.findByTaskDescription('durable evidence', 5)).toEqual([
      expect.objectContaining({
        runId: 'run-terminal',
        parentRunId: 'run-parent',
        sourceRunId: 'run-root',
        artifacts: refs,
      }),
    ]);
  });

  it('makes bus eligibility exhaustive and operator-owned', () => {
    expect(() => parseAutomataOwnerPolicy({
      schemaVersion: 1,
      bus: {
        ...policy().bus,
        eligibleClasses: ['subagent.bounded'],
        excludedClasses: [],
      },
      retentionMs: { ephemeral: 1, standard: 2, extended: 3 },
      recentRunLimit: 5,
      operatorMutationLimit: 10,
    })).toThrow('does not assign bus policy');
    expect(() => parseAutomataOwnerPolicy({
      ...policy(),
      hiddenEligibilityOverride: true,
    })).toThrow('contains unknown keys');
  });

  it('validates every Bus query bound and identity behavior fail closed', () => {
    expect(policy().bus.query).toEqual({
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
    });

    expect(() => parseAutomataOwnerPolicy({
      ...policy(),
      bus: {
        ...policy().bus,
        query: { ...policy().bus.query, maxSearchResults: 41 },
      },
    })).toThrow('maxSearchResults must not exceed candidateLimit');
    expect(() => parseAutomataOwnerPolicy({
      ...policy(),
      bus: {
        ...policy().bus,
        query: { ...policy().bus.query, semanticWeight: 0.8 },
      },
    })).toThrow('weights must sum to 1');
    expect(() => parseAutomataOwnerPolicy({
      ...policy(),
      bus: {
        ...policy().bus,
        query: { ...policy().bus.query, modelIdentityPolicy: 'trust-index' },
      },
    })).toThrow('modelIdentityPolicy');
    expect(() => parseAutomataOwnerPolicy({
      ...policy(),
      bus: {
        ...policy().bus,
        query: { ...policy().bus.query, hiddenLimit: 1 },
      },
    })).toThrow('contains unknown keys');
  });
});
