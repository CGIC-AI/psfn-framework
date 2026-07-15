import { describe, expect, it, vi } from 'vitest';
import { resolveKubeSelfManagementController } from './kube-self-management-runtime.js';

describe('resolveKubeSelfManagementController', () => {
  it('keeps the runtime surface disabled unless explicitly enabled', () => {
    const createApi = vi.fn();

    expect(resolveKubeSelfManagementController({
      env: {},
      audit: vi.fn(async () => 1),
      createApi,
    })).toBeUndefined();
    expect(createApi).not.toHaveBeenCalled();
  });

  it('fails closed on ambiguous enablement and incomplete pinned release metadata', () => {
    expect(() => resolveKubeSelfManagementController({
      env: { PSFN_KUBE_SELF_MANAGEMENT_ENABLED: 'yes' },
      audit: vi.fn(async () => 1),
    })).toThrow('must be true or false');

    expect(() => resolveKubeSelfManagementController({
      env: { PSFN_KUBE_SELF_MANAGEMENT_ENABLED: 'true' },
      audit: vi.fn(async () => 1),
    })).toThrow('must be DNS labels');

    expect(() => resolveKubeSelfManagementController({
      env: {
        PSFN_KUBE_SELF_MANAGEMENT_ENABLED: 'true',
        PSFN_HELM_NAMESPACE: 'psfn-test',
        PSFN_HELM_RELEASE_NAME: 'psfn',
        PSFN_KUBE_RESOURCE_PREFIX: 'psfn',
        PSFN_HELM_REVISION: '7',
        PSFN_GIT_COMMIT: 'a'.repeat(40),
        PSFN_KUBE_CURRENT_IMAGE: 'localhost/psfn-framework:latest',
      },
      audit: vi.fn(async () => 1),
    })).toThrow('must be an exact pinned image reference');

    expect(() => resolveKubeSelfManagementController({
      env: {
        PSFN_KUBE_SELF_MANAGEMENT_ENABLED: 'true',
        PSFN_HELM_NAMESPACE: 'psfn-test',
        PSFN_HELM_RELEASE_NAME: 'psfn',
        PSFN_HELM_REVISION: '7',
        PSFN_GIT_COMMIT: 'a'.repeat(40),
        PSFN_KUBE_CURRENT_IMAGE: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
      },
      audit: vi.fn(async () => 1),
    })).toThrow('PSFN_KUBE_RESOURCE_PREFIX');
  });

  it('wires in-cluster diagnostics and durable sanitized audit records', async () => {
    const audit = vi.fn(async () => 1);
    const getDeployment = vi.fn(async (_namespace: string, name: string) => ({
      name,
      generation: 1,
      observedGeneration: 1,
      desiredReplicas: 1,
      readyReplicas: 1,
      updatedReplicas: 1,
      availableReplicas: 1,
    }));
    const listPods = vi.fn(async () => []);
    const controller = resolveKubeSelfManagementController({
      env: {
        PSFN_KUBE_SELF_MANAGEMENT_ENABLED: 'true',
        PSFN_HELM_NAMESPACE: 'psfn-test',
        PSFN_HELM_RELEASE_NAME: 'psfn',
        PSFN_KUBE_RESOURCE_PREFIX: 'psfn-runtime',
        PSFN_HELM_REVISION: '7',
        PSFN_GIT_COMMIT: 'a'.repeat(40),
        PSFN_KUBE_CURRENT_IMAGE: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
      },
      audit,
      createApi: () => ({ getDeployment, listPods }),
    });

    await controller?.invoke({
      actor: 'companion',
      params: {
        action: 'diagnose',
        namespace: 'psfn-test',
        release: 'psfn',
      },
      approvals: { enqueue: vi.fn() },
    });

    expect(getDeployment.mock.calls.map(([, name]) => name)).toEqual([
      'psfn-runtime-agent',
      'psfn-runtime-gateway',
      'psfn-runtime-garden',
    ]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      method: 'kube.self_management.attempt',
      decision: 'ALLOW',
      params: expect.objectContaining({
        actor: 'companion',
        requestedAction: 'diagnose',
        namespace: 'psfn-test',
        release: 'psfn',
        validationResult: 'not_run',
        rollbackStatus: 'not_requested',
      }),
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain('reason');
  });
});
