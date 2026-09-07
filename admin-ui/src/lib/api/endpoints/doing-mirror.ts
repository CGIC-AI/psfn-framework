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
  return apiPost<DoingMirrorMutationResponse>(
    `/api/admin/doing-mirror/${encodeURIComponent(input.itemType)}/${encodeURIComponent(input.itemId)}`,
    {
      state: input.state,
      ...(input.reason ? { reason: input.reason } : {}),
      subject: input.subject,
      body: input.body,
    },
  );
}

/**
 * psfn-framework-nwtw1: operator escape hatch for a disposition whose Letter
 * delivery was quarantined after repeated failures.
 */
export function retryDoingMirrorLetter(
  itemType: DoingMirrorItem['source']['itemType'],
  itemId: string,
): Promise<DoingMirrorMutationResponse> {
  return apiPost<DoingMirrorMutationResponse>(
    `/api/admin/doing-mirror/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/retry-letter`,
  );
}

export type { DoingMirrorItem, DoingMirrorTransitionInput };
