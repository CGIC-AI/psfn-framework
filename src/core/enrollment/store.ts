import { Pool } from 'pg';
import {
  createPostgresPool,
  ensurePostgresSchema,
  queryOne,
  queryRows,
  withPostgresClient,
} from '../../persistence/postgres.js';
import { POSTGRES_ENROLLMENT_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import type { HubIdentityEnrollmentStorePort } from './enrollment-store-port.js';
import type {
  HubIdentityEnrollment,
  HubIdentityEnrollmentAuditEntry,
  HubIdentityEnrollmentAuditQuery,
  HubIdentityEnrollmentInput,
  HubIdentityResolution,
} from './types.js';

/**
 * Canonical Postgres persistence for hub-identity ↔ contact enrollment
 * bindings (Sprint 10 D2a). PSFN runtime persistence is Postgres-only; the
 * durable schema lives in {@link POSTGRES_ENROLLMENT_MIGRATIONS}. Biometrics
 * stay at the Satellite Hub — core stores only the opaque handle → contact
 * binding plus an audit trail. Fail-closed contact-existence policy lives one
 * layer up in {@link HubIdentityEnrollmentService}; this store owns only durable
 * storage behind the narrow {@link HubIdentityEnrollmentStorePort} seam.
 */

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
  id: string | number;
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
    id: Number(row.id),
    hubIdentityId: row.hub_identity_id,
    contactId: row.contact_id,
    action: row.action === 'revoke' ? 'revoke' : 'enroll',
    actor: row.actor,
    satelliteId: row.satellite_id,
    endpointId: row.endpoint_id,
    timestamp: row.timestamp,
  };
}

export class PostgresHubIdentityEnrollmentStore implements HubIdentityEnrollmentStorePort {
  constructor(private readonly pool: Pool) {}

  async enroll(input: HubIdentityEnrollmentInput): Promise<HubIdentityEnrollment> {
    const hubIdentityId = input.hubIdentityId.trim();
    if (!hubIdentityId) {
      throw new Error('hubIdentityId is required and must be a non-empty opaque handle');
    }
    const contactId = input.canonicalContactId.trim();
    if (!contactId) {
      throw new Error('canonicalContactId is required');
    }
    const actor = normalizeActor(input.actor);
    const satelliteId = input.satelliteId?.trim() || null;
    const endpointId = input.endpointId?.trim() || null;
    const now = new Date().toISOString();

    return withPostgresClient(this.pool, async (client) => {
      const existing = (await client.query<EnrollmentRow>(
        'SELECT * FROM hub_identity_enrollments WHERE hub_identity_id = $1',
        [hubIdentityId],
      )).rows.at(0);

      if (existing && existing.status === 'enrolled' && existing.contact_id !== contactId) {
        throw new Error(
          `hub identity ${hubIdentityId} is already enrolled to a different contact; revoke it before re-binding`,
        );
      }

      await client.query(
        `
        INSERT INTO hub_identity_enrollments (
          hub_identity_id, contact_id, status, satellite_id, endpoint_id,
          enrolled_by, enrolled_at, revoked_by, revoked_at
        ) VALUES ($1, $2, 'enrolled', $3, $4, $5, $6, NULL, NULL)
        ON CONFLICT (hub_identity_id) DO UPDATE SET
          contact_id = EXCLUDED.contact_id,
          status = 'enrolled',
          satellite_id = EXCLUDED.satellite_id,
          endpoint_id = EXCLUDED.endpoint_id,
          enrolled_by = EXCLUDED.enrolled_by,
          enrolled_at = EXCLUDED.enrolled_at,
          revoked_by = NULL,
          revoked_at = NULL
        `,
        [hubIdentityId, contactId, satelliteId, endpointId, actor, now],
      );

      await client.query(
        `
        INSERT INTO hub_identity_enrollment_audit (
          hub_identity_id, contact_id, action, actor, satellite_id, endpoint_id, timestamp
        ) VALUES ($1, $2, 'enroll', $3, $4, $5, $6)
        `,
        [hubIdentityId, contactId, actor, satelliteId, endpointId, new Date().toISOString()],
      );

      const row = (await client.query<EnrollmentRow>(
        'SELECT * FROM hub_identity_enrollments WHERE hub_identity_id = $1',
        [hubIdentityId],
      )).rows[0];
      return toEnrollment(row);
    });
  }

  async revoke(hubIdentityId: string, actor?: string): Promise<boolean> {
    const handle = hubIdentityId.trim();
    if (!handle) {
      throw new Error('hubIdentityId is required and must be a non-empty opaque handle');
    }
    const normalizedActor = normalizeActor(actor);

    return withPostgresClient(this.pool, async (client) => {
      const existing = (await client.query<EnrollmentRow>(
        'SELECT * FROM hub_identity_enrollments WHERE hub_identity_id = $1',
        [handle],
      )).rows.at(0);
      if (!existing || existing.status !== 'enrolled') {
        return false;
      }

      await client.query(
        `
        UPDATE hub_identity_enrollments
        SET status = 'revoked', revoked_by = $1, revoked_at = $2
        WHERE hub_identity_id = $3
        `,
        [normalizedActor, new Date().toISOString(), handle],
      );
      await client.query(
        `
        INSERT INTO hub_identity_enrollment_audit (
          hub_identity_id, contact_id, action, actor, satellite_id, endpoint_id, timestamp
        ) VALUES ($1, $2, 'revoke', $3, $4, $5, $6)
        `,
        [handle, existing.contact_id, normalizedActor, existing.satellite_id, existing.endpoint_id, new Date().toISOString()],
      );
      return true;
    });
  }

  async resolve(hubIdentityId: string): Promise<HubIdentityResolution> {
    const trimmed = hubIdentityId.trim();
    if (!trimmed) return { status: 'unenrolled' };
    const row = await queryOne<EnrollmentRow>(
      this.pool,
      "SELECT * FROM hub_identity_enrollments WHERE hub_identity_id = $1 AND status = 'enrolled'",
      [trimmed],
    );
    if (!row) return { status: 'unenrolled' };
    return { status: 'enrolled', binding: toEnrollment(row) };
  }

  async getBinding(hubIdentityId: string): Promise<HubIdentityEnrollment | undefined> {
    const trimmed = hubIdentityId.trim();
    if (!trimmed) return undefined;
    const row = await queryOne<EnrollmentRow>(
      this.pool,
      'SELECT * FROM hub_identity_enrollments WHERE hub_identity_id = $1',
      [trimmed],
    );
    return row ? toEnrollment(row) : undefined;
  }

  async listByContact(contactId: string): Promise<HubIdentityEnrollment[]> {
    const trimmed = contactId.trim();
    if (!trimmed) return [];
    const rows = await queryRows<EnrollmentRow>(
      this.pool,
      'SELECT * FROM hub_identity_enrollments WHERE contact_id = $1 ORDER BY enrolled_at DESC',
      [trimmed],
    );
    return rows.map(toEnrollment);
  }

  async listAll(): Promise<HubIdentityEnrollment[]> {
    const rows = await queryRows<EnrollmentRow>(
      this.pool,
      'SELECT * FROM hub_identity_enrollments ORDER BY enrolled_at DESC',
    );
    return rows.map(toEnrollment);
  }

  async listAudit(query: HubIdentityEnrollmentAuditQuery = {}): Promise<HubIdentityEnrollmentAuditEntry[]> {
    const limit = Number.isFinite(query.limit)
      ? Math.max(1, Math.min(Math.floor(query.limit ?? 50), 200))
      : 50;
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    let index = 1;

    const handle = query.hubIdentityId?.trim();
    if (handle) {
      clauses.push(`hub_identity_id = $${index++}`);
      params.push(handle);
    }
    const contactId = query.contactId?.trim();
    if (contactId) {
      clauses.push(`contact_id = $${index++}`);
      params.push(contactId);
    }
    if (query.action) {
      clauses.push(`action = $${index++}`);
      params.push(query.action);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await queryRows<AuditRow>(
      this.pool,
      `
      SELECT id, hub_identity_id, contact_id, action, actor, satellite_id, endpoint_id, timestamp
      FROM hub_identity_enrollment_audit
      ${where}
      ORDER BY timestamp DESC, id DESC
      LIMIT $${index}
      `,
      [...params, limit],
    );
    return rows.map(toAuditEntry);
  }
}

export interface PostgresHubIdentityEnrollmentStoreOptions {
  pool?: Pool;
  applicationName?: string;
}

export async function createPostgresHubIdentityEnrollmentStore(
  databaseUrl: string,
  options: PostgresHubIdentityEnrollmentStoreOptions = {},
): Promise<HubIdentityEnrollmentStorePort> {
  const pool = options.pool ?? createPostgresPool(databaseUrl, {
    applicationName: options.applicationName ?? 'psfn-enrollment',
    allowExitOnIdle: true,
  });
  await ensurePostgresSchema(pool, POSTGRES_ENROLLMENT_MIGRATIONS);
  return new PostgresHubIdentityEnrollmentStore(pool);
}
