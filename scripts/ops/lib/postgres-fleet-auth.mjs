// ── Repository-native fleet-auth PostgreSQL provisioning (psfn-framework-fx83b) ──
// Enabling fleet auth (a valid fleet-auth.json in SYSTEM_DATA_DIR) makes the
// gateway enforce a database contract that onboarding does not provision:
//
//   * the three fleet-auth roles (databaseRoles.runtime/migration/backupRestore)
//     and the optional welfare verifier must be LOGIN, NOINHERIT, credential-
//     valid, with a finite CONNECTION LIMIT >= 1, no cluster authority
//     attributes, no memberships, and must not own the database
//     (src/persistence/postgres/role-posture.ts);
//   * all of them need CONNECT and TEMPORARY on the runtime database, and the
//     migration role needs CREATE (it creates the fleet_auth schema);
//   * a second database named <database>_restore_verify must exist, and the
//     backup and migration roles plus every schema owner (each companion's
//     runtime role and the shared migration role) need CONNECT and CREATE on
//     it (src/persistence/backups/restore-verify-preconditions.ts);
//   * the vector extension lives in the `extensions` schema of both databases,
//     usable by the backup role and every schema owner;
//   * FLEET_AUTH_AUTHORITY_FLOOR_ROOT must be an absolute directory with no
//     group/world access (src/system/config/fleet-auth-config.ts);
//   * hubDeviceAssertions.audience and canonicalOrigin must be exact https
//     origins.
//
// planFleetAuthProvisioning resolves and validates all of that from the owner
// files and environment without touching anything; provisionFleetAuthDatabase
// applies the database half idempotently through the superuser credential.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import pg from 'pg';
import {
  assertConnectionLimit,
  assertRoleIsolation,
  assertSafeIdentifier,
  assertSafeSecret,
  ensureLoginRole,
} from './postgres-tenancy.mjs';

const { Pool } = pg;

export const RESTORE_VERIFY_SUFFIX = '_restore_verify';
const EXTENSION_SCHEMA = 'extensions';

function readJson(path) {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error(`Required owner file is missing: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveEnvRef(env, ref, field) {
  if (!ref || ref.kind !== 'env' || typeof ref.envName !== 'string' || ref.envName.length === 0) {
    throw new Error(`${field} must be an {"kind":"env","envName":...} reference for repository-native provisioning`);
  }
  const value = env[ref.envName]?.trim();
  if (!value) throw new Error(`${field} names ${ref.envName}, which is not set`);
  return { envName: ref.envName, value };
}

function parseRoleCredential(value, expectedRole, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a PostgreSQL URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname
    || !url.password || url.pathname === '/' || url.search !== '') {
    throw new Error(`${label} must identify one password-authenticated PostgreSQL database without query overrides`);
  }
  const role = decodeURIComponent(url.username);
  if (role !== expectedRole) {
    throw new Error(`${label} must authenticate as ${expectedRole}, not ${role || '<none>'}`);
  }
  return {
    role: assertSafeIdentifier(`${label} role`, role),
    password: assertSafeSecret(`${label} password`, decodeURIComponent(url.password)),
    target: `${url.hostname.toLowerCase()}:${url.port || '5432'}`,
    databaseName: assertSafeIdentifier(`${label} database`, decodeURIComponent(url.pathname.slice(1))),
  };
}

function assertHttpsOrigin(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`fleet-auth.json ${field} must be an https origin such as https://fleet.example.com`);
  }
  if (url.protocol !== 'https:' || url.origin !== value) {
    throw new Error(
      `fleet-auth.json ${field} must be an exact normalized https origin (got ${JSON.stringify(value)}); `
      + 'use https://<host>[:port] with no path or trailing slash, even for a loopback deployment',
    );
  }
}

/**
 * Resolve every input the provisioning needs and fail with a remediation
 * message before any side effect. `env` is the process environment.
 */
export function planFleetAuthProvisioning({ systemDataDir, env }) {
  const fleetAuth = readJson(join(systemDataDir, 'fleet-auth.json'));
  const companions = readJson(join(systemDataDir, 'companions.json'));
  assertHttpsOrigin(fleetAuth.canonicalOrigin, 'canonicalOrigin');
  if (fleetAuth.hubDeviceAssertions !== undefined) {
    assertHttpsOrigin(fleetAuth.hubDeviceAssertions?.audience, 'hubDeviceAssertions.audience');
  }
  const roles = fleetAuth.databaseRoles ?? {};
  const credentials = fleetAuth.credentials ?? {};
  const fleetConnectionLimit = assertConnectionLimit(
    'PSFN_FLEET_AUTH_DATABASE_CONNECTION_LIMIT',
    Number.parseInt(env.PSFN_FLEET_AUTH_DATABASE_CONNECTION_LIMIT ?? '', 10),
  );

  const loginRoles = [
    ['runtime', 'runtimeDatabaseUrlRef'],
    ['migration', 'migrationDatabaseUrlRef'],
    ['backupRestore', 'backupRestoreDatabaseUrlRef'],
  ].map(([roleKey, refKey]) => {
    const expectedRole = assertSafeIdentifier(`databaseRoles.${roleKey}`, roles[roleKey]);
    const credential = resolveEnvRef(env, credentials[refKey], `credentials.${refKey}`);
    return {
      key: roleKey,
      ...parseRoleCredential(credential.value, expectedRole, credential.envName),
      connectionLimit: fleetConnectionLimit,
    };
  });
  if (fleetAuth.welfareVerifier !== undefined) {
    const verifier = fleetAuth.welfareVerifier;
    const credential = resolveEnvRef(env, verifier.databaseUrlRef, 'welfareVerifier.databaseUrlRef');
    loginRoles.push({
      key: 'welfareVerifier',
      ...parseRoleCredential(
        credential.value,
        assertSafeIdentifier('welfareVerifier.role', verifier.role),
        credential.envName,
      ),
      connectionLimit: assertConnectionLimit('welfareVerifier.connectionLimit', verifier.connectionLimit),
    });
  }
  if (new Set(loginRoles.map(entry => entry.role)).size !== loginRoles.length) {
    throw new Error('fleet-auth.json database roles must be distinct');
  }

  const adminUrl = env.POSTGRES_ADMIN_DATABASE_URL?.trim();
  if (!adminUrl) throw new Error('POSTGRES_ADMIN_DATABASE_URL (a superuser credential) is required');
  const admin = new URL(adminUrl);
  const adminTarget = `${admin.hostname.toLowerCase()}:${admin.port || '5432'}`;
  const databaseName = assertSafeIdentifier('POSTGRES_ADMIN_DATABASE_URL database', decodeURIComponent(admin.pathname.slice(1)));
  for (const entry of loginRoles) {
    if (entry.target !== adminTarget || entry.databaseName !== databaseName) {
      throw new Error(
        `The ${entry.key} credential targets ${entry.target}/${entry.databaseName}; `
        + `fleet auth must share the runtime database ${adminTarget}/${databaseName}`,
      );
    }
  }

  const sharedRole = assertSafeIdentifier('companions.json postgres.sharedMigrationRole', companions?.postgres?.sharedMigrationRole);
  const companionEntries = Array.isArray(companions?.companions) ? companions.companions : [];
  if (companionEntries.length === 0) throw new Error('companions.json must list at least one companion');
  const companionOwners = companionEntries.map((entry, index) => ({
    role: assertSafeIdentifier(`companions[${index}].postgresRole`, entry?.postgresRole),
    schema: assertSafeIdentifier(`companions[${index}].postgresSchema`, entry?.postgresSchema),
  }));
  const schemaOwnerRoles = [...new Set([...companionOwners.map(owner => owner.role), sharedRole])];
  for (const role of schemaOwnerRoles) {
    if (loginRoles.some(entry => entry.role === role)) {
      throw new Error(`Schema owner role ${role} must not also be a fleet-auth database role`);
    }
  }

  const floor = resolveEnvRef(env, credentials.authorityFloorRootRef, 'credentials.authorityFloorRootRef');
  if (!isAbsolute(floor.value)) {
    throw new Error(`${floor.envName} must be an absolute path (got ${floor.value})`);
  }

  const byKey = Object.fromEntries(loginRoles.map(entry => [entry.key, entry.role]));
  return {
    adminUrl,
    databaseName,
    restoreVerifyDatabaseName: `${databaseName}${RESTORE_VERIFY_SUFFIX}`,
    loginRoles,
    migrationRole: byKey.migration,
    backupRole: byKey.backupRestore,
    companionOwners,
    schemaOwnerRoles,
    authorityFloorRoot: floor.value,
  };
}

const quote = identifier => `"${identifier}"`;

/** Statements run in the runtime database after the roles exist. */
export function runtimeDatabaseGrants(plan) {
  const everyRole = plan.loginRoles.map(entry => quote(entry.role)).join(', ');
  const extensionUsers = [plan.backupRole, ...plan.schemaOwnerRoles].map(quote).join(', ');
  return [
    `GRANT CONNECT, TEMPORARY ON DATABASE ${quote(plan.databaseName)} TO ${everyRole}`,
    `GRANT CREATE ON DATABASE ${quote(plan.databaseName)} TO ${quote(plan.migrationRole)}`,
    `CREATE SCHEMA IF NOT EXISTS ${quote(EXTENSION_SCHEMA)}`,
    `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA ${quote(EXTENSION_SCHEMA)}`,
    `REVOKE ALL ON SCHEMA ${quote(EXTENSION_SCHEMA)} FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA ${quote(EXTENSION_SCHEMA)} TO ${extensionUsers}`,
  ];
}

/** Statements run in the restore-verify scratch database. */
export function restoreVerifyDatabaseGrants(plan) {
  const scratch = quote(plan.restoreVerifyDatabaseName);
  const connectCreate = [plan.migrationRole, plan.backupRole, ...plan.schemaOwnerRoles].map(quote).join(', ');
  const extensionUsers = [plan.backupRole, ...plan.schemaOwnerRoles].map(quote).join(', ');
  return [
    `GRANT CONNECT, CREATE ON DATABASE ${scratch} TO ${connectCreate}`,
    `CREATE SCHEMA IF NOT EXISTS ${quote(EXTENSION_SCHEMA)}`,
    `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA ${quote(EXTENSION_SCHEMA)}`,
    `REVOKE ALL ON SCHEMA ${quote(EXTENSION_SCHEMA)} FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA ${quote(EXTENSION_SCHEMA)} TO ${extensionUsers}`,
    ...plan.companionOwners.map(owner => (
      `ALTER ROLE ${quote(owner.role)} IN DATABASE ${scratch} SET search_path TO ${quote(owner.schema)}, ${quote(EXTENSION_SCHEMA)}`
    )),
  ];
}

/**
 * Create (or tighten) the authority floor root: an absolute directory with no
 * group/world access. An existing path must be a real directory.
 */
export function ensureAuthorityFloorRoot(path) {
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(realpathSync(path)).isDirectory()) {
      throw new Error(`Fleet auth authority floor root must be a real directory: ${path}`);
    }
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  chmodSync(path, 0o700);
}

async function withClient(connectionString, applicationName, run) {
  const pool = new Pool({ connectionString, application_name: applicationName, max: 1 });
  const client = await pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
    await pool.end();
  }
}

/** Apply the database half of a validated plan. Idempotent. */
export async function provisionFleetAuthDatabase(plan) {
  const applicationName = 'fleet-auth-bootstrap';
  await withClient(plan.adminUrl, applicationName, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [applicationName]);
      for (const entry of plan.loginRoles) {
        await ensureLoginRole(client, entry.role, entry.password, entry.connectionLimit);
      }
      await assertRoleIsolation(client, plan.loginRoles.map(entry => entry.role));
      const owner = await client.query(
        'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
        [plan.databaseName],
      );
      const databaseOwner = owner.rows[0]?.owner;
      if (plan.loginRoles.some(entry => entry.role === databaseOwner)) {
        throw new Error(`Fleet auth role ${databaseOwner} owns database ${plan.databaseName}; transfer ownership first`);
      }
      for (const statement of runtimeDatabaseGrants(plan)) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
    // CREATE DATABASE cannot run inside a transaction block.
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [plan.restoreVerifyDatabaseName]);
    if (exists.rows.length === 0) {
      await client.query(`CREATE DATABASE ${quote(plan.restoreVerifyDatabaseName)}`);
    }
  });

  const scratchUrl = new URL(plan.adminUrl);
  scratchUrl.pathname = `/${plan.restoreVerifyDatabaseName}`;
  await withClient(scratchUrl.toString(), applicationName, async (client) => {
    await client.query('BEGIN');
    try {
      for (const statement of restoreVerifyDatabaseGrants(plan)) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  });
}
