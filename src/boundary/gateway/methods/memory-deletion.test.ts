import { describe, expect, it, vi } from 'vitest';
import {
  ConfirmationQueue,
  type ConfirmationQueueEntry,
} from '../../../system/capabilities/confirmation-queue.js';
import type { ApprovalBoundaryService } from '../approval-boundary.js';
import {
  handleMemoryDeletionPropose,
  type MemoryDeletionGatewayRuntime,
} from './memory-deletion.js';

type RequestApprovalInput = Parameters<ApprovalBoundaryService['requestExplicitApproval']>[0];
type RefreshApprovalInput = Parameters<ApprovalBoundaryService['refreshExplicitApproval']>[0];
type ReconcileApprovalInput = Parameters<ApprovalBoundaryService['reconcileExplicitApproval']>[0];

function createHarness() {
  const onEnqueued = vi.fn();
  let now = 1_700_000_000_000;
  let approvalSequence = 0;
  let proposalStatus: 'pending_partner_alert' | 'pending_operator_validation' | 'approved' | 'denied' =
    'pending_partner_alert';
  let loseApprovalReply = false;
  let disconnectAfterResolution = false;
  let agentDisconnected = false;
  const queue = new ConfirmationQueue({
    now: () => now,
    idFactory: () => `approval-${++approvalSequence}`,
    observer: { onEnqueued },
  });
  const request = vi.fn(async (method: string, params: unknown) => {
    if (agentDisconnected) throw new Error('agent connection unavailable');
    const proposalId = (params as { proposalId: string }).proposalId;
    if (method === 'memory.deletion.snapshot') {
      return {
        proposalId,
        memoryId: 'memory-1',
        justificationCategory: 'privacy_or_consent',
        explanation: 'Consent was withdrawn for this retained fact.',
        status: proposalStatus,
        ...(proposalStatus === 'approved' ? { deleteId: 'delete-1' } : {}),
      };
    }
    if (method === 'memory.deletion.partner_alerted') {
      proposalStatus = 'pending_operator_validation';
      return { proposalId, status: 'pending_operator_validation' };
    }
    if (method === 'memory.deletion.resolve') {
      const decision = (params as { decision: 'approve' | 'deny' }).decision;
      if (decision === 'approve') {
        proposalStatus = 'approved';
        if (disconnectAfterResolution) {
          disconnectAfterResolution = false;
          agentDisconnected = true;
          throw new Error('agent disconnected after database commit');
        }
        if (loseApprovalReply) {
          loseApprovalReply = false;
          throw new Error('agent reply lost after database commit');
        }
        return { proposalId, status: 'approved', deleteId: 'delete-1' };
      }
      proposalStatus = 'denied';
      if (disconnectAfterResolution) {
        disconnectAfterResolution = false;
        agentDisconnected = true;
        throw new Error('agent disconnected after denial commit');
      }
      return { proposalId, status: 'denied' };
    }
    throw new Error(`Unexpected reverse method: ${method}`);
  });
  const approvalBoundary = {
    listPendingConfirmations: () => queue.listPending(),
    requestExplicitApproval: async (
      input: RequestApprovalInput,
    ): Promise<ConfirmationQueueEntry> => {
      const entry = queue.enqueue({
        ...input.request,
        approvalOwner: { companionId: 'companion-1' },
      }, input.execute, {
        ...(input.onDenied ? { onDenied: input.onDenied } : {}),
        ...(input.retainOnExecutionFailure ? { retainOnExecutionFailure: true } : {}),
        ...(input.renewOnExpiry ? { renewOnExpiry: true } : {}),
      });
      await input.afterEnqueued?.(entry);
      return entry;
    },
    refreshExplicitApproval: async (
      input: RefreshApprovalInput,
    ): Promise<ConfirmationQueueEntry> => {
      const entry = queue.refreshPending(input.id, input.execute, {
        ...(input.onDenied ? { onDenied: input.onDenied } : {}),
        ...(input.retainOnExecutionFailure ? { retainOnExecutionFailure: true } : {}),
        ...(input.renewOnExpiry ? { renewOnExpiry: true } : {}),
      });
      await input.afterRefreshed?.(entry);
      return entry;
    },
    reconcileExplicitApproval: (input: ReconcileApprovalInput) => (
      queue.reconcileRetainedResolution(input.id, input.status)
    ),
  };
  const runtime = {
    authenticatedCompanionId: () => 'companion-1',
    approvalBoundary,
    target: { request },
  } satisfies MemoryDeletionGatewayRuntime;
  const params = {
    proposalId: 'proposal-1',
    memoryId: 'memory-1',
    justificationCategory: 'privacy_or_consent',
    explanation: 'Consent was withdrawn for this retained fact.',
  };
  return {
    advanceBeyondExpiry: () => { now = 1_700_086_400_001; },
    handler: handleMemoryDeletionPropose,
    disconnectOnNextResolution: () => { disconnectAfterResolution = true; },
    loseNextApprovalReply: () => { loseApprovalReply = true; },
    onEnqueued,
    params,
    queue,
    request,
    reconnectAgent: () => { agentDisconnected = false; },
    runtime,
  };
}

describe('memory.deletion.propose gateway method', () => {
  it('alerts the Partner through the existing confirmation queue and applies Operator approval', async () => {
    const h = createHarness();

    await expect(h.handler(h.params, h.runtime)).resolves.toEqual({
      status: 'approval_required',
      proposalId: 'proposal-1',
      approvalId: 'approval-1',
      expiresAt: 1_700_086_400_000,
    });
    expect(h.onEnqueued).toHaveBeenCalledWith(expect.objectContaining({
      id: 'approval-1',
      resolutionAuthority: 'operator',
    }));
    expect(h.request).toHaveBeenCalledWith('memory.deletion.partner_alerted', {
      proposalId: 'proposal-1',
    });

    await expect(h.queue.resolve(
      { id: 'approval-1', decision: 'approve' },
      { kind: 'operator', id: 'operator-1' },
    )).resolves.toMatchObject({ status: 'approved', executed: true });
    expect(h.request).toHaveBeenCalledWith('memory.deletion.resolve', {
      proposalId: 'proposal-1',
      decision: 'approve',
      operatorId: 'operator-1',
    });
  });

  it('persists authenticated Operator denial without invoking deletion', async () => {
    const h = createHarness();
    await h.handler(h.params, h.runtime);

    await expect(h.queue.resolve(
      { id: 'approval-1', decision: 'deny' },
      { kind: 'operator', id: 'operator-2' },
    )).resolves.toMatchObject({ status: 'denied', executed: false });
    expect(h.request).toHaveBeenLastCalledWith('memory.deletion.resolve', {
      proposalId: 'proposal-1',
      decision: 'deny',
      operatorId: 'operator-2',
    });
    expect(h.request).not.toHaveBeenCalledWith(
      'memory.deletion.resolve',
      expect.objectContaining({ decision: 'approve' }),
    );
  });

  it('reconciles an approval whose durable delete committed before the RPC reply was lost', async () => {
    const h = createHarness();
    await h.handler(h.params, h.runtime);
    h.loseNextApprovalReply();

    await expect(h.queue.resolve(
      { id: 'approval-1', decision: 'approve' },
      { kind: 'operator', id: 'operator-4' },
    )).resolves.toMatchObject({ status: 'approved', executed: true });
    expect(h.request).toHaveBeenCalledWith('memory.deletion.snapshot', {
      proposalId: 'proposal-1',
    });
  });

  it('retains and replays a committed approval after the agent disconnects before reconciliation', async () => {
    const h = createHarness();
    await h.handler(h.params, h.runtime);
    h.disconnectOnNextResolution();

    await expect(h.queue.resolve(
      { id: 'approval-1', decision: 'approve' },
      { kind: 'operator', id: 'operator-5' },
    )).resolves.toMatchObject({ status: 'failed', executed: false });
    expect(h.queue.getPending('approval-1')).not.toBeNull();
    expect(h.queue.listHistory()).toEqual([]);

    h.reconnectAgent();
    await expect(h.handler(h.params, h.runtime)).resolves.toMatchObject({
      status: 'already_approved',
      proposalId: 'proposal-1',
      approvalId: 'approval-1',
      deleteId: 'delete-1',
    });
    expect(h.queue.listPending()).toEqual([]);
    expect(h.queue.listHistory()).toEqual([
      expect.objectContaining({ id: 'approval-1', status: 'approved', executed: true }),
    ]);
  });

  it('retains and replays a committed denial after the agent disconnects before acknowledgement', async () => {
    const h = createHarness();
    await h.handler(h.params, h.runtime);
    h.disconnectOnNextResolution();

    await expect(h.queue.resolve(
      { id: 'approval-1', decision: 'deny' },
      { kind: 'operator', id: 'operator-6' },
    )).resolves.toMatchObject({ status: 'failed', executed: false });
    expect(h.queue.getPending('approval-1')).not.toBeNull();

    h.reconnectAgent();
    await expect(h.handler(h.params, h.runtime)).resolves.toMatchObject({
      status: 'already_denied',
      proposalId: 'proposal-1',
      approvalId: 'approval-1',
    });
    expect(h.queue.listHistory()).toEqual([
      expect.objectContaining({ id: 'approval-1', status: 'denied', executed: false }),
    ]);
  });

  it('refreshes an existing confirmation instead of duplicating it during durable recovery', async () => {
    const h = createHarness();
    const first = await h.handler(h.params, h.runtime);
    const recovered = await h.handler(h.params, h.runtime);

    expect(recovered).toEqual(first);
    expect(h.onEnqueued).toHaveBeenCalledOnce();
    expect(h.queue.listPending()).toHaveLength(1);
    expect(h.request).toHaveBeenCalledTimes(4);
  });

  it('automatically renews a durable pending confirmation across expiry without another alert', async () => {
    const h = createHarness();
    await h.handler(h.params, h.runtime);
    h.advanceBeyondExpiry();

    await expect(h.handler(h.params, h.runtime)).resolves.toMatchObject({
      proposalId: 'proposal-1',
      approvalId: 'approval-1',
    });
    expect(h.onEnqueued).toHaveBeenCalledOnce();
    expect(h.queue.listPending()).toEqual([
      expect.objectContaining({
        id: 'approval-1',
        expiresAt: 1_700_172_800_001,
      }),
    ]);
  });

  it('rejects RPC parameters that do not match the durable proposal before alerting the Partner', async () => {
    const h = createHarness();
    await expect(h.handler({ ...h.params, memoryId: 'spoofed-memory' }, h.runtime))
      .rejects.toThrow(/does not match the durable memory deletion proposal/);
    expect(h.onEnqueued).not.toHaveBeenCalled();
    expect(h.queue.listPending()).toEqual([]);
  });

  it('records an attempted modification as denial of the immutable proposal', async () => {
    const h = createHarness();
    await h.handler(h.params, h.runtime);

    await expect(h.queue.resolve(
      {
        id: 'approval-1',
        decision: 'modify',
        modifiedParams: { ...h.params, explanation: 'Changed after the Partner alert.' },
      },
      { kind: 'operator', id: 'operator-3' },
    )).resolves.toMatchObject({ status: 'failed', executed: false });
    expect(h.request).toHaveBeenCalledWith('memory.deletion.resolve', {
      proposalId: 'proposal-1',
      decision: 'deny',
      operatorId: 'operator-3',
    });
    expect(h.request).not.toHaveBeenCalledWith(
      'memory.deletion.resolve',
      expect.objectContaining({ decision: 'approve' }),
    );
  });

  it('refuses non-Operator resolution and leaves the proposal pending', async () => {
    const h = createHarness();
    await h.handler(h.params, h.runtime);

    await expect(h.queue.resolve(
      { id: 'approval-1', decision: 'approve' },
      { kind: 'companion', id: 'companion-1' },
    )).resolves.toMatchObject({ status: 'failed', executed: false });
    expect(h.queue.getPending('approval-1')).not.toBeNull();
  });
});
