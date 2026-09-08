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
