import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KubeDeploymentDiagnostic } from './kube-diagnostics.js';
import {
  decideAutoRollback,
  executeAutoRollback,
  type CurrentRolloutBinding,
  type KubeRollbackTargetResolution,
} from './kube-auto-rollback.js';
import type { PostRolloutValidationRecord } from './kube-post-rollout-validation.js';
import { writePostRolloutValidationVerdict } from './kube-post-rollout-validation-store.js';
import {
  readKubeRollbackHistory,
  type KubeRollbackRecord,
} from './kube-rollback-store.js';
import type { KubeHelmRollbackApiPort } from './kube-helm-rollback.js';

const RELEASE = 'psfn';
const NAMESPACE = 'psfn';
const RESOURCE_PREFIX = 'psfn';
const COMMIT_N = 'a'.repeat(40);
const COMMIT_PRIOR = 'b'.repeat(40);

function ready(name: string): KubeDeploymentDiagnostic {
  return {
    name,
    generation: 2,
    observedGeneration: 2,
    desiredReplicas: 1,
    readyReplicas: 1,
    updatedReplicas: 1,
    availableReplicas: 1,
  };
}

function rolling(name: string): KubeDeploymentDiagnostic {
  return {
    name,
    generation: 2,
    observedGeneration: 1,
    desiredReplicas: 1,
    readyReplicas: 0,
    updatedReplicas: 0,
    availableReplicas: 0,
  };
}

function verdict(
  overrides: Partial<PostRolloutValidationRecord>,
): PostRolloutValidationRecord {
  const healthy = overrides.healthy ?? false;
  return {
    schemaVersion: 1,
    namespace: NAMESPACE,
    release: RELEASE,
    sourceCommit: COMMIT_N,
    imageReference: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaa',
    imageRevisionLabel: COMMIT_N,
    helmRevision: 9,
    trigger: 'deploy_pipeline',
    startedAt: 1_000,
    completedAt: 2_000,
    overall: healthy ? 'passed' : 'failed',
    healthy,
    recommendedAction: healthy ? 'none' : 'rollback',
    checks: [],
    failedChecks: healthy ? [] : ['garden_health'],
    ...overrides,
  };
}

const CURRENT: CurrentRolloutBinding = {
  release: RELEASE,
  helmRevision: 9,
  sourceCommit: COMMIT_N,
};

describe('decideAutoRollback — binding contract (x5rt.7 review)', () => {
  it('rolls back when the verdict binds to the current rollout and is unhealthy', () => {
    const decision = decideAutoRollback(CURRENT, verdict({ healthy: false }), []);
    expect(decision.kind).toBe('rollback');
    if (decision.kind === 'rollback') {
      expect(decision.fromHelmRevision).toBe(9);
      expect(decision.failedChecks).toEqual(['garden_health']);
    }
  });

  it('reports healthy (no rollback) when the bound verdict is healthy', () => {
    const decision = decideAutoRollback(CURRENT, verdict({ healthy: true }), []);
    expect(decision.kind).toBe('healthy');
  });

  it('a STALE HEALTHY verdict from a prior rollout does NOT suppress — it surfaces, never healthy', () => {
    // Verdict is healthy but bound to the PRIOR rollout (different revision + commit).
    const stale = verdict({
      healthy: true,
      helmRevision: 8,
      sourceCommit: COMMIT_PRIOR,
      imageRevisionLabel: COMMIT_PRIOR,
    });
    const decision = decideAutoRollback(CURRENT, stale, []);
    expect(decision.kind).toBe('surface');
    if (decision.kind === 'surface') {
      expect(decision.reasonCode).toBe('binding_mismatch');
    }
    // Critically: it is NOT classified healthy — a stale healthy cannot green-light the new rollout.
    expect(decision.kind).not.toBe('healthy');
  });

  it('a STALE FAILED verdict from a prior rollout does NOT trigger a rollback', () => {
    const staleFailed = verdict({
      healthy: false,
      helmRevision: 8,
      sourceCommit: COMMIT_PRIOR,
    });
    const decision = decideAutoRollback(CURRENT, staleFailed, []);
    expect(decision.kind).toBe('surface');
    if (decision.kind === 'surface') expect(decision.reasonCode).toBe('binding_mismatch');
  });

  it('an ABSENT verdict surfaces (no auto-rollback on absence) and never declares health', () => {
    const decision = decideAutoRollback(CURRENT, null, []);
    expect(decision.kind).toBe('surface');
    if (decision.kind === 'surface') expect(decision.reasonCode).toBe('no_verdict');
    expect(decision.kind).not.toBe('healthy');
  });

  it('a WAIVED verdict surfaces (operator owns it), never rollback and never health', () => {
    const waived = verdict({
      overall: 'waived',
      healthy: true,
      recommendedAction: 'none',
      emergencyWaiver: { justification: 'operator emergency' },
    });
    const decision = decideAutoRollback(CURRENT, waived, []);
    expect(decision.kind).toBe('surface');
    if (decision.kind === 'surface') expect(decision.reasonCode).toBe('waived');
  });

  it('a malformed verdict object surfaces rather than mis-binding', () => {
    const decision = decideAutoRollback(
      CURRENT,
      { schemaVersion: 1 } as unknown as PostRolloutValidationRecord,
      [],
    );
    expect(decision.kind).toBe('surface');
    if (decision.kind === 'surface') expect(decision.reasonCode).toBe('malformed_verdict');
  });

  it('ACT ONCE: an unhealthy bound verdict does NOT re-fire once a rollback away from the revision is recorded', () => {
    const ledger: KubeRollbackRecord[] = [{
      schemaVersion: 1,
      namespace: NAMESPACE,
      release: RELEASE,
      trigger: 'automatic',
      fromHelmRevision: 9,
      targetHelmRevision: 8,
      reason: 'post-rollout validation failed: garden_health',
      validationResult: 'passed',
      outcome: 'succeeded',
      startedAt: 1,
      completedAt: 2,
    }];
    const decision = decideAutoRollback(CURRENT, verdict({ healthy: false }), ledger);
    expect(decision.kind).toBe('surface');
    if (decision.kind === 'surface') expect(decision.reasonCode).toBe('already_acted');
  });

  it('ACT ONCE also holds when the recorded rollback FAILED (never silently re-fire)', () => {
    const ledger: KubeRollbackRecord[] = [{
      schemaVersion: 1,
      namespace: NAMESPACE,
      release: RELEASE,
      trigger: 'automatic',
      fromHelmRevision: 9,
      targetHelmRevision: 8,
      reason: 'post-rollout validation failed',
      validationResult: 'failed',
      outcome: 'failed',
      startedAt: 1,
      completedAt: 2,
    }];
    const decision = decideAutoRollback(CURRENT, verdict({ healthy: false }), ledger);
    expect(decision.kind).toBe('surface');
    if (decision.kind === 'surface') expect(decision.reasonCode).toBe('already_acted');
  });

  it('a ledger rollback for a DIFFERENT revision does not block the current one', () => {
    const ledger: KubeRollbackRecord[] = [{
      schemaVersion: 1,
      namespace: NAMESPACE,
      release: RELEASE,
      trigger: 'automatic',
      fromHelmRevision: 7,
      targetHelmRevision: 6,
      reason: 'earlier rollback',
      validationResult: 'passed',
      outcome: 'succeeded',
      startedAt: 1,
      completedAt: 2,
    }];
    const decision = decideAutoRollback(CURRENT, verdict({ healthy: false }), ledger);
    expect(decision.kind).toBe('rollback');
  });
});

describe('executeAutoRollback — orchestrator', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kube-auto-rollback-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function api(overrides?: Partial<KubeHelmRollbackApiPort>): KubeHelmRollbackApiPort {
    return {
      rollback: vi.fn(async () => ({ helmRevision: 10 })),
      getDeployment: vi.fn(async (_ns: string, name: string) => ready(name)),
      ...overrides,
    };
  }

  const target: (rev: number) => Promise<KubeRollbackTargetResolution> =
    async () => ({ kind: 'target', targetRevision: 8, targetSourceCommit: COMMIT_PRIOR });

  it('rolls back a failed, bound rollout and records the action once', async () => {
    writePostRolloutValidationVerdict(dir, verdict({ healthy: false }));
    const rollback = api();
    const audit = vi.fn(async () => undefined);
    const outcome = await executeAutoRollback({
      namespace: NAMESPACE,
      release: RELEASE,
      resourcePrefix: RESOURCE_PREFIX,
      systemDataDir: dir,
      currentRollout: CURRENT,
      api: rollback,
      resolveRollbackTarget: target,
      audit,
    });
    expect(outcome.status).toBe('rolled_back');
    expect(rollback.rollback).toHaveBeenCalledWith(NAMESPACE, RELEASE, 8);
    const history = readKubeRollbackHistory(dir);
    expect(history).toHaveLength(1);
    expect(history[0].fromHelmRevision).toBe(9);
    expect(history[0].targetHelmRevision).toBe(8);
    expect(history[0].outcome).toBe('succeeded');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ status: 'rolled_back' }));
  });

  it('does NOT roll back twice: the FAILED verdict lingering after a rollback is act-once guarded', async () => {
    writePostRolloutValidationVerdict(dir, verdict({ healthy: false }));
    const rollback = api();
    // First evaluation rolls back.
    await executeAutoRollback({
      namespace: NAMESPACE, release: RELEASE, resourcePrefix: RESOURCE_PREFIX,
      systemDataDir: dir, currentRollout: CURRENT, api: rollback, resolveRollbackTarget: target,
    });
    // The verdict file still holds the FAILED verdict of revision 9. A second
    // evaluation (before any new verdict is written) must NOT roll back again.
    const outcome = await executeAutoRollback({
      namespace: NAMESPACE, release: RELEASE, resourcePrefix: RESOURCE_PREFIX,
      systemDataDir: dir, currentRollout: CURRENT, api: rollback, resolveRollbackTarget: target,
    });
    expect(outcome.status).toBe('surfaced');
    if (outcome.status === 'surfaced') expect(outcome.reasonCode).toBe('already_acted');
    expect(rollback.rollback).toHaveBeenCalledTimes(1);
    expect(readKubeRollbackHistory(dir)).toHaveLength(1);
  });

  it('no-op (surfaced) when a stale healthy verdict from the prior deploy lingers', async () => {
    // latest.json holds a HEALTHY verdict for the PRIOR rollout (rev 8).
    writePostRolloutValidationVerdict(dir, verdict({
      healthy: true, helmRevision: 8, sourceCommit: COMMIT_PRIOR, imageRevisionLabel: COMMIT_PRIOR,
    }));
    const rollback = api();
    const outcome = await executeAutoRollback({
      namespace: NAMESPACE, release: RELEASE, resourcePrefix: RESOURCE_PREFIX,
      systemDataDir: dir, currentRollout: CURRENT, api: rollback, resolveRollbackTarget: target,
    });
    expect(outcome.status).toBe('surfaced');
    if (outcome.status === 'surfaced') expect(outcome.reasonCode).toBe('binding_mismatch');
    // The stale healthy verdict must NOT be read as health, but also must not roll back blindly.
    expect(rollback.rollback).not.toHaveBeenCalled();
  });

  it('no-op when no previous revision exists (first-ever revision)', async () => {
    writePostRolloutValidationVerdict(dir, verdict({ healthy: false }));
    const rollback = api();
    const outcome = await executeAutoRollback({
      namespace: NAMESPACE, release: RELEASE, resourcePrefix: RESOURCE_PREFIX,
      systemDataDir: dir, currentRollout: CURRENT, api: rollback,
      resolveRollbackTarget: async () => ({ kind: 'no_previous_revision' }),
    });
    expect(outcome.status).toBe('no_previous_revision');
    expect(rollback.rollback).not.toHaveBeenCalled();
    expect(readKubeRollbackHistory(dir)).toHaveLength(0);
  });

  it('refuses an unsafe target revision (same or roll-forward) and never calls api.rollback', async () => {
    // CURRENT.helmRevision (the failed revision) is 9; a target >= 9 is a
    // same-revision or roll-forward "rollback" — catastrophic, must be rejected.
    for (const unsafe of [9, 10]) {
      writePostRolloutValidationVerdict(dir, verdict({ healthy: false }));
      const rollback = api();
      await expect(executeAutoRollback({
        namespace: NAMESPACE, release: RELEASE, resourcePrefix: RESOURCE_PREFIX,
        systemDataDir: dir, currentRollout: CURRENT, api: rollback,
        resolveRollbackTarget: async () => ({ kind: 'target', targetRevision: unsafe }),
      })).rejects.toThrow(/unsafe target revision/i);
      expect(rollback.rollback).not.toHaveBeenCalled();
      expect(readKubeRollbackHistory(dir)).toHaveLength(0);
    }
  });

  it('refuses a zero/negative/non-integer target revision and never calls api.rollback', async () => {
    for (const unsafe of [0, -1, 2.5]) {
      writePostRolloutValidationVerdict(dir, verdict({ healthy: false }));
      const rollback = api();
      await expect(executeAutoRollback({
        namespace: NAMESPACE, release: RELEASE, resourcePrefix: RESOURCE_PREFIX,
        systemDataDir: dir, currentRollout: CURRENT, api: rollback,
        resolveRollbackTarget: async () => ({ kind: 'target', targetRevision: unsafe }),
      })).rejects.toThrow(/unsafe target revision/i);
      expect(rollback.rollback).not.toHaveBeenCalled();
      expect(readKubeRollbackHistory(dir)).toHaveLength(0);
    }
  });

  it('healthy rollout is a no-op', async () => {
    writePostRolloutValidationVerdict(dir, verdict({ healthy: true }));
    const rollback = api();
    const outcome = await executeAutoRollback({
      namespace: NAMESPACE, release: RELEASE, resourcePrefix: RESOURCE_PREFIX,
      systemDataDir: dir, currentRollout: CURRENT, api: rollback, resolveRollbackTarget: target,
    });
    expect(outcome.status).toBe('healthy');
    expect(rollback.rollback).not.toHaveBeenCalled();
  });

  it('escalates when the rollback runs but the release never recovers (failed rollback)', async () => {
    writePostRolloutValidationVerdict(dir, verdict({ healthy: false }));
    let clock = 0;
    const rollback = api({
      getDeployment: vi.fn(async (_ns: string, name: string) => rolling(name)),
    });
    const outcome = await executeAutoRollback({
      namespace: NAMESPACE, release: RELEASE, resourcePrefix: RESOURCE_PREFIX,
      systemDataDir: dir, currentRollout: CURRENT, api: rollback, resolveRollbackTarget: target,
      now: () => clock,
      sleep: async () => { clock += 1_000; },
      waitTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });
    expect(outcome.status).toBe('rollback_failed');
    // A failed rollback is still recorded so act-once holds (no infinite retry).
    const history = readKubeRollbackHistory(dir);
    expect(history).toHaveLength(1);
    expect(history[0].outcome).toBe('failed');
    expect(history[0].validationResult).toBe('failed');
  });

  it('propagates an unreadable-cluster probe error (never treats it as recovered)', async () => {
    writePostRolloutValidationVerdict(dir, verdict({ healthy: false }));
    const rollback = api({
      getDeployment: vi.fn(async () => { throw new Error('kube api unreachable'); }),
    });
    await expect(executeAutoRollback({
      namespace: NAMESPACE, release: RELEASE, resourcePrefix: RESOURCE_PREFIX,
      systemDataDir: dir, currentRollout: CURRENT, api: rollback, resolveRollbackTarget: target,
    })).rejects.toThrow(/kube api unreachable/);
  });
});
