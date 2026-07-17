import { apiGet, apiPost } from '$lib/api/client';

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
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiGet<ConcernListData>(`/api/admin/concerns${suffix}`);
}

export function resolveConcern(id: string, outcome?: string): Promise<ConcernActionResult> {
  return apiPost<ConcernActionResult>(`/api/admin/concerns/${encodeURIComponent(id)}/resolve`, {
    ...(outcome ? { outcome } : {}),
  });
}

export function suppressConcern(id: string, outcome?: string): Promise<ConcernActionResult> {
  return apiPost<ConcernActionResult>(`/api/admin/concerns/${encodeURIComponent(id)}/suppress`, {
    ...(outcome ? { outcome } : {}),
  });
}

export function transitionConcern(
  id: string,
  status: string,
  options: { outcome?: string; nextReviewAt?: string } = {},
): Promise<ConcernActionResult> {
  return apiPost<ConcernActionResult>(`/api/admin/concerns/${encodeURIComponent(id)}/transition`, {
    status,
    ...(options.outcome ? { outcome: options.outcome } : {}),
    ...(options.nextReviewAt ? { nextReviewAt: options.nextReviewAt } : {}),
  });
}

export function resolveStaleConcerns(outcome?: string): Promise<ConcernActionResult> {
  return apiPost<ConcernActionResult>('/api/admin/concerns/resolve-stale', {
    ...(outcome ? { outcome } : {}),
  });
}
