import { describe, expect, it, vi } from 'vitest';
import { createKubeDiagnosticsExecutor } from './kube-diagnostics.js';

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
      helmRevision: 7,
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
});
