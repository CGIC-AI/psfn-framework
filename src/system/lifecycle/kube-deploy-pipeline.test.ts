import { describe, expect, it, vi } from 'vitest';
import {
  combineKubeSelfManagementExecutors,
  createKubeDeployPipelineExecutor,
  deriveLocalImportRetag,
  DeployPipelineError,
  redactLiveHelmValues,
  runKubeDeployPipeline,
  summarizeDeployPipelineRecord,
  type DeployPipelinePlan,
  type DeployPipelineRunner,
  type DeployPipelineRunnerContext,
} from './kube-deploy-pipeline.js';
import type {
  KubeSelfManagementExecutor,
  KubeSelfManagementRequest,
} from './kube-self-management.js';
import type {
  PostRolloutValidationRecord,
  PostRolloutValidationRunner,
  RawCheckResult,
} from './kube-post-rollout-validation.js';

const COMMIT = 'a'.repeat(40);
const SECRET_LIVE_VALUES = {
  replicaCount: 1,
  image: { tag: 'old' },
  secrets: { values: { apiKey: 'sk-live-should-never-appear', discordToken: 'tok-secret' } },
  postgres: { auth: { username: 'psfn', password: 'pg-secret-value' } },
};

function basePlan(overrides: Partial<DeployPipelinePlan> = {}): DeployPipelinePlan {
  return {
    action: 'deploy',
    namespace: 'psfn',
    release: 'psfn',
    sourceBranch: 'feat/kube-self-management',
    sourceCommit: COMMIT,
    imageRepository: 'localhost/psfn-framework',
    imageTag: '0.1.0-kube-aaaaaaaa',
    k3dValidation: { mode: 'skip', reason: 'no k3d on this build host' },
    ...overrides,
  };
}

const POST_ROLLOUT_PASS: RawCheckResult = { verdict: 'pass' };

function healthyPostRolloutRunner(
  overrides: Partial<PostRolloutValidationRunner> = {},
): PostRolloutValidationRunner {
  return {
    checkRolloutStatus: async () => POST_ROLLOUT_PASS,
    checkGardenHealth: async () => POST_ROLLOUT_PASS,
    checkModelRoute: async () => POST_ROLLOUT_PASS,
    checkPgVector: async () => POST_ROLLOUT_PASS,
    checkRedis: async () => POST_ROLLOUT_PASS,
    checkAgentReadiness: async () => POST_ROLLOUT_PASS,
    checkChatTurnProbe: async () => POST_ROLLOUT_PASS,
    fetchToolConformance: async () => ({
      schemaVersion: 1,
      ranAt: 1000,
      trigger: 'post_rollout',
      results: [
        { toolName: 'self_status', probeKind: 'read_only', action: 'status', ok: true, durationMs: 2 },
      ],
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

function fakeRunner(overrides: Partial<DeployPipelineRunner> = {}): {
  runner: DeployPipelineRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const runner: DeployPipelineRunner = {
    verifyPreconditions: async () => {
      calls.push('preconditions');
      return { workingTreeClean: true, backupVerified: true };
    },
    archiveSource: async () => {
      calls.push('archive');
      return { sha256: 'b'.repeat(64) };
    },
    runGate: async gate => {
      calls.push(`gate:${gate.id}`);
      return { passed: true };
    },
    buildImage: async () => {
      calls.push('build');
      return { contractHash: 'c'.repeat(16) };
    },
    importImage: async () => {
      calls.push('import');
    },
    validateOnK3d: async () => {
      calls.push('k3d');
      return { passed: true };
    },
    captureLiveValues: async () => {
      calls.push('capture');
      return { ...SECRET_LIVE_VALUES };
    },
    helmUpgrade: async () => {
      calls.push('upgrade');
      return { helmRevision: 9 };
    },
    ...overrides,
  };
  return { runner, calls };
}

describe('runKubeDeployPipeline', () => {
  it('runs the full deploy pipeline and records provenance without leaking secrets', async () => {
    const { runner, calls } = fakeRunner();
    const record = await runKubeDeployPipeline(basePlan(), { runner });

    expect(calls).toEqual([
      'preconditions',
      'archive',
      'gate:lint',
      'gate:build',
      'gate:verify-helm-chart',
      'gate:targeted-tests',
      'build',
      'import',
      'capture',
      'upgrade',
    ]);
    expect(record.outcome).toBe('succeeded');
    expect(record.errorCode).toBeUndefined();
    expect(record.sourceBranch).toBe('feat/kube-self-management');
    expect(record.sourceCommit).toBe(COMMIT);
    expect(record.archiveSha256).toBe('b'.repeat(64));
    expect(record.imageReference).toBe('localhost/psfn-framework:0.1.0-kube-aaaaaaaa');
    expect(record.imageRevisionLabel).toBe(COMMIT);
    expect(record.contractHash).toBe('c'.repeat(16));
    expect(record.helmRevision).toBe(9);
    expect(record.liveUntouched).toBe(false);
    expect(record.gate.overall).toBe('passed');
    expect(record.k3dValidation).toEqual({ status: 'skipped', skipReason: 'no k3d on this build host' });
    expect(record.liveValues.captured).toBe(true);
    expect(record.liveValues.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.liveValues.redactedKeys).toEqual([
      'postgres.auth.password',
      'secrets.values.apiKey',
      'secrets.values.discordToken',
    ]);
    // The record must never carry raw secret material.
    expect(JSON.stringify(record)).not.toContain('sk-live');
    expect(JSON.stringify(record)).not.toContain('pg-secret-value');
    expect(JSON.stringify(summarizeDeployPipelineRecord(record))).not.toContain('sk-live');
  });

  it('rebuild produces a validated imported artifact and stops before the Helm upgrade', async () => {
    const { runner, calls } = fakeRunner();
    const record = await runKubeDeployPipeline(basePlan({ action: 'rebuild' }), { runner });

    expect(calls).not.toContain('capture');
    expect(calls).not.toContain('upgrade');
    expect(calls[calls.length - 1]).toBe('import');
    expect(record.outcome).toBe('succeeded');
    expect(record.liveUntouched).toBe(true);
    expect(record.helmRevision).toBeNull();
    expect(record.stages.find(stage => stage.id === 'helm_upgrade')?.status).toBe('not_run');
    expect(record.liveValues.captured).toBe(false);
  });

  it('fails closed on a failing gate and leaves live untouched', async () => {
    const { runner, calls } = fakeRunner({
      runGate: async gate => ({ passed: gate.id !== 'verify-helm-chart', detail: 'chart drift' }),
    });
    const error = await runKubeDeployPipeline(basePlan(), { runner }).catch(caught => caught);

    expect(error).toBeInstanceOf(DeployPipelineError);
    const record = (error as DeployPipelineError).record;
    expect(record.outcome).toBe('failed');
    expect(record.failedStage).toBe('gate');
    expect(record.errorCode).toBe('gate_failed');
    expect(record.gate.overall).toBe('failed');
    expect(record.liveUntouched).toBe(true);
    expect(calls).not.toContain('build');
    expect(calls).not.toContain('capture');
    const gateResult = record.gate.results.find(result => result.id === 'verify-helm-chart');
    expect(gateResult?.status).toBe('failed');
    expect(gateResult?.detail).toBe('chart drift');
  });

  it('skips the gate only under documented emergency recovery and records the justification', async () => {
    const { runner, calls } = fakeRunner();
    const record = await runKubeDeployPipeline(
      basePlan({ emergencyRecovery: { justification: 'live outage; validated manually' } }),
      { runner },
    );

    expect(calls.filter(call => call.startsWith('gate:'))).toEqual([]);
    expect(record.gate.overall).toBe('skipped');
    expect(record.gate.emergencyRecovery).toBe(true);
    expect(record.gate.emergencyJustification).toBe('live outage; validated manually');
    expect(record.gate.results.every(result => result.status === 'skipped')).toBe(true);
    expect(record.outcome).toBe('succeeded');
  });

  it('rejects an emergency recovery run without a justification', async () => {
    const { runner } = fakeRunner();
    await expect(runKubeDeployPipeline(
      basePlan({ emergencyRecovery: { justification: '   ' } }),
      { runner },
    )).rejects.toThrow('non-empty justification');
  });

  it('requires a recorded reason when k3d validation is skipped', async () => {
    const { runner } = fakeRunner();
    await expect(runKubeDeployPipeline(
      basePlan({ k3dValidation: { mode: 'skip', reason: '' } }),
      { runner },
    )).rejects.toThrow('k3d validation skip requires a recorded reason');
  });

  it('runs k3d validation and fails closed before rollout when it fails', async () => {
    const { runner, calls } = fakeRunner({
      validateOnK3d: async () => ({ passed: false, detail: 'pod crashloop' }),
    });
    const error = await runKubeDeployPipeline(
      basePlan({ k3dValidation: { mode: 'run' } }),
      { runner },
    ).catch(caught => caught);

    const record = (error as DeployPipelineError).record;
    expect(record.failedStage).toBe('k3d_validation');
    expect(record.k3dValidation).toEqual({ status: 'failed', detail: 'pod crashloop' });
    expect(record.liveUntouched).toBe(true);
    expect(calls).not.toContain('upgrade');
  });

  it('fails closed on a dirty working tree and an unverified backup', async () => {
    const dirty = fakeRunner({
      verifyPreconditions: async () => ({ workingTreeClean: false, backupVerified: true }),
    });
    const dirtyError = await runKubeDeployPipeline(basePlan(), dirty).catch(caught => caught);
    expect((dirtyError as DeployPipelineError).record.errorCode).toBe('working_tree_dirty');

    const unbacked = fakeRunner({
      verifyPreconditions: async () => ({ workingTreeClean: true, backupVerified: false }),
    });
    const unbackedError = await runKubeDeployPipeline(basePlan(), unbacked).catch(caught => caught);
    expect((unbackedError as DeployPipelineError).record.errorCode).toBe('backup_unverified');
  });

  it('marks live as touched when the Helm upgrade itself fails', async () => {
    const { runner } = fakeRunner({
      helmUpgrade: async () => {
        throw new Error('helm timed out');
      },
    });
    const error = await runKubeDeployPipeline(basePlan(), { runner }).catch(caught => caught);
    const record = (error as DeployPipelineError).record;
    expect(record.failedStage).toBe('helm_upgrade');
    expect(record.errorCode).toBe('helm_upgrade_failed');
    expect(record.liveUntouched).toBe(false);
    expect(record.liveValues.captured).toBe(true);
  });

  it('rejects a floating tag, a short commit, and a non-DNS namespace', async () => {
    const { runner } = fakeRunner();
    await expect(runKubeDeployPipeline(
      basePlan({ imageTag: 'latest' }), { runner },
    )).rejects.toThrow('non-floating pinned tag');
    await expect(runKubeDeployPipeline(
      basePlan({ sourceCommit: 'abc' }), { runner },
    )).rejects.toThrow('40-character Git revision');
    await expect(runKubeDeployPipeline(
      basePlan({ namespace: 'Not_A_Label' }), { runner },
    )).rejects.toThrow('must be DNS labels');
  });

  it('rejects an invalid archive checksum from the runner', async () => {
    const { runner } = fakeRunner({ archiveSource: async () => ({ sha256: 'nope' }) });
    const error = await runKubeDeployPipeline(basePlan(), { runner }).catch(caught => caught);
    expect((error as DeployPipelineError).record.errorCode).toBe('archive_checksum_invalid');
  });

  it('leaves the post-rollout stage not_run when no validator is supplied', async () => {
    const { runner } = fakeRunner();
    const record = await runKubeDeployPipeline(basePlan(), { runner });
    expect(record.postRolloutValidation).toBeNull();
    expect(record.stages.find(stage => stage.id === 'post_rollout_validation')?.status).toBe('not_run');
    expect(record.outcome).toBe('succeeded');
  });

  it('runs the post-rollout gate after helm_upgrade and passes on a healthy verdict', async () => {
    const { runner } = fakeRunner();
    const persisted: PostRolloutValidationRecord[] = [];
    const record = await runKubeDeployPipeline(basePlan(), {
      runner,
      postRolloutValidation: {
        runner: healthyPostRolloutRunner(),
        persist: verdict => persisted.push(verdict),
      },
    });
    expect(record.stages.find(stage => stage.id === 'post_rollout_validation')?.status).toBe('passed');
    expect(record.postRolloutValidation?.healthy).toBe(true);
    expect(record.postRolloutValidation?.trigger).toBe('deploy_pipeline');
    expect(record.postRolloutValidation?.helmRevision).toBe(9);
    expect(record.outcome).toBe('succeeded');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.healthy).toBe(true);
  });

  it('fails closed after rollout when the post-rollout gate reports unhealthy, attaching the verdict', async () => {
    const { runner, calls } = fakeRunner();
    const persisted: PostRolloutValidationRecord[] = [];
    const error = await runKubeDeployPipeline(basePlan(), {
      runner,
      postRolloutValidation: {
        runner: healthyPostRolloutRunner({
          checkModelRoute: async () => ({ verdict: 'fail', detail: 'model route missing' }),
        }),
        persist: verdict => persisted.push(verdict),
      },
    }).catch(caught => caught);

    expect(error).toBeInstanceOf(DeployPipelineError);
    const record = (error as DeployPipelineError).record;
    expect(record.failedStage).toBe('post_rollout_validation');
    expect(record.errorCode).toBe('post_rollout_validation_failed');
    // Live was already touched by the upgrade — the verdict is the rollback signal.
    expect(record.liveUntouched).toBe(false);
    expect(calls).toContain('upgrade');
    expect(record.postRolloutValidation?.healthy).toBe(false);
    expect(record.postRolloutValidation?.recommendedAction).toBe('rollback');
    // Persisted on the unhealthy path too, so x5rt.8 always has a verdict.
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.healthy).toBe(false);
  });

  it('rebuild never reaches the post-rollout stage even with a validator supplied', async () => {
    const { runner } = fakeRunner();
    let gateRan = false;
    const record = await runKubeDeployPipeline(basePlan({ action: 'rebuild' }), {
      runner,
      postRolloutValidation: {
        runner: healthyPostRolloutRunner({
          checkRolloutStatus: async () => {
            gateRan = true;
            return { verdict: 'pass' };
          },
        }),
      },
    });
    expect(gateRan).toBe(false);
    expect(record.postRolloutValidation).toBeNull();
    expect(record.stages.find(stage => stage.id === 'post_rollout_validation')?.status).toBe('not_run');
  });
});

describe('redactLiveHelmValues', () => {
  it('redacts secret-bearing keys recursively and reports their paths', () => {
    const { redacted, redactedKeys } = redactLiveHelmValues(SECRET_LIVE_VALUES);
    expect(JSON.stringify(redacted)).not.toContain('sk-live');
    expect(JSON.stringify(redacted)).not.toContain('pg-secret-value');
    expect(redactedKeys).toEqual([
      'postgres.auth.password',
      'secrets.values.apiKey',
      'secrets.values.discordToken',
    ]);
    // Non-secret values are preserved.
    expect((redacted as { postgres: { auth: { username: string } } }).postgres.auth.username)
      .toBe('psfn');
  });
});

describe('deriveLocalImportRetag', () => {
  it('maps the containerd import name to the localhost runtime tag', () => {
    expect(deriveLocalImportRetag('localhost/psfn-framework:0.1.0-kube-aaaaaaaa')).toEqual({
      from: 'docker.io/library/psfn-framework:0.1.0-kube-aaaaaaaa',
      to: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaa',
    });
  });

  it('rejects floating tags and non-localhost references', () => {
    expect(() => deriveLocalImportRetag('localhost/psfn-framework:latest')).toThrow('pinned');
    expect(() => deriveLocalImportRetag('docker.io/library/psfn-framework:1.0'))
      .toThrow('localhost/-scoped');
  });
});

describe('combineKubeSelfManagementExecutors', () => {
  const stub = (
    supported: string[],
    label: string,
  ): KubeSelfManagementExecutor => ({
    supports: action => supported.includes(action),
    execute: async () => ({
      validationResult: 'not_run',
      rollbackStatus: 'not_requested',
      details: { via: label },
    }),
  });

  it('routes each action to its unique supporting executor', async () => {
    const combined = combineKubeSelfManagementExecutors([
      stub(['diagnose'], 'diagnostics'),
      stub(['rebuild', 'deploy'], 'pipeline'),
    ]);
    expect(combined.supports('deploy')).toBe(true);
    expect(combined.supports('restart')).toBe(false);
    const result = await combined.execute({
      action: 'deploy', namespace: 'psfn', release: 'psfn',
      sourceRevision: COMMIT, targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaa',
      helmRevision: 8, reason: 'ship',
    });
    expect(result.details).toEqual({ via: 'pipeline' });
  });

  it('fails closed when two executors both claim an action', async () => {
    const combined = combineKubeSelfManagementExecutors([
      stub(['deploy'], 'a'),
      stub(['deploy'], 'b'),
    ]);
    expect(combined.supports('deploy')).toBe(false);
    await expect(combined.execute({
      action: 'deploy', namespace: 'psfn', release: 'psfn',
      sourceRevision: COMMIT, targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaa',
      helmRevision: 8, reason: 'ship',
    })).rejects.toThrow('no unique executor');
  });

  it('requires at least one executor', () => {
    expect(() => combineKubeSelfManagementExecutors([])).toThrow('At least one');
  });
});

describe('createKubeDeployPipelineExecutor', () => {
  const request = (action: 'rebuild' | 'deploy'): KubeSelfManagementRequest => ({
    action,
    namespace: 'psfn',
    release: 'psfn',
    sourceRevision: COMMIT,
    targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaa',
    helmRevision: 8,
    reason: 'ship the fix',
  });

  function executorWithFake(context: DeployPipelineRunnerContext | undefined = undefined): {
    executor: KubeSelfManagementExecutor;
    resolvePlan: ReturnType<typeof vi.fn>;
  } {
    void context;
    const { runner } = fakeRunner();
    const resolvePlan = vi.fn(() => ({
      sourceBranch: 'feat/kube-self-management',
      sourceCommit: COMMIT,
      imageRepository: 'localhost/psfn-framework',
      imageTag: '0.1.0-kube-aaaaaaaa',
      k3dValidation: { mode: 'skip' as const, reason: 'no k3d' },
    }));
    const executor = createKubeDeployPipelineExecutor({ runner, resolvePlan });
    return { executor, resolvePlan };
  }

  it('supports only the build/deploy actions', () => {
    const { executor } = executorWithFake();
    expect(executor.supports('deploy')).toBe(true);
    expect(executor.supports('rebuild')).toBe(true);
    expect(executor.supports('diagnose')).toBe(false);
    expect(executor.supports('rollback')).toBe(false);
  });

  it('maps the pipeline outcome to a validation result and a sanitized detail summary', async () => {
    const { executor, resolvePlan } = executorWithFake();
    const result = await executor.execute(request('deploy'));
    expect(resolvePlan).toHaveBeenCalledOnce();
    expect(result.validationResult).toBe('passed');
    expect(result.rollbackStatus).toBe('not_requested');
    expect(result.details).toMatchObject({
      action: 'deploy',
      outcome: 'succeeded',
      helmRevision: 9,
      liveUntouched: false,
    });
    expect(JSON.stringify(result.details)).not.toContain('sk-live');
  });

  it('propagates a fail-closed gate failure as a throw', async () => {
    const { runner } = fakeRunner({ runGate: async () => ({ passed: false }) });
    const executor = createKubeDeployPipelineExecutor({
      runner,
      resolvePlan: () => ({
        sourceBranch: 'feat/kube-self-management',
        sourceCommit: COMMIT,
        imageRepository: 'localhost/psfn-framework',
        imageTag: '0.1.0-kube-aaaaaaaa',
        k3dValidation: { mode: 'skip', reason: 'no k3d' },
      }),
    });
    await expect(executor.execute(request('deploy'))).rejects.toBeInstanceOf(DeployPipelineError);
  });
});
