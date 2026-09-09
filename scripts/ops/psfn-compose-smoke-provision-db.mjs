#!/usr/bin/env node
// ── Compose smoke tenancy provisioning (psfn-framework-e5aoa) ──
// The smoke stack's Postgres ships a single superuser and predates the
// multi-companion tenancy hardening, so the gateway rejected its credentials
// with "Shared schema migration database credential must authenticate as
// configured topology role shared_schema_migration" and never started.
//
// This runs inside the seed container, before the gateway, and provisions the
// same roles/schemas the supported compose path provisions through
// psfn-compose-bootstrap.mjs — via the shared tenancy module, so the smoke
// topology cannot drift from production. The gateway's credential topology check
// is untouched.

import process from 'node:process';
import { provisionCompanionTenancy } from './lib/postgres-tenancy.mjs';

const COMPANION_CONNECTION_LIMIT = 40;
const SHARED_CONNECTION_LIMIT = 20;

// ── Smoke-target guard (psfn-framework-2xt9c) ──
// This script CREATEs login roles, resets their passwords, and re-owns schemas.
// Run against a real deployment it would hand a checked-in password to that
// deployment's migration authority. It used to be pointed purely by env: the
// smoke stack's role and database carried the same names a supported
// deployment's do, so nothing here could tell the two apart.
//
// They no longer share names, and this refuses to provision anything that does
// not look like the smoke stack: a smoke database, on a host the smoke stack
// actually runs on, with roles whose names are smoke-only. The check runs
// before the first connection, so a misdirected run fails without touching the
// server it was pointed at.
const SMOKE_DATABASE_SUFFIX = '_smoke';
// `shared_schema_migration_smoke`, `companion_smoke_runtime`: a `smoke` segment
// anywhere in the role name, which no supported deployment's roles carry.
const SMOKE_ROLE_SEGMENT = /(?:^|_)smoke(?:_|$)/u;
const SMOKE_HOSTS = new Set([
  // The compose service name on the smoke network, which is where the seed
  // container actually reaches it.
  'postgres',
  // A developer running the seed against a published smoke port.
  'localhost',
  '127.0.0.1',
  '::1',
]);

function assertSmokeTarget(credentials) {
  for (const [name, credential] of credentials) {
    if (!credential.databaseName.endsWith(SMOKE_DATABASE_SUFFIX)) {
      throw new Error(
        `${name} names database "${credential.databaseName}", which is not a smoke database `
        + `(expected a name ending in "${SMOKE_DATABASE_SUFFIX}"); refusing to provision roles `
        + 'against a non-smoke target',
      );
    }
    if (!SMOKE_HOSTS.has(credential.hostname)) {
      throw new Error(
        `${name} points at host "${credential.hostname}", which is not a smoke stack host; `
        + 'refusing to provision roles against a non-smoke target',
      );
    }
  }
}

function assertSmokeRole(name, role) {
  if (!SMOKE_ROLE_SEGMENT.test(role)) {
    throw new Error(
      `${name} authenticates as role "${role}", which is not a smoke-only role name `
      + '(expected a "smoke" segment); refusing to provision it',
    );
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to provision the smoke database tenancy`);
  return value;
}

function parseCredential(name) {
  const value = requiredEnv(name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
  if (!url.username || !url.password || !url.pathname || url.pathname === '/') {
    throw new Error(`${name} must identify one authenticated PostgreSQL database`);
  }
  return {
    value,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    databaseName: decodeURIComponent(url.pathname.slice(1)),
    hostname: url.hostname.toLowerCase(),
    identity: `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || '5432'}${url.pathname}`,
  };
}

async function main() {
  const admin = parseCredential('POSTGRES_ADMIN_DATABASE_URL');
  const shared = parseCredential('SHARED_SCHEMA_MIGRATION_DATABASE_URL');
  const companion = parseCredential('COMPANION_SMOKE_DATABASE_URL');
  const companionSchema = requiredEnv('COMPANION_PG_SCHEMA');

  // Same-database fan-out is a topology invariant the gateway also enforces;
  // proving it here turns a confusing startup failure into a seed-time error.
  if (new Set([admin.identity, shared.identity, companion.identity]).size !== 1) {
    throw new Error('Smoke tenancy credentials must target the same exact database');
  }
  if (new Set([admin.value, shared.value, companion.value]).size !== 3) {
    throw new Error('Smoke tenancy requires one distinct credential per authority');
  }
  // Before the first connection: this is the step that refuses a production URL.
  assertSmokeTarget([
    ['POSTGRES_ADMIN_DATABASE_URL', admin],
    ['SHARED_SCHEMA_MIGRATION_DATABASE_URL', shared],
    ['COMPANION_SMOKE_DATABASE_URL', companion],
  ]);
  assertSmokeRole('SHARED_SCHEMA_MIGRATION_DATABASE_URL', shared.username);
  assertSmokeRole('COMPANION_SMOKE_DATABASE_URL', companion.username);

  await provisionCompanionTenancy({
    adminUrl: admin.value,
    applicationName: 'psfn-compose-smoke-seed',
    advisoryLockKey: 'psfn-compose-smoke-tenancy',
    databaseName: admin.databaseName,
    companionRole: companion.username,
    companionSchema,
    companionPassword: companion.password,
    companionConnectionLimit: COMPANION_CONNECTION_LIMIT,
    sharedRole: shared.username,
    sharedPassword: shared.password,
    sharedConnectionLimit: SHARED_CONNECTION_LIMIT,
    extensionSchema: 'extensions',
  });
  console.log(
    `[smoke-seed] provisioned tenancy roles: ${shared.username}, ${companion.username} `
    + `(schema ${companionSchema})`,
  );
}

main().catch((error) => {
  console.error(`[smoke-seed] tenancy provisioning failed: ${error.message}`);
  process.exit(1);
});
