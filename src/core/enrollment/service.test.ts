import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSQLiteContactStore } from '../contacts/sqlite-adapter.js';
import type { ContactStorePort } from '../contacts/contact-store-port.js';
import { createSQLiteHubIdentityEnrollmentStore } from './store.js';
import { HubIdentityEnrollmentService } from './service.js';

describe('HubIdentityEnrollmentService', () => {
  let db: Database.Database;
  let contactStore: ContactStorePort;
  let service: HubIdentityEnrollmentService;
  let partnerId: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    contactStore = createSQLiteContactStore(db);
    const partner = await contactStore.upsert({ displayName: 'partner' });
    partnerId = partner.id;
    service = new HubIdentityEnrollmentService(createSQLiteHubIdentityEnrollmentStore(db), contactStore);
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
