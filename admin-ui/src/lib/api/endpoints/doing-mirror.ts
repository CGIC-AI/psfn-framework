import { apiGet, apiPost } from '$lib/api/client';
import type {
  DoingMirrorItem,
  DoingMirrorTransitionInput,
} from '../../../../../src/core/doing-mirror/contracts.js';

export interface DoingMirrorListResponse {
  items: DoingMirrorItem[];
  boundary: string;
}

export interface DoingMirrorMutationResponse {
  item: DoingMirrorItem;
  boundary: string;
}

export function listDoingMirrorItems(): Promise<DoingMirrorListResponse> {
  return apiGet<DoingMirrorListResponse>('/api/admin/doing-mirror');
}

export function transitionDoingMirrorItem(
  input: DoingMirrorTransitionInput,
): Promise<DoingMirrorMutationResponse> {
  const path = `/api/admin/doing-mirror/${encodeURIComponent(input.itemType)}/${encodeURIComponent(input.itemId)}`;
  return apiPost<DoingMirrorMutationResponse>(path, {
    state: input.state,
    ...(input.reason ? { reason: input.reason } : {}),
    subject: input.subject,
    body: input.body,
  });
}

export type { DoingMirrorItem, DoingMirrorTransitionInput };
