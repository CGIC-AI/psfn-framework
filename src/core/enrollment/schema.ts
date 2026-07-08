import type Database from 'better-sqlite3';
import { hasColumn } from '../../persistence/sqlite-utils.js';

/**
 * SQLite schema for hub-identity ↔ contact enrollment bindings.
 *
 * Mirrors the contacts-store schema idiom (`src/core/contacts/store/schema.ts`):
 * `CREATE TABLE IF NOT EXISTS` for fresh DBs, plus `hasColumn`-guarded
 * `ALTER TABLE ... ADD COLUMN` upgrades so an older companion DB can be
 * migrated forward idempotently. Semantically separate from the conversational
 * `contact_channel_*` tables: this binds an opaque biometric handle, not a
 * chat identity.
 */
function ensureEndpointIdColumn(db: Database.Database): void {
  if (!hasColumn(db, 'hub_identity_enrollments', 'endpoint_id')) {
    db.exec('ALTER TABLE hub_identity_enrollments ADD COLUMN endpoint_id TEXT');
  }
}

function ensureSatelliteIdColumn(db: Database.Database): void {
  if (!hasColumn(db, 'hub_identity_enrollments', 'satellite_id')) {
    db.exec('ALTER TABLE hub_identity_enrollments ADD COLUMN satellite_id TEXT');
  }
}

export function initializeHubIdentityEnrollmentSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_identity_enrollments (
      hub_identity_id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'enrolled',
      satellite_id TEXT,
      endpoint_id TEXT,
      enrolled_by TEXT NOT NULL DEFAULT 'system:unknown',
      enrolled_at TEXT NOT NULL,
      revoked_by TEXT,
      revoked_at TEXT,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hub_identity_enrollment_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hub_identity_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      satellite_id TEXT,
      endpoint_id TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hub_identity_enrollments_contact
      ON hub_identity_enrollments(contact_id);
    CREATE INDEX IF NOT EXISTS idx_hub_identity_enrollments_status
      ON hub_identity_enrollments(status);
    CREATE INDEX IF NOT EXISTS idx_hub_identity_enrollment_audit_handle
      ON hub_identity_enrollment_audit(hub_identity_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_hub_identity_enrollment_audit_contact
      ON hub_identity_enrollment_audit(contact_id, timestamp DESC);
  `);

  ensureSatelliteIdColumn(db);
  ensureEndpointIdColumn(db);
}
