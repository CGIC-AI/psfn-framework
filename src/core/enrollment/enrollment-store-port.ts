import type {
  HubIdentityEnrollment,
  HubIdentityEnrollmentAuditEntry,
  HubIdentityEnrollmentAuditQuery,
  HubIdentityEnrollmentInput,
  HubIdentityResolution,
} from './types.js';

type Awaitable<T> = T | Promise<T>;

/**
 * Persistence port for hub-identity ↔ contact bindings. Deliberately narrow:
 * enroll, revoke, resolve, and read. Contact-existence validation and
 * fail-closed policy live one layer up in {@link HubIdentityEnrollmentService};
 * this port only owns durable storage + the enrollment audit trail.
 */
export interface HubIdentityEnrollmentStorePort {
  /**
   * Bind (or re-bind after revocation) a hub identity handle to a contact.
   * Idempotent for an already-enrolled binding to the same contact. Throws if
   * an active (`enrolled`) binding already points at a DIFFERENT contact — the
   * caller must revoke first (fail closed, no silent re-point).
   */
  enroll(input: HubIdentityEnrollmentInput): Awaitable<HubIdentityEnrollment>;
  /** Revoke an active binding. Returns false if there was nothing to revoke. */
  revoke(hubIdentityId: string, actor?: string): Awaitable<boolean>;
  /**
   * Resolve a hub identity claim to its bound contact, or an explicit
   * `unenrolled` result. Only `enrolled` bindings resolve; revoked or unknown
   * handles resolve to `unenrolled`.
   */
  resolve(hubIdentityId: string): Awaitable<HubIdentityResolution>;
  /** The binding row for a handle in any status (including revoked), if present. */
  getBinding(hubIdentityId: string): Awaitable<HubIdentityEnrollment | undefined>;
  /** All bindings (any status) for a contact. */
  listByContact(contactId: string): Awaitable<HubIdentityEnrollment[]>;
  /** All bindings (any status). */
  listAll(): Awaitable<HubIdentityEnrollment[]>;
  /** Bounded, newest-first read over the enrollment/revocation audit trail. */
  listAudit(query?: HubIdentityEnrollmentAuditQuery): Awaitable<HubIdentityEnrollmentAuditEntry[]>;
}
