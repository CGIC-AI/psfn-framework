// ── Shared Compose tenancy provisioning (psfn-framework-e5aoa) ──
// The multi-companion tenancy hardening requires the shared schema-migration
// authority and every companion runtime to authenticate as their own configured
// PostgreSQL role. This module owns the CREATE ROLE / schema / grant sequence so
// the production compose bootstrap and the onboarding smoke stack provision the
// same topology instead of drifting apart.

import pg from 'pg';

const { Pool } = pg;

const SAFE_SECRET_PATTERN = /^[A-Za-z0-9._~+-]+$/u;
const SAFE_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/u;

function assertSafeIdentifier(label, value) {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase PostgreSQL identifier`);
  }
  return value;
}

function assertSafeSecret(label, value) {
  if (typeof value !== 'string' || !SAFE_SECRET_PATTERN.test(value)) {
    throw new Error(`${label} contains characters unsupported by the runtime credential handoff`);
  }
  return value;
}

function assertConnectionLimit(label, value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be an integer >= 1`);
  }
  return value;
}

async function quotedLiteral(client, value) {
  const result = await client.query('SELECT quote_literal($1::text) AS value', [value]);
  const literal = result.rows[0]?.value;
  if (typeof literal !== 'string') throw new Error('PostgreSQL did not quote a credential');
  return literal;
}

async function ensureLoginRole(client, role, password, connectionLimit) {
  const passwordLiteral = await quotedLiteral(client, password);
  const exists = await client.query(
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS value',
    [role],
  );
  if (exists.rows[0]?.value !== true) {
    await client.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD ${passwordLiteral} NOINHERIT CONNECTION LIMIT ${connectionLimit}`,
    );
  }
  await client.query(
    `ALTER ROLE "${role}" LOGIN PASSWORD ${passwordLiteral} NOSUPERUSER NOCREATEDB `
    + `NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${connectionLimit}`,
  );
}

async function assertRoleIsolation(client, roles) {
  const result = await client.query(`
    SELECT authority.rolname AS authority_role, related.rolname AS related_role
    FROM pg_roles authority
    CROSS JOIN pg_roles related
    WHERE authority.rolname = ANY($1::text[])
      AND authority.oid <> related.oid
      AND (
        pg_has_role(authority.oid, related.oid, 'MEMBER')
        OR (NOT related.rolsuper AND pg_has_role(related.oid, authority.oid, 'MEMBER'))
      )
  `, [roles]);
  if (result.rows.length > 0) {
    throw new Error('Runtime database roles have unexpected memberships; refusing to repair authority drift');
  }
}

/**
 * Provision the shared migration authority and one companion runtime role with
 * their schemas, extension access, and search paths. Idempotent: an existing
 * deployment is re-asserted, never recreated.
 */
export async function provisionCompanionTenancy(options) {
  const databaseName = assertSafeIdentifier('Database name', options.databaseName);
  const companionRole = assertSafeIdentifier('Companion runtime role', options.companionRole);
  const companionSchema = assertSafeIdentifier('Companion schema', options.companionSchema);
  const sharedRole = assertSafeIdentifier('Shared migration role', options.sharedRole);
  const extensionSchema = assertSafeIdentifier('Extension schema', options.extensionSchema);
  const companionPassword = assertSafeSecret('Companion database password', options.companionPassword);
  const sharedPassword = assertSafeSecret('Shared migration database password', options.sharedPassword);
  const companionConnectionLimit = assertConnectionLimit(
    'Companion database connection limit',
    options.companionConnectionLimit,
  );
  const sharedConnectionLimit = assertConnectionLimit(
    'Shared migration connection limit',
    options.sharedConnectionLimit,
  );
  const advisoryLockKey = options.advisoryLockKey ?? 'psfn-compose-bootstrap';

  const pool = new Pool({
    connectionString: options.adminUrl,
    application_name: options.applicationName ?? 'psfn-compose-tenancy',
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [advisoryLockKey]);
    await ensureLoginRole(client, companionRole, companionPassword, companionConnectionLimit);
    await ensureLoginRole(client, sharedRole, sharedPassword, sharedConnectionLimit);
    await assertRoleIsolation(client, [companionRole, sharedRole]);
    await client.query(`REVOKE CREATE ON DATABASE "${databaseName}" FROM PUBLIC`);
    await client.query(`GRANT CREATE ON DATABASE "${databaseName}" TO "${sharedRole}"`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${extensionSchema}"`);
    await client.query(`REVOKE ALL ON SCHEMA "${extensionSchema}" FROM PUBLIC`);
    await client.query(
      `GRANT USAGE ON SCHEMA "${extensionSchema}" TO "${companionRole}", "${sharedRole}"`,
    );
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA "${extensionSchema}"`);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${companionSchema}" AUTHORIZATION "${companionRole}"`);
    await client.query(`ALTER SCHEMA "${companionSchema}" OWNER TO "${companionRole}"`);
    await client.query(`REVOKE ALL ON SCHEMA "${companionSchema}" FROM PUBLIC`);
    await client.query(`REVOKE ALL ON SCHEMA "${companionSchema}" FROM "${sharedRole}"`);
    await client.query(
      `ALTER ROLE "${companionRole}" SET search_path TO "${companionSchema}", "${extensionSchema}"`,
    );
    await client.query(`ALTER ROLE "${sharedRole}" SET search_path TO shared, "${extensionSchema}"`);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
