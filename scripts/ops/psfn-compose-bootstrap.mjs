#!/usr/bin/env node

import { createHmac } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { provisionCompanionTenancy } from './lib/postgres-tenancy.mjs';

const COMPANION_ROLE = 'companion_main_runtime';
const COMPANION_SCHEMA = 'companion_main';
const SHARED_ROLE = 'shared_schema_migration';
const DATABASE_NAME = 'psfn';
const EXTENSION_SCHEMA = 'extensions';
const SHARED_ROLE_CONNECTION_LIMIT = 20;
const AUTH_CONTEXT = 'substrate-gateway-companion-auth-v1';
const COMPANION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_SECRET_PATTERN = /^[A-Za-z0-9._~+-]+$/u;
const REQUIRED_SYSTEM_FILES = [
  'settings.json',
  'models.json',
  'providers.json',
  'companions.json',
  'trust-policy.json',
  'intake-policy.json',
  'backup.json',
  'mcp-servers.json',
  'automata-policy.json',
  'places.json',
  'runtime-prompt-layers.json',
];
const REQUIRED_COMPANION_FILES = [
  'companion.json',
  'scheduler.json',
  'capability-tier.json',
  'charge-policy.json',
  'skills.json',
  'partner-affect-shadow.json',
];

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; run npm run onboard before starting the runtime`);
  return value;
}

function safeSecret(name) {
  const value = requiredEnv(name);
  if (!SAFE_SECRET_PATTERN.test(value)) {
    throw new Error(`${name} contains characters unsupported by the runtime credential handoff`);
  }
  return value;
}

function parseId(name) {
  const value = requiredEnv(name);
  if (!COMPANION_ID_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase RFC-4122 UUID`);
  }
  return value;
}

function parseNumericId(name) {
  const value = Number.parseInt(requiredEnv(name), 10);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be an integer >= 1`);
  return value;
}

function parseCredential(name, expectedRole) {
  const value = requiredEnv(name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || decodeURIComponent(url.username) !== expectedRole
    || !url.password
    || !url.hostname
    || url.pathname === '/') {
    throw new Error(`${name} must authenticate as ${expectedRole} to one PostgreSQL database`);
  }
  return { value, url };
}

function targetIdentity(url) {
  return `${url.hostname.toLowerCase()}:${url.port || '5432'}${url.pathname}`;
}

function requireRegularFiles(root, names) {
  for (const name of names) {
    const path = join(root, name);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(`Required generated configuration is missing: ${path}; run npm run onboard`);
    }
  }
}

function assertPath(expected, actual, field) {
  if (resolve(expected) !== resolve(actual)) {
    throw new Error(`${field} does not match companions.json: expected ${expected}, got ${actual}`);
  }
}

function validateGeneratedLayout({ runtimeRoot, systemDataDir, companionDataDir, workspacePath, companionId }) {
  requireRegularFiles(systemDataDir, REQUIRED_SYSTEM_FILES);
  requireRegularFiles(companionDataDir, REQUIRED_COMPANION_FILES);
  const manifestPath = join(systemDataDir, 'companions.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entry = Array.isArray(manifest?.companions) && manifest.companions.length === 1
    ? manifest.companions[0]
    : undefined;
  if (!entry || entry.companionId !== companionId) {
    throw new Error('Runtime bootstrap requires one companions.json entry matching COMPANION_ID');
  }
  if (entry.postgresSchema !== COMPANION_SCHEMA || entry.postgresRole !== COMPANION_ROLE) {
    throw new Error(`Runtime companions.json must use ${COMPANION_SCHEMA}/${COMPANION_ROLE}`);
  }
  if (manifest?.postgres?.sharedMigrationRole !== SHARED_ROLE) {
    throw new Error(`Runtime companions.json must use shared migration role ${SHARED_ROLE}`);
  }
  assertPath(
    companionDataDir,
    resolve(runtimeRoot, entry.companionDataDir),
    'COMPANION_DATA_DIR',
  );
  assertPath(
    join(companionDataDir, 'companion.json'),
    resolve(runtimeRoot, entry.characterCardPath),
    'CHARACTER_CARD_PATH',
  );
  assertPath(
    join(runtimeRoot, 'workspaces', 'personal', companionId),
    workspacePath,
    'WORKSPACE_PATH',
  );
}

function chownTree(path, uid, gid) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`Refusing to chown symlink in runtime handoff: ${path}`);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) chownTree(join(path, entry), uid, gid);
  }
  chownSync(path, uid, gid);
}

function writeAgentCredentials({ authDir, socketDir, companionId, hmacKey, backupKey, databaseUrl, uid, gid }) {
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const derive = role => `v1.${createHmac('sha256', hmacKey)
    .update(`${AUTH_CONTEXT}\0${role}\0${companionId}`, 'utf8')
    .digest('hex')}`;
  const authPath = join(authDir, 'agent-auth.env');
  writeFileSync(authPath, [
    `export GATEWAY_COMPANION_AUTH_TOKEN=${derive('agent')}`,
    `export GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN=${derive('internal_session_integrity')}`,
    `export PSFN_BACKUP_ENCRYPTION_KEY=${backupKey}`,
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  const databasePath = join(authDir, 'postgres-database-url');
  writeFileSync(databasePath, databaseUrl, { encoding: 'utf8', mode: 0o600 });
  chmodSync(authDir, 0o700);
  chmodSync(authPath, 0o600);
  chmodSync(databasePath, 0o600);
  chownTree(authDir, uid, gid);
  chownTree(socketDir, uid, gid);
}

async function main() {
  const runtimeRoot = realpathSync(requiredEnv('PSFN_RUNTIME_ROOT'));
  const systemDataDir = realpathSync(requiredEnv('SYSTEM_DATA_DIR'));
  const companionDataDir = realpathSync(requiredEnv('COMPANION_DATA_DIR'));
  const workspacePath = resolve(requiredEnv('WORKSPACE_PATH'));
  mkdirSync(workspacePath, { recursive: true });
  const companionId = parseId('COMPANION_ID');
  const uid = parseNumericId('PSFN_RUNTIME_UID');
  const gid = parseNumericId('PSFN_RUNTIME_GID');
  const companionPassword = safeSecret('PSFN_COMPANION_DATABASE_PASSWORD');
  const sharedPassword = safeSecret('PSFN_SHARED_MIGRATION_DATABASE_PASSWORD');
  const companionConnectionLimit = parseNumericId(
    'PSFN_COMPANION_DATABASE_CONNECTION_LIMIT',
  );
  const hmacKey = safeSecret('GATEWAY_SESSION_HMAC_KEY');
  const backupKey = safeSecret('PSFN_BACKUP_ENCRYPTION_KEY');
  const adminCredential = parseCredential('POSTGRES_ADMIN_DATABASE_URL', 'postgres');
  const companionCredential = parseCredential('COMPANION_MAIN_DATABASE_URL', COMPANION_ROLE);
  const sharedCredential = parseCredential('SHARED_SCHEMA_MIGRATION_DATABASE_URL', SHARED_ROLE);
  if (new Set([
    targetIdentity(adminCredential.url),
    targetIdentity(companionCredential.url),
    targetIdentity(sharedCredential.url),
  ]).size !== 1) {
    throw new Error('Runtime PostgreSQL credentials must target the same exact database');
  }
  validateGeneratedLayout({
    runtimeRoot,
    systemDataDir,
    companionDataDir,
    workspacePath,
    companionId,
  });
  await provisionCompanionTenancy({
    adminUrl: adminCredential.value,
    applicationName: 'psfn-compose-bootstrap',
    databaseName: DATABASE_NAME,
    companionRole: COMPANION_ROLE,
    companionSchema: COMPANION_SCHEMA,
    companionPassword,
    companionConnectionLimit,
    sharedRole: SHARED_ROLE,
    sharedPassword,
    sharedConnectionLimit: SHARED_ROLE_CONNECTION_LIMIT,
    extensionSchema: EXTENSION_SCHEMA,
  });
  writeAgentCredentials({
    authDir: requiredEnv('PSFN_AGENT_AUTH_DIR'),
    socketDir: dirname(requiredEnv('GATEWAY_SOCKET')),
    companionId,
    hmacKey,
    backupKey,
    databaseUrl: companionCredential.value,
    uid,
    gid,
  });
  console.log('[runtime-bootstrap] configuration, database tenancy, and agent handoff are ready');
}

main().catch((error) => {
  console.error(`[runtime-bootstrap] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
