import { describe, expect, it, vi } from 'vitest';
import type { GatewayMethodRuntime } from './types.js';
import { registerKubeSelfManagementMethods } from './kube-self-management.js';

describe('registerKubeSelfManagementMethods', () => {
  it('registers the gateway-owned controller with the authenticated approval queue', async () => {
    const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
    const invoke = vi.fn(async () => ({
      status: 'completed' as const,
      validationResult: 'not_run' as const,
      rollbackStatus: 'not_requested' as const,
    }));
    const requestExplicitApproval = vi.fn();
    const runtime = {
      target: {
        addMethod: (name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
          methods.set(name, handler);
        },
      },
      kubeSelfManagement: { invoke },
      authenticatedCompanionId: () => 'companion',
      approvalBoundary: { requestExplicitApproval },
      audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
    } as unknown as GatewayMethodRuntime;
    registerKubeSelfManagementMethods(runtime);

    const handler = methods.get('kube.self_management');
    expect(handler).toBeDefined();
    await handler?.({
      action: 'diagnose',
      namespace: 'psfn-test',
      release: 'psfn',
    });

    expect(invoke).toHaveBeenCalledWith({
      actor: 'companion',
      params: {
        action: 'diagnose',
        namespace: 'psfn-test',
        release: 'psfn',
      },
      approvals: { enqueue: expect.any(Function) },
    });
    const approvals = invoke.mock.calls[0]?.[0].approvals;
    const execute = vi.fn();
    await approvals?.enqueue({
      method: 'kube.self_management',
      action: 'restart',
      scope: 'psfn-test/psfn',
      params: {},
      companionReason: 'test',
    }, execute);
    expect(requestExplicitApproval).toHaveBeenCalledWith(expect.objectContaining({
      authenticatedCompanionId: 'companion',
      execute,
    }));
  });
});
