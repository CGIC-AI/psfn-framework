import { describe, expect, it, vi } from 'vitest';
import { registerMemoryTools } from './runtime-wiring.js';
import type {
  MemoryDeletionApprovalPort,
  MemoryDeletionProposalStorePort,
} from './deletion-proposals.js';

describe('registerMemoryTools', () => {
  it('registers only canonical memory and scratchpad tools', () => {
    const registerTool = vi.fn();
    const memoryDeletionProposalStore = {
      createMemoryDeletionProposal:
        vi.fn<MemoryDeletionProposalStorePort['createMemoryDeletionProposal']>(),
      markMemoryDeletionPartnerAlerted:
        vi.fn<MemoryDeletionProposalStorePort['markMemoryDeletionPartnerAlerted']>(),
      approveMemoryDeletionProposal:
        vi.fn<MemoryDeletionProposalStorePort['approveMemoryDeletionProposal']>(),
      denyMemoryDeletionProposal:
        vi.fn<MemoryDeletionProposalStorePort['denyMemoryDeletionProposal']>(),
      getMemoryDeletionProposal:
        vi.fn<MemoryDeletionProposalStorePort['getMemoryDeletionProposal']>(),
      listPendingMemoryDeletionProposals:
        vi.fn<MemoryDeletionProposalStorePort['listPendingMemoryDeletionProposals']>(),
      listRecoverableMemoryDeletionProposals:
        vi.fn<MemoryDeletionProposalStorePort['listRecoverableMemoryDeletionProposals']>(),
      listMemoryDeletionAuditEvents:
        vi.fn<MemoryDeletionProposalStorePort['listMemoryDeletionAuditEvents']>(),
    } satisfies MemoryDeletionProposalStorePort;
    const memoryDeletionApprovalPort = {
      requestMemoryDeletionApproval:
        vi.fn<MemoryDeletionApprovalPort['requestMemoryDeletionApproval']>(),
    } satisfies MemoryDeletionApprovalPort;

    registerMemoryTools(
      { registerTool },
      {
        writer: {} as any,
        memoryStore: {} as any,
        memoryDeletionProposalStore,
        memoryDeletionApprovalPort,
        memoryDeletionPolicy: {
          justificationCategories: [{
            id: 'factually_incorrect',
            label: 'Factually incorrect',
            eligible: true,
            explanationPatterns: ['factually incorrect'],
          }],
        },
      },
    );

    const names = registerTool.mock.calls.map(([tool]) => tool.name);
    expect(names).toEqual(['memory', 'scratchpad']);
    expect(names).not.toEqual(expect.arrayContaining([
      'memory_import_batch',
      'memory_patch',
      'memory_redact',
      'memory_delete',
      'undo_memory_delete',
      'memory_write',
      'scratchpad_read',
      'scratchpad_write',
    ]));
  });
});
