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

/**
 * psfn-framework-p4rmp: acknowledging, responding to, or completing a wish
 * records a doing-mirror disposition, and a disposition change always carries
 * the Letter the Partner wrote in their own words.
 */
export interface WishlistDispositionLetter {
  subject: string;
  body: string;
}

export function acknowledgeWish(
  id: string,
  letter: WishlistDispositionLetter,
): Promise<WishlistMutationResponse> {
  return apiPost<WishlistMutationResponse>(
    `/api/admin/wishlist/${encodeURIComponent(id)}/acknowledge`,
    { subject: letter.subject, body: letter.body },
  );
}

export function respondToWish(
  id: string,
  response: string,
  letter: WishlistDispositionLetter,
): Promise<WishlistMutationResponse> {
  return apiPost<WishlistMutationResponse>(
    `/api/admin/wishlist/${encodeURIComponent(id)}/respond`,
    { response, subject: letter.subject, body: letter.body },
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

export function completeWish(
  id: string,
  letter: WishlistDispositionLetter,
): Promise<WishlistMutationResponse> {
  return apiPost<WishlistMutationResponse>(
    `/api/admin/wishlist/${encodeURIComponent(id)}/done`,
    { subject: letter.subject, body: letter.body },
  );
}
