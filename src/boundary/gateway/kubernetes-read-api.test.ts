import { describe, expect, it, vi } from 'vitest';
import {
  createInClusterKubernetesReadApi,
  createKubernetesReadApi,
} from './kubernetes-read-api.js';

describe('createKubernetesReadApi', () => {
  it('uses fixed read-only API paths and returns a bounded status projection', async () => {
    const getJson = vi.fn(async (path: string) => {
      if (path.includes('/deployments/')) {
        return {
          metadata: {
            name: 'psfn-agent',
            generation: 4,
            annotations: { secret: 'must-not-escape' },
          },
          spec: { replicas: 1 },
          status: {
            observedGeneration: 4,
            readyReplicas: 1,
            updatedReplicas: 1,
            availableReplicas: 1,
          },
        };
      }
      return {
        items: [{
          metadata: { name: 'psfn-agent-abc', annotations: { token: 'hidden' } },
          status: {
            phase: 'Running',
            containerStatuses: [{
              image: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
              ready: true,
              restartCount: 2,
            }],
          },
        }],
      };
    });
    const api = createKubernetesReadApi({ getJson });

    const deployment = await api.getDeployment('psfn-test', 'psfn-agent');
    const pods = await api.listPods(
      'psfn-test',
      'app.kubernetes.io/instance=psfn',
    );

    expect(getJson.mock.calls).toEqual([
      ['/apis/apps/v1/namespaces/psfn-test/deployments/psfn-agent'],
      ['/api/v1/namespaces/psfn-test/pods?labelSelector=app.kubernetes.io%2Finstance%3Dpsfn'],
    ]);
    expect(deployment).toEqual({
      name: 'psfn-agent',
      generation: 4,
      observedGeneration: 4,
      desiredReplicas: 1,
      readyReplicas: 1,
      updatedReplicas: 1,
      availableReplicas: 1,
    });
    expect(pods).toEqual([{
      name: 'psfn-agent-abc',
      phase: 'Running',
      ready: true,
      restartCount: 2,
      images: ['localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa'],
    }]);
    expect(JSON.stringify({ deployment, pods })).not.toContain('must-not-escape');
    expect(JSON.stringify({ deployment, pods })).not.toContain('hidden');
  });
});

describe('createInClusterKubernetesReadApi', () => {
  it('reloads and validates the projected ServiceAccount token for every request', async () => {
    const readToken = vi.fn()
      .mockReturnValueOnce('token-one\n')
      .mockReturnValueOnce('token-two\n');
    const requestJson = vi.fn(async ({ path }: { path: string }) => {
      if (path.includes('/deployments/')) {
        return {
          metadata: { name: 'psfn-agent', generation: 1 },
          spec: { replicas: 1 },
          status: {
            observedGeneration: 1,
            readyReplicas: 1,
            updatedReplicas: 1,
            availableReplicas: 1,
          },
        };
      }
      return { items: [] };
    });
    const api = createInClusterKubernetesReadApi({
      KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc',
      KUBERNETES_SERVICE_PORT_HTTPS: '443',
    }, {
      requestTimeoutMs: 5_000,
      readToken,
      readCa: () => Buffer.from('test-ca'),
      requestJson,
    });

    await api.getDeployment('psfn-test', 'psfn-agent');
    await api.listPods('psfn-test', 'app.kubernetes.io/instance=psfn');

    expect(readToken).toHaveBeenCalledTimes(2);
    expect(requestJson.mock.calls.map(([options]) => options.token)).toEqual([
      'token-one',
      'token-two',
    ]);
  });

  it('rejects a rotated token containing header-breaking whitespace', async () => {
    const api = createInClusterKubernetesReadApi({
      KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc',
      KUBERNETES_SERVICE_PORT_HTTPS: '443',
    }, {
      requestTimeoutMs: 5_000,
      readToken: () => 'token-one\ntoken-two',
      readCa: () => Buffer.from('test-ca'),
      requestJson: vi.fn(),
    });

    await expect(api.getDeployment('psfn-test', 'psfn-agent')).rejects.toThrow(
      'Kubernetes ServiceAccount token is missing or invalid.',
    );
  });
});
