import { describe, expect, it, vi } from 'vitest';

import type { AutomataBusFindingBody } from './contract.js';
import {
  parseAutomataBusReviewerPolicy,
  type AutomataBusReviewerPolicy,
} from './reviewer-policy.js';
import {
  AutomataBusReviewerService,
  createAutomataBusReviewerTask,
  type AutomataBusReviewerCurrentFinding,
  type AutomataBusReviewerFindingPort,
  type AutomataBusReviewerModelPort,
  type AutomataBusReviewerMutationPort,
  type AutomataBusReviewerOutcome,
  type AutomataBusReviewerOutcomePort,
} from './reviewer-service.js';
import type {
  AutomataBusReviewerCandidateBatch,
  AutomataBusReviewerCandidateCluster,
} from './reviewer-candidates.js';

const POLICY: AutomataBusReviewerPolicy = {
  enabled: true,
  cadenceMs: 3_600_000,
  model: 'reviewer-model-slot',
  similarityThreshold: 0.91,
  maxFindingsPerRun: 50,
  maxNominationsPerRun: 30,
  maxCandidatesPerCluster: 4,
  maxClustersPerRun: 10,
  maxReviewsPerRun: 5,
  maxEvidenceRefsPerReview: 12,
  maxReviewInputChars: 12_000,
  maxDecisionReasonChars: 800,
  maxOutputTokens: 900,
  deadlineMs: 45_000,
  tokenCeiling: 2_000,
  costCeilingUsd: 0.2,
};

const SCOPE = {
  companionId: 'companion-a',
  audience: 'operator' as const,
  maxSensitivity: 'confidential' as const,
};

function body(claim: string, reference: string): AutomataBusFindingBody {
  return {
    claim,
    provenance: 'computed',
    evidence: [{
      kind: 'artifact',
      reference,
      summary: `Evidence for ${claim}`,
    }],
    verification: {
      status: 'verified',
      by: 'test-reviewer',
      evidenceRefs: [reference],
    },
  };
}

function finding(
  eventId: string,
  claim = `Claim ${eventId}`,
): AutomataBusReviewerCurrentFinding {
  return {
    effectiveFinding: {
      eventId,
      companionId: SCOPE.companionId,
      sequence: eventId === 'event-a' ? 1 : 2,
      occurredAt: '2026-08-11T00:00:00.000Z',
      context: {
        automatonClass: 'subagent.bounded',
        runId: `source-run-${eventId}`,
        taskId: `source-task-${eventId}`,
        sessionIds: [],
        artifactRefs: [`artifact:${eventId}`],
      },
      body: body(claim, `artifact:${eventId}`),
      sourceEventType: 'finding',
    },
    audiences: ['eligible-automata', 'operator'],
    sensitivity: 'personal',
  };
}

function cluster(
  kind: AutomataBusReviewerCandidateCluster['kind'] = 'duplicate',
  eventIds = ['event-a', 'event-b'],
): AutomataBusReviewerCandidateCluster {
  return {
    clusterId: `cluster-${kind}-${eventIds.join('-')}`,
    kind,
    eventIds,
    ...(kind === 'duplicate' || kind === 'contradiction' ? { similarityScore: 1 } : {}),
  };
}

function batch(clusters: AutomataBusReviewerCandidateCluster[]): AutomataBusReviewerCandidateBatch {
  return {
    clusters,
    backlog: {
      findingsScanned: clusters.flatMap(candidate => candidate.eventIds).length,
      nominationsSeen: clusters.length,
      clustersReturned: clusters.length,
      hasMore: false,
    },
  };
}

function makeHarness(input: {
  clusters?: AutomataBusReviewerCandidateCluster[];
  findings?: AutomataBusReviewerCurrentFinding[];
  review?: AutomataBusReviewerModelPort['review'];
  append?: AutomataBusReviewerMutationPort['appendRelation'];
} = {}) {
  const handled = new Set<string>();
  const outcomes: AutomataBusReviewerOutcome[] = [];
  const candidates = {
    generate: vi.fn(async () => batch(input.clusters ?? [cluster()])),
  };
  const current = input.findings ?? [finding('event-a'), finding('event-b')];
  const findings: AutomataBusReviewerFindingPort = {
    loadCurrent: vi.fn(async ({ eventIds }) => (
      current.filter(candidate => eventIds.includes(candidate.effectiveFinding.eventId))
    )),
  };
  const model: AutomataBusReviewerModelPort = {
    review: vi.fn(input.review ?? (async () => ({
      status: 'complete',
      decision: {
        outcome: 'no-change',
        reason: 'The original evidence does not prove a conflict.',
        evidenceRefs: ['artifact:event-a'],
      },
    }))),
  };
  const mutations: AutomataBusReviewerMutationPort = {
    appendRelation: vi.fn(input.append ?? (async request => ({
      status: 'appended',
      eventId: request.idempotencyKey,
    }))),
  };
  const outcomeStore: AutomataBusReviewerOutcomePort = {
    findHandledClusterIds: vi.fn(async ({ clusterIds }) => (
      clusterIds.filter(clusterId => handled.has(clusterId))
    )),
    record: vi.fn(async outcome => {
      if (!outcomes.some(existing => existing.attemptId === outcome.attemptId)) {
        outcomes.push(outcome);
      }
      if (['applied', 'no-change', 'uncertain'].includes(outcome.status)) {
        handled.add(outcome.clusterId);
      }
    }),
    readHealth: vi.fn(async () => ({
      status: 'healthy',
      pendingClusters: 0,
      lastRunAt: '2026-08-11T01:00:00.000Z',
      outcomes: {
        applied: 0,
        noChange: outcomes.filter(outcome => outcome.status === 'no-change').length,
        uncertain: 0,
        partial: 0,
        failed: 0,
        stale: 0,
      },
    })),
  };
  return {
    service: new AutomataBusReviewerService({
      candidates,
      findings,
      model,
      mutations,
      outcomes: outcomeStore,
      policy: POLICY,
      now: () => new Date('2026-08-11T01:00:00.000Z'),
    }),
    candidates,
    findings,
    model,
    mutations,
    outcomeStore,
    outcomes,
  };
}

describe('Automata Bus reviewer owner policy', () => {
  it('strictly accepts the cadence, model, nomination, cluster, and work bounds', () => {
    expect(parseAutomataBusReviewerPolicy(POLICY, 'scheduler.json')).toEqual(POLICY);
    expect(() => parseAutomataBusReviewerPolicy({ ...POLICY, surprise: true }, 'scheduler.json'))
      .toThrow(/unknown fields: surprise/);
    expect(() => parseAutomataBusReviewerPolicy({
      ...POLICY,
      maxReviewsPerRun: POLICY.maxClustersPerRun + 1,
    }, 'scheduler.json')).toThrow(/maxReviewsPerRun.*maxClustersPerRun/);
  });
});

describe('AutomataBusReviewerService', () => {
  it('loads original claims and evidence but records explicit no-change without cosine mutation', async () => {
    const harness = makeHarness({ findings: [finding('event-b'), finding('event-a')] });

    const first = await harness.service.run({
      ...SCOPE,
      runId: 'review-run-1',
    });
    const second = await harness.service.run({
      ...SCOPE,
      runId: 'review-run-2',
    });

    expect(harness.findings.loadCurrent).toHaveBeenCalledWith({
      scope: SCOPE,
      eventIds: ['event-a', 'event-b'],
    });
    expect(harness.model.review).toHaveBeenCalledOnce();
    const modelInput = vi.mocked(harness.model.review).mock.calls[0]?.[0];
    expect(modelInput?.findings.map(candidate => candidate.effectiveFinding.eventId))
      .toEqual(['event-a', 'event-b']);
    expect(harness.model.review).toHaveBeenCalledWith(expect.objectContaining({
      cluster: expect.objectContaining({ similarityScore: 1 }),
      findings: expect.arrayContaining([
        expect.objectContaining({
          effectiveFinding: expect.objectContaining({
            body: expect.objectContaining({
              claim: 'Claim event-a',
              evidence: [expect.objectContaining({ reference: 'artifact:event-a' })],
            }),
          }),
        }),
      ]),
      work: {
        purpose: 'background',
        model: POLICY.model,
        durable: true,
        maxOutputTokens: POLICY.maxOutputTokens,
        deadlineMs: POLICY.deadlineMs,
        tokenCeiling: POLICY.tokenCeiling,
        costCeilingUsd: POLICY.costCeilingUsd,
        cancellation: 'caller_signal',
        retryPolicy: 'none',
        chargeLane: 'maintenance',
        chargeSurface: 'externalModelConsult',
      },
    }));
    expect(harness.mutations.appendRelation).not.toHaveBeenCalled();
    expect(first.outcomes.noChange).toBe(1);
    expect(second.skippedHandled).toBe(1);
    expect(harness.outcomes).toHaveLength(1);
  });

  it.each([
    { relation: 'corrects' as const, replacement: body('Corrected claim', 'artifact:event-a') },
    { relation: 'supersedes' as const, replacement: body('Newer claim', 'artifact:event-a') },
    { relation: 'retracts' as const, replacement: undefined },
  ])('appends only a complete evidence-citing $relation and preserves target visibility', async ({
    relation,
    replacement,
  }) => {
    const harness = makeHarness({
      review: async () => ({
        status: 'complete',
        decision: {
          outcome: 'relation',
          relation,
          targetEventId: 'event-a',
          reason: 'The inspected artifact contradicts the old claim.',
          evidenceRefs: ['artifact:event-a'],
          ...(replacement !== undefined ? { replacement } : {}),
        },
      }),
    });

    const report = await harness.service.run({ ...SCOPE, runId: 'review-run-correction' });

    expect(harness.mutations.appendRelation).toHaveBeenCalledWith({
      scope: SCOPE,
      reviewerRunId: 'review-run-correction',
      clusterId: cluster().clusterId,
      idempotencyKey: expect.stringMatching(/^automata-bus-review-relation:v1:/u),
      targetEventId: 'event-a',
      relation,
      reason: 'The inspected artifact contradicts the old claim.',
      evidenceRefs: ['artifact:event-a'],
      ...(replacement !== undefined ? { replacement } : {}),
      audiences: ['eligible-automata', 'operator'],
      sensitivity: 'personal',
    });
    expect(report.outcomes.applied).toBe(1);
  });

  it('leaves truth unchanged for uncertain, partial, failed, invalid, and stale reviews', async () => {
    const clusters = [
      cluster('stale-evidence', ['event-a']),
      cluster('orphan-provenance', ['event-b']),
      cluster('contradiction', ['event-c', 'event-d']),
      cluster('duplicate', ['event-e', 'event-f']),
      cluster('duplicate', ['missing-event', 'event-g']),
    ];
    const current = clusters.flatMap(candidate => candidate.eventIds)
      .filter(eventId => eventId !== 'missing-event')
      .map(eventId => finding(eventId));
    let call = 0;
    const harness = makeHarness({
      clusters,
      findings: current,
      review: async () => {
        call += 1;
        if (call === 1) {
          return {
            status: 'complete',
            decision: {
              outcome: 'uncertain',
              reason: 'The evidence cannot resolve staleness.',
              evidenceRefs: ['artifact:event-a'],
            },
          };
        }
        if (call === 2) return { status: 'partial', reason: 'deadline' };
        if (call === 3) throw new Error('model unavailable');
        return {
          status: 'complete',
          decision: {
            outcome: 'relation',
            relation: 'retracts',
            targetEventId: 'event-e',
            reason: 'Unsupported citation.',
            evidenceRefs: ['artifact:not-inspected'],
          },
        };
      },
    });

    const report = await harness.service.run({ ...SCOPE, runId: 'review-run-degraded' });

    expect(harness.mutations.appendRelation).not.toHaveBeenCalled();
    expect(report.outcomes).toEqual({
      applied: 0,
      noChange: 0,
      uncertain: 1,
      partial: 1,
      failed: 2,
      stale: 1,
    });
    expect(report.health).toBe('degraded');
  });

  it('refuses a current finding above the reviewer disclosure scope before model review', async () => {
    const tooSensitive = { ...finding('event-a'), sensitivity: 'secret' as const };
    const harness = makeHarness({
      clusters: [cluster('stale-evidence', ['event-a'])],
      findings: [tooSensitive],
    });

    const report = await harness.service.run({
      ...SCOPE,
      maxSensitivity: 'confidential',
      runId: 'review-run-scope',
    });

    expect(harness.model.review).not.toHaveBeenCalled();
    expect(harness.mutations.appendRelation).not.toHaveBeenCalled();
    expect(report.outcomes.stale).toBe(1);
  });

  it('caps review work and exposes the durable bounded health port for operator integration', async () => {
    const clusters = Array.from({ length: POLICY.maxReviewsPerRun + 2 }, (_, index) => (
      cluster('stale-evidence', [`event-${String(index)}`])
    ));
    const harness = makeHarness({
      clusters,
      findings: clusters.map(candidate => finding(candidate.eventIds[0]!)),
    });

    const report = await harness.service.run({ ...SCOPE, runId: 'review-run-bounded' });
    const health = await harness.service.readHealth(SCOPE);

    expect(harness.model.review).toHaveBeenCalledTimes(POLICY.maxReviewsPerRun);
    expect(report.backlog.remainingClusters).toBe(2);
    expect(health.status).toBe('healthy');
    expect(harness.outcomeStore.readHealth).toHaveBeenCalledWith({
      scope: SCOPE,
      maxOutcomes: POLICY.maxClustersPerRun,
    });
  });

  it('builds the scheduler-ready task and candidate generator from one owner policy', async () => {
    const harness = makeHarness({ clusters: [] });
    const nominations = {
      nominate: vi.fn(async () => ({
        nominations: [],
        totalNominations: 0,
        findingsScanned: 0,
        hasMore: false,
      })),
    };
    const task = createAutomataBusReviewerTask({
      nominations,
      findings: harness.findings,
      model: harness.model,
      mutations: harness.mutations,
      outcomes: harness.outcomeStore,
      policy: POLICY,
    });

    await task.run({ ...SCOPE, runId: 'review-run-factory' });

    expect(task.enabled).toBe(true);
    expect(task.cadenceMs).toBe(POLICY.cadenceMs);
    expect(nominations.nominate).toHaveBeenCalledWith({
      scope: SCOPE,
      similarityThreshold: POLICY.similarityThreshold,
      maxFindings: POLICY.maxFindingsPerRun,
      maxNominations: POLICY.maxNominationsPerRun,
    });
  });
});
