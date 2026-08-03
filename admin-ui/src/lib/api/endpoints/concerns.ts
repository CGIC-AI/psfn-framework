import { apiGet, apiPost } from '$lib/api/client';
import {
  FLEET_ESCALATION_GRANT_HEADER,
  issueFleetEscalationGrant,
} from '$lib/api/fleet-escalation';

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

async function postEscalatedConcernAction(
  target: string,
  reason: string,
  post: (headers: Record<string, string>) => Promise<ConcernActionResult>,
): Promise<ConcernActionResult> {
  const grant = await issueFleetEscalationGrant({ method: 'POST', target, reason });
  return post({ [FLEET_ESCALATION_GRANT_HEADER]: grant.grantId });
}

export function resolveConcern(
  id: string,
  reason: string,
  outcome?: string,
): Promise<ConcernActionResult> {
  const target = `/api/admin/concerns/${encodeURIComponent(id)}/resolve`;
  return postEscalatedConcernAction(target, reason, headers => (
    apiPost<ConcernActionResult>(`/api/admin/concerns/${encodeURIComponent(id)}/resolve`, {
      ...(outcome ? { outcome } : {}),
    }, { headers })
  ));
}

export function suppressConcern(
  id: string,
  reason: string,
  outcome?: string,
): Promise<ConcernActionResult> {
  const target = `/api/admin/concerns/${encodeURIComponent(id)}/suppress`;
  return postEscalatedConcernAction(target, reason, headers => (
    apiPost<ConcernActionResult>(`/api/admin/concerns/${encodeURIComponent(id)}/suppress`, {
      ...(outcome ? { outcome } : {}),
    }, { headers })
  ));
}

export function transitionConcern(
  id: string,
  status: string,
  reason: string,
  options: { outcome?: string; nextReviewAt?: string } = {},
): Promise<ConcernActionResult> {
  const target = `/api/admin/concerns/${encodeURIComponent(id)}/transition`;
  return postEscalatedConcernAction(target, reason, headers => (
    apiPost<ConcernActionResult>(`/api/admin/concerns/${encodeURIComponent(id)}/transition`, {
      status,
      ...(options.outcome ? { outcome: options.outcome } : {}),
      ...(options.nextReviewAt ? { nextReviewAt: options.nextReviewAt } : {}),
    }, { headers })
  ));
}

export function resolveStaleConcerns(reason: string, outcome?: string): Promise<ConcernActionResult> {
  return postEscalatedConcernAction('/api/admin/concerns/resolve-stale', reason, headers => (
    apiPost<ConcernActionResult>('/api/admin/concerns/resolve-stale', {
      ...(outcome ? { outcome } : {}),
    }, { headers })
  ));
}
