import type {
  MemoryDeletionApprovalPort,
  MemoryDeletionProposalStorePort,
} from './deletion-proposals.js';

/** Rebuilds the volatile confirmation surface from durable pending proposals. */
export async function recoverPendingMemoryDeletionProposals(
  proposalStore: Pick<MemoryDeletionProposalStorePort, 'listRecoverableMemoryDeletionProposals'>,
  approvalPort: MemoryDeletionApprovalPort,
): Promise<number> {
  const recoverable = await proposalStore.listRecoverableMemoryDeletionProposals();
  for (const proposal of recoverable) {
    await approvalPort.requestMemoryDeletionApproval({
      proposalId: proposal.id,
      memoryId: proposal.memoryId,
      justificationCategory: proposal.justificationCategory,
      explanation: proposal.explanation,
    });
  }
  return recoverable.length;
}
