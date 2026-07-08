import type Database from 'better-sqlite3';
import type { HubIdentityEnrollmentStorePort } from './enrollment-store-port.js';
import { initializeHubIdentityEnrollmentSchema } from './schema.js';
import type {
  HubIdentityEnrollment,
  HubIdentityEnrollmentAuditAction,
  HubIdentityEnrollmentAuditEntry,
  HubIdentityEnrollmentAuditQuery,
  HubIdentityEnrollmentInput,
  HubIdentityResolution,
} from './types.js';

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

function normalizeActor(actor: string | undefined): string {
  const trimmed = actor?.trim();
  if (!trimmed) return 'system:unknown';
  return trimmed.slice(0, 120);
}

function requireHandle(hubIdentityId: string): string {
  const trimmed = hubIdentityId.trim();
  if (!trimmed) {
    throw new Error('hubIdentityId is required and must be a non-empty opaque handle');
  }
  return trimmed;
}

function requireContactId(contactId: string): string {
  const trimmed = contactId.trim();
  if (!trimmed) {
    throw new Error('canonicalContactId is required');
  }
  return trimmed;
}

function toEnrollment(row: EnrollmentRow): HubIdentityEnrollment {
  return {
    hubIdentityId: row.hub_identity_id,
    canonicalContactId: row.contact_id,
    status: row.status === 'revoked' ? 'revoked' : 'enrolled',
    enrolledAt: row.enrolled_at,
    enrolledBy: row.enrolled_by,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    satelliteId: row.satellite_id,
    endpointId: row.endpoint_id,
  };
}

function toAuditEntry(row: AuditRow): HubIdentityEnrollmentAuditEntry {
  return {
    id: row.id,
    hubIdentityId: row.hub_identity_id,
    contactId: row.contact_id,
    action: row.action === 'revoke' ? 'revoke' : 'enroll',
    actor: row.actor,
    satelliteId: row.satellite_id,
    endpointId: row.endpoint_id,
    timestamp: row.timestamp,
  };
}

/**
 * Synchronous SQLite implementation. The async {@link HubIdentityEnrollmentStorePort}
 * wrapper is produced by {@link createSQLiteHubIdentityEnrollmentStore}.
 */
export class HubIdentityEnrollmentStore {
  constructor(private readonly db: Database.Database) {
    initializeHubIdentityEnrollmentSchema(db);
  }

  private appendAudit(
    hubIdentityId: string,
    contactId: string,
    action: HubIdentityEnrollmentAuditAction,
    actor: string,
    satelliteId: string | null,
    endpointId: string | null,
  ): void {
    this.db.prepare(`
      INSERT INTO hub_identity_enrollment_audit (
        hub_identity_id, contact_id, action, actor, satellite_id, endpoint_id, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(hubIdentityId, contactId, action, actor, satelliteId, endpointId, new Date().toISOString());
  }

  enroll(input: HubIdentityEnrollmentInput): HubIdentityEnrollment {
    const hubIdentityId = requireHandle(input.hubIdentityId);
    const contactId = requireContactId(input.canonicalContactId);
    const actor = normalizeActor(input.actor);
    const satelliteId = input.satelliteId?.trim() || null;
    const endpointId = input.endpointId?.trim() || null;

    return this.db.transaction((): HubIdentityEnrollment => {
      const existing = this.db.prepare(
        'SELECT * FROM hub_identity_enrollments WHERE hub_identity_id = ?',
      ).get(hubIdentityId) as EnrollmentRow | undefined;

      // Fail closed: an active binding may never be silently re-pointed at a
      // different contact. The owner must revoke first.
      if (existing && existing.status === 'enrolled' && existing.contact_id !== contactId) {
        throw new Error(
          `hub identity ${hubIdentityId} is already enrolled to a different contact; revoke it before re-binding`,
        );
      }

      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO hub_identity_enrollments (
          hub_identity_id, contact_id, status, satellite_id, endpoint_id,
          enrolled_by, enrolled_at, revoked_by, revoked_at
        ) VALUES (?, ?, 'enrolled', ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(hub_identity_id) DO UPDATE SET
          contact_id = excluded.contact_id,
          status = 'enrolled',
          satellite_id = excluded.satellite_id,
          endpoint_id = excluded.endpoint_id,
          enrolled_by = excluded.enrolled_by,
          enrolled_at = excluded.enrolled_at,
          revoked_by = NULL,
          revoked_at = NULL
      `).run(hubIdentityId, contactId, satelliteId, endpointId, actor, now);

      this.appendAudit(hubIdentityId, contactId, 'enroll', actor, satelliteId, endpointId);

      const row = this.db.prepare(
        'SELECT * FROM hub_identity_enrollments WHERE hub_identity_id = ?',
      ).get(hubIdentityId) as EnrollmentRow;
      return toEnrollment(row);
    })();
  }

  revoke(hubIdentityId: string, actor?: string): boolean {
    const handle = requireHandle(hubIdentityId);
    const normalizedActor = normalizeActor(actor);

    return this.db.transaction((): boolean => {
      const existing = this.db.prepare(
        'SELECT * FROM hub_identity_enrollments WHERE hub_identity_id = ?',
      ).get(handle) as EnrollmentRow | undefined;

      if (!existing || existing.status !== 'enrolled') {
        return false;
      }

      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE hub_identity_enrollments
        SET status = 'revoked', revoked_by = ?, revoked_at = ?
        WHERE hub_identity_id = ?
      `).run(normalizedActor, now, handle);

      this.appendAudit(
        handle,
        existing.contact_id,
        'revoke',
        normalizedActor,
        existing.satellite_id,
        existing.endpoint_id,
      );
      return true;
    })();
  }

  resolve(hubIdentityId: string): HubIdentityResolution {
    const trimmed = hubIdentityId.trim();
    if (!trimmed) return { status: 'unenrolled' };
    const row = this.db.prepare(
      "SELECT * FROM hub_identity_enrollments WHERE hub_identity_id = ? AND status = 'enrolled'",
    ).get(trimmed) as EnrollmentRow | undefined;
    if (!row) return { status: 'unenrolled' };
    return { status: 'enrolled', binding: toEnrollment(row) };
  }

  getBinding(hubIdentityId: string): HubIdentityEnrollment | undefined {
    const trimmed = hubIdentityId.trim();
    if (!trimmed) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM hub_identity_enrollments WHERE hub_identity_id = ?',
    ).get(trimmed) as EnrollmentRow | undefined;
    return row ? toEnrollment(row) : undefined;
  }

  listByContact(contactId: string): HubIdentityEnrollment[] {
    const trimmed = contactId.trim();
    if (!trimmed) return [];
    const rows = this.db.prepare(
      'SELECT * FROM hub_identity_enrollments WHERE contact_id = ? ORDER BY enrolled_at DESC',
    ).all(trimmed) as EnrollmentRow[];
    return rows.map(toEnrollment);
  }

  listAll(): HubIdentityEnrollment[] {
    const rows = this.db.prepare(
      'SELECT * FROM hub_identity_enrollments ORDER BY enrolled_at DESC',
    ).all() as EnrollmentRow[];
    return rows.map(toEnrollment);
  }

  listAudit(query: HubIdentityEnrollmentAuditQuery = {}): HubIdentityEnrollmentAuditEntry[] {
    const limit = Number.isFinite(query.limit)
      ? Math.max(1, Math.min(Math.floor(query.limit ?? 50), 200))
      : 50;
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    const handle = query.hubIdentityId?.trim();
    if (handle) {
      clauses.push('hub_identity_id = ?');
      params.push(handle);
    }
    const contactId = query.contactId?.trim();
    if (contactId) {
      clauses.push('contact_id = ?');
      params.push(contactId);
    }
    if (query.action) {
      clauses.push('action = ?');
      params.push(query.action);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT id, hub_identity_id, contact_id, action, actor, satellite_id, endpoint_id, timestamp
      FROM hub_identity_enrollment_audit
      ${where}
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(...params, limit) as AuditRow[];
    return rows.map(toAuditEntry);
  }
}

export function createSQLiteHubIdentityEnrollmentStore(
  db: Database.Database,
): HubIdentityEnrollmentStorePort {
  const store = new HubIdentityEnrollmentStore(db);
  return {
    enroll: async (input) => store.enroll(input),
    revoke: async (hubIdentityId, actor) => store.revoke(hubIdentityId, actor),
    resolve: async (hubIdentityId) => store.resolve(hubIdentityId),
    getBinding: async (hubIdentityId) => store.getBinding(hubIdentityId),
    listByContact: async (contactId) => store.listByContact(contactId),
    listAll: async () => store.listAll(),
    listAudit: async (query) => store.listAudit(query),
  };
}
