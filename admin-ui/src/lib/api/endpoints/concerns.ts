import { apiGet } from '$lib/api/client';
import { withQuery } from '$lib/api/query';
import { apiPostProtected } from '$lib/api/protected-mutation';

export interface ConcernView {
  id: string;
  text: string;
  priority: 'high' | 'medium' | 'low';
  source: string;
  status: string;
  createdAt: string;
  salience: number;
  contactId?: string;
  nextReviewAt?: string;
  outcome?: string;
  owner?: string;
}

export interface ConcernListData {
  concerns: ConcernView[];
}

export interface ConcernActionResult {
  ok: boolean;
  message?: string;
}

export interface ConcernListQuery {
  includeResolved?: boolean;
  includeExpired?: boolean;
  limit?: number;
}

export function listConcerns(query: ConcernListQuery = {}): Promise<ConcernListData> {
  const params = new URLSearchParams();
  if (query.includeResolved !== undefined) params.set('includeResolved', String(query.includeResolved));
  if (query.includeExpired !== undefined) params.set('includeExpired', String(query.includeExpired));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  return apiGet<ConcernListData>(withQuery('/api/admin/concerns', params));
}

export function resolveConcern(
  id: string,
  reason: string,
  outcome?: string,
): Promise<ConcernActionResult> {
  return apiPostProtected<ConcernActionResult>(
    `/api/admin/concerns/${encodeURIComponent(id)}/resolve`, {
      reason,
      ...(outcome ? { outcome } : {}),
    }, reason,
  );
}

export function suppressConcern(
  id: string,
  reason: string,
  outcome?: string,
): Promise<ConcernActionResult> {
  return apiPostProtected<ConcernActionResult>(
    `/api/admin/concerns/${encodeURIComponent(id)}/suppress`, {
      reason,
      ...(outcome ? { outcome } : {}),
    }, reason,
  );
}

export function transitionConcern(
  id: string,
  status: string,
  reason: string,
  options: { outcome?: string; nextReviewAt?: string } = {},
): Promise<ConcernActionResult> {
  return apiPostProtected<ConcernActionResult>(
    `/api/admin/concerns/${encodeURIComponent(id)}/transition`, {
      reason,
      status,
      ...(options.outcome ? { outcome: options.outcome } : {}),
      ...(options.nextReviewAt ? { nextReviewAt: options.nextReviewAt } : {}),
    }, reason,
  );
}

export function resolveStaleConcerns(reason: string, outcome?: string): Promise<ConcernActionResult> {
  return apiPostProtected<ConcernActionResult>('/api/admin/concerns/resolve-stale', {
      reason,
      ...(outcome ? { outcome } : {}),
    }, reason,
  );
}
