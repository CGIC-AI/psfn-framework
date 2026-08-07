import {
  readConfirmedApprovalExecution,
  type ConfirmationExecutionContext,
  type ConfirmationQueueEntry,
  type ConfirmationQueueTerminalOutcome,
} from '../../../system/capabilities/confirmation-queue.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import type {
  MemoryDeletionPartnerAlertedResult,
  MemoryDeletionProposalSnapshotResult,
  MemoryDeletionProposeParams,
  MemoryDeletionProposeResult,
  MemoryDeletionResolveResult,
} from '../protocol.js';
import type { ApprovalBoundaryService } from '../approval-boundary.js';
import { registerAuditedDescriptors } from './register.js';
import { defineAuditedMethod, type GatewayMethodRuntime } from './types.js';

export interface MemoryDeletionGatewayRuntime {
  target: {
    request(method: string, params: unknown): PromiseLike<unknown>;
  };
  authenticatedCompanionId(): string | undefined;
  approvalBoundary: Pick<
    ApprovalBoundaryService,
    | 'listPendingConfirmations'
    | 'requestExplicitApproval'
    | 'refreshExplicitApproval'
    | 'reconcileExplicitApproval'
  >;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`memory.deletion.propose ${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseParams(input: unknown): MemoryDeletionProposeParams {
  if (!isRecord(input)) throw new Error('memory.deletion.propose params must be an object');
  assertNoUnknownKeys(
    input,
    ['proposalId', 'memoryId', 'justificationCategory', 'explanation'],
    'memory.deletion.propose params',
  );
  return {
    proposalId: requiredString(input.proposalId, 'proposalId'),
    memoryId: requiredString(input.memoryId, 'memoryId'),
    justificationCategory: requiredString(input.justificationCategory, 'justificationCategory'),
    explanation: requiredString(input.explanation, 'explanation'),
  };
}

function parsePartnerAlertedResult(
  input: unknown,
  proposalId: string,
): MemoryDeletionPartnerAlertedResult {
  if (!isRecord(input)) throw new Error('Agent returned an invalid Partner alert acknowledgement');
  assertNoUnknownKeys(input, ['proposalId', 'status'], 'memory deletion Partner alert result');
  if (input.proposalId !== proposalId || input.status !== 'pending_operator_validation') {
    throw new Error('Agent returned a mismatched Partner alert acknowledgement');
  }
  return { proposalId, status: 'pending_operator_validation' };
}

function parseProposalSnapshot(input: unknown, expected: MemoryDeletionProposeParams): MemoryDeletionProposalSnapshotResult {
  if (!isRecord(input)) throw new Error('Agent returned an invalid memory deletion proposal snapshot');
  assertNoUnknownKeys(
    input,
    ['proposalId', 'memoryId', 'justificationCategory', 'explanation', 'status', 'deleteId'],
    'memory deletion proposal snapshot',
  );
  const statuses = ['pending_partner_alert', 'pending_operator_validation', 'approved', 'denied', 'restored'];
  if (input.proposalId !== expected.proposalId
    || input.memoryId !== expected.memoryId
    || input.justificationCategory !== expected.justificationCategory
    || input.explanation !== expected.explanation
    || typeof input.status !== 'string'
    || !statuses.includes(input.status)
    || (input.deleteId !== undefined && (typeof input.deleteId !== 'string' || !input.deleteId.trim()))) {
    throw new Error('Gateway request does not match the durable memory deletion proposal');
  }
  return {
    proposalId: expected.proposalId,
    memoryId: expected.memoryId,
    justificationCategory: expected.justificationCategory,
    explanation: expected.explanation,
    status: input.status as MemoryDeletionProposalSnapshotResult['status'],
    ...(typeof input.deleteId === 'string' ? { deleteId: input.deleteId.trim() } : {}),
  };
}

function parseResolutionResult(
  input: unknown,
  proposalId: string,
  decision: 'approve' | 'deny',
): MemoryDeletionResolveResult {
  if (!isRecord(input)) throw new Error('Agent returned an invalid memory deletion resolution');
  assertNoUnknownKeys(input, ['proposalId', 'status', 'deleteId'], 'memory deletion resolution');
  const expectedStatus = decision === 'approve' ? 'approved' : 'denied';
  if (input.proposalId !== proposalId || input.status !== expectedStatus) {
    throw new Error('Agent returned a mismatched memory deletion resolution');
  }
  if (decision === 'approve' && (typeof input.deleteId !== 'string' || !input.deleteId.trim())) {
    throw new Error('Approved memory deletion did not return a delete checkpoint id');
  }
  if (decision === 'deny' && input.deleteId !== undefined) {
    throw new Error('Denied memory deletion unexpectedly returned a delete checkpoint id');
  }
  return {
    proposalId,
    status: expectedStatus,
    ...(decision === 'approve' ? { deleteId: (input.deleteId as string).trim() } : {}),
  };
}

async function approveProposalWithReconciliation(
  runtime: MemoryDeletionGatewayRuntime,
  params: MemoryDeletionProposeParams,
  operatorId: string,
): Promise<MemoryDeletionResolveResult> {
  try {
    return parseResolutionResult(await runtime.target.request('memory.deletion.resolve', {
      proposalId: params.proposalId,
      decision: 'approve',
      operatorId,
    }), params.proposalId, 'approve');
  } catch (approvalError) {
    let snapshot: MemoryDeletionProposalSnapshotResult;
    try {
      snapshot = parseProposalSnapshot(
        await runtime.target.request('memory.deletion.snapshot', { proposalId: params.proposalId }),
        params,
      );
    } catch (reconciliationError) {
      throw new AggregateError(
        [approvalError, reconciliationError],
        `Could not reconcile memory deletion proposal ${params.proposalId} after approval RPC failure`,
      );
    }
    if (snapshot.status === 'approved' && snapshot.deleteId) {
      return {
        proposalId: params.proposalId,
        status: 'approved',
        deleteId: snapshot.deleteId,
      };
    }
    throw approvalError;
  }
}

async function persistDenial(
  runtime: MemoryDeletionGatewayRuntime,
  proposalId: string,
  outcome: ConfirmationQueueTerminalOutcome,
): Promise<void> {
  if (outcome.resolver?.kind !== 'operator') {
    throw new Error('Memory deletion denial requires an independently authenticated Operator');
  }
  await denyProposal(runtime, proposalId, outcome.resolver.id);
}

async function denyProposal(
  runtime: MemoryDeletionGatewayRuntime,
  proposalId: string,
  operatorId: string,
): Promise<void> {
  parseResolutionResult(await runtime.target.request('memory.deletion.resolve', {
    proposalId,
    decision: 'deny',
    operatorId,
  }), proposalId, 'deny');
}

export async function handleMemoryDeletionPropose(
  params: MemoryDeletionProposeParams,
  runtime: MemoryDeletionGatewayRuntime,
): Promise<MemoryDeletionProposeResult> {
    const authenticatedCompanionId = runtime.authenticatedCompanionId();
    if (!authenticatedCompanionId) {
      throw new Error('memory.deletion.propose requires an authenticated Companion connection');
    }
    const immutableProposalParams = {
      proposalId: params.proposalId,
      memoryId: params.memoryId,
      justificationCategory: params.justificationCategory,
      explanation: params.explanation,
    };
    const proposalSnapshot = parseProposalSnapshot(
      await runtime.target.request('memory.deletion.snapshot', { proposalId: params.proposalId }),
      params,
    );
    const existing = runtime.approvalBoundary.listPendingConfirmations().find(candidate => (
      candidate.method === 'memory.deletion.validate'
      && candidate.params.proposalId === params.proposalId
    ));
    if (existing
      && (existing.approvalOwner?.companionId !== authenticatedCompanionId
        || existing.resolutionAuthority !== 'operator'
        || existing.scope !== `memory:${params.memoryId}`
        || JSON.stringify(existing.params) !== JSON.stringify(immutableProposalParams))) {
      throw new Error(`Pending confirmation for memory deletion proposal ${params.proposalId} is inconsistent`);
    }
    if (proposalSnapshot.status === 'approved'
      || proposalSnapshot.status === 'restored'
      || proposalSnapshot.status === 'denied') {
      const terminalStatus = proposalSnapshot.status === 'denied' ? 'denied' : 'approved';
      if (terminalStatus === 'approved' && !proposalSnapshot.deleteId) {
        throw new Error(
          `Durable memory deletion proposal ${params.proposalId} has no delete checkpoint id`,
        );
      }
      if (existing) {
        runtime.approvalBoundary.reconcileExplicitApproval({
          authenticatedCompanionId,
          id: existing.id,
          status: terminalStatus,
        });
      }
      return {
        status: terminalStatus === 'approved' ? 'already_approved' : 'already_denied',
        proposalId: params.proposalId,
        ...(existing ? { approvalId: existing.id } : {}),
        ...(terminalStatus === 'approved' && proposalSnapshot.deleteId
          ? { deleteId: proposalSnapshot.deleteId }
          : {}),
      };
    }
    const execute = async (
      approvedParams: Record<string, unknown>,
      queueEntry: ConfirmationQueueEntry,
      context: ConfirmationExecutionContext,
    ): Promise<MemoryDeletionResolveResult> => {
      const proof = readConfirmedApprovalExecution(context, queueEntry.id);
      if (proof.resolver?.kind !== 'operator') {
        throw new Error('Memory deletion approval requires an independently authenticated Operator');
      }
      if (proof.decision !== 'approve') {
        await denyProposal(runtime, params.proposalId, proof.resolver.id);
        throw new Error('Memory deletion proposal parameters are immutable; modification denies the proposal');
      }
      if (JSON.stringify(approvedParams) !== JSON.stringify(immutableProposalParams)) {
        throw new Error('Memory deletion proposal parameters are immutable; approve or deny without modification');
      }
      return await approveProposalWithReconciliation(runtime, params, proof.resolver.id);
    };
    const markPartnerAlerted = async (): Promise<void> => {
      parsePartnerAlertedResult(await runtime.target.request('memory.deletion.partner_alerted', {
        proposalId: params.proposalId,
      }), params.proposalId);
    };
    const onDenied = (outcome: ConfirmationQueueTerminalOutcome): Promise<void> => (
      persistDenial(runtime, params.proposalId, outcome)
    );
    let entry: ConfirmationQueueEntry;
    if (existing) {
      entry = await runtime.approvalBoundary.refreshExplicitApproval({
        authenticatedCompanionId,
        id: existing.id,
        execute,
        afterRefreshed: markPartnerAlerted,
        onDenied,
        retainOnExecutionFailure: true,
        renewOnExpiry: true,
      });
    } else {
      entry = await runtime.approvalBoundary.requestExplicitApproval({
        authenticatedCompanionId,
        request: {
          method: 'memory.deletion.validate',
          action: 'Validate memory deletion proposal',
          scope: `memory:${params.memoryId}`,
          params: immutableProposalParams,
          companionReason:
            `Companion proposes deletion under ${params.justificationCategory}: ${params.explanation}`,
          resolutionAuthority: 'operator',
          sourceSystem: 'tool-access',
        },
        execute,
        requirePartnerAlertDelivery: true,
        afterEnqueued: markPartnerAlerted,
        onDenied,
        retainOnExecutionFailure: true,
        renewOnExpiry: true,
      });
    }
    return {
      status: 'approval_required',
      proposalId: params.proposalId,
      approvalId: entry.id,
      expiresAt: entry.expiresAt,
    };
}

export const memoryDeletionMethodDescriptors = [
  defineAuditedMethod<MemoryDeletionProposeParams, MemoryDeletionProposeResult>({
    name: 'memory.deletion.propose',
    decode: parseParams,
    handler: handleMemoryDeletionPropose,
    summary: params => ({
      proposalId: params.proposalId,
      memoryId: params.memoryId,
      justificationCategory: params.justificationCategory,
    }),
  }),
];

export function registerMemoryDeletionMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, memoryDeletionMethodDescriptors);
}
