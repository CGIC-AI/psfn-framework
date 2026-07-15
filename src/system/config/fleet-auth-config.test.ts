import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStaticCredentialVault } from '../../boundary/custody/credential-vault.js';
import {
  FLEET_AUTH_ENV_VAR,
  FLEET_AUTH_FILE_NAME,
  isFleetAuthEnabled,
  projectFleetAuthGardenMetadata,
  resolveFleetAuthOwnerFile,
  resolveGatewayFleetAuthSecrets,
  validateFleetAuthConfig,
  type FleetAuthConfig,
} from './fleet-auth-config.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';

function credential(envName: string) {
  return { kind: 'env' as const, envName };
}

function validConfig(publicKeyPem: string): FleetAuthConfig {
  return {
    schemaVersion: 1,
    activationGeneration: 1,
    canonicalOrigin: 'https://fleet.example.test',
    callbackPath: '/auth/discord/callback',
    provider: {
      kind: 'discord',
      clientId: '123456789012345678',
      scopes: ['identify', 'guilds', 'guilds.members.read'],
      clientSecretRef: credential('FLEET_AUTH_DISCORD_CLIENT_SECRET'),
      tokenCustody: 'discard',
    },
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
      issuer: 'psfn-fleet-auth',
      kid: '2026-07-primary',
      publicKeyPem,
      notBefore: '2026-07-01T00:00:00.000Z',
      notAfter: '2099-07-01T00:00:00.000Z',
      status: 'active',
    }],
    ttls: {
      oauthTransactionMs: 300_000,
      sessionIdleMs: 1_800_000,
      sessionAbsoluteMs: 28_800_000,
      discordEvidenceMs: 300_000,
      jitGrantMs: 300_000,
      stepUpChallengeMs: 180_000,
      internalAssertionMs: 30_000,
    },
    rolePolicy: {
      disabledActionsByRole: {
        owner: [],
        admin: ['roles.manage'],
        member: ['settings.write', 'roles.manage'],
        guest: ['garden.read', 'settings.read', 'settings.write', 'roles.manage'],
      },
    },
    discordEvidenceMappings: [{
      guildId: '234567890123456789',
      channelId: '345678901234567890',
      companionId: COMPANION_ID,
      requiredRoleIds: ['456789012345678901'],
    }],
  };
}

describe('fleet-auth owner-file configuration', () => {
  const tempDirs: string[] = [];
  const keyPair = generateKeyPairSync('ed25519');
  const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-config-'));
    tempDirs.push(root);
    return root;
  }

  function writeConfig(dataDir: string, config: unknown): void {
    writeFileSync(join(dataDir, FLEET_AUTH_FILE_NAME), `${JSON.stringify(config, null, 2)}\n`);
  }

  it('keeps flag-off/file-absent mode inert and rejects either mismatch', () => {
    const dataDir = makeRoot();
    expect(isFleetAuthEnabled({})).toBe(false);
    expect(resolveFleetAuthOwnerFile({ dataDir, enabled: false, processMode: 'agent' }))
      .toBeUndefined();
    expect(() => resolveFleetAuthOwnerFile({ dataDir, enabled: true, processMode: 'gateway' }))
      .toThrow(/enabled but .*fleet-auth\.json.*missing/i);

    writeConfig(dataDir, validConfig(publicKeyPem));
    expect(() => resolveFleetAuthOwnerFile({ dataDir, enabled: false, processMode: 'agent' }))
      .toThrow(/present.*PSFN_FLEET_AUTH.*not enabled/i);
    expect(() => isFleetAuthEnabled({ [FLEET_AUTH_ENV_VAR]: 'perhaps' }))
      .toThrow(/Invalid PSFN_FLEET_AUTH/);
  });

  it('projects the full config only to the gateway and public verifier material elsewhere', () => {
    const dataDir = makeRoot();
    writeConfig(dataDir, validConfig(publicKeyPem));

    const gateway = resolveFleetAuthOwnerFile({ dataDir, enabled: true, processMode: 'gateway' });
    const agent = resolveFleetAuthOwnerFile({ dataDir, enabled: true, processMode: 'agent' });
    const operator = resolveFleetAuthOwnerFile({ dataDir, enabled: true, processMode: 'operator' });

    expect(gateway?.kind).toBe('gateway');
    expect(gateway && 'config' in gateway ? gateway.config.credentials.runtimeDatabaseUrlRef : null)
      .toEqual(credential('FLEET_AUTH_RUNTIME_DATABASE_URL'));
    expect(agent).toEqual({
      kind: 'verifier',
      enabled: true,
      canonicalOrigin: 'https://fleet.example.test',
      verifierKeys: validateFleetAuthConfig(
        validConfig(publicKeyPem),
        FLEET_AUTH_FILE_NAME,
      ).verifierKeys,
    });
    expect(operator).toEqual(agent);
    expect(JSON.stringify(agent)).not.toContain('clientSecretRef');
    expect(JSON.stringify(agent)).not.toContain('DatabaseUrlRef');
  });

  it('rejects unknown keys, unsafe origins, partial mappings, duplicates, and widening vocabulary', () => {
    const config = validConfig(publicKeyPem);
    expect(() => validateFleetAuthConfig({ ...config, secret: 'inline' }, 'fleet-auth.json'))
      .toThrow(/unknown keys: secret/);
    expect(() => validateFleetAuthConfig({ ...config, canonicalOrigin: 'http://fleet.example.test' }, 'fleet-auth.json'))
      .toThrow(/canonicalOrigin must use https/);
    expect(() => validateFleetAuthConfig({ ...config, canonicalOrigin: 'https://*.example.test' }, 'fleet-auth.json'))
      .toThrow(/wildcard/);
    expect(() => validateFleetAuthConfig({
      ...config,
      callbackPath: '/\\evil.example/callback',
    }, 'fleet-auth.json')).toThrow(/callbackPath must be an absolute path/);
    expect(() => validateFleetAuthConfig({
      ...config,
      callbackPath: '/auth/../callback',
    }, 'fleet-auth.json')).toThrow(/callbackPath must be an exact normalized path/);
    expect(() => validateFleetAuthConfig({
      ...config,
      rolePolicy: {
        disabledActionsByRole: {
          ...config.rolePolicy.disabledActionsByRole,
          member: ['memory.read.everyone'],
        },
      },
    }, 'fleet-auth.json')).toThrow(/unknown action/);
    expect(() => validateFleetAuthConfig({
      ...config,
      discordEvidenceMappings: [
        ...config.discordEvidenceMappings,
        structuredClone(config.discordEvidenceMappings[0]),
      ],
    }, 'fleet-auth.json')).toThrow(/duplicate Discord evidence mapping/);
    expect(() => validateFleetAuthConfig({
      ...config,
      ttls: { ...config.ttls, sessionIdleMs: config.ttls.sessionAbsoluteMs },
    }, 'fleet-auth.json')).toThrow(/sessionIdleMs must be less than sessionAbsoluteMs/);
  });

  it('rejects invalid verifier rings, private signing keys in public config, and reused credentials', () => {
    const config = validConfig(publicKeyPem);
    expect(() => validateFleetAuthConfig({
      ...config,
      verifierKeys: [{ ...config.verifierKeys[0], publicKeyPem: privateKeyPem }],
    }, 'fleet-auth.json')).toThrow(/public Ed25519/);
    expect(() => validateFleetAuthConfig({
      ...config,
      verifierKeys: [{ ...config.verifierKeys[0], status: 'revoked' }],
    }, 'fleet-auth.json')).toThrow(/active verifier key/);
    expect(() => validateFleetAuthConfig({
      ...config,
      credentials: {
        ...config.credentials,
        runtimeDatabaseUrlRef: config.credentials.migrationDatabaseUrlRef,
      },
    }, 'fleet-auth.json')).toThrow(/credential references must be distinct/);
    expect(() => validateFleetAuthConfig({
      ...config,
      provider: {
        ...config.provider,
        clientSecretRef: config.credentials.sessionPepperRef,
      },
    }, 'fleet-auth.json')).toThrow(/credential references must be distinct/);
    expect(() => validateFleetAuthConfig({
      ...config,
      credentials: {
        ...config.credentials,
        runtimeDatabaseUrlRef: credential('POSTGRES_DATABASE_URL'),
      },
    }, 'fleet-auth.json')).toThrow(/must not reuse POSTGRES_DATABASE_URL/);
  });

  it('resolves every private credential only at the gateway and enforces role/database separation', () => {
    const config = validConfig(publicKeyPem);
    const floorRoot = join(makeRoot(), 'authority');
    mkdirSync(floorRoot, { mode: 0o700 });
    chmodSync(floorRoot, 0o700);
    const credentials = {
      FLEET_AUTH_DISCORD_CLIENT_SECRET: 'discord-secret',
      FLEET_AUTH_TOKEN_ENCRYPTION_KEY: 't'.repeat(32),
      FLEET_AUTH_SESSION_PEPPER: 'p'.repeat(32),
      FLEET_AUTH_ASSERTION_PRIVATE_KEY: privateKeyPem,
      FLEET_AUTH_RECOVERY_CREDENTIAL: 'r'.repeat(32),
      FLEET_AUTH_RUNTIME_DATABASE_URL: 'postgres://fleet_auth_runtime:runtime@db.example.test/psfn',
      FLEET_AUTH_MIGRATION_DATABASE_URL: 'postgres://fleet_auth_migration:migrate@db.example.test/psfn',
      FLEET_AUTH_BACKUP_DATABASE_URL: 'postgres://fleet_auth_backup:backup@db.example.test/psfn',
      FLEET_AUTH_AUTHORITY_FLOOR_ROOT: floorRoot,
    };
    const resolved = resolveGatewayFleetAuthSecrets({
      config,
      credentialVault: createStaticCredentialVault(credentials),
      protectedRestoreRoots: [makeRoot()],
    });
    expect(resolved.database.runtimeUrl).toContain('fleet_auth_runtime');
    expect(resolved.database.migrationUrl).toContain('fleet_auth_migration');
    expect(resolved.database.backupRestoreUrl).toContain('fleet_auth_backup');
    expect(resolved.authorityFloorRoot).toBe(floorRoot);
    expect(resolved.assertionSigningKid).toBe('2026-07-primary');

    expect(() => resolveGatewayFleetAuthSecrets({
      config,
      credentialVault: createStaticCredentialVault(credentials),
      protectedRestoreRoots: [join(floorRoot, 'future-backups')],
    })).toThrow(/authority floor root must remain outside/);

    expect(() => resolveGatewayFleetAuthSecrets({
      config,
      credentialVault: createStaticCredentialVault({
        ...credentials,
        FLEET_AUTH_RUNTIME_DATABASE_URL: credentials.FLEET_AUTH_MIGRATION_DATABASE_URL,
      }),
      protectedRestoreRoots: [],
    })).toThrow(/authenticate as configured role|distinct PostgreSQL credentials/);
    expect(() => resolveGatewayFleetAuthSecrets({
      config,
      credentialVault: createStaticCredentialVault({
        ...credentials,
        FLEET_AUTH_RECOVERY_CREDENTIAL: credentials.FLEET_AUTH_SESSION_PEPPER,
      }),
      protectedRestoreRoots: [],
    })).toThrow(/security credentials must be distinct/);
    expect(() => resolveGatewayFleetAuthSecrets({
      config,
      credentialVault: createStaticCredentialVault(credentials),
      protectedRestoreRoots: [],
      companionDatabaseUrl: credentials.FLEET_AUTH_RUNTIME_DATABASE_URL,
    })).toThrow(/must not reuse the companion POSTGRES_DATABASE_URL value/);
    expect(() => resolveGatewayFleetAuthSecrets({
      config,
      credentialVault: createStaticCredentialVault(credentials),
      protectedRestoreRoots: [],
      companionDatabaseUrl: 'postgres://fleet_auth_runtime:different@db.example.test/psfn',
    })).toThrow(/must not authenticate as a fleet auth role/);

    for (const query of [
      'host=alternate.example.test',
      'hostaddr=192.0.2.10',
      'port=6543',
      'dbname=other',
      'database=other',
      'user=fleet_auth_migration',
      'password=alternate',
      'service=shadow',
      'servicefile=%2Ftmp%2Fpg_service.conf',
      'passfile=%2Ftmp%2Fpgpass',
      'options=-c%20role%3Dfleet_auth_migration',
      'target_session_attrs=read-write',
    ]) {
      expect(() => resolveGatewayFleetAuthSecrets({
        config,
        credentialVault: createStaticCredentialVault({
          ...credentials,
          FLEET_AUTH_RUNTIME_DATABASE_URL: `${credentials.FLEET_AUTH_RUNTIME_DATABASE_URL}?${query}`,
        }),
        protectedRestoreRoots: [],
      })).toThrow(/must not use PostgreSQL routing or authentication query override/);
    }
  });

  it('publishes Garden-safe metadata without credential refs or verifier key bytes', () => {
    const config = validConfig(publicKeyPem);
    const metadata = projectFleetAuthGardenMetadata(config);
    expect(metadata).toMatchObject({
      enabled: true,
      canonicalOrigin: config.canonicalOrigin,
      callbackPath: config.callbackPath,
      provider: {
        kind: 'discord',
        scopes: ['identify', 'guilds', 'guilds.members.read'],
        tokenCustody: 'discard',
      },
      verifierKeys: [{ issuer: 'psfn-fleet-auth', kid: '2026-07-primary', status: 'active' }],
    });
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('envName');
    expect(serialized).not.toContain('PUBLIC KEY');
    expect(serialized).not.toContain('clientId');
  });

  it('keeps the distributed example valid without embedding secret values', () => {
    const raw = readFileSync(join(process.cwd(), 'config', 'fleet-auth.seed.json'), 'utf8');
    expect(validateFleetAuthConfig(JSON.parse(raw), 'fleet-auth.seed.json').schemaVersion).toBe(1);
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).not.toContain('postgres://');
  });
});
