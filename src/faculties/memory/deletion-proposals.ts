export type MemoryDeletionProposalStatus =
  | 'pending_partner_alert'
  | 'pending_operator_validation'
  | 'approved'
  | 'denied'
  | 'restored';

export type MemoryDeletionAuditEventType =
  | 'proposed'
  | 'partner_alerted'
  | 'approved'
  | 'denied'
  | 'deleted'
  | 'restored';

export type MemoryDeletionActorRole = 'Companion' | 'Partner' | 'Operator';

export interface MemoryDeletionProposal {
  id: string;
  memoryId: string;
  memoryAuthorizationRevision: number;
  justificationCategory: string;
  explanation: string;
  status: MemoryDeletionProposalStatus;
  proposedAt: number;
  proposedBy: 'Companion';
  partnerAlertedAt?: number;
  operatorDecidedAt?: number;
  operatorId?: string;
  deleteId?: string;
  restoredAt?: number;
  restoredBy?: string;
}

export interface MemoryDeletionAuditEvent {
  sequence: number;
  id: string;
  proposalId: string;
  eventType: MemoryDeletionAuditEventType;
  actorRole: MemoryDeletionActorRole;
  actorId?: string;
  occurredAt: number;
  deleteId?: string;
}

export interface CreateMemoryDeletionProposalInput {
  memoryId: string;
  justificationCategory: string;
  explanation: string;
  proposedBy: 'Companion';
  proposalId?: string;
  proposedAt?: number;
}

export interface MemoryDeletionProposalStorePort {
  createMemoryDeletionProposal(input: CreateMemoryDeletionProposalInput): Promise<MemoryDeletionProposal>;
  markMemoryDeletionPartnerAlerted(proposalId: string, alertedAt?: number): Promise<MemoryDeletionProposal>;
  approveMemoryDeletionProposal(
    proposalId: string,
    operatorId: string,
    decidedAt?: number,
  ): Promise<MemoryDeletionProposal>;
  denyMemoryDeletionProposal(
    proposalId: string,
    operatorId: string,
    decidedAt?: number,
  ): Promise<MemoryDeletionProposal>;
  getMemoryDeletionProposal(proposalId: string): Promise<MemoryDeletionProposal | undefined>;
  listPendingMemoryDeletionProposals(): Promise<MemoryDeletionProposal[]>;
  listRecoverableMemoryDeletionProposals(): Promise<MemoryDeletionProposal[]>;
  listMemoryDeletionAuditEvents(proposalId: string): Promise<MemoryDeletionAuditEvent[]>;
}

export interface MemoryDeletionApprovalRequest {
  proposalId: string;
  memoryId: string;
  justificationCategory: string;
  explanation: string;
}

export type MemoryDeletionApprovalResult = {
  status: 'approval_required';
  proposalId: string;
  approvalId: string;
  expiresAt: number;
} | {
  status: 'already_approved' | 'already_denied';
  proposalId: string;
  approvalId?: string;
  deleteId?: string;
};

export interface MemoryDeletionApprovalPort {
  requestMemoryDeletionApproval(
    request: MemoryDeletionApprovalRequest,
  ): Promise<MemoryDeletionApprovalResult>;
}
