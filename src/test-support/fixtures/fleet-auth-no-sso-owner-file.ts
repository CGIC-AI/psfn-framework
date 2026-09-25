import { generateKeyPairSync } from 'node:crypto';

// A complete provider-none fleet-auth.json fixture shared by the key-only
// (key-or-SSO ruling) gateway tests.

function credential(envName: string) {
  return { kind: 'env' as const, envName };
}

function publicPem(): string {
  return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

/** A complete fleet-auth.json that declares no human SSO provider. */
export function noSsoOwnerFile(canonicalOrigin: string): unknown {
  return {
    schemaVersion: 1,
    activationGeneration: 1,
    canonicalOrigin,
    callbackPath: '/auth/discord/callback',
    provider: { kind: 'none' },
    credentials: {
      tokenEncryptionKeyRef: credential('FLEET_AUTH_TOKEN_ENCRYPTION_KEY'),
      sessionPepperRef: credential('FLEET_AUTH_SESSION_PEPPER'),
      assertionPrivateKeyRef: credential('FLEET_AUTH_ASSERTION_PRIVATE_KEY'),
      trustedHostRecoveryCredentialRef: credential('FLEET_AUTH_RECOVERY_CREDENTIAL'),
      runtimeDatabaseUrlRef: credential('FLEET_AUTH_RUNTIME_DATABASE_URL'),
      migrationDatabaseUrlRef: credential('FLEET_AUTH_MIGRATION_DATABASE_URL'),
      backupRestoreDatabaseUrlRef: credential('FLEET_AUTH_BACKUP_DATABASE_URL'),
      authorityFloorRootRef: credential('FLEET_AUTH_AUTHORITY_FLOOR_ROOT'),
    },
    databaseRoles: {
      runtime: 'fleet_auth_runtime',
      migration: 'fleet_auth_migration',
      backupRestore: 'fleet_auth_backup',
    },
    verifierKeys: [{
      issuer: 'fleet-no-sso-test',
      kid: 'broker-2026-07',
      publicKeyPem: publicPem(),
      notBefore: '2026-07-01T00:00:00.000Z',
      notAfter: '2099-07-01T00:00:00.000Z',
      status: 'active',
    }],
    hubDeviceAssertions: {
      issuer: 'fleet-no-sso-hub',
      audience: canonicalOrigin,
      maxTtlSeconds: 60,
      clockSkewSeconds: 2,
      keys: [{
        kid: 'hub-2026-07',
        publicKeyPem: publicPem(),
        notBefore: '2026-07-01T00:00:00.000Z',
        notAfter: '2099-07-01T00:00:00.000Z',
        status: 'active',
      }],
    },
    ttls: {
      oauthTransactionMs: 300_000,
      sessionIdleMs: 1_800_000,
      sessionAbsoluteMs: 28_800_000,
      discordEvidenceMs: 300_000,
      escalationGrantMs: 900_000,
      internalAssertionMs: 30_000,
    },
    rolePolicy: {
      disabledActionsByRole: { owner: [], admin: [], member: [], guest: [] },
    },
    discordEvidenceMappings: [],
  };
}
