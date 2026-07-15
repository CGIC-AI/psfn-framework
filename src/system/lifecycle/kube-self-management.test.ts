import { describe, expect, it, vi } from 'vitest';
import { ConfirmationQueue } from '../capabilities/confirmation-queue.js';
import { KubeSelfManagementController } from './kube-self-management.js';

const GARDEN_OPERATOR = { kind: 'operator' as const, id: 'garden-admin' };

describe('KubeSelfManagementController', () => {
  it('denies an unknown action without enqueueing approval or executing it', async () => {
    const execute = vi.fn();
    const queue = new ConfirmationQueue();
    const controller = new KubeSelfManagementController({
      namespace: 'psfn-test',
      release: 'psfn',
      executor: {
        supports: () => true,
        execute,
      },
      audit: vi.fn(async () => undefined),
    });

    await expect(controller.invoke({
      actor: 'companion',
      params: {
        action: 'delete_namespace',
        namespace: 'psfn-test',
        release: 'psfn',
      },
      approvals: {
        enqueue: async (request, run) => queue.enqueue(request, run),
      },
    })).rejects.toThrow('Unsupported Kubernetes self-management action');

    expect(queue.listPending()).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['namespace', { namespace: 'other-namespace', release: 'psfn' }],
    ['release', { namespace: 'psfn-test', release: 'other-release' }],
  ])('denies an unknown %s before approval or execution', async (_field, scope) => {
    const execute = vi.fn();
    const queue = new ConfirmationQueue();
    const audit = vi.fn(async () => undefined);
    const controller = new KubeSelfManagementController({
      namespace: 'psfn-test',
      release: 'psfn',
      executor: {
        supports: () => true,
        execute,
      },
      audit,
    });

    await expect(controller.invoke({
      actor: 'companion',
      params: {
        action: 'diagnose',
        ...scope,
      },
      approvals: {
        enqueue: async (request, run) => queue.enqueue(request, run),
      },
    })).rejects.toThrow('outside the configured Kubernetes release scope');

    expect(queue.listPending()).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'attempt',
      decision: 'DENY',
      errorCode: 'scope_mismatch',
    }));
  });

  it('runs a supported read-only diagnostic without creating an approval', async () => {
    const queue = new ConfirmationQueue();
    const execute = vi.fn(async () => ({
      validationResult: 'not_run' as const,
      rollbackStatus: 'not_requested' as const,
      details: { deploymentCount: 3 },
    }));
    const audit = vi.fn(async () => undefined);
    const controller = new KubeSelfManagementController({
      namespace: 'psfn-test',
      release: 'psfn',
      executor: {
        supports: action => action === 'diagnose',
        execute,
      },
      audit,
    });

    const result = await controller.invoke({
      actor: 'companion',
      params: {
        action: 'diagnose',
        namespace: 'psfn-test',
        release: 'psfn',
      },
      approvals: {
        enqueue: async (request, run) => queue.enqueue(request, run),
      },
    });

    expect(result).toEqual({
      status: 'completed',
      validationResult: 'not_run',
      rollbackStatus: 'not_requested',
      details: { deploymentCount: 3 },
    });
    expect(queue.listPending()).toEqual([]);
    expect(execute).toHaveBeenCalledWith({
      action: 'diagnose',
      namespace: 'psfn-test',
      release: 'psfn',
    });
    expect(audit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      phase: 'attempt',
      decision: 'ALLOW',
      requestedAction: 'diagnose',
    }));
    expect(audit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      phase: 'result',
      decision: 'ALLOW',
      outcome: 'succeeded',
    }));
  });

  it('does not execute a mutation until the existing confirmation queue approves it', async () => {
    const queue = new ConfirmationQueue({
      now: () => 10_000,
      idFactory: () => 'kube-approval-1',
      defaultExpiryMs: 5_000,
    });
    const execute = vi.fn(async () => ({
      validationResult: 'not_run' as const,
      rollbackStatus: 'not_requested' as const,
    }));
    const audit = vi.fn(async () => undefined);
    const controller = new KubeSelfManagementController({
      namespace: 'psfn-test',
      release: 'psfn',
      executor: {
        supports: action => action === 'restart',
        execute,
      },
      audit,
    });

    const result = await controller.invoke({
      actor: 'companion',
      params: {
        action: 'restart',
        namespace: 'psfn-test',
        release: 'psfn',
        sourceRevision: 'a'.repeat(40),
        targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
        helmRevision: 7,
        reason: 'Apply the approved runtime update.',
      },
      approvals: {
        enqueue: async (request, run) => queue.enqueue(request, run),
      },
    });

    expect(result).toEqual({
      status: 'approval_required',
      approvalId: 'kube-approval-1',
      expiresAt: 15_000,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(queue.listPending()).toEqual([
      expect.objectContaining({
        id: 'kube-approval-1',
        method: 'kube.self_management',
        action: 'restart',
        scope: 'psfn-test/psfn',
        resolutionAuthority: 'operator',
        params: {
          action: 'restart',
          namespace: 'psfn-test',
          release: 'psfn',
          sourceRevision: 'a'.repeat(40),
          targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
          helmRevision: 7,
        },
      }),
    ]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'attempt',
      decision: 'NEEDS_APPROVAL',
      sourceRevision: 'a'.repeat(40),
      targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
      helmRevision: 7,
    }));
  });

  it.each([
    'restart',
    'rebuild',
    'deploy',
    'validate',
    'rollback',
  ] as const)('writes a sanitized audit attempt for %s', async (action) => {
    const queue = new ConfirmationQueue();
    const audit = vi.fn(async () => undefined);
    const controller = new KubeSelfManagementController({
      namespace: 'psfn-test',
      release: 'psfn',
      executor: {
        supports: () => true,
        execute: vi.fn(async () => ({
          validationResult: action === 'validate' ? 'passed' as const : 'not_run' as const,
          rollbackStatus: action === 'rollback' ? 'succeeded' as const : 'not_requested' as const,
        })),
      },
      audit,
    });
    const params = action === 'validate'
      ? {
        action,
        namespace: 'psfn-test',
        release: 'psfn',
      }
      : {
        action,
        namespace: 'psfn-test',
        release: 'psfn',
        sourceRevision: 'a'.repeat(40),
        targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
        helmRevision: 7,
        reason: 'Operator-visible context that must not enter audit records.',
      };

    await controller.invoke({
      actor: 'c',
      params,
      approvals: {
        enqueue: async (request, run) => queue.enqueue(request, run),
      },
    });

    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'attempt',
      actor: 'c',
      requestedAction: action,
      namespace: 'psfn-test',
      release: 'psfn',
      ...(action === 'validate' ? {
        decision: 'ALLOW',
      } : {
        decision: 'NEEDS_APPROVAL',
        sourceRevision: 'a'.repeat(40),
        targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
        helmRevision: 7,
      }),
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain('Operator-visible context');
  });

  it('denies an approval whose bound target image was modified', async () => {
    const queue = new ConfirmationQueue({ idFactory: () => 'kube-mismatch' });
    const execute = vi.fn(async () => ({
      validationResult: 'not_run' as const,
      rollbackStatus: 'not_requested' as const,
    }));
    const audit = vi.fn(async () => undefined);
    const controller = new KubeSelfManagementController({
      namespace: 'psfn-test',
      release: 'psfn',
      executor: { supports: () => true, execute },
      audit,
    });
    await controller.invoke({
      actor: 'companion',
      params: {
        action: 'deploy',
        namespace: 'psfn-test',
        release: 'psfn',
        sourceRevision: 'a'.repeat(40),
        targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
        helmRevision: 8,
        reason: 'Deploy the reviewed image.',
      },
      approvals: {
        enqueue: async (request, run) => queue.enqueue(request, run),
      },
    });

    const result = await queue.resolve({
      id: 'kube-mismatch',
      decision: 'modify',
      modifiedParams: {
        action: 'deploy',
        namespace: 'psfn-test',
        release: 'psfn',
        sourceRevision: 'a'.repeat(40),
        targetImage: 'localhost/psfn-framework:0.1.0-kube-bbbbbbbbbbbb',
        helmRevision: 8,
      },
    }, GARDEN_OPERATOR);

    expect(result).toMatchObject({ status: 'failed', executed: false });
    expect(execute).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'result',
      decision: 'DENY',
      approvalId: 'kube-mismatch',
      errorCode: 'approval_mismatch',
    }));
  });

  it('denies a stale approval without executing the mutation', async () => {
    let now = 1_000;
    const queue = new ConfirmationQueue({
      now: () => now,
      idFactory: () => 'kube-stale',
      defaultExpiryMs: 100,
    });
    const execute = vi.fn(async () => ({
      validationResult: 'not_run' as const,
      rollbackStatus: 'not_requested' as const,
    }));
    const controller = new KubeSelfManagementController({
      namespace: 'psfn-test',
      release: 'psfn',
      executor: { supports: () => true, execute },
      audit: vi.fn(async () => undefined),
    });
    await controller.invoke({
      actor: 'companion',
      params: {
        action: 'restart',
        namespace: 'psfn-test',
        release: 'psfn',
        sourceRevision: 'a'.repeat(40),
        targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
        helmRevision: 7,
        reason: 'Restart the reviewed release.',
      },
      approvals: {
        enqueue: async (request, run) => queue.enqueue(request, run),
      },
    });

    now = 1_101;
    const result = await queue.resolve(
      { id: 'kube-stale', decision: 'approve' },
      GARDEN_OPERATOR,
    );

    expect(result).toMatchObject({ status: 'expired', executed: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes an exact approval once and denies replay', async () => {
    const queue = new ConfirmationQueue({ idFactory: () => 'kube-once' });
    const execute = vi.fn(async () => ({
      validationResult: 'passed' as const,
      rollbackStatus: 'not_requested' as const,
    }));
    const audit = vi.fn(async () => undefined);
    const controller = new KubeSelfManagementController({
      namespace: 'psfn-test',
      release: 'psfn',
      executor: { supports: () => true, execute },
      audit,
    });
    const request = {
      action: 'restart',
      namespace: 'psfn-test',
      release: 'psfn',
      sourceRevision: 'a'.repeat(40),
      targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
      helmRevision: 7,
      reason: 'Restart the reviewed release.',
    };
    await controller.invoke({
      actor: 'companion',
      params: request,
      approvals: {
        enqueue: async (approvalRequest, run) => queue.enqueue(approvalRequest, run),
      },
    });

    const approved = await queue.resolve(
      { id: 'kube-once', decision: 'approve' },
      GARDEN_OPERATOR,
    );
    const replayed = await queue.resolve(
      { id: 'kube-once', decision: 'approve' },
      GARDEN_OPERATOR,
    );

    expect(approved).toMatchObject({ status: 'approved', executed: true });
    expect(replayed).toMatchObject({ status: 'not_found', executed: false });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(request);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'result',
      decision: 'ALLOW',
      approvalId: 'kube-once',
      validationResult: 'passed',
      outcome: 'succeeded',
      resolverKind: 'operator',
      resolverId: 'garden-admin',
    }));
  });

  it('reports a committed mutation as executed when its result audit fails', async () => {
    const queue = new ConfirmationQueue({ idFactory: () => 'kube-audit-failed' });
    const execute = vi.fn(async () => ({
      validationResult: 'passed' as const,
      rollbackStatus: 'not_requested' as const,
    }));
    const audit = vi.fn(async (event: { phase: string; decision: string; outcome: string }) => {
      if (event.phase === 'result'
        && event.decision === 'ALLOW'
        && event.outcome === 'succeeded') {
        throw new Error('audit store unavailable');
      }
    });
    const controller = new KubeSelfManagementController({
      namespace: 'psfn-test',
      release: 'psfn',
      executor: { supports: () => true, execute },
      audit,
    });
    await controller.invoke({
      actor: 'companion',
      params: {
        action: 'restart',
        namespace: 'psfn-test',
        release: 'psfn',
        sourceRevision: 'a'.repeat(40),
        targetImage: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaaaaaa',
        helmRevision: 7,
        reason: 'Restart the reviewed release.',
      },
      approvals: {
        enqueue: async (request, run) => queue.enqueue(request, run),
      },
    });

    const result = await queue.resolve(
      { id: 'kube-audit-failed', decision: 'approve' },
      GARDEN_OPERATOR,
    );
    const replay = await queue.resolve(
      { id: 'kube-audit-failed', decision: 'approve' },
      GARDEN_OPERATOR,
    );

    expect(result).toEqual({
      id: 'kube-audit-failed',
      status: 'failed',
      message: 'Kubernetes self-management action executed, but result audit failed; do not retry.',
      executed: true,
    });
    expect(replay).toMatchObject({ status: 'not_found', executed: false });
    expect(execute).toHaveBeenCalledOnce();
    expect(queue.listHistory()).toEqual([
      expect.objectContaining({
        id: 'kube-audit-failed',
        status: 'failed',
        executed: true,
        resolver: GARDEN_OPERATOR,
      }),
    ]);
    expect(audit.mock.calls.flat().some(event => (
      event.phase === 'result'
      && event.errorCode === 'execution_failed'
    ))).toBe(false);
  });

  it('audits execution failure without copying the executor error or reason', async () => {
    const audit = vi.fn(async () => undefined);
    const controller = new KubeSelfManagementController({
      namespace: 'psfn-test',
      release: 'psfn',
      executor: {
        supports: action => action === 'diagnose',
        execute: vi.fn(async () => {
          throw new Error('Bearer secret-value-from-upstream');
        }),
      },
      audit,
    });

    await expect(controller.invoke({
      actor: 'companion',
      params: {
        action: 'diagnose',
        namespace: 'psfn-test',
        release: 'psfn',
      },
      approvals: { enqueue: vi.fn() },
    })).rejects.toThrow('Kubernetes self-management execution failed');

    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'result',
      decision: 'DENY',
      validationResult: 'failed',
      errorCode: 'execution_failed',
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain('secret-value-from-upstream');
  });
});
