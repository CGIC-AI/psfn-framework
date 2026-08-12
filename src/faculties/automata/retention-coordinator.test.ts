import { describe, expect, it, vi } from 'vitest';
import {
  AutomataRetentionCoordinator,
  evaluateAutomataRetentionEligibility,
} from './retention-coordinator.js';
import type {
  AutomataRetentionProof,
  AutomataSessionPurgeSurface,
  ExactSessionPurgeReport,
} from './retention-contract.js';
import type { AutomataSessionClassification } from './session-classification.js';
import { InMemoryAutomataRetentionStore } from './retention-store.js';

const classification: AutomataSessionClassification = {
  schemaVersion: 1,
  companionId: 'companion-a',
  sessionId: 'session-a',
  ownership: 'automata',
  runId: 'run-a',
  automatonClass: 'subagent.bounded',
  workerGeneration: 2,
  classifiedAtMs: 100,
  retentionDeadlineMs: 200,
};

const proof: AutomataRetentionProof = {
  companionId: 'companion-a',
  sessionId: 'session-a',
  runId: 'run-a',
  automatonClass: 'subagent.bounded',
  workerGeneration: 2,
  generationState: 'terminal',
  runStatus: 'completed',
  pendingWorkCount: 0,
  handoffState: 'recorded',
  artifacts: [{ kind: 'commit', ref: 'artifact:commit:abc', custody: 'durable' }],
  promotionReceipt: {
    disposition: 'promoted',
    receiptRefs: ['bus:receipt:1'],
    copiedEvidenceRefs: ['bus:evidence:1'],
  },
  reviewState: 'clear',
  foldState: 'not_required',
  targetRevision: 'revision-1',
};

const surfaces: AutomataSessionPurgeSurface[] = [
  'journals',
  'journal_rolls',
  'channel_index',
  'transcript_projection',
  'turn_records',
  'redis_tail_pointers',
];

function purgeReport(overrides: Partial<ExactSessionPurgeReport> = {}): ExactSessionPurgeReport {
  return {
    companionId: classification.companionId,
    sessionId: classification.sessionId,
    runId: classification.runId,
    targetRevision: proof.targetRevision,
    status: 'purged',
    surfaces: surfaces.map(surface => ({ surface, status: 'removed', removedCount: 1 })),
    verifiedPreservedReferences: [
      'artifact:commit:abc',
      'bus:evidence:1',
      'bus:receipt:1',
    ],
    ...overrides,
  };
}

function coordinatorHarness(input: {
  store?: InMemoryAutomataRetentionStore;
  proofs?: Array<AutomataRetentionProof | null>;
  report?: ExactSessionPurgeReport;
  purgeError?: Error;
  custodyError?: Error;
} = {}) {
  const store = input.store ?? new InMemoryAutomataRetentionStore();
  const loaded = input.proofs ?? [proof, proof];
  let proofIndex = 0;
  const purgeExactSession = vi.fn(async () => {
    if (input.purgeError) throw input.purgeError;
    return input.report ?? purgeReport();
  });
  const assertResolvable = vi.fn(async () => {
    if (input.custodyError) throw input.custodyError;
  });
  return {
    store,
    purgeExactSession,
    assertResolvable,
    coordinator: new AutomataRetentionCoordinator({
      store,
      proofs: {
        loadProof: vi.fn(async () => loaded[Math.min(proofIndex++, loaded.length - 1)] ?? null),
      },
      custody: { assertResolvable },
      purge: { purgeExactSession },
    }),
  };
}

describe('evaluateAutomataRetentionEligibility', () => {
  it.each([
    [{ runStatus: 'running' as const }, 'run_not_terminal'],
    [{ generationState: 'active' as const }, 'generation_not_terminal'],
    [{ workerGeneration: 3 }, 'generation_not_terminal'],
    [{ pendingWorkCount: 1 }, 'pending_work'],
    [{ handoffState: 'pending' as const }, 'pending_handoff'],
    [{ artifacts: [{ kind: 'commit', ref: 'artifact:1', custody: 'pending' as const }] }, 'artifact_custody_pending'],
    [{ promotionReceipt: undefined }, 'promotion_receipt_missing'],
    [{ reviewState: 'pending' as const }, 'review_pending'],
  ])('fails closed when a required proof is absent: %s', (override, reason) => {
    expect(evaluateAutomataRetentionEligibility(
      classification,
      { ...proof, ...override },
      classification.retentionDeadlineMs,
    )).toMatchObject({ eligible: false, reason });
  });

  it('requires explicit elapsed owner policy', () => {
    expect(evaluateAutomataRetentionEligibility(classification, proof, 199))
      .toMatchObject({ eligible: false, reason: 'retention_window_open' });
  });

  it('retains an unfolded shard session', () => {
    const shard = { ...classification, automatonClass: 'shard.long_horizon' as const };
    const shardProof = {
      ...proof,
      automatonClass: 'shard.long_horizon',
      foldState: 'pending' as const,
    };
    expect(evaluateAutomataRetentionEligibility(shard, shardProof, 200))
      .toMatchObject({ eligible: false, reason: 'shard_unfolded' });
  });

  it('accepts an explicit nothing-to-promote receipt as durable promotion proof', () => {
    expect(evaluateAutomataRetentionEligibility(classification, {
      ...proof,
      promotionReceipt: {
        disposition: 'nothing_to_promote',
        receiptRef: 'bus:receipt:nothing',
      },
    }, 200)).toEqual({
      eligible: true,
      reason: 'eligible',
      preserveReferences: ['artifact:commit:abc', 'bus:receipt:nothing'],
    });
  });
});

describe('AutomataRetentionCoordinator', () => {
  it('revalidates, purges every exact surface, preserves refs, and writes a content-free receipt', async () => {
    const harness = coordinatorHarness();
    await harness.store.recordClassification(classification);

    await expect(harness.coordinator.run({ companionId: 'companion-a', nowMs: 200, limit: 10 }))
      .resolves.toEqual([{ sessionId: 'session-a', outcome: 'purged', reason: 'eligible' }]);
    expect(harness.purgeExactSession).toHaveBeenCalledWith({
      companionId: 'companion-a',
      sessionId: 'session-a',
      runId: 'run-a',
      targetRevision: 'revision-1',
      preserveReferences: ['artifact:commit:abc', 'bus:evidence:1', 'bus:receipt:1'],
    });
    expect(harness.assertResolvable).toHaveBeenCalledTimes(2);
    const audit = harness.store.listAuditEvents();
    expect(audit.map(event => event.kind)).toEqual(['purge_started', 'purged']);
    expect(audit[1]).toMatchObject({
      preservedReferenceCount: 3,
      removedCounts: Object.fromEntries(surfaces.map(surface => [surface, 1])),
    });
    expect(JSON.stringify(audit)).not.toContain('raw worker message');
  });

  it('is restart-safe and idempotent after a durable success receipt', async () => {
    const sharedStore = new InMemoryAutomataRetentionStore();
    await sharedStore.recordClassification(classification);
    const first = coordinatorHarness({ store: sharedStore });
    await first.coordinator.run({ companionId: 'companion-a', nowMs: 200, limit: 10 });

    const restarted = coordinatorHarness({ store: sharedStore });
    await expect(restarted.coordinator.run({ companionId: 'companion-a', nowMs: 300, limit: 10 }))
      .resolves.toEqual([{
        sessionId: 'session-a',
        outcome: 'already_purged',
        reason: 'already_purged',
      }]);
    expect(restarted.purgeExactSession).not.toHaveBeenCalled();
  });

  it('never reports partial exact cleanup as success and leaves a retryable diagnostic', async () => {
    const incomplete = purgeReport({
      surfaces: purgeReport().surfaces.filter(entry => entry.surface !== 'turn_records'),
    });
    const harness = coordinatorHarness({ report: incomplete });
    await harness.store.recordClassification(classification);

    await expect(harness.coordinator.run({ companionId: 'companion-a', nowMs: 200, limit: 10 }))
      .resolves.toEqual([{
        sessionId: 'session-a',
        outcome: 'retryable_failure',
        reason: 'purge_incomplete',
      }]);
    expect(await harness.store.hasPurgeReceipt('companion-a', 'session-a')).toBe(false);
    expect(harness.store.listAuditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'retryable_failure', reason: 'purge_incomplete' }),
    ]));
  });

  it('retains when target revision changes during mandatory revalidation', async () => {
    const harness = coordinatorHarness({ proofs: [proof, { ...proof, targetRevision: 'revision-2' }] });
    await harness.store.recordClassification(classification);

    await expect(harness.coordinator.run({ companionId: 'companion-a', nowMs: 200, limit: 10 }))
      .resolves.toEqual([{ sessionId: 'session-a', outcome: 'retained', reason: 'target_changed' }]);
    expect(harness.purgeExactSession).not.toHaveBeenCalled();
  });

  it('keeps unknown and companion-owned classifications outside the deletion candidate set', async () => {
    const harness = coordinatorHarness();
    await harness.store.recordClassification({
      schemaVersion: 1,
      companionId: 'companion-a',
      sessionId: 'unknown-session',
      ownership: 'unknown',
      classifiedAtMs: 1,
    });
    await harness.store.recordClassification({
      schemaVersion: 1,
      companionId: 'companion-a',
      sessionId: 'companion-session',
      ownership: 'companion',
      classifiedAtMs: 1,
    });

    await expect(harness.coordinator.run({ companionId: 'companion-a', nowMs: 99_999, limit: 10 }))
      .resolves.toEqual([]);
    expect(harness.purgeExactSession).not.toHaveBeenCalled();
  });
});
