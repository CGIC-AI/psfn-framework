import { apiGet, apiPost } from '$lib/api/client';
import type {
  PostTurnActionQueueStatus,
  PostTurnActionStatusRecord,
} from '../../../../../src/core/agent/post-turn-action-runtime.js';
import type { AdminActionPipeMutationResult } from '../../../../../src/operator/garden/services/types.js';

export type ActionPipeStatus = PostTurnActionQueueStatus;
export type ActionPipeActionStatus = PostTurnActionStatusRecord;
export type ActionPipeMutationResult = AdminActionPipeMutationResult;

export function getActionPipeStatus(): Promise<ActionPipeStatus> {
  return apiGet<ActionPipeStatus>('/api/admin/action-pipe');
}

export function cancelActionPipeAction(actionRef: string, reason?: string): Promise<ActionPipeMutationResult> {
  return apiPost<ActionPipeMutationResult>(
    `/api/admin/action-pipe/actions/${encodeURIComponent(actionRef)}/cancel`,
    { reason },
  );
}

export function acknowledgeActionPipeAction(actionRef: string, detail?: string): Promise<ActionPipeMutationResult> {
  return apiPost<ActionPipeMutationResult>(
    `/api/admin/action-pipe/actions/${encodeURIComponent(actionRef)}/acknowledge`,
    { detail },
  );
}
