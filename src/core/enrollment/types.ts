/**
 * Hub identity ↔ contact enrollment (Sprint 10, Workstream D2a — Decision 4).
 *
 * Face-recognition compute and biometric templates live ENTIRELY at the
 * endpoint + Satellite Hub (a separate repo) and NEVER enter core. Core owns
 * only an owner-controlled, durable binding between an OPAQUE identity handle
 * presented by the Hub (`hubIdentityId`) and a core contact
 * (`canonicalContactId`). A hub identity is meaningless to core until the owner
 * explicitly enrolls it; an unenrolled handle always resolves to "unknown".
 * A handle may be source-issued (for example, an Eidoverse participant id);
 * presenting that handle is never itself proof of enrollment or trust.
 *
 * There is deliberately NO field here for a biometric template, embedding, or
 * raw sensor payload — core has no place to store one.
 */

export type {
  HubIdentityEnrollment,
  HubIdentityEnrollmentStatus,
  HubIdentityResolution,
} from '../../shared/contracts/hub-identity-resolution.js';

/** Input to enroll (bind) a hub identity handle to an existing contact. */
export interface HubIdentityEnrollmentInput {
  hubIdentityId: string;
  canonicalContactId: string;
  satelliteId?: string;
  endpointId?: string;
  actor?: string;
}

export const ENROLLMENT_AUDIT_ACTIONS = ['enroll', 'revoke'] as const;
export type HubIdentityEnrollmentAuditAction = typeof ENROLLMENT_AUDIT_ACTIONS[number];

export interface HubIdentityEnrollmentAuditEntry {
  id: number;
  hubIdentityId: string;
  contactId: string;
  action: HubIdentityEnrollmentAuditAction;
  actor: string;
  satelliteId: string | null;
  endpointId: string | null;
  timestamp: string;
}

export interface HubIdentityEnrollmentAuditQuery {
  hubIdentityId?: string;
  contactId?: string;
  action?: HubIdentityEnrollmentAuditAction;
  limit?: number;
}
