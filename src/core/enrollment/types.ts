/**
 * Hub identity ↔ contact enrollment (Sprint 10, Workstream D2a — Decision 4).
 *
 * Face-recognition compute and biometric templates live ENTIRELY at the
 * endpoint + Satellite Hub (a separate repo) and NEVER enter core. Core owns
 * only an owner-controlled, durable binding between an OPAQUE hub-side identity
 * handle (`hubIdentityId`, minted by the Hub) and a core contact
 * (`canonicalContactId`). A hub identity is meaningless to core until the owner
 * explicitly enrolls it; an unenrolled handle always resolves to "unknown".
 *
 * There is deliberately NO field here for a biometric template, embedding, or
 * raw sensor payload — core has no place to store one.
 */

/** Lifecycle of a single hub-identity binding. */
export type HubIdentityEnrollmentStatus = 'enrolled' | 'revoked';

/**
 * A durable binding between an opaque hub identity handle and a core contact.
 * `hubIdentityId` is the primary key: at most one binding row exists per handle.
 */
export interface HubIdentityEnrollment {
  /** Opaque handle minted by the Satellite Hub. Never a biometric template. */
  hubIdentityId: string;
  /** The core contact this handle is bound to (`contacts.id`). */
  canonicalContactId: string;
  status: HubIdentityEnrollmentStatus;
  /** ISO timestamp the binding was (most recently) enrolled. */
  enrolledAt: string;
  /** Actor that performed the enrollment (owner-facing audit trail). */
  enrolledBy: string;
  /** ISO timestamp of the most recent revocation, if currently revoked. */
  revokedAt: string | null;
  revokedBy: string | null;
  /** Satellite that enrolled this handle, if the enrollment named one. */
  satelliteId: string | null;
  /** Endpoint device that enrolled this handle, if the enrollment named one. */
  endpointId: string | null;
}

/** Input to enroll (bind) a hub identity handle to an existing contact. */
export interface HubIdentityEnrollmentInput {
  hubIdentityId: string;
  canonicalContactId: string;
  satelliteId?: string;
  endpointId?: string;
  actor?: string;
}

/**
 * Result of resolving a hub identity claim. Discriminated union so callers
 * (the D2b perception path) must handle the unenrolled case explicitly and
 * can never accidentally treat "unknown" as a bound contact.
 */
export type HubIdentityResolution =
  | { status: 'enrolled'; binding: HubIdentityEnrollment }
  | { status: 'unenrolled' };

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
