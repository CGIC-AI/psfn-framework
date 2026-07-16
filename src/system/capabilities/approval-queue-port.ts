import type {
  ConfirmationQueue,
  ConfirmationQueueEntry,
  ConfirmationQueueHistoryEntry,
  ConfirmationQueueRequest,
  ConfirmationExecutionContext,
  ConfirmationResolverIdentity,
  ConfirmationResolveRequest,
  ConfirmationResolveResult,
} from './confirmation-queue.js';

export type {
  ConfirmationQueueEntry,
  ConfirmationQueueHistoryEntry,
  ConfirmationQueueRequest,
  ConfirmationExecutionContext,
  ConfirmationResolverIdentity,
  ConfirmationResolveRequest,
  ConfirmationResolveResult,
};

export interface ApprovalQueuePort {
  enqueue(request: ConfirmationQueueRequest, execute: (
    params: Record<string, unknown>,
    entry: ConfirmationQueueEntry,
    context: ConfirmationExecutionContext,
  ) => Promise<unknown>): ConfirmationQueueEntry;
  listPending(): ConfirmationQueueEntry[];
  listHistory(): ConfirmationQueueHistoryEntry[];
  getPending(id: string): ConfirmationQueueEntry | null;
  resolve(
    request: ConfirmationResolveRequest,
    resolver?: ConfirmationResolverIdentity,
  ): Promise<ConfirmationResolveResult>;
}

export function createApprovalQueuePort(queue: ApprovalQueuePort): ApprovalQueuePort {
  return {
    enqueue: (request, execute) => queue.enqueue(request, execute),
    listPending: () => queue.listPending(),
    listHistory: () => queue.listHistory(),
    getPending: (id) => queue.getPending(id),
    resolve: (request, resolver) => queue.resolve(request, resolver),
  };
}

export function createApprovalQueuePortFromConfirmationQueue(
  queue: ConfirmationQueue,
): ApprovalQueuePort {
  return createApprovalQueuePort(queue);
}
