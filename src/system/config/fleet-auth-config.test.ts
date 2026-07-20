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

function validConfig(publicKeyPem: string, hubPublicKeyPem: string): FleetAuthConfig {
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
    hubDeviceAssertions: {
      issuer: 'psfn-satellite-hub',
      audience: 'https://fleet.example.test',
      maxTtlSeconds: 60,
      clockSkewSeconds: 2,
      keys: [{
        kid: 'hub-2026-07',
        publicKeyPem: hubPublicKeyPem,
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

function rewrapPublicKeyPem(publicKeyPem: string): string {
  const body = publicKeyPem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s/gu, '');
  const lines = body.match(/.{1,17}/gu);
  if (!lines) throw new Error('test public key must contain DER bytes');
  return `-----BEGIN PUBLIC KEY-----\r\n${lines.join('\r\n')}\r\n-----END PUBLIC KEY-----\r\n`;
}

describe('fleet-auth owner-file configuration', () => {
  const tempDirs: string[] = [];
  const keyPair = generateKeyPairSync('ed25519');
  const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const hubKeyPair = generateKeyPairSync('ed25519');
  const hubPublicKeyPem = hubKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

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

    writeConfig(dataDir, validConfig(publicKeyPem, hubPublicKeyPem));
    expect(() => resolveFleetAuthOwnerFile({ dataDir, enabled: false, processMode: 'agent' }))
      .toThrow(/present.*PSFN_FLEET_AUTH.*not enabled/i);
    expect(() => isFleetAuthEnabled({ [FLEET_AUTH_ENV_VAR]: 'perhaps' }))
      .toThrow(/Invalid PSFN_FLEET_AUTH/);
  });

  it('projects the full config only to the gateway and public verifier material elsewhere', () => {
    const dataDir = makeRoot();
    const config = validConfig(publicKeyPem, hubPublicKeyPem);
    writeConfig(dataDir, config);

    const gateway = resolveFleetAuthOwnerFile({ dataDir, enabled: true, processMode: 'gateway' });
    const agent = resolveFleetAuthOwnerFile({ dataDir, enabled: true, processMode: 'agent' });
    const operator = resolveFleetAuthOwnerFile({ dataDir, enabled: true, processMode: 'operator' });

    expect(gateway?.kind).toBe('gateway');
    expect(gateway && 'config' in gateway ? gateway.config.credentials.runtimeDatabaseUrlRef : null)
      .toEqual(credential('FLEET_AUTH_RUNTIME_DATABASE_URL'));
    if (!gateway || gateway.kind !== 'gateway') throw new Error('gateway projection missing');
    expect(agent).toEqual({
      kind: 'verifier',
      enabled: true,
      canonicalOrigin: 'https://fleet.example.test',
      gardenMetadata: projectFleetAuthGardenMetadata(gateway.config),
      requestCapabilities: {
        issuer: 'psfn-fleet-auth',
        maxTtlSeconds: 30,
        keys: validateFleetAuthConfig(
          validConfig(publicKeyPem, hubPublicKeyPem),
          FLEET_AUTH_FILE_NAME,
        ).verifierKeys,
      },
      hubDeviceAssertions: validateFleetAuthConfig(
        validConfig(publicKeyPem, hubPublicKeyPem),
        FLEET_AUTH_FILE_NAME,
      ).hubDeviceAssertions,
    });
    expect(operator).toEqual(agent);
    expect(JSON.stringify(agent)).not.toContain('clientSecretRef');
    expect(JSON.stringify(agent)).not.toContain('DatabaseUrlRef');
    expect(JSON.stringify(agent)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(agent)).not.toContain('sessionPepper');
  });

  it('requires one request-capability issuer and whole-second assertion TTLs', () => {
    const config = validConfig(publicKeyPem, hubPublicKeyPem);
    expect(() => validateFleetAuthConfig({
      ...config,
      verifierKeys: [
        ...config.verifierKeys,
        {
          ...config.verifierKeys[0],
          issuer: 'other-fleet',
          kid: 'other-retiring',
          status: 'retiring',
        },
      ],
    }, FLEET_AUTH_FILE_NAME)).toThrow(/one request-capability issuer/u);
    expect(() => validateFleetAuthConfig({
      ...config,
      ttls: { ...config.ttls, internalAssertionMs: 30_001 },
    }, FLEET_AUTH_FILE_NAME)).toThrow(/whole seconds/u);
  });

  it('rejects unknown keys, unsafe origins, partial mappings, duplicates, and widening vocabulary', () => {
    const config = validConfig(publicKeyPem, hubPublicKeyPem);
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
    const config = validConfig(publicKeyPem, hubPublicKeyPem);
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
      hubDeviceAssertions: {
        ...config.hubDeviceAssertions,
        keys: [{ ...config.hubDeviceAssertions.keys[0], status: 'revoked' }],
      },
    }, 'fleet-auth.json')).toThrow(/Hub device assertion.*active key/i);
    expect(() => validateFleetAuthConfig({
      ...config,
      hubDeviceAssertions: {
        ...config.hubDeviceAssertions,
        keys: [{ ...config.hubDeviceAssertions.keys[0], publicKeyPem: privateKeyPem }],
      },
    }, 'fleet-auth.json')).toThrow(/hubDeviceAssertions.*public Ed25519/i);
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

  it('rejects canonical public-key reuse across and within verifier rings', () => {
    const config = validConfig(publicKeyPem, hubPublicKeyPem);
    expect(() => validateFleetAuthConfig({
      ...config,
      hubDeviceAssertions: {
        ...config.hubDeviceAssertions,
        keys: [{
          ...config.hubDeviceAssertions.keys[0],
          kid: 'different-hub-kid',
          publicKeyPem: rewrapPublicKeyPem(publicKeyPem),
        }],
      },
    }, 'fleet-auth.json')).toThrow(/broker and Hub verifier rings must use distinct Ed25519 keys/i);

    const sharedRotation = generateKeyPairSync('ed25519').publicKey
      .export({ type: 'spki', format: 'pem' }).toString();
    expect(() => validateFleetAuthConfig({
      ...config,
      verifierKeys: [
        ...config.verifierKeys,
        {
          issuer: config.verifierKeys[0]!.issuer,
          kid: 'retired-broker-kid',
          publicKeyPem: sharedRotation,
          notBefore: '2025-01-01T00:00:00.000Z',
          notAfter: '2025-02-01T00:00:00.000Z',
          status: 'revoked',
        },
      ],
      hubDeviceAssertions: {
        ...config.hubDeviceAssertions,
        keys: [
          ...config.hubDeviceAssertions.keys,
          {
            kid: 'future-hub-kid',
            publicKeyPem: rewrapPublicKeyPem(sharedRotation),
            notBefore: '2028-01-01T00:00:00.000Z',
            notAfter: '2028-02-01T00:00:00.000Z',
            status: 'retiring',
          },
        ],
      },
    }, 'fleet-auth.json')).toThrow(/broker and Hub verifier rings must use distinct Ed25519 keys/i);

    expect(() => validateFleetAuthConfig({
      ...config,
      verifierKeys: [
        ...config.verifierKeys,
        {
          ...config.verifierKeys[0],
          issuer: config.verifierKeys[0]!.issuer,
          kid: 'duplicate-broker-key',
          publicKeyPem: rewrapPublicKeyPem(publicKeyPem),
          notBefore: '2025-01-01T00:00:00.000Z',
          notAfter: '2025-02-01T00:00:00.000Z',
          status: 'revoked',
        },
      ],
    }, 'fleet-auth.json')).toThrow(/broker verifier ring must not contain duplicate Ed25519 keys/i);

    expect(() => validateFleetAuthConfig({
      ...config,
      hubDeviceAssertions: {
        ...config.hubDeviceAssertions,
        keys: [
          ...config.hubDeviceAssertions.keys,
          {
            ...config.hubDeviceAssertions.keys[0],
            kid: 'duplicate-hub-key',
            publicKeyPem: rewrapPublicKeyPem(hubPublicKeyPem),
            notBefore: '2025-01-01T00:00:00.000Z',
            notAfter: '2025-02-01T00:00:00.000Z',
            status: 'revoked',
          },
        ],
      },
    }, 'fleet-auth.json')).toThrow(/Hub verifier ring must not contain duplicate Ed25519 keys/i);
  });

  it('preserves distinct broker and Hub key rotations', () => {
    const config = validConfig(publicKeyPem, hubPublicKeyPem);
    const retiringBroker = generateKeyPairSync('ed25519').publicKey
      .export({ type: 'spki', format: 'pem' }).toString();
    const retiringHub = generateKeyPairSync('ed25519').publicKey
      .export({ type: 'spki', format: 'pem' }).toString();
    const validated = validateFleetAuthConfig({
      ...config,
      verifierKeys: [
        ...config.verifierKeys,
        {
          ...config.verifierKeys[0],
          kid: '2026-06-retiring',
          publicKeyPem: retiringBroker,
          status: 'retiring',
        },
      ],
      hubDeviceAssertions: {
        ...config.hubDeviceAssertions,
        keys: [
          ...config.hubDeviceAssertions.keys,
          {
            ...config.hubDeviceAssertions.keys[0],
            kid: 'hub-2026-06-retiring',
            publicKeyPem: retiringHub,
            status: 'retiring',
          },
        ],
      },
    }, 'fleet-auth.json');

    expect(validated.verifierKeys).toHaveLength(2);
    expect(validated.hubDeviceAssertions.keys).toHaveLength(2);
  });

  it('resolves every private credential only at the gateway and enforces role/database separation', () => {
    const config = validConfig(publicKeyPem, hubPublicKeyPem);
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

    const forgedHubTrust = structuredClone(config);
    forgedHubTrust.hubDeviceAssertions.keys[0].publicKeyPem = publicKeyPem;
    expect(() => resolveGatewayFleetAuthSecrets({
      config: forgedHubTrust,
      credentialVault: createStaticCredentialVault(credentials),
      protectedRestoreRoots: [],
    })).toThrow(/broker private signing key must not match any trusted Hub key/i);

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
    expect(() => resolveGatewayFleetAuthSecrets({
      config,
      credentialVault: createStaticCredentialVault(credentials),
      protectedRestoreRoots: [],
      companionDatabaseUrl: 'postgres://companion_runtime:secret@db.example.test/psfn?user=fleet_auth_runtime',
    })).toThrow(/routing or authentication query override|role-routing override/);
    expect(() => resolveGatewayFleetAuthSecrets({
      config,
      credentialVault: createStaticCredentialVault({
        ...credentials,
        FLEET_AUTH_RUNTIME_DATABASE_URL:
          'postgres://fleet_auth_runtime:runtime@db.example.test/psfn?user=fleet_auth_backup',
      }),
      protectedRestoreRoots: [],
    })).toThrow(/routing or authentication query override/);
  });

  it('publishes Garden-safe metadata without credential refs or verifier key bytes', () => {
    const config = validConfig(publicKeyPem, hubPublicKeyPem);
    const metadata = projectFleetAuthGardenMetadata(config);
    expect(metadata).toMatchObject({
      enabled: true,
      featureMode: 'fleet-principal',
      canonicalOrigin: {
        value: config.canonicalOrigin,
        status: 'configured_https',
      },
      callbackPath: config.callbackPath,
      revision: {
        schemaVersion: 1,
        activationGeneration: 1,
        canonicalSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      providerPolicy: {
        kind: 'discord',
        scopes: ['identify', 'guilds', 'guilds.members.read'],
        tokenCustody: 'discard',
      },
      disabledActionsByRole: config.rolePolicy.disabledActionsByRole,
      discordEvidence: {
        mappingCount: 1,
        companionBindingCount: 1,
        channelRestrictedMappingCount: 1,
        roleRestrictedMappingCount: 1,
        requiredRoleBindingCount: 1,
      },
      verifierKeys: [{ issuer: 'psfn-fleet-auth', kid: '2026-07-primary', status: 'active' }],
      hubDeviceAssertions: {
        issuer: 'psfn-satellite-hub',
        audience: 'https://fleet.example.test',
        keys: [{ kid: 'hub-2026-07', status: 'active' }],
      },
    });
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('envName');
    expect(serialized).not.toContain('PUBLIC KEY');
    expect(serialized).not.toContain('clientId');
    expect(serialized).not.toContain(config.provider.clientId);
    expect(serialized).not.toContain(config.discordEvidenceMappings[0]!.guildId);
    expect(serialized).not.toContain(config.discordEvidenceMappings[0]!.channelId);
    expect(serialized).not.toContain(config.discordEvidenceMappings[0]!.companionId);
    expect(serialized).not.toContain(config.discordEvidenceMappings[0]!.requiredRoleIds[0]);
    expect(serialized).not.toContain('fleet_auth_runtime');
    expect(serialized).not.toContain('RECOVERY_CREDENTIAL');
  });

  it('keeps the distributed example schema-readable but rejects every seed key in enabled config', () => {
    const raw = readFileSync(join(process.cwd(), 'config', 'fleet-auth.seed.json'), 'utf8');
    const seed = validateFleetAuthConfig(JSON.parse(raw), 'fleet-auth.seed.json');
    expect(seed.schemaVersion).toBe(1);
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).not.toContain('postgres://');

    const dataDir = makeRoot();
    writeFileSync(join(dataDir, FLEET_AUTH_FILE_NAME), raw);
    expect(() => resolveFleetAuthOwnerFile({
      dataDir,
      enabled: true,
      processMode: 'gateway',
    })).toThrow(/replace-before-enable.*must be replaced/i);

    const config = validConfig(publicKeyPem, hubPublicKeyPem);
    expect(() => validateFleetAuthConfig({
      ...config,
      verifierKeys: [{
        ...config.verifierKeys[0],
        kid: 'renamed-seed-broker-key',
        publicKeyPem: seed.verifierKeys[0].publicKeyPem,
      }],
    }, FLEET_AUTH_FILE_NAME)).toThrow(/distributed seed or test fixture key must be replaced/i);

    const fixture = JSON.parse(readFileSync(
      join(process.cwd(), 'test-fixtures/fleet-sso/hub-device-assertion-v1.json'),
      'utf8',
    )) as { publicKeyPem: string };
    expect(() => validateFleetAuthConfig({
      ...config,
      hubDeviceAssertions: {
        ...config.hubDeviceAssertions,
        keys: [{
          ...config.hubDeviceAssertions.keys[0],
          kid: 'renamed-fixture-hub-key',
          publicKeyPem: fixture.publicKeyPem,
        }],
      },
    }, FLEET_AUTH_FILE_NAME)).toThrow(/distributed seed or test fixture key must be replaced/i);

    expect(() => validateFleetAuthConfig({
      ...config,
      verifierKeys: [{ ...config.verifierKeys[0], kid: 'replace-before-enable' }],
    }, FLEET_AUTH_FILE_NAME)).toThrow(/replace-before-enable.*must be replaced/i);
    expect(() => validateFleetAuthConfig({
      ...config,
      hubDeviceAssertions: {
        ...config.hubDeviceAssertions,
        keys: [{ ...config.hubDeviceAssertions.keys[0], kid: 'replace-before-enable' }],
      },
    }, FLEET_AUTH_FILE_NAME)).toThrow(/replace-before-enable.*must be replaced/i);
  });
});

describe('fleet-auth account roster validation', () => {
  const rosterKeyPair = generateKeyPairSync('ed25519');
  const rosterPublicKeyPem = rosterKeyPair.publicKey
    .export({ type: 'spki', format: 'pem' }).toString();
  const rosterHubKeyPair = generateKeyPairSync('ed25519');
  const rosterHubPublicKeyPem = rosterHubKeyPair.publicKey
    .export({ type: 'spki', format: 'pem' }).toString();
  const OWNER_SUBJECT = '100000000000000001';
  const OTHER_SUBJECT = '100000000000000002';
  const OTHER_COMPANION_ID = '22222222-2222-4222-8222-222222222222';

  function config(): FleetAuthConfig {
    return validConfig(rosterPublicKeyPem, rosterHubPublicKeyPem);
  }

  function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      providerSubjectId: OWNER_SUBJECT,
      companionId: COMPANION_ID,
      role: 'owner',
      ...overrides,
    };
  }

  it('accepts an absent roster and leaves the parsed config without roster fields', () => {
    const parsed = validateFleetAuthConfig(config(), FLEET_AUTH_FILE_NAME);
    expect(parsed.accountRoster).toBeUndefined();
    expect(parsed.accountRosterSatisfiesStepUp).toBeUndefined();
  });

  it('accepts a valid roster with the explicit step-up opt-in and round-trips it', () => {
    const parsed = validateFleetAuthConfig({
      ...config(),
      accountRoster: [
        entry(),
        entry({ providerSubjectId: OTHER_SUBJECT, companionId: OTHER_COMPANION_ID, role: 'member' }),
      ],
      accountRosterSatisfiesStepUp: true,
    }, FLEET_AUTH_FILE_NAME);
    expect(parsed.accountRoster).toEqual([
      { providerSubjectId: OWNER_SUBJECT, companionId: COMPANION_ID, role: 'owner' },
      { providerSubjectId: OTHER_SUBJECT, companionId: OTHER_COMPANION_ID, role: 'member' },
    ]);
    expect(parsed.accountRosterSatisfiesStepUp).toBe(true);
    const reParsed = validateFleetAuthConfig(
      JSON.parse(JSON.stringify(parsed)),
      FLEET_AUTH_FILE_NAME,
    );
    expect(reParsed.accountRoster).toEqual(parsed.accountRoster);
  });

  it('allows the same subject on multiple companions and the same companion for multiple subjects', () => {
    const parsed = validateFleetAuthConfig({
      ...config(),
      accountRoster: [
        entry(),
        entry({ companionId: OTHER_COMPANION_ID }),
        entry({ providerSubjectId: OTHER_SUBJECT, role: 'guest' }),
      ],
    }, FLEET_AUTH_FILE_NAME);
    expect(parsed.accountRoster).toHaveLength(3);
  });

  it.each([
    ['non-array roster', { accountRoster: { providerSubjectId: OWNER_SUBJECT } }, /accountRoster must be an array/],
    ['non-object entry', { accountRoster: ['owner'] }, /must be an object/],
    ['missing role', { accountRoster: [{ providerSubjectId: OWNER_SUBJECT, companionId: COMPANION_ID }] }, /role is required/],
    ['unknown entry key', { accountRoster: [entry({ trustLevel: 'ultimate' })] }, /unknown/i],
    ['short snowflake', { accountRoster: [entry({ providerSubjectId: '1234567890123456' })] }, /snowflake/],
    ['leading-zero snowflake', { accountRoster: [entry({ providerSubjectId: '000000000000000001' })] }, /snowflake/],
    ['non-digit snowflake', { accountRoster: [entry({ providerSubjectId: '10000000000000000x' })] }, /snowflake/],
    ['numeric snowflake', { accountRoster: [entry({ providerSubjectId: 100000000000000001 })] }, /non-empty string/],
    ['uppercase companion uuid', { accountRoster: [entry({ companionId: 'ABCDEF00-0000-4000-8000-000000000000' })] }, /RFC-4122 UUID/],
    ['malformed companion id', { accountRoster: [entry({ companionId: 'companion-one' })] }, /RFC-4122 UUID/],
    ['unknown role', { accountRoster: [entry({ role: 'root' })] }, /role must be one of/],
    ['non-string role', { accountRoster: [entry({ role: 1 })] }, /role must be one of/],
    ['duplicate subject+companion pair', { accountRoster: [entry(), entry({ role: 'member' })] }, /duplicate accountRoster entry/],
    ['step-up opt-in without roster', { accountRosterSatisfiesStepUp: true }, /requires a non-empty accountRoster/],
    ['step-up opt-in with empty roster', { accountRoster: [], accountRosterSatisfiesStepUp: true }, /requires a non-empty accountRoster/],
    ['non-boolean step-up opt-in', { accountRoster: [entry()], accountRosterSatisfiesStepUp: 'yes' }, /must be a boolean/],
  ])('refuses startup on %s', (_label, overrides, expected) => {
    expect(() => validateFleetAuthConfig({ ...config(), ...overrides }, FLEET_AUTH_FILE_NAME))
      .toThrow(expected);
  });

  it('accepts an explicit false opt-in and an empty roster without the opt-in', () => {
    const parsed = validateFleetAuthConfig({
      ...config(),
      accountRoster: [],
      accountRosterSatisfiesStepUp: false,
    }, FLEET_AUTH_FILE_NAME);
    expect(parsed.accountRoster).toEqual([]);
    expect(parsed.accountRosterSatisfiesStepUp).toBe(false);
  });
});
