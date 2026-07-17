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
import type { GardenRequestContext } from '../garden-request-context.js';

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
}

export interface AdminEnrollmentRevokeResult {
  revoked: boolean;
  hubIdentityId: string;
}

export interface AdminEnrollmentService {
  listEnrollments(context?: GardenRequestContext): Promise<AdminEnrollmentListData>;
  enroll(input: AdminEnrollmentInput): Promise<AdminEnrollmentBindingView>;
  enroll(context: GardenRequestContext | undefined, input: AdminEnrollmentInput): Promise<AdminEnrollmentBindingView>;
  revoke(hubIdentityId: string): Promise<AdminEnrollmentRevokeResult>;
  revoke(context: GardenRequestContext | undefined, hubIdentityId: string): Promise<AdminEnrollmentRevokeResult>;
}

function actorFromRequest(context: GardenRequestContext | undefined): string {
  return context?.kind === 'fleet_principal'
    ? `fleet-principal:${context.actor.principalId}`
    : 'legacy-token:operator';
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
    async listEnrollments(_context?: GardenRequestContext): Promise<AdminEnrollmentListData> {
      const bindings = await enrollmentService.listAll();
      const enrollments = bindings
        .filter(binding => (
          _context?.kind !== 'fleet_principal'
          || binding.canonicalContactId === _context.actor.contactId
        ))
        .map(toBindingView);
      return { enrollments, total: enrollments.length };
    },

    async enroll(
      contextOrInput: GardenRequestContext | AdminEnrollmentInput | undefined,
      maybeInput?: AdminEnrollmentInput,
    ): Promise<AdminEnrollmentBindingView> {
      const context = maybeInput ? contextOrInput as GardenRequestContext | undefined : undefined;
      const input = maybeInput ?? contextOrInput as AdminEnrollmentInput;
      const hubIdentityId = input.hubIdentityId.trim();
      if (!hubIdentityId) {
        throw new Error('hubIdentityId is required to enroll a hub identity');
      }
      const canonicalContactId = input.canonicalContactId.trim();
      if (!canonicalContactId) {
        throw new Error('canonicalContactId is required to enroll a hub identity');
      }
      if (context?.kind === 'fleet_principal'
        && canonicalContactId !== context.actor.contactId) {
        throw new Error('Enrollment contact must be the current trusted subject');
      }
      const satelliteId = input.satelliteId?.trim();
      const endpointId = input.endpointId?.trim();
      // Delegates to core, which fails closed when the contact does not exist —
      // an enrollment NEVER auto-creates a contact.
      const binding = await enrollmentService.enroll({
        hubIdentityId,
        canonicalContactId,
        ...(satelliteId ? { satelliteId } : {}),
        ...(endpointId ? { endpointId } : {}),
        actor: actorFromRequest(context),
      });
      return toBindingView(binding);
    },

    async revoke(
      contextOrHubIdentityId: GardenRequestContext | string | undefined,
      maybeHubIdentityId?: string,
    ): Promise<AdminEnrollmentRevokeResult> {
      const legacyCall = typeof contextOrHubIdentityId === 'string';
      const context = legacyCall ? undefined : contextOrHubIdentityId;
      const hubIdentityId = legacyCall ? contextOrHubIdentityId : maybeHubIdentityId ?? '';
      const handle = hubIdentityId.trim();
      if (!handle) {
        throw new Error('hubIdentityId is required to revoke a hub identity');
      }
      if (context?.kind === 'fleet_principal') {
        const binding = (await enrollmentService.listAll())
          .find(candidate => candidate.hubIdentityId === handle);
        if (!binding || binding.canonicalContactId !== context.actor.contactId) {
          return { revoked: false, hubIdentityId: handle };
        }
      }
      const revoked = await enrollmentService.revoke(handle, actorFromRequest(context));
      return { revoked, hubIdentityId: handle };
    },
  };
}
