import { apiGet, apiPost } from '$lib/api/client';
import type {
  CompanionWish,
  CompanionWishState,
} from '../../../../../src/faculties/wiki/personal-wishlist-contracts.js';
export { MAX_OPERATOR_RESPONSE_CHARS } from '../../../../../src/faculties/wiki/personal-wishlist-contracts.js';

export type { CompanionWish, CompanionWishState };

export interface WishlistListResponse {
  wishes: CompanionWish[];
  boundary: string;
}

export interface WishlistMutationResponse {
  wish: CompanionWish;
}

export type WishlistBeadIssueType = 'bug' | 'feature' | 'task' | 'epic' | 'chore';

export function listWishes(): Promise<WishlistListResponse> {
  return apiGet<WishlistListResponse>('/api/admin/wishlist');
}

export function acknowledgeWish(id: string): Promise<WishlistMutationResponse> {
  return apiPost<WishlistMutationResponse>(
    `/api/admin/wishlist/${encodeURIComponent(id)}/acknowledge`,
  );
}

export function respondToWish(id: string, response: string): Promise<WishlistMutationResponse> {
  return apiPost<WishlistMutationResponse>(
    `/api/admin/wishlist/${encodeURIComponent(id)}/respond`,
    { response },
  );
}

export function convertWishToBead(
  id: string,
  issueType: WishlistBeadIssueType = 'task',
  priority = 2,
): Promise<WishlistMutationResponse> {
  return apiPost<WishlistMutationResponse>(
    `/api/admin/wishlist/${encodeURIComponent(id)}/convert-to-bead`,
    { issueType, priority },
  );
}

export function completeWish(id: string): Promise<WishlistMutationResponse> {
  return apiPost<WishlistMutationResponse>(
    `/api/admin/wishlist/${encodeURIComponent(id)}/done`,
  );
}
