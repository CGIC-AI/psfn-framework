import { describe, expect, it, vi } from 'vitest';

import { loadAutomataPolicySeedDefaults } from '../../../system/config/automata-policy-config.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { AutomataRunRegistry, InMemoryAutomataRunStore } from '../run-registry.js';
import {
  AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE,
  type AutomataBusEvent,
} from './contract.js';
import type { AutomataBusProductionRuntime } from './production-runtime.js';
import type { PostgresAutomataBusRuntimeStore } from './runtime-store.js';
import {
  CanonicalAutomataBusWriter,
  createSubagentAutomataLifecycleAdapter,
} from './production-worker-adapter.js';
import { createAutomataBusReviewerModelAdapter } from './production-reviewer-adapters.js';

function createHarness() {
  const events = new Map<string, {
    event: AutomataBusEvent;
    audiences: string[];
    sensitivity: string;
  }>();
  const order: string[] = [];
  const store = {
    appendAllocated: vi.fn(async (input: {
      eventId: string;
      createEvent(sequence: number): unknown;
      audiences: string[];
      sensitivity: string;
    }) => {
      const incumbent = events.get(input.eventId);
      const event = input.createEvent(
        incumbent?.event.sequence ?? events.size + 1,
      ) as AutomataBusEvent;
      if (incumbent) {
        const same = JSON.stringify(incumbent.event) === JSON.stringify(event)
          && JSON.stringify(incumbent.audiences) === JSON.stringify([...input.audiences].sort())
          && incumbent.sensitivity === input.sensitivity;
        if (!same) {
          throw new Error(`Automata Bus eventId ${input.eventId} was reused with different content`);
        }
        return { event: incumbent.event, inserted: false };
      }
      order.push('persist');
      events.set(event.eventId, {
        event,
        audiences: [...input.audiences].sort(),
        sensitivity: input.sensitivity,
      });
      return { event, inserted: true };
    }),
    readHistory: vi.fn(async () => [...events.values()].map(value => value.event)),
  } as unknown as PostgresAutomataBusRuntimeStore;
  const canonical = {
    getCurrentByEventIds: vi.fn(async (input: { eventIds: string[] }) => {
      order.push('hydrate');
      const event = events.get(input.eventIds[0]!)?.event;
      if (!event || event.type !== 'finding') return [];
      return [{
        eventId: event.eventId,
        companionId: event.companionId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        automatonClass: event.context.automatonClass,
        taskId: event.context.taskId,
        runId: event.context.runId,
        claim: event.body.claim,
        provenance: event.body.provenance,
        verificationStatus: event.body.verification.status,
        audience: 'operator' as const,
        sensitivity: 'confidential' as const,
      }];
    }),
  };
  const indexing = {
    indexCurrentFinding: vi.fn(async (finding: { eventId: string }) => {
      order.push('index');
      return {
        status: 'indexed' as const,
        eventId: finding.eventId,
        modelIdentity: { provider: 'test', model: 'test', dimensions: 2 },
      };
    }),
  };
  const runtime = { canonical, indexing } as unknown as AutomataBusProductionRuntime;
  return {
    events,
    order,
    store,
    writer: new CanonicalAutomataBusWriter({
      companionId: 'companion-a',
      store,
      runtime,
    }),
  };
}

async function createRegistry() {
  const registry = await AutomataRunRegistry.hydrate({
    companionId: 'companion-a',
    policy: loadAutomataPolicySeedDefaults(),
    store: new InMemoryAutomataRunStore(),
  });
  await registry.register({
    runId: 'subagent-1',
    automatonClass: 'subagent.bounded',
    workerId: 'subagent-1',
    taskId: 'task-1',
    taskLabel: 'Inspect production runtime',
    taskSummary: 'Inspect production runtime',
    sessionIds: ['subagent:subagent-1'],
    createdAtMs: 1_700_000_000_000,
  });
  await registry.transition('subagent-1', {
    status: 'running',
    reason: 'agent_initialized',
    atMs: 1_700_000_000_010,
  });
  await registry.transition('subagent-1', {
    status: 'completed',
    reason: 'completed',
    outcome: 'completed',
    atMs: 1_700_000_000_100,
  });
  return registry;
}

describe('production Automata Bus lifecycle composition', () => {
  it('marks attributed findings with the required negotiated feature', async () => {
    const harness = createHarness();
    const registry = await createRegistry();
    const run = registry.getRun('subagent-1');
    if (!run) throw new Error('expected test run');

    const result = await harness.writer.append({
      eventId: 'finding-attributed',
      occurredAt: '2026-08-11T12:00:00.000Z',
      run,
      type: 'finding',
      body: {
        claim: 'The worker omitted a repository instruction.',
        provenance: 'computed',
        evidence: [{ kind: 'artifact', reference: 'artifact:test', summary: 'Reviewed output.' }],
        verification: { status: 'pending' },
        lessonAttribution: {
          promptRevision: 'sha256:prompt-r1',
          toolName: 'repo',
          failureCategory: 'missing-instruction',
          lessonCode: 'read-before-edit',
          contradictionEventIds: [],
        },
      },
      audiences: ['operator'],
      sensitivity: 'personal',
    });

    expect(result.event.mustUnderstand).toContain(AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE);
  });

  it('persists, hydrates, and only then indexes the canonical terminal finding', async () => {
    const harness = createHarness();
    const lifecycle = createSubagentAutomataLifecycleAdapter({
      companionId: 'companion-a',
      registry: await createRegistry(),
      store: harness.store,
      writer: harness.writer,
    });
    const receipt = await lifecycle.recordTerminalHandoff({
      idempotencyKey: 'terminal-key',
      lineage: {
        runId: 'subagent-1',
        taskId: 'task-1',
        workerId: 'subagent-1',
        sessionIds: ['subagent:subagent-1'],
      },
      lifecycleState: 'completed',
      outcome: 'completed',
      stateReason: 'completed',
      resultKind: 'final',
      usage: {
        model: 'test-model',
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 100,
        turns: 1,
      },
      outputRefs: [{ kind: 'session_output', ref: 'session:output:1', custody: 'pending' }],
      occurredAtMs: 1_700_000_000_100,
    });

    expect(receipt.inserted).toBe(true);
    expect(harness.order).toEqual(['persist', 'hydrate', 'index']);
  });

  it('replays exactly after artifact linking and rejects changed content under the same key', async () => {
    const harness = createHarness();
    const registry = await createRegistry();
    const lifecycle = createSubagentAutomataLifecycleAdapter({
      companionId: 'companion-a',
      registry,
      store: harness.store,
      writer: harness.writer,
    });
    const input = {
      idempotencyKey: 'terminal-key',
      lineage: {
        runId: 'subagent-1',
        taskId: 'task-1',
        workerId: 'subagent-1',
        sessionIds: ['subagent:subagent-1'],
      },
      lifecycleState: 'completed' as const,
      outcome: 'completed' as const,
      stateReason: 'completed',
      resultKind: 'final' as const,
      usage: {
        model: 'test-model',
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 100,
        turns: 1,
      },
      outputRefs: [{ kind: 'session_output', ref: 'session:output:1', custody: 'pending' as const }],
      occurredAtMs: 1_700_000_000_100,
    };
    const first = await lifecycle.recordTerminalHandoff(input);
    await registry.linkArtifacts('subagent-1', [{
      kind: 'automata_bus_handoff',
      ref: first.handoffRef,
      custody: 'durable',
    }]);
    const replay = await lifecycle.recordTerminalHandoff(input);

    expect(replay).toMatchObject({ inserted: false, handoffRef: first.handoffRef });
    await expect(lifecycle.recordTerminalHandoff({
      ...input,
      stateReason: 'changed-under-replay',
    })).rejects.toThrow(/reused with different content/u);
  });
});

describe('production Automata Bus reviewer model composition', () => {
  it('routes review through the scheduled maintenance work spec, charge surface, and owner model slot', async () => {
    const complete = vi.fn<LLMProviderPort['complete']>(async () => ({
      content: JSON.stringify({
        status: 'complete',
        decision: { outcome: 'no-change', reason: 'Evidence agrees.', evidenceRefs: [] },
      }),
      toolCalls: [],
      model: 'test-model',
      inputTokens: 10,
      outputTokens: 5,
      stopReason: 'end_turn',
    }));
    const adapter = createAutomataBusReviewerModelAdapter({
      llmProvider: { complete } as LLMProviderPort,
    });

    const result = await adapter.review({
      scope: {
        companionId: 'companion-a',
        audience: 'operator',
        maxSensitivity: 'confidential',
      },
      reviewerRunId: 'review-run-1',
      cluster: {
        clusterId: 'cluster-1',
        kind: 'duplicate',
        eventIds: ['event-a', 'event-b'],
        similarityScore: 1,
      },
      findings: [],
      work: {
        purpose: 'background',
        model: 'gpt-5.4-nano',
        durable: true,
        maxOutputTokens: 1_200,
        deadlineMs: 120_000,
        tokenCeiling: 4_000,
        costCeilingUsd: 0.25,
        cancellation: 'caller_signal',
        retryPolicy: 'none',
        chargeLane: 'maintenance',
        chargeSurface: 'externalModelConsult',
      },
    });

    expect(result).toEqual({
      status: 'complete',
      decision: { outcome: 'no-change', reason: 'Evidence agrees.', evidenceRefs: [] },
    });
    expect(complete).toHaveBeenCalledWith(
      expect.any(Object),
      'background',
      expect.objectContaining({
        modelHint: { slotKey: 'gpt-5.4-nano', maxTokens: 1_200 },
        workSpec: expect.objectContaining({
          lane: 'maintenance_reflection',
          durable: true,
          maxOutputTokens: 1_200,
          deadlineMs: 120_000,
          tokenCeiling: 4_000,
          costCeilingUsd: 0.25,
          cancellation: 'caller_signal',
          retryPolicy: 'none',
        }),
      }),
    );
  });
});
