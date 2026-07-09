// ── Garden hub-identity enrollment service (S10 Workstream F1 / Decision 4) ──
// Operator-facing surface over the hub-identity ↔ contact enrollment binding
// (`HubIdentityEnrollmentService`). This is the human-in-the-loop seam: the
// owner binds an OPAQUE hub identity handle to an EXISTING contact, revokes a
// binding, and reads the current bindings.
//
// Biometric templates and face-recognition compute live ENTIRELY at the
// Satellite Hub and never enter core, so nothing here can leak one — the
// underlying binding type has no biometric field. The view is deliberately just
// the opaque handle + the contact link + audit metadata (who/when).
//
// Fail-closed policy (contact must already exist; no auto-create; no silent
// re-point of an active binding) is enforced one layer down in
// `HubIdentityEnrollmentService` / the store port; this wrapper only shapes the
// admin view and surfaces those errors to the caller.

import type { HubIdentityEnrollmentService } from '../../../core/enrollment/service.js';
import type {
  HubIdentityEnrollment,
  HubIdentityEnrollmentStatus,
} from '../../../core/enrollment/types.js';

/** Admin-safe view of a binding: opaque handle + contact link + audit only. */
export interface AdminEnrollmentBindingView {
  hubIdentityId: string;
  canonicalContactId: string;
  status: HubIdentityEnrollmentStatus;
  enrolledAt: string;
  enrolledBy: string;
  revokedAt: string | null;
  revokedBy: string | null;
  satelliteId: string | null;
  endpointId: string | null;
}

export interface AdminEnrollmentListData {
  enrollments: AdminEnrollmentBindingView[];
  total: number;
}

export interface AdminEnrollmentInput {
  hubIdentityId: string;
  canonicalContactId: string;
  satelliteId?: string;
  endpointId?: string;
  actor?: string;
}

export interface AdminEnrollmentRevokeResult {
  revoked: boolean;
  hubIdentityId: string;
}

export interface AdminEnrollmentService {
  listEnrollments(): Promise<AdminEnrollmentListData>;
  enroll(input: AdminEnrollmentInput): Promise<AdminEnrollmentBindingView>;
  revoke(hubIdentityId: string, actor?: string): Promise<AdminEnrollmentRevokeResult>;
}

function toBindingView(binding: HubIdentityEnrollment): AdminEnrollmentBindingView {
  return {
    hubIdentityId: binding.hubIdentityId,
    canonicalContactId: binding.canonicalContactId,
    status: binding.status,
    enrolledAt: binding.enrolledAt,
    enrolledBy: binding.enrolledBy,
    revokedAt: binding.revokedAt,
    revokedBy: binding.revokedBy,
    satelliteId: binding.satelliteId,
    endpointId: binding.endpointId,
  };
}

export function createAdminEnrollmentService(options: {
  enrollmentService: HubIdentityEnrollmentService;
}): AdminEnrollmentService {
  const { enrollmentService } = options;

  return {
    async listEnrollments(): Promise<AdminEnrollmentListData> {
      const bindings = await enrollmentService.listAll();
      const enrollments = bindings.map(toBindingView);
      return { enrollments, total: enrollments.length };
    },

    async enroll(input: AdminEnrollmentInput): Promise<AdminEnrollmentBindingView> {
      const hubIdentityId = input.hubIdentityId.trim();
      if (!hubIdentityId) {
        throw new Error('hubIdentityId is required to enroll a hub identity');
      }
      const canonicalContactId = input.canonicalContactId.trim();
      if (!canonicalContactId) {
        throw new Error('canonicalContactId is required to enroll a hub identity');
      }
      const satelliteId = input.satelliteId?.trim();
      const endpointId = input.endpointId?.trim();
      const actor = input.actor?.trim();
      // Delegates to core, which fails closed when the contact does not exist —
      // an enrollment NEVER auto-creates a contact.
      const binding = await enrollmentService.enroll({
        hubIdentityId,
        canonicalContactId,
        ...(satelliteId ? { satelliteId } : {}),
        ...(endpointId ? { endpointId } : {}),
        ...(actor ? { actor } : {}),
      });
      return toBindingView(binding);
    },

    async revoke(hubIdentityId: string, actor?: string): Promise<AdminEnrollmentRevokeResult> {
      const handle = hubIdentityId.trim();
      if (!handle) {
        throw new Error('hubIdentityId is required to revoke a hub identity');
      }
      const trimmedActor = actor?.trim();
      const revoked = await enrollmentService.revoke(handle, trimmedActor || undefined);
      return { revoked, hubIdentityId: handle };
    },
  };
}
