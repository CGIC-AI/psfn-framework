import { describe, expect, it, vi } from 'vitest';
import type { KubeDeploymentDiagnostic } from './kube-diagnostics.js';
import {
  createKubeHelmRollbackExecutor,
  managedRollbackDeploymentNames,
  type KubeHelmRollbackApiPort,
} from './kube-helm-rollback.js';
import { combineKubeSelfManagementExecutors } from './kube-self-management.js';
import { hasRolledBackFrom, type KubeRollbackRecord } from './kube-rollback-store.js';

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

const ROLLBACK_REQUEST = {
  action: 'rollback' as const,
  namespace: 'psfn',
  release: 'psfn',
  sourceRevision: 'b'.repeat(40),
  targetImage: 'localhost/psfn-framework:0.1.0-kube-bbbbbbbb',
  helmRevision: 8,
  reason: 'roll back the broken rev-9 update',
};

describe('createKubeHelmRollbackExecutor', () => {
  it('supports only the rollback action', () => {
    const executor = createKubeHelmRollbackExecutor({
      namespace: 'psfn',
      release: 'psfn',
      resourcePrefix: 'psfn',
      api: { rollback: vi.fn(), getDeployment: vi.fn() },
    });
    expect(executor.supports('rollback')).toBe(true);
    expect(executor.supports('restart')).toBe(false);
    expect(executor.supports('deploy')).toBe(false);
    expect(executor.supports('diagnose')).toBe(false);
  });

  it('rolls back to the target revision then waits for the three deployments to recover', async () => {
    const rollback = vi.fn(async () => ({ helmRevision: 10 }));
    const getDeployment = vi.fn(async (_ns: string, name: string) => ready(name));
    const recordRollback = vi.fn();
    const api: KubeHelmRollbackApiPort = { rollback, getDeployment };

    const executor = createKubeHelmRollbackExecutor({
      namespace: 'psfn', release: 'psfn', resourcePrefix: 'psfn-runtime', api, recordRollback,
    });

    const result = await executor.execute(ROLLBACK_REQUEST);

    expect(rollback).toHaveBeenCalledWith('psfn', 'psfn', 8);
    expect(getDeployment.mock.calls.map(call => call[1])).toEqual(
      managedRollbackDeploymentNames('psfn-runtime'),
    );
    expect(result.validationResult).toBe('passed');
    expect(result.rollbackStatus).toBe('succeeded');
    expect(result.details?.targetHelmRevision).toBe(8);
    expect(result.details?.resultingHelmRevision).toBe(10);

    expect(recordRollback).toHaveBeenCalledTimes(1);
    const record = recordRollback.mock.calls[0][0] as KubeRollbackRecord;
    expect(record.trigger).toBe('manual');
    expect(record.targetHelmRevision).toBe(8);
    expect(record.outcome).toBe('succeeded');
    expect(record.reason).toBe('roll back the broken rev-9 update');
  });

  it('records the source revision so a manual rollback keys the act-once ledger', async () => {
    // Helm enacts the rollback as resulting revision 10 (from live revision 9),
    // so the ledger must key on fromHelmRevision=9 — the revision the automatic
    // surface stays pinned to and must not double-fire against.
    const recordRollback = vi.fn();
    const executor = createKubeHelmRollbackExecutor({
      namespace: 'psfn', release: 'psfn', resourcePrefix: 'psfn',
      api: {
        rollback: vi.fn(async () => ({ helmRevision: 10 })),
        getDeployment: vi.fn(async (_ns: string, name: string) => ready(name)),
      },
      recordRollback,
    });

    await executor.execute(ROLLBACK_REQUEST);

    const record = recordRollback.mock.calls[0][0] as KubeRollbackRecord;
    expect(record.fromHelmRevision).toBe(9);
    // The recorded manual rollback now satisfies the auto surface's act-once
    // predicate for the failed revision it moved away from.
    expect(hasRolledBackFrom([record], 'psfn', 9)).toBe(true);
  });

  it('escalates (rollbackStatus failed) when the release never recovers', async () => {
    let clock = 0;
    const recordRollback = vi.fn();
    const executor = createKubeHelmRollbackExecutor({
      namespace: 'psfn', release: 'psfn', resourcePrefix: 'psfn',
      api: {
        rollback: vi.fn(async () => ({ helmRevision: 10 })),
        getDeployment: vi.fn(async (_ns: string, name: string) => rolling(name)),
      },
      recordRollback,
      now: () => clock,
      sleep: vi.fn(async () => { clock += 1_000; }),
      waitTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });

    const result = await executor.execute(ROLLBACK_REQUEST);
    expect(result.validationResult).toBe('failed');
    expect(result.rollbackStatus).toBe('failed');
    expect(String(result.details?.escalation)).toMatch(/did not recover/);
    const record = recordRollback.mock.calls[0][0] as KubeRollbackRecord;
    expect(record.outcome).toBe('failed');
    expect(record.validationResult).toBe('failed');
  });

  it('propagates a failing helm rollback command (audited as an execution failure upstream)', async () => {
    const executor = createKubeHelmRollbackExecutor({
      namespace: 'psfn', release: 'psfn', resourcePrefix: 'psfn',
      api: {
        rollback: vi.fn(async () => { throw new Error('helm rollback failed: release not found'); }),
        getDeployment: vi.fn(),
      },
    });
    await expect(executor.execute(ROLLBACK_REQUEST)).rejects.toThrow(/helm rollback failed/);
  });

  it('rejects an invalid resulting helm revision', async () => {
    const executor = createKubeHelmRollbackExecutor({
      namespace: 'psfn', release: 'psfn', resourcePrefix: 'psfn',
      api: { rollback: vi.fn(async () => ({ helmRevision: 0 })), getDeployment: vi.fn() },
    });
    await expect(executor.execute(ROLLBACK_REQUEST)).rejects.toThrow(/invalid resulting release revision/);
  });

  it('rejects a request outside the configured release scope', async () => {
    const executor = createKubeHelmRollbackExecutor({
      namespace: 'psfn', release: 'psfn', resourcePrefix: 'psfn',
      api: { rollback: vi.fn(), getDeployment: vi.fn() },
    });
    await expect(executor.execute({ ...ROLLBACK_REQUEST, namespace: 'other' }))
      .rejects.toThrow(/outside the configured release scope/);
    await expect(executor.execute({ ...ROLLBACK_REQUEST, release: 'other' }))
      .rejects.toThrow(/outside the configured release scope/);
  });
});

describe('rollback executor composition (fail-closed unique-executor guard stays intact)', () => {
  it('claims the rollback action uniquely alongside restart', async () => {
    const restart = {
      supports: (action: string) => action === 'restart',
      execute: vi.fn(async () => ({
        validationResult: 'passed' as const,
        rollbackStatus: 'not_requested' as const,
      })),
    };
    const rollback = createKubeHelmRollbackExecutor({
      namespace: 'psfn', release: 'psfn', resourcePrefix: 'psfn',
      api: {
        rollback: vi.fn(async () => ({ helmRevision: 10 })),
        getDeployment: vi.fn(async (_ns: string, name: string) => ready(name)),
      },
    });
    const combined = combineKubeSelfManagementExecutors([restart, rollback]);
    expect(combined.supports('rollback')).toBe(true);
    expect(combined.supports('restart')).toBe(true);
    const result = await combined.execute(ROLLBACK_REQUEST);
    expect(result.rollbackStatus).toBe('succeeded');
    expect(restart.execute).not.toHaveBeenCalled();
  });

  it('fails closed when two executors both claim rollback', async () => {
    const rollbackA = createKubeHelmRollbackExecutor({
      namespace: 'psfn', release: 'psfn', resourcePrefix: 'psfn',
      api: { rollback: vi.fn(), getDeployment: vi.fn() },
    });
    const rollbackB = createKubeHelmRollbackExecutor({
      namespace: 'psfn', release: 'psfn', resourcePrefix: 'psfn',
      api: { rollback: vi.fn(), getDeployment: vi.fn() },
    });
    const combined = combineKubeSelfManagementExecutors([rollbackA, rollbackB]);
    expect(combined.supports('rollback')).toBe(false);
    await expect(combined.execute(ROLLBACK_REQUEST)).rejects.toThrow(/no unique executor/);
  });
});
