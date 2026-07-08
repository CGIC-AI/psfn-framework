import { describe, it, expect, beforeEach } from 'vitest';
import type { Contact } from '../contacts/types.js';
import type { ContactStorePort } from '../contacts/contact-store-port.js';
import type { HubIdentityEnrollmentStorePort } from './enrollment-store-port.js';
import type {
  HubIdentityEnrollment,
  HubIdentityEnrollmentAuditEntry,
  HubIdentityEnrollmentAuditQuery,
  HubIdentityEnrollmentInput,
  HubIdentityResolution,
} from './types.js';
import { HubIdentityEnrollmentService } from './service.js';

/**
 * Port-level fakes only — the service layer is storage-agnostic, so these
 * tests exercise its fail-closed policy without any concrete (Postgres) store.
 */
class InMemoryEnrollmentStore implements HubIdentityEnrollmentStorePort {
  private bindings = new Map<string, HubIdentityEnrollment>();
  private audit: HubIdentityEnrollmentAuditEntry[] = [];

  async enroll(input: HubIdentityEnrollmentInput): Promise<HubIdentityEnrollment> {
    const hubIdentityId = input.hubIdentityId.trim();
    const contactId = input.canonicalContactId.trim();
    const existing = this.bindings.get(hubIdentityId);
    if (existing && existing.status === 'enrolled' && existing.canonicalContactId !== contactId) {
      throw new Error(
        `hub identity ${hubIdentityId} is already enrolled to a different contact; revoke it before re-binding`,
      );
    }
    const now = new Date().toISOString();
    const actor = input.actor?.trim() || 'system:unknown';
    const binding: HubIdentityEnrollment = {
      hubIdentityId,
      canonicalContactId: contactId,
      status: 'enrolled',
      enrolledAt: now,
      enrolledBy: actor,
      revokedAt: null,
      revokedBy: null,
      satelliteId: input.satelliteId?.trim() || null,
      endpointId: input.endpointId?.trim() || null,
    };
    this.bindings.set(hubIdentityId, binding);
    this.audit.push({
      id: this.audit.length + 1,
      hubIdentityId,
      contactId,
      action: 'enroll',
      actor,
      satelliteId: binding.satelliteId,
      endpointId: binding.endpointId,
      timestamp: now,
    });
    return binding;
  }

  async revoke(hubIdentityId: string, actor?: string): Promise<boolean> {
    const handle = hubIdentityId.trim();
    const existing = this.bindings.get(handle);
    if (!existing || existing.status !== 'enrolled') return false;
    const now = new Date().toISOString();
    const normalizedActor = actor?.trim() || 'system:unknown';
    existing.status = 'revoked';
    existing.revokedAt = now;
    existing.revokedBy = normalizedActor;
    this.audit.push({
      id: this.audit.length + 1,
      hubIdentityId: handle,
      contactId: existing.canonicalContactId,
      action: 'revoke',
      actor: normalizedActor,
      satelliteId: existing.satelliteId,
      endpointId: existing.endpointId,
      timestamp: now,
    });
    return true;
  }

  async resolve(hubIdentityId: string): Promise<HubIdentityResolution> {
    const binding = this.bindings.get(hubIdentityId.trim());
    if (!binding || binding.status !== 'enrolled') return { status: 'unenrolled' };
    return { status: 'enrolled', binding };
  }

  async getBinding(hubIdentityId: string): Promise<HubIdentityEnrollment | undefined> {
    return this.bindings.get(hubIdentityId.trim());
  }

  async listByContact(contactId: string): Promise<HubIdentityEnrollment[]> {
    return [...this.bindings.values()].filter(binding => binding.canonicalContactId === contactId.trim());
  }

  async listAll(): Promise<HubIdentityEnrollment[]> {
    return [...this.bindings.values()];
  }

  async listAudit(query: HubIdentityEnrollmentAuditQuery = {}): Promise<HubIdentityEnrollmentAuditEntry[]> {
    return this.audit
      .filter(entry => (query.hubIdentityId ? entry.hubIdentityId === query.hubIdentityId : true))
      .filter(entry => (query.contactId ? entry.contactId === query.contactId : true))
      .filter(entry => (query.action ? entry.action === query.action : true))
      .sort((left, right) => right.id - left.id);
  }
}

class InMemoryContactStore {
  private contacts = new Map<string, Contact>();
  private nextId = 1;

  async upsert(input: { displayName: string }): Promise<Contact> {
    const id = `contact-${this.nextId++}`;
    const now = new Date().toISOString();
    const contact: Contact = {
      id,
      displayName: input.displayName,
      trustLevel: 'regular',
      relationshipType: 'stranger',
      firstSeen: now,
      lastSeen: now,
    };
    this.contacts.set(id, contact);
    return contact;
  }

  async getById(id: string): Promise<Contact | undefined> {
    return this.contacts.get(id);
  }

  async deleteContact(id: string): Promise<boolean> {
    return this.contacts.delete(id);
  }
}

describe('HubIdentityEnrollmentService', () => {
  let contactStore: InMemoryContactStore;
  let service: HubIdentityEnrollmentService;
  let partnerId: string;

  beforeEach(async () => {
    contactStore = new InMemoryContactStore();
    const partner = await contactStore.upsert({ displayName: 'partner' });
    partnerId = partner.id;
    service = new HubIdentityEnrollmentService(
      new InMemoryEnrollmentStore(),
      contactStore as unknown as ContactStorePort,
    );
  });

  it('enrolls a hub identity to an existing contact and resolves to that contact', async () => {
    const binding = await service.enroll({
      hubIdentityId: 'hub-xyz',
      canonicalContactId: partnerId,
      actor: 'operator',
    });
    expect(binding.status).toBe('enrolled');

    const resolution = await service.resolveContact('hub-xyz');
    expect(resolution.status).toBe('enrolled');
    if (resolution.status === 'enrolled') {
      expect(resolution.contact.id).toBe(partnerId);
      expect(resolution.contact.displayName).toBe('partner');
    }
  });

  it('never auto-creates a contact from a claim (fails closed on unknown contact)', async () => {
    await expect(
      service.enroll({ hubIdentityId: 'hub-xyz', canonicalContactId: 'contact-does-not-exist' }),
    ).rejects.toThrow(/does not exist/);
    // No binding was created.
    expect(await service.getBinding('hub-xyz')).toBeUndefined();
  });

  it('resolves an unenrolled handle to unenrolled', async () => {
    expect((await service.resolve('unknown')).status).toBe('unenrolled');
    expect((await service.resolveContact('unknown')).status).toBe('unenrolled');
  });

  it('revoked bindings resolve to unenrolled; re-enrollment restores resolution', async () => {
    await service.enroll({ hubIdentityId: 'hub-xyz', canonicalContactId: partnerId, actor: 'operator' });
    expect(await service.revoke('hub-xyz', 'operator')).toBe(true);
    expect((await service.resolveContact('hub-xyz')).status).toBe('unenrolled');

    await service.enroll({ hubIdentityId: 'hub-xyz', canonicalContactId: partnerId, actor: 'operator' });
    expect((await service.resolveContact('hub-xyz')).status).toBe('enrolled');
  });

  it('fails closed when the bound contact has been deleted (dangling binding)', async () => {
    await service.enroll({ hubIdentityId: 'hub-xyz', canonicalContactId: partnerId, actor: 'operator' });
    await contactStore.deleteContact(partnerId);

    const resolution = await service.resolveContact('hub-xyz');
    expect(resolution.status).toBe('unenrolled');
  });

  it('surfaces enroll and revoke in the audit trail', async () => {
    await service.enroll({ hubIdentityId: 'hub-xyz', canonicalContactId: partnerId, actor: 'operator' });
    await service.revoke('hub-xyz', 'operator');
    const audit = await service.listAudit({ hubIdentityId: 'hub-xyz' });
    expect(audit.map((entry) => entry.action)).toEqual(['revoke', 'enroll']);
  });
});
