import { describe, expect, it, vi } from 'vitest';
import type { KubeDeploymentDiagnostic } from './kube-diagnostics.js';
import {
  createKubeRolloutRestartExecutor,
  isDeploymentRolloutComplete,
  type KubeRolloutApiPort,
} from './kube-rollout-restart.js';
import { combineKubeSelfManagementExecutors } from './kube-self-management.js';

function ready(name: string, generation = 2): KubeDeploymentDiagnostic {
  return {
    name,
    generation,
    observedGeneration: generation,
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

const RESTART_REQUEST = {
  action: 'restart' as const,
  namespace: 'psfn',
  release: 'psfn',
  sourceRevision: '0123456789abcdef0123456789abcdef01234567',
  targetImage: 'localhost/psfn-framework:0.1.0-kube-0ecaa08d',
  helmRevision: 8,
  reason: 'apply hotfix',
};

describe('isDeploymentRolloutComplete', () => {
  it('is true only when observed, updated, ready, and available all reach desired', () => {
    expect(isDeploymentRolloutComplete(ready('psfn-agent'))).toBe(true);
    expect(isDeploymentRolloutComplete(rolling('psfn-agent'))).toBe(false);
    expect(isDeploymentRolloutComplete({ ...ready('x'), desiredReplicas: 0 })).toBe(false);
    expect(isDeploymentRolloutComplete({ ...ready('x'), availableReplicas: 0 })).toBe(false);
  });
});

describe('createKubeRolloutRestartExecutor', () => {
  it('supports only the restart action', () => {
    const executor = createKubeRolloutRestartExecutor({
      namespace: 'psfn',
      release: 'psfn',
      resourcePrefix: 'psfn',
      api: { restartDeployment: vi.fn(), getDeployment: vi.fn() },
    });
    expect(executor.supports('restart')).toBe(true);
    expect(executor.supports('diagnose')).toBe(false);
    expect(executor.supports('deploy')).toBe(false);
  });

  it('restarts all three deployments then waits for readiness', async () => {
    const restartDeployment = vi.fn(async () => undefined);
    const getDeployment = vi.fn(async (_ns: string, name: string) => ready(name));
    const api: KubeRolloutApiPort = { restartDeployment, getDeployment };

    const executor = createKubeRolloutRestartExecutor({
      namespace: 'psfn',
      release: 'psfn',
      resourcePrefix: 'psfn',
      api,
    });

    const result = await executor.execute(RESTART_REQUEST);

    expect(restartDeployment.mock.calls.map(call => call[1])).toEqual([
      'psfn-agent', 'psfn-gateway', 'psfn-garden',
    ]);
    expect(result.validationResult).toBe('passed');
    expect(result.rollbackStatus).toBe('not_requested');
    expect(result.details?.restartedDeployments).toEqual([
      'psfn-agent', 'psfn-gateway', 'psfn-garden',
    ]);
  });

  it('polls until deployments become ready', async () => {
    const readiness = new Map<string, number>();
    const getDeployment = vi.fn(async (_ns: string, name: string) => {
      const seen = (readiness.get(name) ?? 0) + 1;
      readiness.set(name, seen);
      return seen >= 2 ? ready(name) : rolling(name);
    });
    const sleep = vi.fn(async () => undefined);

    const executor = createKubeRolloutRestartExecutor({
      namespace: 'psfn',
      release: 'psfn',
      resourcePrefix: 'psfn',
      api: { restartDeployment: vi.fn(async () => undefined), getDeployment },
      sleep,
      pollIntervalMs: 10,
    });

    const result = await executor.execute(RESTART_REQUEST);
    expect(result.validationResult).toBe('passed');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('fails closed with a clear error when readiness never converges', async () => {
    let clock = 0;
    const executor = createKubeRolloutRestartExecutor({
      namespace: 'psfn',
      release: 'psfn',
      resourcePrefix: 'psfn',
      api: {
        restartDeployment: vi.fn(async () => undefined),
        getDeployment: vi.fn(async (_ns: string, name: string) => rolling(name)),
      },
      sleep: vi.fn(async () => { clock += 1_000; }),
      now: () => clock,
      waitTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });

    await expect(executor.execute(RESTART_REQUEST)).rejects.toThrow(/did not become ready within 5000ms/);
  });

  it('rejects a request outside the configured release scope', async () => {
    const executor = createKubeRolloutRestartExecutor({
      namespace: 'psfn',
      release: 'psfn',
      resourcePrefix: 'psfn',
      api: { restartDeployment: vi.fn(), getDeployment: vi.fn() },
    });
    await expect(executor.execute({ ...RESTART_REQUEST, namespace: 'other' }))
      .rejects.toThrow(/outside the configured release scope/);
  });
});

describe('combineKubeSelfManagementExecutors', () => {
  it('delegates each action to its unique supporting executor', async () => {
    const diagnose = {
      supports: (action: string) => action === 'diagnose',
      execute: vi.fn(async () => ({
        validationResult: 'not_run' as const,
        rollbackStatus: 'not_requested' as const,
        details: { via: 'diagnose' },
      })),
    };
    const restart = {
      supports: (action: string) => action === 'restart',
      execute: vi.fn(async () => ({
        validationResult: 'passed' as const,
        rollbackStatus: 'not_requested' as const,
        details: { via: 'restart' },
      })),
    };
    const combined = combineKubeSelfManagementExecutors([diagnose, restart]);

    expect(combined.supports('diagnose')).toBe(true);
    expect(combined.supports('restart')).toBe(true);
    expect(combined.supports('deploy')).toBe(false);

    expect((await combined.execute({ action: 'diagnose', namespace: 'psfn', release: 'psfn' })).details)
      .toEqual({ via: 'diagnose' });
    expect((await combined.execute(RESTART_REQUEST)).details).toEqual({ via: 'restart' });
    expect(diagnose.execute).toHaveBeenCalledTimes(1);
    expect(restart.execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed for an action no executor supports', async () => {
    const combined = combineKubeSelfManagementExecutors([{
      supports: (action: string) => action === 'diagnose',
      execute: vi.fn(),
    }]);
    await expect(combined.execute(RESTART_REQUEST)).rejects.toThrow(/no unique executor/);
  });
});
