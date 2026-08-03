import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import type { FleetAuthConfig } from '../../../system/config/fleet-auth-config.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../../postgres.js';
import { FleetAuthAuthorityFloorStore } from './authority-floor.js';
import {
  createGatewayProviderRevocationAuthorityPort,
  reconcileFleetAuthAuthorityState,
} from './gateway-persistence.js';
import { PostgresFleetAuthBrokerStore } from './oauth-session-store.js';
import { migrateFleetAuthSchema, type FleetAuthDatabaseRoles } from './schema.js';

export const OAUTH_SESSION_TEST_NOW = new Date('2026-07-15T12:00:00.000Z');
export const OAUTH_SESSION_TEST_PROVIDER_SUBJECT_ID = '123456789012345679';

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function useOAuthSessionStoreIntegrationHarness(
  roleNamespace: string,
  timeoutMs: number,
): {
  roles: FleetAuthDatabaseRoles;
  createStore: (options?: {
    failDuringReconcile?: boolean;
    accountRoster?: FleetAuthConfig['accountRoster'];
  }) => Promise<{
    store: PostgresFleetAuthBrokerStore;
    runtime: import('pg').Pool;
    coordinator: import('pg').Pool;
    migration: import('pg').Pool;
    authorityFloors: FleetAuthAuthorityFloorStore;
  }>;
  authenticate: (
    store: PostgresFleetAuthBrokerStore,
    suffix: string,
  ) => Promise<{ transactionId: string; token: string; csrfToken: string }>;
} {
  if (!/^[a-z][a-z0-9_]{0,20}$/u.test(roleNamespace)) {
    throw new Error('OAuth session integration role namespace is invalid');
  }
  const roles: FleetAuthDatabaseRoles = {
    runtime: `fleet_auth_${roleNamespace}_runtime`,
    migration: `fleet_auth_${roleNamespace}_migration`,
    backupRestore: `fleet_auth_${roleNamespace}_backup`,
  };
  const passwords = new Map<string, string>([
    [roles.runtime, 'runtime-password'],
    [roles.migration, 'migration-password'],
    [roles.backupRestore, 'backup-password'],
  ]);
  let harness: PostgresTestHarness | null = null;
  const floorRoots: string[] = [];

  function roleUrl(databaseUrl: string, role: string): string {
    const password = passwords.get(role);
    if (!password) throw new Error(`Missing integration password for ${role}`);
    const url = new URL(databaseUrl);
    url.username = role;
    url.password = password;
    return url.toString();
  }

  beforeAll(async () => {
    harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
    const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
    try {
      for (const role of Object.values(roles)) {
        await admin.query(
          `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 16 PASSWORD '${passwords.get(role)}'`,
        );
      }
    } finally {
      await admin.end();
    }
  }, timeoutMs);

  afterAll(async () => {
    await harness?.stop();
    for (const root of floorRoots) rmSync(root, { recursive: true, force: true });
  }, timeoutMs);

  async function createStore(options: {
    failDuringReconcile?: boolean;
    accountRoster?: FleetAuthConfig['accountRoster'];
  } = {}) {
    if (!harness) throw new Error('Postgres harness unavailable');
    const database = await harness.createDatabase();
    const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
    try {
      await admin.query(
        `GRANT CREATE, CONNECT ON DATABASE ${quoteIdentifier(database.databaseName)} TO ${quoteIdentifier(roles.migration)}`,
      );
    } finally {
      await admin.end();
    }
    const migrationUrl = roleUrl(database.databaseUrl, roles.migration);
    await migrateFleetAuthSchema({ databaseUrl: migrationUrl, roles });
    const runtime = createPostgresPool(roleUrl(database.databaseUrl, roles.runtime), {
      max: 4,
      allowExitOnIdle: true,
    });
    const coordinator = createPostgresPool(roleUrl(database.databaseUrl, roles.backupRestore), {
      max: 1,
      allowExitOnIdle: true,
    });
    const floorRoot = mkdtempSync(join(tmpdir(), 'fleet-auth-oauth-floor-'));
    floorRoots.push(floorRoot);
    const authorityFloors = new FleetAuthAuthorityFloorStore(floorRoot);
    const initialFloor = authorityFloors.open({
      activationGeneration: 1,
      databaseHasDurableAuthority: false,
    });
    await reconcileFleetAuthAuthorityState(coordinator, initialFloor, randomUUID());
    const providerRevocationAuthority = createGatewayProviderRevocationAuthorityPort(
      authorityFloors,
    );
    return {
      runtime,
      coordinator,
      migration: createPostgresPool(migrationUrl, { max: 1, allowExitOnIdle: true }),
      authorityFloors,
      store: new PostgresFleetAuthBrokerStore({
        pool: runtime,
        providerAuthorityPool: coordinator,
        sessionPepper: 'session-pepper-at-least-thirty-two-bytes',
        tokenEncryptionKey: 'token-encryption-key-at-least-thirty-two-bytes',
        providerRevocationAuthority: {
          sessionAuthorityGenerationIsCurrent: authorityGeneration => (
            providerRevocationAuthority.sessionAuthorityGenerationIsCurrent(authorityGeneration)
          ),
          fence: async (input) => {
            const fence = await providerRevocationAuthority.fence(input);
            if (!options.failDuringReconcile) return fence;
            return {
              ...fence,
              reconcile: async () => {
                throw new Error('injected failure during provider authority reconciliation');
              },
            };
          },
        },
        ...(options.accountRoster ? { accountRoster: options.accountRoster } : {}),
      }),
    };
  }

  async function authenticate(
    store: PostgresFleetAuthBrokerStore,
    suffix: string,
  ): Promise<{ transactionId: string; token: string; csrfToken: string }> {
    const transactionId = randomUUID();
    const stateDigest = createHash('sha256').update(suffix).digest('hex');
    const initiatingBrowserDigest = createHash('sha256').update(`browser-${suffix}`).digest('hex');
    await store.createOAuthTransaction({
      transactionId,
      stateDigest,
      initiatingBrowserDigest,
      pkceVerifier: `pkce-verifier-${suffix}`,
      callbackUri: 'https://fleet.example.test/auth/discord/callback',
      returnPath: '/fleet',
      kind: 'login',
      createdAt: OAUTH_SESSION_TEST_NOW,
      expiresAt: new Date(OAUTH_SESSION_TEST_NOW.getTime() + 300_000),
    });
    const consumed = await store.consumeOAuthTransaction({
      stateDigest,
      initiatingBrowserDigest,
      now: OAUTH_SESSION_TEST_NOW,
    });
    if (consumed.pkceVerifier !== `pkce-verifier-${suffix}`) {
      throw new Error('OAuth integration transaction lost its PKCE verifier');
    }
    return {
      transactionId,
      token: `token-${suffix}`,
      csrfToken: `csrf-${suffix}`,
    };
  }

  return { roles, createStore, authenticate };
}
