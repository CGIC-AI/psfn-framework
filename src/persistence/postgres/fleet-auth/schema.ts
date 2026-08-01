import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createPostgresPool } from '../../postgres.js';
import { FLEET_AUTH_MIGRATIONS } from './migrations.js';
import {
  FLEET_AUTH_REAPPROVAL_DDL_SQL,
  FLEET_AUTH_REAPPROVE_FUNCTION_ARG_TYPES,
  FLEET_AUTH_REAPPROVE_FUNCTION_NAME,
} from './reapproval-sql.js';
import { assertPostgresRolesAreLeastPrivilege } from '../role-posture.js';
import { assertPostgresRuntimeDdlAllowed } from '../runtime-readiness.js';
import {
  FLEET_AUTH_COMPANION_REAPPROVAL_DDL_SQL,
  FLEET_AUTH_REAPPROVE_COMPANION_FUNCTION_ARG_TYPES,
  FLEET_AUTH_REAPPROVE_COMPANION_FUNCTION_NAME,
} from './companion-reapproval-sql.js';
import {
  FLEET_AUTH_FIRST_OWNER_DDL_SQL,
  FLEET_AUTH_FIRST_OWNER_FUNCTION_ARG_TYPES,
  FLEET_AUTH_FIRST_OWNER_FUNCTION_NAME,
} from './first-owner-sql.js';
import {
  FLEET_AUTH_LOCK_AUTHORITY_STATE_DDL_SQL,
  FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_ARG_TYPES,
  FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME,
} from './authority-state-lock-sql.js';
import {
  FLEET_AUTH_LOCK_COMPANION_AUTHORITY_DDL_SQL,
  FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_ARG_TYPES,
  FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_NAME,
} from './companion-authority-lock-sql.js';
import {
  FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_DDL_SQL,
  FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_ARG_TYPES,
  FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME,
} from './authority-floor-read-sql.js';
import {
  FLEET_AUTH_RECONCILIATION_DDL_SQL,
  FLEET_AUTH_RECONCILE_FUNCTION_ARG_TYPES,
  FLEET_AUTH_RECONCILE_FUNCTION_NAME,
} from './authority-reconciliation-sql.js';
import {
  FLEET_AUTH_CONSUME_HUB_REPLAY_FUNCTION_ARG_TYPES,
  FLEET_AUTH_CONSUME_HUB_REPLAY_FUNCTION_NAME,
  FLEET_AUTH_HUB_REPLAY_BOUNDARY_DDL_SQL,
  FLEET_AUTH_IMPORT_HUB_REPLAY_AUDIT_FUNCTION_ARG_TYPES,
  FLEET_AUTH_IMPORT_HUB_REPLAY_AUDIT_FUNCTION_NAME,
} from './hub-device-assertion-replay-sql.js';
import {
  FLEET_AUTH_CONSUME_REQUEST_CAPABILITY_FUNCTION_ARG_TYPES,
  FLEET_AUTH_CONSUME_REQUEST_CAPABILITY_FUNCTION_NAME,
  FLEET_AUTH_REQUEST_CAPABILITY_REPLAY_DDL_SQL,
} from './request-capability-replay-sql.js';
import {
  FLEET_AUTH_AUDIT_RECOVERY_CAPABILITY_FUNCTION_ARG_TYPES,
  FLEET_AUTH_AUDIT_RECOVERY_CAPABILITY_FUNCTION_NAME,
  FLEET_AUTH_CONSUME_RECOVERY_CAPABILITY_FUNCTION_ARG_TYPES,
  FLEET_AUTH_CONSUME_RECOVERY_CAPABILITY_FUNCTION_NAME,
  FLEET_AUTH_RECOVERY_CAPABILITY_DDL_SQL,
} from './recovery-request-capability-sql.js';
import {
  FLEET_AUTH_COMPANION_RESTORE_DDL_SQL,
  FLEET_AUTH_IMPORT_RESTORED_COMPANION_FUNCTION_ARG_TYPES,
  FLEET_AUTH_IMPORT_RESTORED_COMPANION_FUNCTION_NAME,
} from './companion-restore-sql.js';
import {
  FLEET_AUTH_CONTACT_AUTHORITY_DDL_SQL,
  FLEET_AUTH_CONTACT_AUTHORITY_FENCE_FUNCTION_ARG_TYPES,
  FLEET_AUTH_CONTACT_AUTHORITY_FENCE_FUNCTION_NAME,
} from './contact-authority-sql.js';
import {
  FLEET_AUTH_ATTACH_HUB_DEVICE_HUMAN_FUNCTION_ARG_TYPES,
  FLEET_AUTH_ATTACH_HUB_DEVICE_HUMAN_FUNCTION_NAME,
  FLEET_AUTH_FENCE_HUB_DEVICE_ATTACHMENT_FUNCTION_ARG_TYPES,
  FLEET_AUTH_FENCE_HUB_DEVICE_ATTACHMENT_FUNCTION_NAME,
  FLEET_AUTH_HUB_DEVICE_HUMAN_ATTACHMENT_DDL_SQL,
} from './hub-device-human-attachment-sql.js';
import {
  FLEET_AUTH_HANDOFF_PRIMARY_EMBODIMENT_FUNCTION_ARG_TYPES,
  FLEET_AUTH_HANDOFF_PRIMARY_EMBODIMENT_FUNCTION_NAME,
  FLEET_AUTH_PRIMARY_EMBODIMENT_DDL_SQL,
} from './primary-embodiment-sql.js';

export const FLEET_AUTH_SCHEMA_NAME = 'fleet_auth';
const MIGRATION_LOCK_CLASS = 0x5053464e;
const MIGRATION_LOCK_ID = 0x46415554;
const ROLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;

export interface FleetAuthDatabaseRoles {
  runtime: string;
  migration: string;
  backupRestore: string;
}

/**
 * Complete database authority set for a fleet backup family. The shared-world
 * schema has its own migration owner; it is deliberately not one of the three
 * fleet_auth roles above and receives no fleet_auth privileges.
 */
export interface FleetAuthFamilyDatabaseRoles extends FleetAuthDatabaseRoles {
  sharedMigration: string;
}

export const FLEET_AUTH_DURABLE_TABLES = [
  'authority_state',
  'human_principals',
  'provider_subjects',
  'provider_subject_history',
  'provider_subject_tombstones',
  'companion_authority_state',
  'principal_contact_bindings',
  'principal_role_grants',
  'principal_merge_aliases',
  'authorization_audit_events',
  'contact_authority_intents',
  'contact_authority_resources',
  'contact_authority_receipts',
  'hub_device_human_attachments',
] as const;

export const FLEET_AUTH_EPHEMERAL_TABLES = [
  'discord_evidence_lifecycle_fences',
  'discord_evidence_snapshots',
  'oauth_transactions',
  'provider_token_custody',
  'browser_sessions',
  'escalation_grants',
  'trusted_host_ceremonies',
  'hub_device_assertion_replays',
  'request_capability_consumptions',
  'primary_embodiment_authority',
  'primary_embodiment_handoff_decisions',
  'lifecycle_decision_receipts',
] as const;

const FLEET_AUTH_MUTABLE_TABLES = [
  'authority_state',
  'authority_floor_tombstone_projection',
  'companion_authority_state',
  'human_principals',
  'provider_subjects',
  'principal_contact_bindings',
  'principal_role_grants',
  'contact_authority_intents',
  'hub_device_human_attachments',
  ...FLEET_AUTH_EPHEMERAL_TABLES,
] as const;

const FLEET_AUTH_RUNTIME_MUTABLE_TABLES = FLEET_AUTH_MUTABLE_TABLES.filter(
  table => table !== 'authority_state'
    && table !== 'authority_floor_tombstone_projection'
    && table !== 'companion_authority_state'
    && table !== 'lifecycle_decision_receipts'
    && table !== 'contact_authority_intents',
);

const FLEET_AUTH_IMMUTABLE_TABLES = [
  'provider_subject_history',
  'provider_subject_tombstones',
  'authorization_audit_events',
  'principal_merge_aliases',
  'contact_authority_resources',
  'contact_authority_receipts',
] as const;

const FLEET_AUTH_RUNTIME_IMMUTABLE_TABLES = FLEET_AUTH_IMMUTABLE_TABLES.filter(
  table => table !== 'principal_merge_aliases'
    && table !== 'contact_authority_resources'
    && table !== 'contact_authority_receipts',
);

const FLEET_AUTH_RUNTIME_READ_ONLY_TABLES = [
  'companion_authority_state',
  'principal_merge_aliases',
] as const;

const FLEET_AUTH_INTERNAL_TABLES = [
  'schema_migrations',
  'provider_subject_registry',
  'companion_restore_import_receipts',
] as const;

const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;

function quoteIdentifier(identifier: string): string {
  if (!ROLE_PATTERN.test(identifier)) {
    throw new Error(`Invalid fleet auth PostgreSQL role name ${JSON.stringify(identifier)}`);
  }
  return `"${identifier}"`;
}

function qualifiedTable(table: string): string {
  return `"${FLEET_AUTH_SCHEMA_NAME}"."${table}"`;
}

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function assertDistinctRoles(roles: FleetAuthDatabaseRoles): void {
  const values = [roles.runtime, roles.migration, roles.backupRestore];
  values.forEach(quoteIdentifier);
  if (new Set(values).size !== values.length) {
    throw new Error('Fleet auth PostgreSQL runtime, migration, and backup/restore roles must be distinct');
  }
}

async function assertCurrentRole(
  pool: Pool,
  expectedRole: string,
  authority: string,
  roles: FleetAuthDatabaseRoles,
): Promise<void> {
  const result = await pool.query<{ current_user: string }>('SELECT current_user');
  const row = result.rows.at(0);
  if (!row || row.current_user !== expectedRole) {
    throw new Error(`${authority} credential must authenticate as PostgreSQL role ${expectedRole}`);
  }
  await assertPostgresRolesAreLeastPrivilege(
    pool,
    [roles.runtime, roles.migration, roles.backupRestore],
    authority,
  );
  const memberships = await pool.query<{ role_name: string }>(`
    SELECT candidate.rolname AS role_name
    FROM pg_roles AS candidate
    WHERE candidate.rolname <> current_user
      AND pg_has_role(current_user, candidate.oid, 'MEMBER')
    ORDER BY candidate.rolname
  `);
  if (memberships.rows.length > 0) {
    throw new Error(
      `${authority} PostgreSQL role must have no role memberships or SET ROLE targets: `
      + memberships.rows.map(row => row.role_name).join(', '),
    );
  }
  const protectedRoles = [roles.runtime, roles.migration, roles.backupRestore];
  const inverseMemberships = await pool.query<{
    member_role: string;
    protected_role: string;
  }>(`
    SELECT member_role.rolname AS member_role, protected_role.rolname AS protected_role
    FROM pg_roles AS member_role
    CROSS JOIN pg_roles AS protected_role
    WHERE protected_role.rolname = ANY($1::text[])
      AND member_role.oid <> protected_role.oid
      AND NOT member_role.rolsuper
      AND pg_has_role(member_role.oid, protected_role.oid, 'MEMBER')
    ORDER BY protected_role.rolname, member_role.rolname
  `, [protectedRoles]);
  if (inverseMemberships.rows.length > 0) {
    const edges = inverseMemberships.rows.map(edge => (
      `${edge.member_role}->${edge.protected_role}`
    ));
    throw new Error(
      `${authority} found unexpected role membership into a fleet auth authority: ${edges.join(', ')}`,
    );
  }
}

async function applyRoleGrants(
  client: import('pg').PoolClient,
  roles: FleetAuthDatabaseRoles,
): Promise<void> {
  const runtime = quoteIdentifier(roles.runtime);
  const backup = quoteIdentifier(roles.backupRestore);
  const schema = `"${FLEET_AUTH_SCHEMA_NAME}"`;
  await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${runtime}, ${backup}`);
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${runtime}, ${backup}`);
  await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${runtime}, ${backup}`);
  await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC, ${runtime}, ${backup}`);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtime}, ${backup}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${FLEET_AUTH_RUNTIME_MUTABLE_TABLES.map(qualifiedTable).join(', ')} TO ${runtime}`,
  );
  // Hub assertion replay keys are serialized and mutated only inside the
  // schema-owner consume procedure. Ordinary runtime SQL may observe the fence
  // for diagnostics but cannot replace, delete, or pre-seed it.
  await client.query(
    `REVOKE INSERT, UPDATE, DELETE ON ${qualifiedTable('hub_device_assertion_replays')} FROM ${runtime}`,
  );
  await client.query(
    `REVOKE INSERT, UPDATE, DELETE ON ${qualifiedTable('request_capability_consumptions')} FROM ${runtime}`,
  );
  await client.query(
    `REVOKE INSERT, UPDATE, DELETE ON ${[
      qualifiedTable('primary_embodiment_authority'),
      qualifiedTable('primary_embodiment_handoff_decisions'),
    ].join(', ')} FROM ${runtime}`,
  );
  await client.query(
    `REVOKE INSERT, UPDATE, DELETE ON ${qualifiedTable('hub_device_human_attachments')} FROM ${runtime}`,
  );
  // The restorable database copy of the non-restored authority floor is
  // observable by the broker, never directly mutable by its ordinary SQL
  // credential. Startup/restore reconciliation uses the coordinator role;
  // trusted-host reapproval changes the epoch only inside the constrained
  // SECURITY DEFINER procedure.
  await client.query(
    `GRANT SELECT ON ${[
      qualifiedTable('authority_state'),
      ...FLEET_AUTH_RUNTIME_READ_ONLY_TABLES.map(qualifiedTable),
    ].join(', ')} TO ${runtime}`,
  );
  // The runtime broker may invalidate pending trusted-host ceremonies during
  // reconciliation (DELETE) and observe them (SELECT), but it must never author
  // or tamper with one: the ceremony is the reapproval procedure's only external
  // gate, so a runtime able to INSERT/UPDATE a ceremony could self-mint a fully
  // sanctioned reapproval. Ceremony minting belongs to the schema owner
  // (migration / SECURITY DEFINER) or a future distinct trusted-host credential.
  // The reapproval procedure consumes the row as the schema owner, so revoking
  // the caller's INSERT/UPDATE does not affect it.
  await client.query(
    `REVOKE INSERT, UPDATE ON ${qualifiedTable('trusted_host_ceremonies')} FROM ${runtime}`,
  );
  await client.query(
    `GRANT SELECT, INSERT ON ${FLEET_AUTH_RUNTIME_IMMUTABLE_TABLES.map(qualifiedTable).join(', ')} TO ${runtime}`,
  );
  // The repo-owned coordinator alone restores durable rows and invalidates
  // ephemeral rows. It receives DML but never schema/migration authority.
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${FLEET_AUTH_MUTABLE_TABLES.map(qualifiedTable).join(', ')} TO ${backup}`,
  );
  // Replay rows are ephemeral and never restored. Reconciliation and expiry
  // cleanup run through schema-owner procedures, so the durable coordinator has
  // no reason to mutate a live replay fence directly.
  await client.query(
    `REVOKE INSERT, UPDATE, DELETE ON ${qualifiedTable('hub_device_assertion_replays')} FROM ${backup}`,
  );
  await client.query(
    `REVOKE INSERT, UPDATE, DELETE ON ${qualifiedTable('request_capability_consumptions')} FROM ${backup}`,
  );
  await client.query(
    `REVOKE INSERT, UPDATE, DELETE ON ${[
      qualifiedTable('primary_embodiment_authority'),
      qualifiedTable('primary_embodiment_handoff_decisions'),
    ].join(', ')} FROM ${backup}`,
  );
  // Companion creation is narrower than ordinary restore DML. The coordinator
  // retains SELECT/UPDATE for lifecycle reconciliation, while restore INSERT is
  // exposed only by the bounded schema-owner import procedure.
  await client.query(
    `REVOKE INSERT, DELETE ON ${qualifiedTable('companion_authority_state')} FROM ${backup}`,
  );
  await client.query(
    `GRANT SELECT, INSERT ON ${FLEET_AUTH_IMMUTABLE_TABLES.map(qualifiedTable).join(', ')} TO ${backup}`,
  );
  await client.query(`REVOKE ALL ON ${qualifiedTable('schema_migrations')} FROM ${runtime}, ${backup}`);
  // The broker runtime alone may invoke the constrained reapproval procedure.
  // Its SECURITY DEFINER body — not this EXECUTE grant — is what actually
  // reactivates quarantined authority; the runtime's ordinary UPDATE is fenced
  // by restore_quarantine_activation_guard. The backup/restore coordinator
  // never reapproves, so it receives no EXECUTE.
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_REAPPROVE_FUNCTION_NAME}(${FLEET_AUTH_REAPPROVE_FUNCTION_ARG_TYPES}) TO ${runtime}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_REAPPROVE_COMPANION_FUNCTION_NAME}(${FLEET_AUTH_REAPPROVE_COMPANION_FUNCTION_ARG_TYPES}) TO ${runtime}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_FIRST_OWNER_FUNCTION_NAME}(${FLEET_AUTH_FIRST_OWNER_FUNCTION_ARG_TYPES}) TO ${runtime}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}(${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_ARG_TYPES}) TO ${runtime}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_NAME}(${FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_ARG_TYPES}) TO ${runtime}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_ARG_TYPES}) TO ${runtime}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_CONTACT_AUTHORITY_FENCE_FUNCTION_NAME}(${FLEET_AUTH_CONTACT_AUTHORITY_FENCE_FUNCTION_ARG_TYPES}) TO ${runtime}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_RECONCILE_FUNCTION_NAME}(${FLEET_AUTH_RECONCILE_FUNCTION_ARG_TYPES}) TO ${backup}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_CONSUME_HUB_REPLAY_FUNCTION_NAME}(${FLEET_AUTH_CONSUME_HUB_REPLAY_FUNCTION_ARG_TYPES}) TO ${runtime}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_CONSUME_REQUEST_CAPABILITY_FUNCTION_NAME}(${FLEET_AUTH_CONSUME_REQUEST_CAPABILITY_FUNCTION_ARG_TYPES}) TO ${runtime}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_CONSUME_RECOVERY_CAPABILITY_FUNCTION_NAME}(${FLEET_AUTH_CONSUME_RECOVERY_CAPABILITY_FUNCTION_ARG_TYPES}) TO ${runtime}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_AUDIT_RECOVERY_CAPABILITY_FUNCTION_NAME}(${FLEET_AUTH_AUDIT_RECOVERY_CAPABILITY_FUNCTION_ARG_TYPES}) TO ${runtime}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_ATTACH_HUB_DEVICE_HUMAN_FUNCTION_NAME}(${FLEET_AUTH_ATTACH_HUB_DEVICE_HUMAN_FUNCTION_ARG_TYPES}) TO ${runtime}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_FENCE_HUB_DEVICE_ATTACHMENT_FUNCTION_NAME}(${FLEET_AUTH_FENCE_HUB_DEVICE_ATTACHMENT_FUNCTION_ARG_TYPES}) TO ${runtime}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_HANDOFF_PRIMARY_EMBODIMENT_FUNCTION_NAME}(${FLEET_AUTH_HANDOFF_PRIMARY_EMBODIMENT_FUNCTION_ARG_TYPES}) TO ${runtime}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_IMPORT_HUB_REPLAY_AUDIT_FUNCTION_NAME}(${FLEET_AUTH_IMPORT_HUB_REPLAY_AUDIT_FUNCTION_ARG_TYPES}) TO ${backup}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION ${FLEET_AUTH_IMPORT_RESTORED_COMPANION_FUNCTION_NAME}(${FLEET_AUTH_IMPORT_RESTORED_COMPANION_FUNCTION_ARG_TYPES}) TO ${backup}`,
  );
}

/**
 * Idempotently (re)assert the trusted-host reapproval boundary: the
 * quarantine-activation guard triggers and the SECURITY DEFINER reapproval
 * procedure. Applied on every migration run, like applyRoleGrants, so the
 * boundary can never drift or be left half-applied. Requires the transaction's
 * search_path to already include fleet_auth (set by migrateFleetAuthSchema).
 */
async function applyFleetAuthReapprovalBoundary(
  client: import('pg').PoolClient,
): Promise<void> {
  await client.query(FLEET_AUTH_REAPPROVAL_DDL_SQL);
  await client.query(FLEET_AUTH_COMPANION_REAPPROVAL_DDL_SQL);
  await client.query(FLEET_AUTH_FIRST_OWNER_DDL_SQL);
  await client.query(FLEET_AUTH_LOCK_AUTHORITY_STATE_DDL_SQL);
  await client.query(FLEET_AUTH_LOCK_COMPANION_AUTHORITY_DDL_SQL);
  await client.query(FLEET_AUTH_HUB_DEVICE_HUMAN_ATTACHMENT_DDL_SQL);
  await client.query(FLEET_AUTH_PRIMARY_EMBODIMENT_DDL_SQL);
  await client.query(FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_DDL_SQL);
  await client.query(FLEET_AUTH_CONTACT_AUTHORITY_DDL_SQL);
  await client.query(FLEET_AUTH_RECONCILIATION_DDL_SQL);
  await client.query(FLEET_AUTH_HUB_REPLAY_BOUNDARY_DDL_SQL);
  await client.query(FLEET_AUTH_REQUEST_CAPABILITY_REPLAY_DDL_SQL);
  await client.query(FLEET_AUTH_RECOVERY_CAPABILITY_DDL_SQL);
  await client.query(FLEET_AUTH_COMPANION_RESTORE_DDL_SQL);
}

export async function migrateFleetAuthSchema(options: {
  databaseUrl: string;
  roles: FleetAuthDatabaseRoles;
}): Promise<void> {
  assertPostgresRuntimeDdlAllowed('migrate fleet authentication schema');
  assertDistinctRoles(options.roles);
  const pool = createPostgresPool(options.databaseUrl, {
    applicationName: 'fleet-auth-migration',
    allowExitOnIdle: true,
    max: 1,
  });
  try {
    await assertCurrentRole(
      pool,
      options.roles.migration,
      'Fleet auth migration',
      options.roles,
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
        [MIGRATION_LOCK_CLASS, MIGRATION_LOCK_ID],
      );
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${FLEET_AUTH_SCHEMA_NAME}"`);
      const schemaOwner = await client.query<{ owner_name: string }>(`
        SELECT owner_role.rolname AS owner_name
        FROM pg_namespace AS namespace
        JOIN pg_roles AS owner_role ON owner_role.oid = namespace.nspowner
        WHERE namespace.nspname = $1
      `, [FLEET_AUTH_SCHEMA_NAME]);
      if (schemaOwner.rows.at(0)?.owner_name !== options.roles.migration) {
        throw new Error('fleet_auth schema must be owned by the configured migration role');
      }
      await client.query(`REVOKE ALL ON SCHEMA "${FLEET_AUTH_SCHEMA_NAME}" FROM PUBLIC`);
      await client.query(`SET LOCAL search_path TO "${FLEET_AUTH_SCHEMA_NAME}", public`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY CHECK (version >= 1),
          name TEXT NOT NULL UNIQUE,
          checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
          applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
        )
      `);
      for (const migration of FLEET_AUTH_MIGRATIONS) {
        const checksum = migrationChecksum(migration.sql);
        const existing = await client.query<{ name: string; checksum: string }>(
          'SELECT name, checksum FROM schema_migrations WHERE version = $1',
          [migration.version],
        );
        const row = existing.rows.at(0);
        if (row) {
          if (row.name !== migration.name || row.checksum !== checksum) {
            throw new Error(`Fleet auth migration ${migration.version} checksum/name mismatch`);
          }
          continue;
        }
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, checksum],
        );
      }
      await applyFleetAuthReapprovalBoundary(client);
      await applyRoleGrants(client, options.roles);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function assertNoDdlOrLedger(
  pool: Pool,
  expectedRole: string,
  authority: string,
  roles: FleetAuthDatabaseRoles,
): Promise<void> {
  await assertCurrentRole(pool, expectedRole, authority, roles);
  const result = await pool.query<{
    schema_usage: boolean;
    schema_create: boolean;
    ledger_select: boolean;
  }>(`
    SELECT
      has_schema_privilege(current_user, $1, 'USAGE') AS schema_usage,
      has_schema_privilege(current_user, $1, 'CREATE') AS schema_create,
      has_table_privilege(current_user, $2, 'SELECT') AS ledger_select
  `, [FLEET_AUTH_SCHEMA_NAME, `${FLEET_AUTH_SCHEMA_NAME}.schema_migrations`]);
  const row = result.rows.at(0);
  if (!row?.schema_usage || row.schema_create || row.ledger_select) {
    throw new Error(`${authority} PostgreSQL privileges violate the fleet_auth least-privilege boundary`);
  }
}

async function assertNoUnexpectedFleetAuthGrantees(
  pool: Pool,
  roles: FleetAuthDatabaseRoles,
  authority: string,
): Promise<void> {
  const allowed = [roles.runtime, roles.migration, roles.backupRestore];
  const result = await pool.query<{ role_name: string }>(`
    WITH acl_grantees AS (
      SELECT acl.grantee
      FROM pg_namespace AS namespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
      ) AS acl
      WHERE namespace.nspname = $1
      UNION
      SELECT acl.grantee
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(relation.relacl, acldefault('r', relation.relowner))
      ) AS acl
      WHERE namespace.nspname = $1
      UNION
      SELECT acl.grantee
      FROM pg_proc AS routine
      JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(routine.proacl, acldefault('f', routine.proowner))
      ) AS acl
      WHERE namespace.nspname = $1
    )
    SELECT DISTINCT CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(grantee) END AS role_name
    FROM acl_grantees
    WHERE grantee = 0 OR NOT (pg_get_userbyid(grantee) = ANY($2::text[]))
    ORDER BY role_name
  `, [FLEET_AUTH_SCHEMA_NAME, allowed]);
  if (result.rows.length > 0) {
    throw new Error(
      `${authority} found unexpected fleet_auth grantees: ${result.rows.map(row => row.role_name).join(', ')}`,
    );
  }
}

async function assertExactDml(
  pool: Pool,
  authority: string,
  expectedRole: string,
  roles: FleetAuthDatabaseRoles,
): Promise<void> {
  const tables = [
    ...FLEET_AUTH_MUTABLE_TABLES,
    ...FLEET_AUTH_IMMUTABLE_TABLES,
    ...FLEET_AUTH_INTERNAL_TABLES,
  ];
  const result = await pool.query<{
    table_name: string;
    privilege: typeof TABLE_PRIVILEGES[number];
    present: boolean;
  }>(`
    SELECT table_name, privilege,
      has_table_privilege(
        current_user,
        format('%I.%I', $1::text, table_name),
        privilege
      ) AS present
    FROM unnest($2::text[]) AS table_names(table_name)
    CROSS JOIN unnest($3::text[]) AS privileges(privilege)
    ORDER BY table_name, privilege
  `, [FLEET_AUTH_SCHEMA_NAME, tables, TABLE_PRIVILEGES]);
  const mutable = new Set<string>(FLEET_AUTH_MUTABLE_TABLES);
  const immutable = new Set<string>(FLEET_AUTH_IMMUTABLE_TABLES);
  const runtimeReadOnly = new Set<string>(FLEET_AUTH_RUNTIME_READ_ONLY_TABLES);
  const runtimeImmutable = new Set<string>(FLEET_AUTH_RUNTIME_IMMUTABLE_TABLES);
  const expectedPrivileges = (tableName: string): ReadonlySet<string> => {
    if (mutable.has(tableName)) {
      if (expectedRole === roles.runtime
        && (tableName === 'lifecycle_decision_receipts'
          || tableName === 'authority_floor_tombstone_projection'
          || tableName === 'contact_authority_intents')) {
        return new Set<string>();
      }
      if (expectedRole === roles.runtime
        && (tableName === 'authority_state' || runtimeReadOnly.has(tableName))) {
        return new Set(['SELECT']);
      }
      // The runtime broker cannot author or tamper with trusted-host ceremonies;
      // it may only SELECT/DELETE them. The backup/restore coordinator retains
      // full DML on every mutable table and never receives reapproval EXECUTE.
      if (expectedRole === roles.runtime && tableName === 'trusted_host_ceremonies') {
        return new Set(['SELECT', 'DELETE']);
      }
      if ((tableName === 'hub_device_assertion_replays'
          || tableName === 'request_capability_consumptions'
          || tableName === 'primary_embodiment_authority'
          || tableName === 'primary_embodiment_handoff_decisions')
        && (expectedRole === roles.runtime || expectedRole === roles.backupRestore)) {
        return new Set(['SELECT']);
      }
      if (tableName === 'hub_device_human_attachments' && expectedRole === roles.runtime) {
        return new Set(['SELECT']);
      }
      if (expectedRole === roles.backupRestore
        && tableName === 'companion_authority_state') {
        return new Set(['SELECT', 'UPDATE']);
      }
      return new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
    }
    if (immutable.has(tableName)) {
      if (expectedRole === roles.runtime && runtimeReadOnly.has(tableName)) {
        return new Set(['SELECT']);
      }
      if (expectedRole === roles.runtime && !runtimeImmutable.has(tableName)) {
        return new Set<string>();
      }
      return new Set(['SELECT', 'INSERT']);
    }
    return new Set<string>();
  };
  const drift = result.rows.filter(row => (
    expectedPrivileges(row.table_name).has(row.privilege) !== row.present
  ));
  if (drift.length > 0) {
    throw new Error(
      `${authority} PostgreSQL exact DML privileges violate the fleet_auth contract: `
      + drift.map(row => `${row.table_name}.${row.privilege}=${row.present}`).join(', '),
    );
  }
}

export async function assertFleetAuthRuntimePrivileges(
  databaseUrl: string,
  roles: FleetAuthDatabaseRoles,
): Promise<void> {
  assertDistinctRoles(roles);
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'fleet-auth-runtime-preflight',
    max: 1,
  });
  try {
    await assertNoDdlOrLedger(
      pool,
      roles.runtime,
      'Fleet auth runtime',
      roles,
    );
    await assertNoUnexpectedFleetAuthGrantees(pool, roles, 'Fleet auth runtime');
    await assertExactDml(pool, 'Fleet auth runtime', roles.runtime, roles);
  } finally {
    await pool.end();
  }
}

export async function assertFleetAuthBackupRestorePrivileges(
  databaseUrl: string,
  roles: FleetAuthDatabaseRoles,
): Promise<void> {
  assertDistinctRoles(roles);
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'fleet-auth-backup-preflight',
    max: 1,
  });
  try {
    await assertNoDdlOrLedger(
      pool,
      roles.backupRestore,
      'Fleet auth backup/restore',
      roles,
    );
    await assertNoUnexpectedFleetAuthGrantees(pool, roles, 'Fleet auth backup/restore');
    await assertExactDml(pool, 'Fleet auth backup/restore', roles.backupRestore, roles);
  } finally {
    await pool.end();
  }
}

export async function hasDurableFleetAuthAuthority(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(`
    SELECT (
      EXISTS (SELECT 1 FROM ${qualifiedTable('human_principals')} LIMIT 1)
      OR EXISTS (SELECT 1 FROM ${qualifiedTable('provider_subject_tombstones')} LIMIT 1)
      OR EXISTS (SELECT 1 FROM ${qualifiedTable('principal_contact_bindings')} LIMIT 1)
      OR EXISTS (
        SELECT 1 FROM ${qualifiedTable('authority_state')}
        WHERE authority_lineage_id IS NOT NULL
          OR authority_generation > 1 OR restore_checkpoint > 0 OR global_auth_epoch > 1
      )
    ) AS present
  `);
  return result.rows[0]?.present === true;
}
