// Result validation for `memory.deletion.propose` (extracted from the
// GatewayClient facade to keep it under the ratified god-file threshold).
// Fails closed on any unknown key or malformed terminal state.

import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import type {
  MemoryDeletionApprovalRequest,
  MemoryDeletionApprovalResult,
} from '../../../faculties/memory/deletion-proposals.js';

export function parseMemoryDeletionApprovalResult(
  result: unknown,
  request: MemoryDeletionApprovalRequest,
): MemoryDeletionApprovalResult {
  if (!isRecord(result)) throw new Error('Gateway returned an invalid memory deletion approval result');
  assertNoUnknownKeys(
    result,
    ['status', 'proposalId', 'approvalId', 'expiresAt', 'deleteId'],
    'memory.deletion.propose result',
  );
  if (result.proposalId !== request.proposalId) {
    throw new Error('Gateway returned a malformed memory deletion approval result');
  }
  if (result.status === 'already_approved' || result.status === 'already_denied') {
    if ((result.approvalId !== undefined
        && (typeof result.approvalId !== 'string' || !result.approvalId.trim()))
      || (result.deleteId !== undefined
        && (typeof result.deleteId !== 'string' || !result.deleteId.trim()))
      || (result.status === 'already_approved'
        && (typeof result.deleteId !== 'string' || !result.deleteId.trim()))
      || (result.status === 'already_denied' && result.deleteId !== undefined)) {
      throw new Error('Gateway returned a malformed terminal memory deletion result');
    }
    return {
      status: result.status,
      proposalId: request.proposalId,
      ...(typeof result.approvalId === 'string' ? { approvalId: result.approvalId.trim() } : {}),
      ...(typeof result.deleteId === 'string' ? { deleteId: result.deleteId.trim() } : {}),
    };
  }
  if (result.status !== 'approval_required'
    || typeof result.approvalId !== 'string'
    || !result.approvalId.trim()
    || !Number.isSafeInteger(result.expiresAt)) {
    throw new Error('Gateway returned a malformed memory deletion approval result');
  }
  return {
    status: 'approval_required',
    proposalId: request.proposalId,
    approvalId: result.approvalId.trim(),
    expiresAt: result.expiresAt as number,
  };
}
