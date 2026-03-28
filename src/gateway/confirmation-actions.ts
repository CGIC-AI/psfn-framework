import type { ConfirmationQueueEntry } from '../system/capabilities/confirmation-queue.js';
import { toErrorMessage } from '../shared/utils/errors.js';
import type { PolicyDecision } from './protocol.js';

interface QueuedActionAuditHooks {
  audit(method: string, decision: PolicyDecision, params?: Record<string, unknown>): number;
  auditComplete(id: number, startTime: number, error?: string): void;
}

export interface ExecuteQueuedActionOptions<P, R> extends QueuedActionAuditHooks {
  method: string;
  handler: (params: P) => Promise<R>;
  paramsSummary: (params: P) => Record<string, unknown>;
  params: P;
  entry: ConfirmationQueueEntry;
}

export function resolveCompanionReason(
  params: Record<string, unknown>,
  fallback: string,
): string {
  const candidateKeys = ['reason', 'prompt', 'intent', 'summary'];
  for (const key of candidateKeys) {
    const raw = params[key];
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
  }
  return fallback.trim() || 'No companion reason provided.';
}

export async function executeQueuedAction<P, R>({
  method,
  handler,
  paramsSummary,
  params,
  entry,
  audit,
  auditComplete,
}: ExecuteQueuedActionOptions<P, R>): Promise<R> {
  const queuedSummary = {
    ...paramsSummary(params),
    confirmationId: entry.id,
    confirmationDecision: 'approve',
  };
  const queuedAuditId = audit(method, 'ALLOW', queuedSummary);
  const queuedStart = Date.now();
  try {
    const result = await handler(params);
    auditComplete(queuedAuditId, queuedStart);
    return result;
  } catch (error) {
    const message = toErrorMessage(error);
    auditComplete(queuedAuditId, queuedStart, message);
    throw error;
  }
}
