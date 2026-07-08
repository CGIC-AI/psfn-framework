import type { Contact } from '../contacts/types.js';
import type { ContactStorePort } from '../contacts/contact-store-port.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { HubIdentityEnrollmentStorePort } from './enrollment-store-port.js';
import type {
  HubIdentityEnrollment,
  HubIdentityEnrollmentAuditEntry,
  HubIdentityEnrollmentAuditQuery,
  HubIdentityEnrollmentInput,
  HubIdentityResolution,
} from './types.js';

const logger = createComponentLogger('hub-identity-enrollment');

/**
 * Result of resolving a hub identity claim all the way to a live contact. The
 * D2b perception path uses this to fail closed: an unenrolled handle — or a
 * handle whose bound contact has since been deleted — surfaces as
 * `unenrolled`, never a guessed identity.
 */
export type HubIdentityContactResolution =
  | { status: 'enrolled'; binding: HubIdentityEnrollment; contact: Contact }
  | { status: 'unenrolled' };

/**
 * Owner-facing enrollment operations (Sprint 10 D2a). This is the seam the
 * Garden enrollment surface (bead .17 / Workstream F1) and the presence
 * resolution path (bead .13 / Workstream D2b) consume. It layers fail-closed
 * policy over the raw {@link HubIdentityEnrollmentStorePort}:
 *
 *  - enrollment binds an opaque `hubIdentityId` to an EXISTING contact only —
 *    a claim never auto-creates a contact;
 *  - no biometric template/embedding is accepted or stored (the input surface
 *    has no field for one);
 *  - unenrolled or dangling handles resolve to `unenrolled`, never a guess.
 */
export class HubIdentityEnrollmentService {
  constructor(
    private readonly store: HubIdentityEnrollmentStorePort,
    private readonly contactStore: ContactStorePort,
  ) {}

  /**
   * Bind (or re-bind after revocation) a hub identity handle to an existing
   * contact. Throws if the contact does not exist — core never fabricates a
   * contact from an identity claim.
   */
  async enroll(input: HubIdentityEnrollmentInput): Promise<HubIdentityEnrollment> {
    const contactId = input.canonicalContactId.trim();
    if (!contactId) {
      throw new Error('canonicalContactId is required to enroll a hub identity');
    }
    const contact = await this.contactStore.getById(contactId);
    if (!contact) {
      throw new Error(
        `cannot enroll hub identity: contact ${contactId} does not exist (claims never auto-create contacts)`,
      );
    }
    const binding = await this.store.enroll({ ...input, canonicalContactId: contactId });
    logger.info('hub identity enrolled', {
      hubIdentityId: binding.hubIdentityId,
      contactId: binding.canonicalContactId,
      actor: binding.enrolledBy,
      satelliteId: binding.satelliteId ?? undefined,
      endpointId: binding.endpointId ?? undefined,
    });
    return binding;
  }

  /** Revoke an active binding. Returns false if there was nothing to revoke. */
  async revoke(hubIdentityId: string, actor?: string): Promise<boolean> {
    const revoked = await this.store.revoke(hubIdentityId, actor);
    if (revoked) {
      logger.info('hub identity revoked', { hubIdentityId: hubIdentityId.trim(), actor: actor?.trim() });
    }
    return revoked;
  }

  /** Resolve a claim to its binding, or an explicit `unenrolled` result. */
  async resolve(hubIdentityId: string): Promise<HubIdentityResolution> {
    return this.store.resolve(hubIdentityId);
  }

  /**
   * Resolve a claim all the way to a live contact, fail-closed. A revoked or
   * unknown handle, or a binding whose contact has been deleted, yields
   * `unenrolled`.
   */
  async resolveContact(hubIdentityId: string): Promise<HubIdentityContactResolution> {
    const resolution = await this.store.resolve(hubIdentityId);
    if (resolution.status !== 'enrolled') {
      return { status: 'unenrolled' };
    }
    const contact = await this.contactStore.getById(resolution.binding.canonicalContactId);
    if (!contact) {
      // Binding points at a contact that no longer exists — fail closed.
      logger.warn('hub identity binding references a missing contact; resolving as unenrolled', {
        hubIdentityId: resolution.binding.hubIdentityId,
        contactId: resolution.binding.canonicalContactId,
      });
      return { status: 'unenrolled' };
    }
    return { status: 'enrolled', binding: resolution.binding, contact };
  }

  async getBinding(hubIdentityId: string): Promise<HubIdentityEnrollment | undefined> {
    return this.store.getBinding(hubIdentityId);
  }

  async listByContact(contactId: string): Promise<HubIdentityEnrollment[]> {
    return this.store.listByContact(contactId);
  }

  async listAll(): Promise<HubIdentityEnrollment[]> {
    return this.store.listAll();
  }

  async listAudit(query?: HubIdentityEnrollmentAuditQuery): Promise<HubIdentityEnrollmentAuditEntry[]> {
    return this.store.listAudit(query);
  }
}
