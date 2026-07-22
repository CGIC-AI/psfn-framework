import { describe, expect, it, vi } from 'vitest';
import {
  HELM_REVISION_UNAVAILABLE_NO_RESOLVER,
  createKubeDiagnosticsExecutor,
} from './kube-diagnostics.js';

function deploymentReader() {
  return async (_namespace: string, name: string) => ({
    name,
    generation: 4,
    observedGeneration: 4,
    desiredReplicas: 1,
    readyReplicas: 1,
    updatedReplicas: 1,
    availableReplicas: 1,
  });
}

describe('createKubeDiagnosticsExecutor', () => {
  it('reads only the configured release deployments and release-labelled pods', async () => {
    const getDeployment = vi.fn(async (_namespace: string, name: string) => ({
      name,
      generation: 4,
      observedGeneration: 4,
      desiredReplicas: 1,
      readyReplicas: 1,
      updatedReplicas: 1,
      availableReplicas: 1,
    }));
    const listPods = vi.fn(async () => [{
      name: 'psfn-agent-abc',
      phase: 'Running',
      ready: true,
      restartCount: 0,
      images: ['localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa'],
    }]);
    const executor = createKubeDiagnosticsExecutor({
      namespace: 'psfn-test',
      release: 'psfn',
      resourcePrefix: 'psfn-runtime',
      resolveHelmRevision: async () => 7,
      sourceRevision: 'a'.repeat(40),
      targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
      api: { getDeployment, listPods },
    });

    const result = await executor.execute({
      action: 'diagnose',
      namespace: 'psfn-test',
      release: 'psfn',
    });

    expect(getDeployment.mock.calls).toEqual([
      ['psfn-test', 'psfn-runtime-agent'],
      ['psfn-test', 'psfn-runtime-gateway'],
      ['psfn-test', 'psfn-runtime-garden'],
    ]);
    expect(listPods).toHaveBeenCalledWith(
      'psfn-test',
      'app.kubernetes.io/instance=psfn',
    );
    expect(result).toEqual({
      validationResult: 'not_run',
      rollbackStatus: 'not_requested',
      details: {
        namespace: 'psfn-test',
        release: 'psfn',
        helmRevision: 7,
        sourceRevision: 'a'.repeat(40),
        targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
        deployments: [
          expect.objectContaining({ name: 'psfn-runtime-agent', readyReplicas: 1 }),
          expect.objectContaining({ name: 'psfn-runtime-gateway', readyReplicas: 1 }),
          expect.objectContaining({ name: 'psfn-runtime-garden', readyReplicas: 1 }),
        ],
        pods: [expect.objectContaining({ name: 'psfn-agent-abc', ready: true })],
      },
    });
    expect(executor.supports('diagnose')).toBe(true);
    expect(executor.supports('restart')).toBe(false);
  });

  // psfn-framework-6187t regression: the revision used to be captured once at
  // process construction, so a pod that survived later upgrades kept reporting
  // the revision it was born at. Diagnose must ask the live release every time.
  it('reports the CURRENT revision on each diagnose, not the one at construction', async () => {
    const revisions = [12, 13, 14];
    const resolveHelmRevision = vi.fn(async () => revisions.shift() as number);
    const executor = createKubeDiagnosticsExecutor({
      namespace: 'psfn-test',
      release: 'psfn',
      resourcePrefix: 'psfn-runtime',
      resolveHelmRevision,
      sourceRevision: 'a'.repeat(40),
      targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
      api: { getDeployment: deploymentReader(), listPods: async () => [] },
    });

    const request = { action: 'diagnose', namespace: 'psfn-test', release: 'psfn' } as const;
    const first = await executor.execute(request);
    const second = await executor.execute(request);
    const third = await executor.execute(request);

    expect(first.details?.helmRevision).toBe(12);
    expect(second.details?.helmRevision).toBe(13);
    expect(third.details?.helmRevision).toBe(14);
    expect(resolveHelmRevision).toHaveBeenCalledTimes(3);
    expect(resolveHelmRevision).toHaveBeenCalledWith('psfn-test', 'psfn');
  });

  it('reports the revision as explicitly unavailable when no resolver is wired', async () => {
    const executor = createKubeDiagnosticsExecutor({
      namespace: 'psfn-test',
      release: 'psfn',
      resourcePrefix: 'psfn-runtime',
      sourceRevision: 'a'.repeat(40),
      targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
      api: { getDeployment: deploymentReader(), listPods: async () => [] },
    });

    const result = await executor.execute({
      action: 'diagnose',
      namespace: 'psfn-test',
      release: 'psfn',
    });

    expect(result.details?.helmRevision).toBeNull();
    expect(result.details?.helmRevisionUnavailable).toBe(HELM_REVISION_UNAVAILABLE_NO_RESOLVER);
  });

  it('propagates a failing revision resolver instead of reporting a fabricated revision', async () => {
    const executor = createKubeDiagnosticsExecutor({
      namespace: 'psfn-test',
      release: 'psfn',
      resourcePrefix: 'psfn-runtime',
      resolveHelmRevision: async () => { throw new Error('helm history unreachable'); },
      sourceRevision: 'a'.repeat(40),
      targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
      api: { getDeployment: deploymentReader(), listPods: async () => [] },
    });

    await expect(executor.execute({
      action: 'diagnose',
      namespace: 'psfn-test',
      release: 'psfn',
    })).rejects.toThrow(/helm history unreachable/);
  });
});
