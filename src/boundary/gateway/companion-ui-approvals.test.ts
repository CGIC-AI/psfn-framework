import { describe, expect, it, vi } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { ConfirmationQueueEntry } from '../../system/capabilities/confirmation-queue.js';
import { compileCompanionUiAction } from '../fleet-auth/companion-ui-action.js';
import { dispatchCompanionUiApproval } from './companion-ui-approvals.js';

const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
const otherCompanionId = createCompanionId('22222222-2222-4222-8222-222222222222');

function compiled(
  resource: 'confirmations.list' | 'confirmations.resolve' | 'conversation.status',
  body: unknown,
) {
  return compileCompanionUiAction(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    requestId: 'request-1',
    action: resource === 'confirmations.resolve'
      ? 'confirmations.resolve'
      : resource === 'confirmations.list'
        ? 'confirmations.read'
        : 'companion.read',
    resource,
    body,
  })), companionId, { capabilities: [], telemetryScopes: ['approvals', 'status'] });
}

function entry(
  id: string,
  owner: string,
  shardId?: string,
): ConfirmationQueueEntry {
  return {
    id,
    method: 'tools.execute',
    action: 'write',
    scope: '/private/path',
    params: { secret: 'must-not-leak' },
    companionReason: 'Needs permission',
    requestedAt: 1_750_000_000_000,
    expiresAt: 1_750_000_060_000,
    sourceSystem: 'tool-access',
    approvalOwner: { companionId: owner, ...(shardId ? { shardId } : {}) },
    attribution: {
      parentId: owner,
      parentLabel: 'Companion',
      ...(shardId ? { shardId, shardLabel: 'Shard' } : {}),
    },
  };
}

describe('Companion UI approval dispatch', () => {
  it('projects only exact owner-and-shard entries through the redaction boundary', async () => {
    const gateway = {
      listCompanionUiConfirmations: vi.fn(() => [
        entry('ordinary', companionId),
        entry('shard', companionId, 'shard-1'),
        entry('other-owner', otherCompanionId),
        {
          ...entry('shard-mismatch', companionId, 'shard-1'),
          approvalOwner: { companionId, shardId: 'shard-2' },
        },
      ]),
      resolveCompanionUiApproval: vi.fn(),
    };

    const result = await dispatchCompanionUiApproval({
      compiled: compiled('confirmations.list', {}),
      gateway,
    });

    expect(gateway.listCompanionUiConfirmations).toHaveBeenCalledWith(companionId);
    expect(result).toEqual({
      handled: true,
      result: {
        schemaVersion: 1,
        approvals: [
          expect.objectContaining({ id: 'ordinary', status: 'pending' }),
          expect.objectContaining({
            id: 'shard',
            attribution: expect.objectContaining({ parentId: companionId, shardId: 'shard-1' }),
          }),
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('other-owner');
    expect(JSON.stringify(result)).not.toContain('shard-mismatch');
  });

  it('resolves through the target companion-scoped gateway method', async () => {
    const resolveCompanionUiApproval = vi.fn(async () => ({
      id: 'approval-1',
      status: 'approved' as const,
      message: 'Approved and executed',
      executed: true,
    }));
    const gateway = {
      listCompanionUiConfirmations: vi.fn(),
      resolveCompanionUiApproval,
    };

    await expect(dispatchCompanionUiApproval({
      compiled: compiled('confirmations.resolve', { id: 'approval-1', decision: 'approve' }),
      gateway,
    })).resolves.toEqual({
      handled: true,
      result: expect.objectContaining({ id: 'approval-1', status: 'approved' }),
    });
    expect(resolveCompanionUiApproval).toHaveBeenCalledWith(companionId, {
      id: 'approval-1',
      decision: 'approve',
    });
  });

  it('leaves unrelated Companion UI resources to their owning dispatcher', async () => {
    const gateway = {
      listCompanionUiConfirmations: vi.fn(),
      resolveCompanionUiApproval: vi.fn(),
    };
    await expect(dispatchCompanionUiApproval({
      compiled: compiled('conversation.status', {}),
      gateway,
    })).resolves.toEqual({ handled: false });
    expect(gateway.listCompanionUiConfirmations).not.toHaveBeenCalled();
    expect(gateway.resolveCompanionUiApproval).not.toHaveBeenCalled();
  });
});
