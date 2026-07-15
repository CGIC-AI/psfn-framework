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
      createRolloutApi: () => ({ getDeployment, restartDeployment: vi.fn(async () => undefined) }),
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

  it('supports the mutating restart action through the approval gate', async () => {
    const restartDeployment = vi.fn(async () => undefined);
    const getDeployment = vi.fn(async (_namespace: string, name: string) => ({
      name,
      generation: 1,
      observedGeneration: 1,
      desiredReplicas: 1,
      readyReplicas: 1,
      updatedReplicas: 1,
      availableReplicas: 1,
    }));
    const enqueue = vi.fn(async () => ({ id: 'approval-1', expiresAt: 123 }));
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
      audit: vi.fn(async () => 1),
      createApi: () => ({ getDeployment, listPods: vi.fn(async () => []) }),
      createRolloutApi: () => ({ getDeployment, restartDeployment }),
    });

    const response = await controller?.invoke({
      actor: 'companion',
      params: {
        action: 'restart',
        namespace: 'psfn-test',
        release: 'psfn',
        sourceRevision: 'a'.repeat(40),
        targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
        helmRevision: 7,
        reason: 'apply a hotfix',
      },
      approvals: { enqueue },
    });

    // Restart is a mutation: it enqueues an operator approval rather than
    // executing immediately, and does not restart before approval.
    expect(response).toEqual({ status: 'approval_required', approvalId: 'approval-1', expiresAt: 123 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(restartDeployment).not.toHaveBeenCalled();
  });

  it('composes the deploy pipeline executor only when an operator-job runner is supplied', () => {
    const baseEnv = {
      PSFN_KUBE_SELF_MANAGEMENT_ENABLED: 'true',
      PSFN_HELM_NAMESPACE: 'psfn-test',
      PSFN_HELM_RELEASE_NAME: 'psfn',
      PSFN_KUBE_RESOURCE_PREFIX: 'psfn-runtime',
      PSFN_HELM_REVISION: '7',
      PSFN_GIT_COMMIT: 'a'.repeat(40),
      PSFN_KUBE_CURRENT_IMAGE: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
    } as const;
    const createApi = () => ({ getDeployment: vi.fn(), listPods: vi.fn() });
    const createRolloutApi = () => ({ getDeployment: vi.fn(), restartDeployment: vi.fn() });

    // Agent path (no operator-job runner): diagnose + restart only, credential-free.
    const diagnoseOnly = resolveKubeSelfManagementController({
      env: { ...baseEnv }, audit: vi.fn(async () => 1), createApi, createRolloutApi,
    });
    expect(diagnoseOnly).toBeDefined();

    // Operator-job composition: rebuild/deploy become available.
    const withPipeline = resolveKubeSelfManagementController({
      env: { ...baseEnv },
      audit: vi.fn(async () => 1),
      createApi,
      createRolloutApi,
      deployPipeline: {
        runner: {
          verifyPreconditions: vi.fn(),
          archiveSource: vi.fn(),
          runGate: vi.fn(),
          buildImage: vi.fn(),
          importImage: vi.fn(),
          validateOnK3d: vi.fn(),
          captureLiveValues: vi.fn(),
          helmUpgrade: vi.fn(),
        },
        resolvePlan: () => ({
          sourceBranch: 'feat/kube-self-management',
          sourceCommit: 'a'.repeat(40),
          imageRepository: 'localhost/psfn-framework',
          imageTag: '0.1.0-kube-aaaaaaaa',
          k3dValidation: { mode: 'skip', reason: 'no k3d' },
        }),
      },
    });
    expect(withPipeline).toBeDefined();
  });
});
