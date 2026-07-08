import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { HubIdentityEnrollmentStore } from './store.js';
import { initializeHubIdentityEnrollmentSchema } from './schema.js';

const OPERATOR = 'contact-operator';
const PARTNER = 'contact-partner';

function seedContacts(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO contacts (id, display_name) VALUES (?, ?)').run(OPERATOR, 'operator');
  db.prepare('INSERT INTO contacts (id, display_name) VALUES (?, ?)').run(PARTNER, 'partner');
}

describe('HubIdentityEnrollmentStore', () => {
  let db: Database.Database;
  let store: HubIdentityEnrollmentStore;

  beforeEach(() => {
    db = new Database(':memory:');
    seedContacts(db);
    store = new HubIdentityEnrollmentStore(db);
  });

  it('binds a hub identity to a contact and resolves it', () => {
    const binding = store.enroll({
      hubIdentityId: 'hub-abc',
      canonicalContactId: PARTNER,
      satelliteId: 'sat-living-room',
      endpointId: 'endpoint-1',
      actor: 'operator',
    });
    expect(binding.status).toBe('enrolled');
    expect(binding.canonicalContactId).toBe(PARTNER);
    expect(binding.satelliteId).toBe('sat-living-room');
    expect(binding.endpointId).toBe('endpoint-1');

    const resolution = store.resolve('hub-abc');
    expect(resolution.status).toBe('enrolled');
    if (resolution.status === 'enrolled') {
      expect(resolution.binding.canonicalContactId).toBe(PARTNER);
    }
  });

  it('resolves an unknown handle to unenrolled (never guesses)', () => {
    expect(store.resolve('nope').status).toBe('unenrolled');
    expect(store.resolve('').status).toBe('unenrolled');
  });

  it('enroll → resolve → revoke → resolve round-trips to unenrolled', () => {
    store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: PARTNER, actor: 'operator' });
    expect(store.resolve('hub-abc').status).toBe('enrolled');

    const revoked = store.revoke('hub-abc', 'operator');
    expect(revoked).toBe(true);
    expect(store.resolve('hub-abc').status).toBe('unenrolled');

    // The binding row still exists in revoked status for audit/history.
    const binding = store.getBinding('hub-abc');
    expect(binding?.status).toBe('revoked');
    expect(binding?.revokedBy).toBe('operator');
    expect(binding?.revokedAt).toBeTruthy();
  });

  it('revoking a non-existent or already-revoked binding returns false', () => {
    expect(store.revoke('ghost')).toBe(false);
    store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: PARTNER });
    expect(store.revoke('hub-abc')).toBe(true);
    expect(store.revoke('hub-abc')).toBe(false);
  });

  it('re-enrolls a handle after revocation (resurrects the binding)', () => {
    store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: PARTNER, actor: 'operator' });
    store.revoke('hub-abc', 'operator');

    const rebound = store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: OPERATOR, actor: 'operator' });
    expect(rebound.status).toBe('enrolled');
    expect(rebound.canonicalContactId).toBe(OPERATOR);
    expect(rebound.revokedAt).toBeNull();

    const resolution = store.resolve('hub-abc');
    expect(resolution.status).toBe('enrolled');
    if (resolution.status === 'enrolled') {
      expect(resolution.binding.canonicalContactId).toBe(OPERATOR);
    }
  });

  it('is idempotent when re-enrolling to the same contact', () => {
    store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: PARTNER });
    store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: PARTNER });
    const all = store.listByContact(PARTNER);
    expect(all).toHaveLength(1);
  });

  it('fails closed when re-pointing an active binding to a different contact', () => {
    store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: PARTNER });
    expect(() => store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: OPERATOR })).toThrow(
      /already enrolled to a different contact/,
    );
    // Original binding is untouched.
    const resolution = store.resolve('hub-abc');
    expect(resolution.status === 'enrolled' && resolution.binding.canonicalContactId).toBe(PARTNER);
  });

  it('rejects empty handle / contact id on enroll', () => {
    expect(() => store.enroll({ hubIdentityId: '  ', canonicalContactId: PARTNER })).toThrow(/hubIdentityId/);
    expect(() => store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: '' })).toThrow(/canonicalContactId/);
  });

  it('records enroll and revoke in the audit trail', () => {
    store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: PARTNER, actor: 'operator', satelliteId: 'sat-1' });
    store.revoke('hub-abc', 'operator');

    const audit = store.listAudit({ hubIdentityId: 'hub-abc' });
    expect(audit.map((entry) => entry.action)).toEqual(['revoke', 'enroll']);
    expect(audit.every((entry) => entry.actor === 'operator')).toBe(true);
    expect(audit.find((entry) => entry.action === 'enroll')?.satelliteId).toBe('sat-1');
  });

  it('lists all bindings and bindings by contact', () => {
    store.enroll({ hubIdentityId: 'hub-1', canonicalContactId: PARTNER });
    store.enroll({ hubIdentityId: 'hub-2', canonicalContactId: PARTNER });
    store.enroll({ hubIdentityId: 'hub-3', canonicalContactId: OPERATOR });
    expect(store.listAll()).toHaveLength(3);
    expect(store.listByContact(PARTNER)).toHaveLength(2);
    expect(store.listByContact(OPERATOR)).toHaveLength(1);
  });

  it('migration is idempotent and upgrades a legacy table missing satellite/endpoint columns', () => {
    const legacyDb = new Database(':memory:');
    legacyDb.exec(`
      CREATE TABLE hub_identity_enrollments (
        hub_identity_id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'enrolled',
        enrolled_by TEXT NOT NULL DEFAULT 'system:unknown',
        enrolled_at TEXT NOT NULL,
        revoked_by TEXT,
        revoked_at TEXT
      );
    `);
    expect(() => initializeHubIdentityEnrollmentSchema(legacyDb)).not.toThrow();
    // Second run must also be a no-op.
    expect(() => initializeHubIdentityEnrollmentSchema(legacyDb)).not.toThrow();

    const columns = legacyDb.prepare('PRAGMA table_info(hub_identity_enrollments)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    expect(names).toContain('satellite_id');
    expect(names).toContain('endpoint_id');
  });
});
