import { apiDelete, apiGet, apiPost } from '$lib/api/client';
import type {
  AdminEnrollmentBindingView,
  AdminEnrollmentInput,
  AdminEnrollmentListData,
} from '../../../../../src/operator/garden/services/enrollment-service.js';

// Re-export the canonical admin view types (no shadow DTO mirror — see PSFN-00yo.1).
export type {
  AdminEnrollmentBindingView,
  AdminEnrollmentInput,
  AdminEnrollmentListData,
};

/** GET /api/admin/enrollments — current hub-identity ↔ contact bindings. */
export function getEnrollments(): Promise<AdminEnrollmentListData> {
  return apiGet<AdminEnrollmentListData>('/api/admin/enrollments');
}

/**
 * POST /api/admin/enrollments — bind an opaque hub-identity handle to an
 * EXISTING contact. Fails closed if the contact does not exist (never
 * auto-creates). Returns the created binding.
 */
export function enrollHubIdentity(
  input: AdminEnrollmentInput
): Promise<{ ok: true; binding: AdminEnrollmentBindingView }> {
  return apiPost<{ ok: true; binding: AdminEnrollmentBindingView }>(
    '/api/admin/enrollments',
    input
  );
}

/** DELETE /api/admin/enrollments/:hubIdentityId — revoke an active binding. */
export function revokeEnrollment(
  hubIdentityId: string,
  actor?: string
): Promise<{ ok: true; revoked: boolean; hubIdentityId: string }> {
  const query = actor ? `?actor=${encodeURIComponent(actor)}` : '';
  return apiDelete<{ ok: true; revoked: boolean; hubIdentityId: string }>(
    `/api/admin/enrollments/${encodeURIComponent(hubIdentityId)}${query}`
  );
}
