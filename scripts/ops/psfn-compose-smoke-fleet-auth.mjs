#!/usr/bin/env node
// Disposable key-only fleet authentication for the real browser smoke journey.
// Uses the normal owner contract and role provisioning; no auth bypass or SSO double.
import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  ensureAuthorityFloorRoot,
  planFleetAuthProvisioning,
  provisionFleetAuthDatabase,
} from './lib/postgres-fleet-auth.mjs';

const UID = 999;
const GID = 999;
const KEY_NAMES = [
  'FLEET_AUTH_TOKEN_ENCRYPTION_KEY', 'FLEET_AUTH_SESSION_PEPPER',
  'FLEET_AUTH_ASSERTION_PRIVATE_KEY', 'FLEET_AUTH_RECOVERY_CREDENTIAL',
  'FLEET_AUTH_RUNTIME_DATABASE_URL', 'FLEET_AUTH_MIGRATION_DATABASE_URL',
  'FLEET_AUTH_BACKUP_DATABASE_URL', 'FLEET_AUTH_AUTHORITY_FLOOR_ROOT',
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for smoke fleet authentication`);
  return value;
}

function ownDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  chownSync(path, UID, GID);
}

function writePrivate(path, value) {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
  chownSync(path, UID, GID);
}

function ref(envName) { return { kind: 'env', envName }; }
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

async function main() {
  const adminUrl = new URL(required('POSTGRES_ADMIN_DATABASE_URL'));
  if (!['postgres:', 'postgresql:'].includes(adminUrl.protocol)
    || !['postgres', '127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname)
    || !decodeURIComponent(adminUrl.pathname).endsWith('_smoke')) {
    throw new Error('Refusing fleet auth provisioning outside a disposable smoke database');
  }
  const origin = new URL(required('PSFN_SMOKE_FLEET_ORIGIN'));
  if (origin.protocol !== 'https:' || origin.origin !== process.env.PSFN_SMOKE_FLEET_ORIGIN
    || !['127.0.0.1', 'localhost'].includes(origin.hostname)) {
    throw new Error('PSFN_SMOKE_FLEET_ORIGIN must be an exact loopback HTTPS origin');
  }
  const systemRoot = required('SYSTEM_DATA_DIR');
  const secretRoot = required('PSFN_SMOKE_FLEET_AUTH_DIR');
  const tlsRoot = required('PSFN_SMOKE_FLEET_TLS_DIR');
  const floorRoot = required('FLEET_AUTH_AUTHORITY_FLOOR_ROOT');
  const hubPrivateKey = readFileSync(join(required('PSFN_SMOKE_HUB_DEVICE_DIR'), 'device-assertion-key.pem'));
  const hubPublicKey = createPublicKey(hubPrivateKey).export({ type: 'spki', format: 'pem' }).toString();
  const secretsPath = join(secretRoot, 'credentials.json');
  const ownerPath = join(systemRoot, 'fleet-auth.json');
  if (existsSync(ownerPath) !== existsSync(secretsPath)) {
    throw new Error('Incomplete smoke fleet authority; use a fresh disposable Compose project');
  }
  ownDirectory(secretRoot);
  ownDirectory(tlsRoot);
  const roles = {
    runtime: 'fleet_auth_runtime_smoke', migration: 'fleet_auth_migration_smoke', backupRestore: 'fleet_auth_backup_smoke',
  };
  const databaseCredential = role => {
    const url = new URL(adminUrl);
    url.username = role;
    url.password = randomBytes(32).toString('hex');
    return url.toString();
  };
  const secrets = existsSync(secretsPath)
    ? JSON.parse(readFileSync(secretsPath, 'utf8'))
    : {
        FLEET_AUTH_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
        FLEET_AUTH_SESSION_PEPPER: randomBytes(32).toString('base64url'),
        FLEET_AUTH_ASSERTION_PRIVATE_KEY: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        FLEET_AUTH_RECOVERY_CREDENTIAL: randomBytes(32).toString('base64url'),
        FLEET_AUTH_RUNTIME_DATABASE_URL: databaseCredential(roles.runtime),
        FLEET_AUTH_MIGRATION_DATABASE_URL: databaseCredential(roles.migration),
        FLEET_AUTH_BACKUP_DATABASE_URL: databaseCredential(roles.backupRestore),
        FLEET_AUTH_AUTHORITY_FLOOR_ROOT: floorRoot,
      };
  for (const key of KEY_NAMES) {
    if (typeof secrets[key] !== 'string' || !secrets[key]) throw new Error(`Invalid smoke credential ${key}`);
  }
  const owner = {
    schemaVersion: 1, activationGeneration: 1,
    canonicalOrigin: origin.origin, callbackPath: '/auth/discord/callback', provider: { kind: 'none' },
    credentials: {
      tokenEncryptionKeyRef: ref('FLEET_AUTH_TOKEN_ENCRYPTION_KEY'),
      sessionPepperRef: ref('FLEET_AUTH_SESSION_PEPPER'),
      assertionPrivateKeyRef: ref('FLEET_AUTH_ASSERTION_PRIVATE_KEY'),
      trustedHostRecoveryCredentialRef: ref('FLEET_AUTH_RECOVERY_CREDENTIAL'),
      runtimeDatabaseUrlRef: ref('FLEET_AUTH_RUNTIME_DATABASE_URL'),
      migrationDatabaseUrlRef: ref('FLEET_AUTH_MIGRATION_DATABASE_URL'),
      backupRestoreDatabaseUrlRef: ref('FLEET_AUTH_BACKUP_DATABASE_URL'),
      authorityFloorRootRef: ref('FLEET_AUTH_AUTHORITY_FLOOR_ROOT'),
    },
    databaseRoles: roles,
    verifierKeys: [{
      issuer: 'psfn-smoke-fleet', kid: 'smoke-fleet-v1',
      publicKeyPem: createPublicKey(secrets.FLEET_AUTH_ASSERTION_PRIVATE_KEY).export({ type: 'spki', format: 'pem' }).toString(),
      notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2099-01-01T00:00:00.000Z', status: 'active',
    }],
    hubDeviceAssertions: {
      issuer: 'psfn-smoke-hub', audience: origin.origin, maxTtlSeconds: 60, clockSkewSeconds: 2,
      keys: [{
        kid: 'smoke-hub-device-assertion-v1', publicKeyPem: hubPublicKey,
        notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2099-01-01T00:00:00.000Z', status: 'active',
      }],
    },
    ttls: {
      oauthTransactionMs: 300_000, sessionIdleMs: 1_800_000, sessionAbsoluteMs: 28_800_000,
      discordEvidenceMs: 300_000, escalationGrantMs: 900_000, internalAssertionMs: 30_000,
    },
    rolePolicy: { disabledActionsByRole: { owner: [], admin: [], member: [], guest: [] } },
    discordEvidenceMappings: [],
  };
  if (existsSync(ownerPath) && JSON.stringify(JSON.parse(readFileSync(ownerPath, 'utf8'))) !== JSON.stringify(owner)) {
    throw new Error('Smoke fleet authority changed; use a fresh disposable Compose project');
  }
  writePrivate(secretsPath, `${JSON.stringify(secrets)}\n`);
  writePrivate(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
  writePrivate(join(secretRoot, 'gateway.env'), `${KEY_NAMES.map(key => `export ${key}=${shellQuote(secrets[key])}`).join('\n')}\n`);
  const plan = planFleetAuthProvisioning({
    systemDataDir: systemRoot,
    env: { ...process.env, ...secrets, PSFN_FLEET_AUTH_DATABASE_CONNECTION_LIMIT: '20' },
  });
  ensureAuthorityFloorRoot(plan.authorityFloorRoot);
  chownSync(plan.authorityFloorRoot, UID, GID);
  await provisionFleetAuthDatabase(plan);

  const certPath = join(tlsRoot, 'localhost.crt');
  const keyPath = join(tlsRoot, 'localhost.key');
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    const result = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
      '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { encoding: 'utf8', stdio: 'pipe' });
    if (result.error || result.status !== 0) throw new Error('Smoke HTTPS certificate generation failed');
  }
  for (const path of [keyPath, certPath]) {
    chmodSync(path, 0o600);
    chownSync(path, UID, GID);
  }
  console.log('[smoke-fleet-auth] key-only owner, isolated database roles, authority floor and loopback TLS ready');
}

main().catch(error => {
  console.error(`[smoke-fleet-auth] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
