import { apiGet } from '$lib/api/client';
import type {
  AuditFilters,
  AuditHistoryData,
} from '$lib/types';

export function getAuditHistory(filters: AuditFilters): Promise<AuditHistoryData> {
  const params = new URLSearchParams();
  params.set('actionType', filters.actionType);
  params.set('decision', filters.decision);
  params.set('timeRange', filters.timeRange);
  params.set('source', filters.source ?? 'all');
  if (filters.query?.trim()) params.set('query', filters.query.trim());
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters.offset !== undefined) params.set('offset', String(filters.offset));
  return apiGet<AuditHistoryData>(`/api/admin/audit/history?${params.toString()}`);
}
