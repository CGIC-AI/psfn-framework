import { describe, expect, it, vi } from 'vitest';
import type { KubeDeploymentDiagnostic } from './kube-diagnostics.js';
import {
  isDeploymentRolloutComplete,
  waitForDeploymentsReady,
} from './kube-readiness-wait.js';

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

describe('isDeploymentRolloutComplete', () => {
  it('requires observed, updated, ready, and available replicas to reach desired', () => {
    expect(isDeploymentRolloutComplete(ready('psfn-agent'))).toBe(true);
    expect(isDeploymentRolloutComplete({ ...ready('psfn-agent'), observedGeneration: 1 })).toBe(false);
    expect(isDeploymentRolloutComplete({ ...ready('psfn-agent'), updatedReplicas: 0 })).toBe(false);
    expect(isDeploymentRolloutComplete({ ...ready('psfn-agent'), readyReplicas: 0 })).toBe(false);
    expect(isDeploymentRolloutComplete({ ...ready('psfn-agent'), availableReplicas: 0 })).toBe(false);
    expect(isDeploymentRolloutComplete({ ...ready('psfn-agent'), desiredReplicas: 0 })).toBe(false);
  });
});

describe('waitForDeploymentsReady', () => {
  it('polls the deployment set until every rollout is complete', async () => {
    const seen = new Map<string, number>();
    const getDeployment = vi.fn(async (_namespace: string, name: string) => {
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      return count === 1
        ? { ...ready(name), observedGeneration: 1, readyReplicas: 0 }
        : ready(name);
    });
    const sleep = vi.fn(async () => undefined);

    const result = await waitForDeploymentsReady({
      namespace: 'psfn',
      deploymentNames: ['psfn-agent', 'psfn-gateway', 'psfn-garden'],
      api: { getDeployment },
      waitTimeoutMs: 5_000,
      pollIntervalMs: 250,
      now: () => 0,
      sleep,
    });

    expect(result).toEqual({
      ready: true,
      deployments: [ready('psfn-agent'), ready('psfn-gateway'), ready('psfn-garden')],
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('returns every pending deployment when the readiness deadline passes', async () => {
    const getDeployment = vi.fn(async (_namespace: string, name: string) => ({
      ...ready(name),
      observedGeneration: 1,
      updatedReplicas: 0,
      readyReplicas: 0,
      availableReplicas: 0,
    }));
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValue(1_100);

    const result = await waitForDeploymentsReady({
      namespace: 'psfn',
      deploymentNames: ['psfn-agent', 'psfn-gateway'],
      api: { getDeployment },
      waitTimeoutMs: 100,
      pollIntervalMs: 25,
      now,
      sleep: async () => {
        throw new Error('readiness wait slept after the deadline');
      },
    });

    expect(result).toEqual({
      ready: false,
      pending:
        'psfn-agent (ready 0/1, updated 0/1, observedGeneration 1/2); '
        + 'psfn-gateway (ready 0/1, updated 0/1, observedGeneration 1/2)',
    });
  });
});
