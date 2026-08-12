import { describe, expect, it, vi } from 'vitest';

import type { AutomataBusFindingEvent } from '../../../faculties/automata/bus/contract.js';
import type { AutomataBusEffectiveFinding } from '../../../faculties/automata/bus/current-state.js';
import { InMemoryAutomataRunStore, AutomataRunRegistry } from '../../../faculties/automata/run-registry.js';
import { loadAutomataPolicySeedDefaults } from '../../../system/config/automata-policy-config.js';
import {
  AdminAutomataDataService,
  AdminAutomataNotFoundError,
  type AdminAutomataBusReadInput,
  type AdminAutomataBusReadPort,
  type AdminAutomataLessonReadPort,
} from './automata-service.js';

const findingEvent: AutomataBusFindingEvent = {
  schemaVersion: 1,
  eventId: 'event-1',
  companionId: 'companion-test',
  sequence: 1,
  occurredAt: '2026-08-11T12:00:00.000Z',
  mustUnderstand: [],
  type: 'finding',
  context: {
    automatonClass: 'subagent.bounded',
    runId: 'run-1',
    taskId: 'task-1',
    sessionIds: ['private-session-id'],
    artifactRefs: ['file:///private/operator/transcript.txt'],
  },
  body: {
    claim: 'The focused check passed.',
    provenance: 'computed',
    source: 'private prompt text',
    confidence: 0.9,
    evidence: [{
      kind: 'artifact',
      reference: 'file:///private/operator/transcript.txt',
      summary: 'Focused test output.',
      digest: `sha256:${'a'.repeat(64)}`,
    }],
    verification: {
      status: 'verified',
      by: 'private-reviewer-id',
      evidenceRefs: ['file:///private/operator/transcript.txt'],
    },
  },
};

const currentFinding: AutomataBusEffectiveFinding = {
  eventId: findingEvent.eventId,
  companionId: findingEvent.companionId,
  sequence: findingEvent.sequence,
  occurredAt: findingEvent.occurredAt,
  context: findingEvent.context,
  body: findingEvent.body,
  sourceEventType: 'finding',
};

async function createRegistry(): Promise<AutomataRunRegistry> {
  const registry = await AutomataRunRegistry.hydrate({
    companionId: 'companion-test',
    policy: loadAutomataPolicySeedDefaults(),
    store: new InMemoryAutomataRunStore(),
    nowMs: 1,
  });
  await registry.register({
    runId: 'run-1',
    automatonClass: 'subagent.bounded',
    workerId: 'worker-1',
    taskId: 'task-1',
    taskLabel: 'Review',
    taskSummary: 'private prompt text',
    sessionIds: ['subagent:worker-1'],
    artifacts: [{
      kind: 'report',
      ref: 'file:///private/operator/report.md',
      custody: 'durable',
    }],
    createdAtMs: 2,
  });
  return registry;
}

function busPort(overrides: Partial<Awaited<ReturnType<AdminAutomataBusReadPort['readPage']>>> = {}) {
  const inputs: AdminAutomataBusReadInput[] = [];
  const port: AdminAutomataBusReadPort = {
    async readPage(input) {
      inputs.push(input);
      return {
        companionId: 'companion-test',
        events: [findingEvent],
        currentFindings: [currentFinding],
        dispositions: [],
        hasMore: false,
        eventIdMatched: true,
        health: {
          condition: 'degraded',
          freshness: 'stale',
          observedAt: '2026-08-11T12:01:00.000Z',
          lastEventAt: findingEvent.occurredAt,
          indexState: 'degraded',
          reindexState: 'running',
          pendingIndexCount: 2,
          degradationReasons: ['index_lagging'],
        },
        ...overrides,
      };
    },
  };
  return { inputs, port };
}

describe('AdminAutomataDataService', () => {
  it('projects bounded registry and Bus state without disclosing prompt, source, or raw references', async () => {
    const registry = await createRegistry();
    const { inputs, port } = busPort();
    const service = new AdminAutomataDataService({
      registry,
      companionId: 'companion-test',
      readPolicy: { defaultPageLimit: 5, maxPageLimit: 20 },
      bus: port,
    });

    const snapshot = await service.getSnapshot({
      limit: 5,
      busLimit: 4,
      busOffset: 8,
      busClassId: 'subagent.bounded',
      verificationStatus: 'verified',
    });

    expect(inputs).toEqual([expect.objectContaining({
      companionId: 'companion-test',
      limit: 4,
      offset: 8,
      classId: 'subagent.bounded',
      verificationStatus: 'verified',
    })]);
    expect(snapshot.runs).toEqual([expect.objectContaining({
      taskId: 'task-1',
      trigger: 'tool-or-post-turn-request',
      busEligibility: 'eligible',
      sessionIds: ['subagent:worker-1'],
      artifactCount: 1,
      artifactCustody: { discarded: 0, durable: 1, pending: 0 },
      promotionState: 'not_requested',
      foldState: 'not_required',
      retentionState: 'active_protected',
    })]);
    expect(snapshot.bus).toMatchObject({
      available: true,
      health: { condition: 'degraded', freshness: 'stale' },
      events: [{
        context: { sessionCount: 1, artifactCount: 1 },
        finding: {
          provenance: 'computed',
          verificationStatus: 'verified',
          evidence: [{ referenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) }],
        },
      }],
      currentFindings: [{ finding: { claim: 'The focused check passed.' } }],
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('private prompt text');
    expect(serialized).not.toContain('file:///private');
    expect(serialized).not.toContain('private-session-id');
    expect(serialized).not.toContain('private-reviewer-id');
  });

  it('fails unknown event lookups and cross-companion pages closed', async () => {
    const registry = await createRegistry();
    const unknown = busPort({ events: [], currentFindings: [], eventIdMatched: false });
    const unknownService = new AdminAutomataDataService({
      registry,
      companionId: 'companion-test',
      readPolicy: { defaultPageLimit: 5, maxPageLimit: 20 },
      bus: unknown.port,
    });
    await expect(unknownService.getSnapshot({ eventId: 'missing' }))
      .rejects.toBeInstanceOf(AdminAutomataNotFoundError);

    const crossCompanion = busPort({ companionId: 'companion-other' });
    const scopedService = new AdminAutomataDataService({
      registry,
      companionId: 'companion-test',
      readPolicy: { defaultPageLimit: 5, maxPageLimit: 20 },
      bus: crossCompanion.port,
    });
    const snapshot = await scopedService.getSnapshot();
    expect(snapshot.bus).toMatchObject({
      available: false,
      health: { condition: 'unavailable', degradationReasons: ['read_failed'] },
      events: [],
      currentFindings: [],
    });
  });

  it('reports an absent Bus port honestly and rejects pages beyond owner policy', async () => {
    const registry = await createRegistry();
    const service = new AdminAutomataDataService({
      registry,
      companionId: 'companion-test',
      readPolicy: { defaultPageLimit: 5, maxPageLimit: 20 },
    });

    await expect(service.getSnapshot({ limit: 21 })).rejects.toThrow(/between 1 and 20/);
    await expect(service.getSnapshot({ verificationStatus: 'guessed' })).rejects.toThrow(/Unknown/);
    expect((await service.getSnapshot()).bus).toMatchObject({
      available: false,
      health: { condition: 'unavailable', freshness: 'unknown' },
    });
  });

  it('logs Bus and lesson read failures before returning degraded operator state', async () => {
    const registry = await createRegistry();
    const logger = { error: vi.fn() };
    const service = new AdminAutomataDataService({
      registry,
      companionId: 'companion-test',
      readPolicy: { defaultPageLimit: 5, maxPageLimit: 20 },
      bus: {
        async readPage() {
          throw new Error('canonical Bus read unavailable');
        },
      },
      lessons: {
        async query() {
          throw new Error('lesson projection unavailable');
        },
      },
      logger,
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.bus.health.degradationReasons).toEqual(['read_failed']);
    expect(snapshot.lessons.degradationReason).toBe('read_failed');
    expect(logger.error).toHaveBeenCalledWith('Automata Bus operator read failed', {
      error: 'canonical Bus read unavailable',
    });
    expect(logger.error).toHaveBeenCalledWith('Automata lesson operator read failed', {
      error: 'lesson projection unavailable',
    });
  });

  it('exposes the content-safe recurrent lesson projection and governed review handoff', async () => {
    const registry = await createRegistry();
    const lessons: AdminAutomataLessonReadPort = {
      async query(scope) {
        expect(scope).toEqual({
          companionId: 'companion-test',
          audience: 'operator',
          maxSensitivity: 'confidential',
        });
        return {
          groups: [{
            groupId: `automata-lesson:v1:${'a'.repeat(64)}`,
            automatonClass: 'subagent.bounded',
            promptRevision: 'sha256:prompt-r1',
            toolName: 'repo',
            failureCategory: 'missing-instruction',
            lessonCode: 'read-before-edit',
            sourceCount: 2,
            support: 'supported',
            evidenceQuality: 'verified',
            sourceFindingIds: ['finding-1', 'finding-2'],
            evidenceIds: [`sha256:${'b'.repeat(64)}`],
            sourceTraceTruncated: false,
            contradiction: { present: false, sourceFindingIds: [] },
            inferenceOnly: false,
            interpretation: 'candidate-pattern-not-verified-defect',
          }],
          hasMore: false,
          sourceFindingCount: 2,
        };
      },
    };
    const service = new AdminAutomataDataService({
      registry,
      companionId: 'companion-test',
      readPolicy: { defaultPageLimit: 5, maxPageLimit: 20 },
      lessons,
    });

    expect((await service.getSnapshot()).lessons).toMatchObject({
      available: true,
      groups: [{ support: 'supported', evidenceQuality: 'verified', sourceCount: 2 }],
      proposalReviewPath: '/api/admin/shared-workspace/proposals',
    });
  });
});
