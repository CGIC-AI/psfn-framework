import { describe, expect, it, vi } from 'vitest';
import {
  createInClusterKubernetesRolloutApi,
  createKubernetesRolloutApi,
} from './kubernetes-rollout-api.js';

describe('createKubernetesRolloutApi', () => {
  it('issues a strategic-merge patch on the pod template with a restart annotation', async () => {
    const patchJson = vi.fn(async () => undefined);
    const api = createKubernetesRolloutApi({
      read: {
        getDeployment: vi.fn(),
        listPods: vi.fn(),
      },
      patch: { patchJson },
      now: () => new Date('2026-07-15T12:00:00.000Z'),
    });

    await api.restartDeployment('psfn', 'psfn-agent');

    expect(patchJson).toHaveBeenCalledTimes(1);
    const [path, body, contentType] = patchJson.mock.calls[0]!;
    expect(path).toBe('/apis/apps/v1/namespaces/psfn/deployments/psfn-agent');
    expect(contentType).toBe('application/strategic-merge-patch+json');
    expect(JSON.parse(body as string)).toEqual({
      spec: {
        template: {
          metadata: {
            annotations: {
              'kubectl.kubernetes.io/restartedAt': '2026-07-15T12:00:00.000Z',
            },
          },
        },
      },
    });
  });

  it('rejects non-DNS-label namespace or deployment names', async () => {
    const api = createKubernetesRolloutApi({
      read: { getDeployment: vi.fn(), listPods: vi.fn() },
      patch: { patchJson: vi.fn() },
    });
    await expect(api.restartDeployment('Bad_NS', 'psfn-agent')).rejects.toThrow(/DNS label/);
    await expect(api.restartDeployment('psfn', 'Bad_Name')).rejects.toThrow(/DNS label/);
  });

  it('delegates getDeployment to the read api', async () => {
    const getDeployment = vi.fn(async () => ({
      name: 'psfn-agent',
      generation: 2,
      observedGeneration: 2,
      desiredReplicas: 1,
      readyReplicas: 1,
      updatedReplicas: 1,
      availableReplicas: 1,
    }));
    const api = createKubernetesRolloutApi({
      read: { getDeployment, listPods: vi.fn() },
      patch: { patchJson: vi.fn() },
    });
    await api.getDeployment('psfn', 'psfn-agent');
    expect(getDeployment).toHaveBeenCalledWith('psfn', 'psfn-agent');
  });
});

describe('createInClusterKubernetesRolloutApi', () => {
  it('reads the service-account token per request and sends a PATCH', async () => {
    const patchRequest = vi.fn(async () => undefined);
    const readToken = vi.fn(() => 'sa-token');
    const api = createInClusterKubernetesRolloutApi({
      KUBERNETES_SERVICE_HOST: '10.0.0.1',
      KUBERNETES_SERVICE_PORT_HTTPS: '443',
    } as NodeJS.ProcessEnv, {
      requestTimeoutMs: 5_000,
      rolloutRequestTimeoutMs: 5_000,
      readToken,
      readCa: () => Buffer.from('ca'),
      requestJson: vi.fn(),
      patchRequest,
      now: () => new Date('2026-07-15T12:00:00.000Z'),
    });

    await api.restartDeployment('psfn', 'psfn-gateway');

    expect(readToken).toHaveBeenCalledTimes(1);
    expect(patchRequest).toHaveBeenCalledTimes(1);
    const options = patchRequest.mock.calls[0]![0]!;
    expect(options).toMatchObject({
      hostname: '10.0.0.1',
      port: 443,
      path: '/apis/apps/v1/namespaces/psfn/deployments/psfn-gateway',
      token: 'sa-token',
      contentType: 'application/strategic-merge-patch+json',
    });
  });

  it('fails closed on an invalid service-account token', async () => {
    const api = createInClusterKubernetesRolloutApi({
      KUBERNETES_SERVICE_HOST: '10.0.0.1',
      KUBERNETES_SERVICE_PORT_HTTPS: '443',
    } as NodeJS.ProcessEnv, {
      requestTimeoutMs: 5_000,
      rolloutRequestTimeoutMs: 5_000,
      readToken: () => 'has whitespace',
      readCa: () => Buffer.from('ca'),
      patchRequest: vi.fn(),
    });
    await expect(api.restartDeployment('psfn', 'psfn-agent')).rejects.toThrow(/token is missing or invalid/);
  });
});
