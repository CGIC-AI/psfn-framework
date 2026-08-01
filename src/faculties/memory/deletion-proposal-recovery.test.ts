import { describe, expect, it, vi } from 'vitest';
import type {
  MemoryDeletionApprovalPort,
  MemoryDeletionProposal,
  MemoryDeletionProposalStorePort,
} from './deletion-proposals.js';
import { recoverPendingMemoryDeletionProposals } from './deletion-proposal-recovery.js';

const pendingProposal: MemoryDeletionProposal = {
  id: 'proposal-restart',
  memoryId: 'memory-1',
  memoryAuthorizationRevision: 4,
  justificationCategory: 'privacy_or_consent',
  explanation: 'Consent was withdrawn.',
  status: 'pending_operator_validation',
  proposedAt: 10,
  proposedBy: 'Companion',
  partnerAlertedAt: 11,
};

describe('recoverPendingMemoryDeletionProposals', () => {
  it('reconstructs confirmation requests from durable pending proposals after restart', async () => {
    const listRecoverableMemoryDeletionProposals = vi.fn(async () => [pendingProposal]);
    const requestMemoryDeletionApproval = vi.fn(async () => ({
      status: 'approval_required' as const,
      proposalId: pendingProposal.id,
      approvalId: 'approval-recovered',
      expiresAt: 100,
    }));
    const proposalStore = {
      listRecoverableMemoryDeletionProposals,
    } as Pick<MemoryDeletionProposalStorePort, 'listRecoverableMemoryDeletionProposals'>;
    const approvalPort: MemoryDeletionApprovalPort = { requestMemoryDeletionApproval };

    await expect(recoverPendingMemoryDeletionProposals(proposalStore, approvalPort)).resolves.toBe(1);
    expect(requestMemoryDeletionApproval).toHaveBeenCalledWith({
      proposalId: pendingProposal.id,
      memoryId: pendingProposal.memoryId,
      justificationCategory: pendingProposal.justificationCategory,
      explanation: pendingProposal.explanation,
    });
  });

  it('fails closed when reconstruction cannot reach the confirmation boundary', async () => {
    const proposalStore = {
      listRecoverableMemoryDeletionProposals: async () => [pendingProposal],
    } as Pick<MemoryDeletionProposalStorePort, 'listRecoverableMemoryDeletionProposals'>;
    const approvalPort: MemoryDeletionApprovalPort = {
      requestMemoryDeletionApproval: async () => { throw new Error('gateway unavailable'); },
    };

    await expect(recoverPendingMemoryDeletionProposals(proposalStore, approvalPort))
      .rejects.toThrow('gateway unavailable');
  });
});
