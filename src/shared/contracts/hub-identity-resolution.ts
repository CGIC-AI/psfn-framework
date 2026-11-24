// ── Hub identity resolution core contracts (psfn-framework-kbdvl.1) ──

/** Lifecycle of a single hub-identity binding. */
export type HubIdentityEnrollmentStatus = 'enrolled' | 'revoked';

/**
 * A durable binding between an opaque hub identity handle and a core contact.
 * `hubIdentityId` is the primary key: at most one binding row exists per handle.
 */
export interface HubIdentityEnrollment {
  /** Opaque handle presented by the Satellite Hub. Never enrollment proof or a biometric template. */
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

/**
 * Result of resolving a hub identity claim. Discriminated union so callers
 * (the D2b perception path) must handle the unenrolled case explicitly and
 * can never accidentally treat "unknown" as a bound contact.
 */
export type HubIdentityResolution =
  | { status: 'enrolled'; binding: HubIdentityEnrollment }
  | { status: 'unenrolled' };
