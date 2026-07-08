import { describe, it, expect, beforeEach } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { createPostgresHubIdentityEnrollmentStore } from './store.js';
import type { HubIdentityEnrollmentStorePort } from './enrollment-store-port.js';

const OPERATOR = 'contact-operator';
const PARTNER = 'contact-partner';

interface EnrollmentRow {
  hub_identity_id: string;
  contact_id: string;
  status: string;
  satellite_id: string | null;
  endpoint_id: string | null;
  enrolled_by: string;
  enrolled_at: string;
  revoked_by: string | null;
  revoked_at: string | null;
}

interface AuditRow {
  id: number;
  hub_identity_id: string;
  contact_id: string;
  action: string;
  actor: string;
  satellite_id: string | null;
  endpoint_id: string | null;
  timestamp: string;
}

function result(rows: unknown[] = []): QueryResult {
  return {
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  } as QueryResult;
}

/**
 * In-memory Postgres pool double, matching the FakePostgresPool idiom used by
 * the contacts Postgres adapter test. It honours BOTH access paths the store
 * uses: `pool.connect()` (transactional enroll/revoke + schema bootstrap) and
 * direct `pool.query()` (resolve/getBinding/list*). No embedded DB is involved.
 */
class FakePostgresPool {
  enrollments = new Map<string, EnrollmentRow>();
  audit: AuditRow[] = [];

  async connect(): Promise<PoolClient> {
    return {
      query: async (text: string, values?: readonly unknown[]) => await this.query(text, values),
      release: () => undefined,
    } as unknown as PoolClient;
  }

  private normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    const normalized = this.normalize(text);

    if (
      normalized === 'begin'
      || normalized === 'commit'
      || normalized === 'rollback'
      || normalized.startsWith('create table')
      || normalized.startsWith('create index')
      || normalized.startsWith('alter table')
    ) {
      return result();
    }

    if (normalized.startsWith("select * from hub_identity_enrollments where hub_identity_id = $1 and status = 'enrolled'")) {
      const row = this.enrollments.get(String(values[0] ?? ''));
      return result(row && row.status === 'enrolled' ? [row] : []);
    }

    if (normalized.startsWith('select * from hub_identity_enrollments where hub_identity_id = $1')) {
      const row = this.enrollments.get(String(values[0] ?? ''));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('select * from hub_identity_enrollments where contact_id = $1')) {
      const contactId = String(values[0] ?? '');
      const rows = [...this.enrollments.values()]
        .filter(row => row.contact_id === contactId)
        .sort((left, right) => right.enrolled_at.localeCompare(left.enrolled_at));
      return result(rows);
    }

    if (normalized.startsWith('select * from hub_identity_enrollments order by enrolled_at desc')) {
      const rows = [...this.enrollments.values()]
        .sort((left, right) => right.enrolled_at.localeCompare(left.enrolled_at));
      return result(rows);
    }

    if (normalized.startsWith('insert into hub_identity_enrollments (')) {
      // VALUES ($1, $2, 'enrolled', $3, $4, $5, $6, NULL, NULL) with ON CONFLICT upsert.
      const hubIdentityId = String(values[0] ?? '');
      const contactId = String(values[1] ?? '');
      const satelliteId = values[2] == null ? null : String(values[2]);
      const endpointId = values[3] == null ? null : String(values[3]);
      const enrolledBy = String(values[4] ?? 'system:unknown');
      const enrolledAt = String(values[5] ?? '');
      this.enrollments.set(hubIdentityId, {
        hub_identity_id: hubIdentityId,
        contact_id: contactId,
        status: 'enrolled',
        satellite_id: satelliteId,
        endpoint_id: endpointId,
        enrolled_by: enrolledBy,
        enrolled_at: enrolledAt,
        revoked_by: null,
        revoked_at: null,
      });
      return result();
    }

    if (normalized.startsWith("update hub_identity_enrollments set status = 'revoked'")) {
      const revokedBy = values[0] == null ? null : String(values[0]);
      const revokedAt = values[1] == null ? null : String(values[1]);
      const handle = String(values[2] ?? '');
      const row = this.enrollments.get(handle);
      if (row) {
        row.status = 'revoked';
        row.revoked_by = revokedBy;
        row.revoked_at = revokedAt;
      }
      return result();
    }

    if (normalized.startsWith('insert into hub_identity_enrollment_audit (')) {
      const action = normalized.includes("'revoke'") ? 'revoke' : 'enroll';
      this.audit.push({
        id: this.audit.length + 1,
        hub_identity_id: String(values[0] ?? ''),
        contact_id: String(values[1] ?? ''),
        action,
        actor: String(values[2] ?? ''),
        satellite_id: values[3] == null ? null : String(values[3]),
        endpoint_id: values[4] == null ? null : String(values[4]),
        timestamp: String(values[5] ?? ''),
      });
      return result();
    }

    if (normalized.includes('from hub_identity_enrollment_audit')) {
      // Dynamic filters are pushed in [hubIdentityId, contactId, action] order,
      // with the LIMIT as the final parameter (mirrors the store's SQL builder).
      let paramIndex = 0;
      const handle = normalized.includes('hub_identity_id = $') ? String(values[paramIndex++] ?? '') : undefined;
      const contactId = normalized.includes('contact_id = $') ? String(values[paramIndex++] ?? '') : undefined;
      const action = normalized.includes('action = $') ? String(values[paramIndex++] ?? '') : undefined;
      const limit = Number(values[values.length - 1] ?? 50);

      const rows = this.audit
        .filter(row => (handle === undefined || row.hub_identity_id === handle))
        .filter(row => (contactId === undefined || row.contact_id === contactId))
        .filter(row => (action === undefined || row.action === action))
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.id - left.id)
        .slice(0, limit);
      return result(rows);
    }

    throw new Error(`Unhandled SQL in FakePostgresPool: ${text}`);
  }
}

async function newStore(): Promise<HubIdentityEnrollmentStorePort> {
  const pool = new FakePostgresPool();
  return createPostgresHubIdentityEnrollmentStore('postgres://unused', {
    pool: pool as unknown as Pool,
  });
}

describe('PostgresHubIdentityEnrollmentStore', () => {
  let store: HubIdentityEnrollmentStorePort;

  beforeEach(async () => {
    store = await newStore();
  });

  it('binds a hub identity to a contact and resolves it', async () => {
    const binding = await store.enroll({
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

    const resolution = await store.resolve('hub-abc');
    expect(resolution.status).toBe('enrolled');
    if (resolution.status === 'enrolled') {
      expect(resolution.binding.canonicalContactId).toBe(PARTNER);
    }
  });

  it('resolves an unknown handle to unenrolled (never guesses)', async () => {
    expect((await store.resolve('nope')).status).toBe('unenrolled');
    expect((await store.resolve('')).status).toBe('unenrolled');
  });

  it('enroll → resolve → revoke → resolve round-trips to unenrolled', async () => {
    await store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: PARTNER, actor: 'operator' });
    expect((await store.resolve('hub-abc')).status).toBe('enrolled');

    const revoked = await store.revoke('hub-abc', 'operator');
    expect(revoked).toBe(true);
    expect((await store.resolve('hub-abc')).status).toBe('unenrolled');

    // The binding row still exists in revoked status for audit/history.
    const binding = await store.getBinding('hub-abc');
    expect(binding?.status).toBe('revoked');
    expect(binding?.revokedBy).toBe('operator');
    expect(binding?.revokedAt).toBeTruthy();
  });

  it('revoking a non-existent or already-revoked binding returns false', async () => {
    expect(await store.revoke('ghost')).toBe(false);
    await store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: PARTNER });
    expect(await store.revoke('hub-abc')).toBe(true);
    expect(await store.revoke('hub-abc')).toBe(false);
  });

  it('re-enrolls a handle after revocation (resurrects the binding)', async () => {
    await store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: PARTNER, actor: 'operator' });
    await store.revoke('hub-abc', 'operator');

    const rebound = await store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: OPERATOR, actor: 'operator' });
    expect(rebound.status).toBe('enrolled');
    expect(rebound.canonicalContactId).toBe(OPERATOR);
    expect(rebound.revokedAt).toBeNull();

    const resolution = await store.resolve('hub-abc');
    expect(resolution.status).toBe('enrolled');
    if (resolution.status === 'enrolled') {
      expect(resolution.binding.canonicalContactId).toBe(OPERATOR);
    }
  });

  it('is idempotent when re-enrolling to the same contact', async () => {
    await store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: PARTNER });
    await store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: PARTNER });
    const all = await store.listByContact(PARTNER);
    expect(all).toHaveLength(1);
  });

  it('fails closed when re-pointing an active binding to a different contact', async () => {
    await store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: PARTNER });
    await expect(
      store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: OPERATOR }),
    ).rejects.toThrow(/already enrolled to a different contact/);
    // Original binding is untouched.
    const resolution = await store.resolve('hub-abc');
    expect(resolution.status === 'enrolled' && resolution.binding.canonicalContactId).toBe(PARTNER);
  });

  it('rejects empty handle / contact id on enroll', async () => {
    await expect(store.enroll({ hubIdentityId: '  ', canonicalContactId: PARTNER })).rejects.toThrow(/hubIdentityId/);
    await expect(store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: '' })).rejects.toThrow(/canonicalContactId/);
  });

  it('records enroll and revoke in the audit trail', async () => {
    await store.enroll({ hubIdentityId: 'hub-abc', canonicalContactId: PARTNER, actor: 'operator', satelliteId: 'sat-1' });
    await store.revoke('hub-abc', 'operator');

    const audit = await store.listAudit({ hubIdentityId: 'hub-abc' });
    expect(audit.map((entry) => entry.action)).toEqual(['revoke', 'enroll']);
    expect(audit.every((entry) => entry.actor === 'operator')).toBe(true);
    expect(audit.find((entry) => entry.action === 'enroll')?.satelliteId).toBe('sat-1');
  });

  it('lists all bindings and bindings by contact', async () => {
    await store.enroll({ hubIdentityId: 'hub-1', canonicalContactId: PARTNER });
    await store.enroll({ hubIdentityId: 'hub-2', canonicalContactId: PARTNER });
    await store.enroll({ hubIdentityId: 'hub-3', canonicalContactId: OPERATOR });
    expect(await store.listAll()).toHaveLength(3);
    expect(await store.listByContact(PARTNER)).toHaveLength(2);
    expect(await store.listByContact(OPERATOR)).toHaveLength(1);
  });
});
