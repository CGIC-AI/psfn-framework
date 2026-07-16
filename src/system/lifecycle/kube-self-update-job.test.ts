import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKubeSelfUpdateJob, type KubeSelfUpdateJobOptions } from './kube-self-update-job.js';
import type { DeployPipelinePlan, DeployPipelineRunner } from './kube-deploy-pipeline.js';
import type { PostRolloutValidationRunner, RawCheckResult } from './kube-post-rollout-validation.js';
import type { KubeHelmRollbackApiPort } from './kube-helm-rollback.js';
import type { KubeDeploymentDiagnostic } from './kube-diagnostics.js';
import { readKubeRollbackHistory } from './kube-rollback-store.js';
import { readPostRolloutValidationLatest } from './kube-post-rollout-validation-store.js';
import type { KubeRollbackTargetResolution } from './kube-auto-rollback.js';
import { lifecycleKubernetesSettingsFixture } from '../../test-support/lifecycle-kubernetes-settings.js';

const COMMIT = 'a'.repeat(40);
const PASS: RawCheckResult = { verdict: 'pass' };
const lifecycleKubernetes = lifecycleKubernetesSettingsFixture({
  rollbackWaitTimeoutMs: 1_000,
  rollbackPollIntervalMs: 1,
});

function basePlan(overrides: Partial<DeployPipelinePlan> = {}): DeployPipelinePlan {
  return {
    action: 'deploy',
    namespace: 'psfn',
    release: 'psfn',
    sourceBranch: 'feat/x5rt-kube-self-management',
    sourceCommit: COMMIT,
    imageRepository: 'localhost/psfn-framework',
    imageTag: '0.1.0-kube-aaaaaaaa',
    k3dValidation: { mode: 'skip', reason: 'unit test' },
    ...overrides,
  };
}

function fakeDeployRunner(overrides: Partial<DeployPipelineRunner> = {}): DeployPipelineRunner {
  return {
    verifyPreconditions: async () => ({ workingTreeClean: true, backupVerified: true }),
    archiveSource: async () => ({ sha256: 'a'.repeat(64) }),
    runGate: async () => ({ passed: true }),
    buildImage: async () => ({}),
    importImage: async () => undefined,
    validateOnK3d: async () => ({ passed: true }),
    captureLiveValues: async () => ({ replicaCount: 1 }),
    helmUpgrade: async () => ({ helmRevision: 9 }),
    ...overrides,
  };
}

function validationRunner(
  overrides: Partial<PostRolloutValidationRunner> = {},
): PostRolloutValidationRunner {
  return {
    checkRolloutStatus: async () => PASS,
    checkGardenHealth: async () => PASS,
    checkModelRoute: async () => PASS,
    checkPgVector: async () => PASS,
    checkRedis: async () => PASS,
    checkAgentReadiness: async () => PASS,
    checkChatTurnProbe: async () => PASS,
    fetchToolConformance: async () => ({
      schemaVersion: 1,
      ranAt: 1000,
      trigger: 'post_rollout',
      results: [{ toolName: 'self_status', probeKind: 'read_only', action: 'status', ok: true, durationMs: 1 }],
    }),
    fetchDiagnostics: async () => ({
      schemaVersion: 1,
      generatedAt: 2000,
      window: { sinceMs: 0, untilMs: 2000, windowMs: 2000, limit: 20, includeFileLogs: false, logsDir: '/app/logs' },
      sources: [],
      agentLog: { status: 'available', counts: { warn: 0, error: 0, total: 0 }, records: [] },
      fileLogs: { status: 'unavailable', reason: 'requires kube surface' },
      toolValidationFailures: { status: 'available', total: 0, byTool: [] },
      lifecycle: { status: 'available', events: [] },
      rollout: { status: 'unavailable', reason: 'requires kube surface' },
      pods: { status: 'unavailable', reason: 'requires kube surface' },
      backup: { status: 'available', counts: { success: 0, failure: 0, total: 0 }, lastSuccess: null, lastFailure: null, recent: [] },
    }),
    ...overrides,
  };
}

function readyDeployment(name: string): KubeDeploymentDiagnostic {
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

function helmRollbackApi(
  rollback: KubeHelmRollbackApiPort['rollback'],
): KubeHelmRollbackApiPort {
  return {
    rollback,
    getDeployment: async (_ns, name) => readyDeployment(name),
  };
}

const strictlyEarlierTarget = async (failed: number): Promise<KubeRollbackTargetResolution> => ({
  kind: 'target',
  targetRevision: failed - 1,
});

describe('runKubeSelfUpdateJob (operator-job composition wiring)', () => {
  let systemDataDir: string;

  beforeEach(() => {
    systemDataDir = mkdtempSync(join(tmpdir(), 'psfn-selfupdate-'));
  });
  afterEach(() => {
    rmSync(systemDataDir, { recursive: true, force: true });
  });

  it('refuses to enable auto-rollback without a post-rollout validation runner (persist-required contract)', async () => {
    await expect(runKubeSelfUpdateJob({
      plan: basePlan(),
      systemDataDir,
      resourcePrefix: 'psfn',
      lifecycleKubernetes,
      deployRunner: fakeDeployRunner(),
      autoRollback: {
        api: helmRollbackApi(async () => ({ helmRevision: 10 })),
        resolveRollbackTarget: strictlyEarlierTarget,
      },
    })).rejects.toThrow(/requires a post-rollout validation runner/);
  });

  it('drives executeAutoRollback with the bound live rollout and persists the verdict', async () => {
    const persistVerdict = vi.fn();
    const executeAutoRollbackFn = vi.fn(async () => ({
      status: 'healthy' as const,
      verdict: {} as never,
    }));

    const result = await runKubeSelfUpdateJob({
      plan: basePlan(),
      systemDataDir,
      resourcePrefix: 'psfn-runtime',
      lifecycleKubernetes,
      deployRunner: fakeDeployRunner(),
      postRolloutValidationRunner: validationRunner(),
      autoRollback: {
        api: helmRollbackApi(async () => ({ helmRevision: 10 })),
        resolveRollbackTarget: strictlyEarlierTarget,
      },
      persistVerdict,
      executeAutoRollbackFn,
    });

    // The verdict was persisted (the pipeline invoked our persist callback).
    expect(persistVerdict).toHaveBeenCalledTimes(1);
    const [, persistedVerdict] = persistVerdict.mock.calls[0]!;
    expect(persistedVerdict).toMatchObject({ healthy: true, helmRevision: 9, sourceCommit: COMMIT });

    // Auto-rollback was driven with the rollout the pipeline actually rolled out.
    expect(executeAutoRollbackFn).toHaveBeenCalledTimes(1);
    const [autoOpts] = executeAutoRollbackFn.mock.calls[0]!;
    expect(autoOpts).toMatchObject({
      namespace: 'psfn',
      release: 'psfn',
      resourcePrefix: 'psfn-runtime',
      systemDataDir,
      currentRollout: { release: 'psfn', helmRevision: 9, sourceCommit: COMMIT },
    });
    expect(result.autoRollback.status).toBe('healthy');
    expect(result.pipeline.outcome).toBe('succeeded');
  });

  it('a healthy rollout is left running: verdict persisted, no rollback fired', async () => {
    const rollback = vi.fn(async () => ({ helmRevision: 10 }));
    const result = await runKubeSelfUpdateJob({
      plan: basePlan(),
      systemDataDir,
      resourcePrefix: 'psfn-runtime',
      lifecycleKubernetes,
      deployRunner: fakeDeployRunner(),
      postRolloutValidationRunner: validationRunner(),
      autoRollback: {
        api: helmRollbackApi(rollback),
        resolveRollbackTarget: strictlyEarlierTarget,
      },
    });

    expect(result.autoRollback.status).toBe('healthy');
    expect(rollback).not.toHaveBeenCalled();
    const verdict = readPostRolloutValidationLatest(systemDataDir);
    expect(verdict).toMatchObject({ healthy: true, helmRevision: 9 });
    expect(readKubeRollbackHistory(systemDataDir)).toEqual([]);
  });

  it('a broken rollout fails validation, fires exactly one rollback, and a second evaluation is already_acted', async () => {
    const rollback = vi.fn(async () => ({ helmRevision: 10 }));
    const audit = vi.fn(async () => undefined);
    const jobOptions: KubeSelfUpdateJobOptions = {
      plan: basePlan(),
      systemDataDir,
      resourcePrefix: 'psfn-runtime',
      lifecycleKubernetes,
      deployRunner: fakeDeployRunner(),
      // Deliberately-broken rollout: the rollout-status probe fails.
      postRolloutValidationRunner: validationRunner({
        checkRolloutStatus: async () => ({ verdict: 'fail', detail: 'agent CrashLoopBackOff' }),
      }),
      autoRollback: {
        api: helmRollbackApi(rollback),
        resolveRollbackTarget: strictlyEarlierTarget,
      },
      audit,
    };

    const first = await runKubeSelfUpdateJob(jobOptions);

    // Pipeline failed at the post-rollout gate but still recorded the live revision.
    expect(first.pipeline.outcome).toBe('failed');
    expect(first.pipeline.failedStage).toBe('post_rollout_validation');
    expect(first.pipeline.helmRevision).toBe(9);

    // The unhealthy verdict was persisted and bound; exactly one rollback fired.
    const verdict = readPostRolloutValidationLatest(systemDataDir);
    expect(verdict).toMatchObject({ healthy: false, helmRevision: 9, recommendedAction: 'rollback' });
    expect(first.autoRollback.status).toBe('rolled_back');
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledWith('psfn', 'psfn', 8);

    // The act-once ledger recorded the rollback away from revision 9.
    const ledger = readKubeRollbackHistory(systemDataDir);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ trigger: 'automatic', fromHelmRevision: 9, targetHelmRevision: 8, outcome: 'succeeded' });

    // A second job over the same failed rollout must NOT roll back again (no loop).
    const second = await runKubeSelfUpdateJob(jobOptions);
    expect(second.autoRollback.status).toBe('surfaced');
    expect(second.autoRollback).toMatchObject({ reasonCode: 'already_acted' });
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(readKubeRollbackHistory(systemDataDir)).toHaveLength(1);
  });

  it('serializes overlapping auto-rollback evaluations through the default single-flight guard', async () => {
    let active = 0;
    let maxConcurrent = 0;
    const executeAutoRollbackFn = vi.fn(async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { status: 'healthy' as const, verdict: {} as never };
    });

    const mk = (): KubeSelfUpdateJobOptions => ({
      plan: basePlan(),
      systemDataDir,
      resourcePrefix: 'psfn-runtime',
      lifecycleKubernetes,
      deployRunner: fakeDeployRunner(),
      postRolloutValidationRunner: validationRunner(),
      autoRollback: {
        api: helmRollbackApi(async () => ({ helmRevision: 10 })),
        resolveRollbackTarget: strictlyEarlierTarget,
      },
      executeAutoRollbackFn,
      // No runExclusive override: exercise the module-level default serializer.
    });

    await Promise.all([runKubeSelfUpdateJob(mk()), runKubeSelfUpdateJob(mk()), runKubeSelfUpdateJob(mk())]);
    expect(executeAutoRollbackFn).toHaveBeenCalledTimes(3);
    expect(maxConcurrent).toBe(1);
  });

  it('skips auto-rollback when the deploy fails before the live Helm upgrade (live untouched)', async () => {
    const rollback = vi.fn(async () => ({ helmRevision: 10 }));
    const executeAutoRollbackFn = vi.fn(async () => ({ status: 'healthy' as const, verdict: {} as never }));
    const result = await runKubeSelfUpdateJob({
      plan: basePlan(),
      systemDataDir,
      resourcePrefix: 'psfn-runtime',
      lifecycleKubernetes,
      deployRunner: fakeDeployRunner({ runGate: async () => ({ passed: false, detail: 'lint failed' }) }),
      postRolloutValidationRunner: validationRunner(),
      autoRollback: {
        api: helmRollbackApi(rollback),
        resolveRollbackTarget: strictlyEarlierTarget,
      },
      executeAutoRollbackFn,
    });

    expect(result.pipeline.outcome).toBe('failed');
    expect(result.pipeline.liveUntouched).toBe(true);
    expect(result.autoRollback.status).toBe('skipped');
    expect(executeAutoRollbackFn).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('runs a deploy-only job with the safety net disabled', async () => {
    const result = await runKubeSelfUpdateJob({
      plan: basePlan(),
      systemDataDir,
      resourcePrefix: 'psfn-runtime',
      lifecycleKubernetes,
      deployRunner: fakeDeployRunner(),
      postRolloutValidationRunner: validationRunner(),
      autoRollback: {
        enabled: false,
        api: helmRollbackApi(async () => ({ helmRevision: 10 })),
        resolveRollbackTarget: strictlyEarlierTarget,
      },
    });
    expect(result.pipeline.outcome).toBe('succeeded');
    expect(result.autoRollback.status).toBe('skipped');
  });

  it('fails closed when the rollback target is not strictly earlier than the failed revision', async () => {
    const rollback = vi.fn(async () => ({ helmRevision: 10 }));
    await expect(runKubeSelfUpdateJob({
      plan: basePlan(),
      systemDataDir,
      resourcePrefix: 'psfn-runtime',
      lifecycleKubernetes,
      deployRunner: fakeDeployRunner(),
      postRolloutValidationRunner: validationRunner({
        checkRolloutStatus: async () => ({ verdict: 'fail' }),
      }),
      autoRollback: {
        api: helmRollbackApi(rollback),
        // Unsafe: rolls FORWARD to a later revision.
        resolveRollbackTarget: async (failed) => ({ kind: 'target', targetRevision: failed + 1 }),
      },
    })).rejects.toThrow(/unsafe target revision/);
    expect(rollback).not.toHaveBeenCalled();
  });
});
