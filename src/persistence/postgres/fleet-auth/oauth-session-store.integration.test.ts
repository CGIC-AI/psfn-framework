import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GatewayFleetAuthBroker } from '../../../boundary/gateway/fleet-auth-broker.js';
import { FleetAuthHttpRoutes } from '../../../channels/api/server/fleet-auth-routes.js';
import type { FleetAuthConfig } from '../../../system/config/fleet-auth-config.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../../postgres.js';
import { migrateFleetAuthSchema, type FleetAuthDatabaseRoles } from './schema.js';
import { PostgresFleetAuthBrokerStore } from './oauth-session-store.js';
import { FleetAuthAuthorityFloorStore } from './authority-floor.js';
import {
  createGatewayAccountReapprovalAuthority,
  createGatewayProviderRevocationAuthorityPort,
  reconcileFleetAuthAuthorityState,
} from './gateway-persistence.js';

const TIMEOUT_MS = 120_000;
const ROLES: FleetAuthDatabaseRoles = {
  runtime: 'fleet_auth_runtime',
  migration: 'fleet_auth_migration',
  backupRestore: 'fleet_auth_backup',
};
const PASSWORDS = {
  fleet_auth_runtime: 'runtime-password',
  fleet_auth_migration: 'migration-password',
  fleet_auth_backup: 'backup-password',
} as const;
const PROVIDER_SUBJECT_ID = '123456789012345679';
const SECOND_PROVIDER_SUBJECT_ID = '223456789012345679';
const NOW = new Date('2026-07-15T12:00:00.000Z');
const CALLBACK_CONFIG: FleetAuthConfig = {
  schemaVersion: 1,
  activationGeneration: 1,
  canonicalOrigin: 'https://fleet.example.test',
  callbackPath: '/auth/discord/callback',
  provider: {
    kind: 'discord',
    clientId: '123456789012345678',
    scopes: ['identify'],
    clientSecretRef: { kind: 'env', envName: 'FLEET_AUTH_DISCORD_CLIENT_SECRET' },
    tokenCustody: 'discard',
  },
  credentials: {
    tokenEncryptionKeyRef: { kind: 'env', envName: 'FLEET_AUTH_TOKEN_ENCRYPTION_KEY' },
    sessionPepperRef: { kind: 'env', envName: 'FLEET_AUTH_SESSION_PEPPER' },
    assertionPrivateKeyRef: { kind: 'env', envName: 'FLEET_AUTH_ASSERTION_PRIVATE_KEY' },
    trustedHostRecoveryCredentialRef: { kind: 'env', envName: 'FLEET_AUTH_RECOVERY_CREDENTIAL' },
    runtimeDatabaseUrlRef: { kind: 'env', envName: 'FLEET_AUTH_RUNTIME_DATABASE_URL' },
    migrationDatabaseUrlRef: { kind: 'env', envName: 'FLEET_AUTH_MIGRATION_DATABASE_URL' },
    backupRestoreDatabaseUrlRef: { kind: 'env', envName: 'FLEET_AUTH_BACKUP_DATABASE_URL' },
    authorityFloorRootRef: { kind: 'env', envName: 'FLEET_AUTH_AUTHORITY_FLOOR_ROOT' },
  },
  databaseRoles: ROLES,
  verifierKeys: [{
    issuer: 'psfn-fleet-auth',
    kid: 'callback-test',
    publicKeyPem: 'unused-in-callback-test',
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2099-01-01T00:00:00.000Z',
    status: 'active',
  }],
  hubDeviceAssertions: {
    issuer: 'psfn-satellite-hub',
    audience: 'https://fleet.example.test',
    maxTtlSeconds: 60,
    clockSkewSeconds: 2,
    keys: [{
      kid: 'hub-callback-test',
      publicKeyPem: 'unused-in-callback-test',
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2099-01-01T00:00:00.000Z',
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
    disabledActionsByRole: {
      owner: [],
      admin: ['roles.manage'],
      member: ['settings.write', 'roles.manage'],
      guest: ['garden.read', 'settings.read', 'settings.write', 'roles.manage'],
    },
  },
  discordEvidenceMappings: [],
};

interface CapturedResponse {
  statusCode: number;
  headers: Map<string, string | number | readonly string[]>;
  body: string;
  writableEnded: boolean;
}

function callbackResponse(): ServerResponse & CapturedResponse {
  const captured: CapturedResponse = {
    statusCode: 200,
    headers: new Map(),
    body: '',
    writableEnded: false,
  };
  return Object.assign(captured, {
    setHeader(name: string, value: string | number | readonly string[]) {
      captured.headers.set(name.toLowerCase(), value);
      return this;
    },
    writeHead(statusCode: number, headers?: Record<string, string>) {
      captured.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers ?? {})) {
        captured.headers.set(name.toLowerCase(), value);
      }
      return this;
    },
    end(body?: string) {
      captured.body = body ?? '';
      captured.writableEnded = true;
      return this;
    },
  }) as unknown as ServerResponse & CapturedResponse;
}

let harness: PostgresTestHarness | null = null;
const floorRoots: string[] = [];

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function roleUrl(databaseUrl: string, role: keyof typeof PASSWORDS): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = PASSWORDS[role];
  return url.toString();
}

async function createStore(options: {
  failDuringReconcile?: boolean;
  accountRoster?: FleetAuthConfig['accountRoster'];
} = {}): Promise<{
  store: PostgresFleetAuthBrokerStore;
  runtime: import('pg').Pool;
  coordinator: import('pg').Pool;
  migration: import('pg').Pool;
  authorityFloors: FleetAuthAuthorityFloorStore;
}> {
  if (!harness) throw new Error('Postgres harness unavailable');
  const database = await harness.createDatabase();
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    await admin.query(
      `GRANT CREATE, CONNECT ON DATABASE ${quoteIdentifier(database.databaseName)} TO ${quoteIdentifier(ROLES.migration)}`,
    );
  } finally {
    await admin.end();
  }
  const migrationUrl = roleUrl(database.databaseUrl, ROLES.migration);
  await migrateFleetAuthSchema({
    databaseUrl: migrationUrl,
    roles: ROLES,
  });
  const runtime = createPostgresPool(roleUrl(database.databaseUrl, ROLES.runtime), {
    max: 4,
    allowExitOnIdle: true,
  });
  const coordinator = createPostgresPool(roleUrl(database.databaseUrl, ROLES.backupRestore), {
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
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 300_000),
  });
  const consumed = await store.consumeOAuthTransaction({
    stateDigest,
    initiatingBrowserDigest,
    now: NOW,
  });
  expect(consumed.pkceVerifier).toBe(`pkce-verifier-${suffix}`);
  const token = `token-${suffix}`;
  const csrfToken = `csrf-${suffix}`;
  return { transactionId, token, csrfToken };
}

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (const role of Object.values(ROLES)) {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 16 PASSWORD '${PASSWORDS[role]}'`,
      );
    }
  } finally {
    await admin.end();
  }
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  for (const root of floorRoots) rmSync(root, { recursive: true, force: true });
}, TIMEOUT_MS);

describe('Postgres gateway OAuth/session authority', () => {
  it('leaves one active session and fences dependents when same-audience logins race', async () => {
    const { store, runtime, coordinator, migration } = await createStore();
    try {
      const firstInput = await authenticate(store, 'superseding-login-initial');
      const first = await store.createLoginSession({
        ...firstInput,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        providerMetadata: {},
        audience: 'fleet',
        now: NOW,
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });
      const escalationGrantId = randomUUID();
      await runtime.query(`
        INSERT INTO fleet_auth.escalation_grants
          (grant_id, principal_id, browser_session_id, companion_id, action,
           route_id, scope_digest, reason_digest, assurance_requirement,
           exact_origin, authz_version, binding_version, grant_version,
           policy_version, global_auth_epoch, created_at, expires_at)
        VALUES ($1, $2, $3, $4, 'memory.reveal',
                'POST /api/admin/memory/:id/reveal', $5, $6, 'escalated',
                'https://fleet.example.test', 1, 1, 1, 1, 1, $7, $8)
      `, [
        escalationGrantId,
        first.principalId,
        first.recordId,
        randomUUID(),
        'c'.repeat(64),
        'd'.repeat(64),
        NOW,
        new Date(NOW.getTime() + 300_000),
      ]);

      const nextInputs = await Promise.all(Array.from({ length: 3 }, (_, index) => (
        authenticate(store, `superseding-login-race-${index}`)
      )));
      const sessions = [
        first,
        ...await Promise.all(nextInputs.map((loginInput, index) => (
          store.createLoginSession({
            ...loginInput,
            providerSubjectId: PROVIDER_SUBJECT_ID,
            providerMetadata: {},
            audience: 'fleet',
            now: new Date(NOW.getTime() + index + 1),
            idleTtlMs: 1_800_000,
            absoluteTtlMs: 28_800_000,
          })
        ))),
      ];

      const durable = await runtime.query<{
        record_id: string;
        revoked_at: Date | null;
        replaced_by: string | null;
      }>(`
        SELECT record_id, revoked_at, replaced_by
        FROM fleet_auth.browser_sessions
        WHERE principal_id = $1 AND audience = 'fleet'
        ORDER BY created_at, record_id
      `, [sessions[0]!.principalId]);
      const active = durable.rows.filter(row => (
        row.revoked_at === null && row.replaced_by === null
      ));
      expect(active).toHaveLength(1);
      expect(sessions.some(session => session.recordId === active[0]!.record_id)).toBe(true);
      expect(durable.rows.filter(row => row.record_id !== active[0]!.record_id).every(row => (
        row.revoked_at !== null && row.replaced_by !== null
      ))).toBe(true);

      const dependents = await runtime.query<{
        escalation_revoked: boolean;
      }>(`
        SELECT
          (SELECT revoked_at IS NOT NULL FROM fleet_auth.escalation_grants
           WHERE grant_id = $1) AS escalation_revoked
      `, [escalationGrantId]);
      expect(dependents.rows[0]).toEqual({ escalation_revoked: true });
    } finally {
      await migration.end();
      await coordinator.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('produces exact lifecycle OAuth evidence without linking the new provider subject', async () => {
    const { store, runtime, coordinator, migration } = await createStore();
    try {
      const loginInput = await authenticate(store, 'lifecycle-proof-producer');
      const login = await store.createLoginSession({
        ...loginInput,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        providerMetadata: {},
        audience: 'fleet',
        now: NOW,
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });
      const transactionId = randomUUID();
      const ceremonyId = randomUUID();
      const stateDigest = createHash('sha256').update('lifecycle-state').digest('hex');
      const browserDigest = createHash('sha256').update('lifecycle-browser').digest('hex');
      const lifecycleInput = {
        transactionId,
        stateDigest,
        initiatingBrowserDigest: browserDigest,
        pkceVerifier: 'lifecycle-pkce-verifier',
        callbackUri: 'https://fleet.example.test/auth/discord/callback',
        returnPath: '/fleet/security',
        kind: 'provider_link' as const,
        createdAt: new Date(NOW.getTime() + 1_000),
        expiresAt: new Date(NOW.getTime() + 301_000),
        token: login.token,
        csrfToken: login.csrfToken,
        lifecyclePurpose: {
          ceremonyId,
          action: 'provider.add' as const,
          proofRole: 'new' as const,
        },
      };
      await expect(store.createLifecycleOAuthTransaction({
        ...lifecycleInput,
        kind: 'recovery',
      })).rejects.toMatchObject({ code: 'oauth_transaction_kind_mismatch' });
      await store.createLifecycleOAuthTransaction(lifecycleInput);
      const consumed = await store.consumeOAuthTransaction({
        stateDigest,
        initiatingBrowserDigest: browserDigest,
        now: new Date(NOW.getTime() + 2_000),
      });
      expect(consumed.lifecyclePurpose).toEqual({
        ceremonyId,
        action: 'provider.add',
        proofRole: 'new',
        initiatingPrincipalId: login.principalId,
        initiatingSessionId: login.recordId,
      });
      await expect(store.createLoginSession({
        transactionId,
        providerSubjectId: '223456789012345679',
        providerMetadata: {},
        token: 'forbidden-login-token',
        csrfToken: 'forbidden-login-csrf',
        audience: 'fleet',
        now: new Date(NOW.getTime() + 2_000),
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      })).rejects.toMatchObject({ code: 'invalid_oauth_state' });
      const purpose = await store.completeLifecycleOAuthEvidence({
        transactionId,
        providerSubjectId: '223456789012345679',
        now: new Date(NOW.getTime() + 3_000),
      });
      expect(purpose).toEqual(consumed.lifecyclePurpose);
      const durable = await runtime.query<{
        provider_count: string;
        completed_session_id: string | null;
        verified_provider_subject_id: string;
      }>(`
        SELECT
          (SELECT count(*)::text FROM fleet_auth.provider_subjects
           WHERE subject_id = '223456789012345679') AS provider_count,
          completed_session_id,
          verified_provider_subject_id
        FROM fleet_auth.oauth_transactions
        WHERE transaction_id = $1
      `, [transactionId]);
      expect(durable.rows[0]).toEqual({
        provider_count: '0',
        completed_session_id: null,
        verified_provider_subject_id: '223456789012345679',
      });
    } finally {
      await migration.end();
      await coordinator.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('routes the live shared callback to lifecycle completion before consuming its transaction', async () => {
    const { store, runtime, coordinator, migration } = await createStore();
    const tlsSocket = new TLSSocket(new Socket());
    try {
      const loginInput = await authenticate(store, 'live-lifecycle-callback');
      const session = await store.createLoginSession({
        ...loginInput,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        providerMetadata: {},
        token: 's'.repeat(43),
        csrfToken: 'c'.repeat(43),
        audience: 'fleet',
        now: NOW,
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });
      const providerAccessToken = 'provider-access-secret-must-stay-server-side';
      const verifiedSubjectId = '223456789012345679';
      const broker = new GatewayFleetAuthBroker({
        config: CALLBACK_CONFIG,
        store,
        oauthClientSecret: 'discord-client-secret',
        sessionPepper: 'session-pepper-at-least-thirty-two-bytes',
        now: () => new Date(NOW.getTime() + 1_000),
        fetchImpl: vi.fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(JSON.stringify({
            access_token: providerAccessToken,
            token_type: 'Bearer',
            expires_in: 3_600,
            scope: 'identify',
          }), { status: 200, headers: { 'content-type': 'application/json' } }))
          .mockResolvedValueOnce(new Response(JSON.stringify({ id: verifiedSubjectId }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })),
      });
      const ceremonyId = randomUUID();
      const started = await broker.beginLifecycleOAuth({
        token: session.token,
        csrfToken: session.csrfToken,
        requestOrigin: CALLBACK_CONFIG.canonicalOrigin,
        returnPath: '/fleet/security',
        ceremonyId,
        action: 'provider.add',
        proofRole: 'new',
      });
      const state = new URL(started.authorizationUrl).searchParams.get('state')!;
      const stateDigest = createHmac('sha256', 'session-pepper-at-least-thirty-two-bytes')
        .update(state)
        .digest('hex');
      await expect(store.resolveOAuthCallbackDestination({
        stateDigest,
        initiatingBrowserDigest: createHmac(
          'sha256',
          'session-pepper-at-least-thirty-two-bytes',
        ).update(started.initiatingBrowserToken).digest('hex'),
        now: NOW,
      })).resolves.toBe('lifecycle');
      const pending = await runtime.query<{ status: string }>(`
        SELECT status
        FROM fleet_auth.oauth_transactions
        WHERE state_digest = $1
      `, [stateDigest]);
      expect(pending.rows[0]?.status).toBe('pending');
      const routes = new FleetAuthHttpRoutes({
        broker,
        canonicalOrigin: CALLBACK_CONFIG.canonicalOrigin,
        callbackPath: CALLBACK_CONFIG.callbackPath,
      });
      const request = {
        method: 'GET',
        headers: {
          host: 'fleet.example.test',
          cookie: `__Host-psfn_preauth=${started.initiatingBrowserToken}`,
        },
        socket: tlsSocket,
      } as IncomingMessage;
      const response = callbackResponse();
      await routes.handle(
        request,
        response,
        new URL(`${CALLBACK_CONFIG.canonicalOrigin}${CALLBACK_CONFIG.callbackPath}`
          + `?state=${encodeURIComponent(state)}&code=one-time-code`),
      );
      const transaction = await runtime.query<{
        status: string;
        verified_provider: string | null;
        verified_provider_subject_id: string | null;
        completed_session_id: string | null;
      }>(`
        SELECT status, verified_provider, verified_provider_subject_id, completed_session_id
        FROM fleet_auth.oauth_transactions
        WHERE state_digest = $1
      `, [stateDigest]);

      expect({
        statusCode: response.statusCode,
        receipt: JSON.parse(response.body) as unknown,
        transaction: transaction.rows[0],
      }).toEqual({
        statusCode: 200,
        receipt: {
          kind: 'lifecycle',
          returnPath: '/fleet/security',
          ceremonyId,
          action: 'provider.add',
          proofRole: 'new',
          proof: {
            provider: 'discord',
            subjectId: verifiedSubjectId,
            callbackTransactionId: expect.any(String),
            proofDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
          },
        },
        transaction: {
          status: 'consumed',
          verified_provider: 'discord',
          verified_provider_subject_id: verifiedSubjectId,
          completed_session_id: null,
        },
      });
      expect(response.headers.get('set-cookie')).toBe(
        '__Host-psfn_preauth=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
      );
      expect(response.body).not.toContain(providerAccessToken);
      expect(response.body).not.toContain(session.token);
    } finally {
      tlsSocket.destroy();
      await migration.end();
      await coordinator.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('durably fences Discord reauthentication against rotation with redacted audit evidence', async () => {
    const { store, runtime, coordinator, migration } = await createStore();
    try {
      const loginInput = await authenticate(store, 'discord-reauthentication-fence');
      const login = await store.createLoginSession({
        ...loginInput,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        providerMetadata: {},
        audience: 'fleet',
        now: NOW,
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });
      const fenceAt = new Date(NOW.getTime() + 1000);
      const concurrent = await Promise.allSettled([
        store.rotateSession({
          token: login.token,
          csrfToken: login.csrfToken,
          nextToken: 'must-be-fenced-rotated-token',
          nextCsrfToken: 'must-be-fenced-rotated-csrf',
          now: fenceAt,
          idleTtlMs: 1_800_000,
        }),
        store.fencePrincipalSessionsForDiscordReauthentication({
          principalId: login.principalId,
          now: fenceAt,
        }),
      ]);
      expect(concurrent[1]).toMatchObject({ status: 'fulfilled' });

      await store.revokeIssuedSessionForReauthentication({
        recordId: login.recordId,
        principalId: login.principalId,
        now: new Date(fenceAt.getTime() + 1),
      });
      const durable = await runtime.query<{
        live_sessions: string;
        audit_count: string;
        audit_projection: unknown;
      }>(`
        SELECT
          (SELECT count(*)::text FROM fleet_auth.browser_sessions
           WHERE principal_id = $1 AND revoked_at IS NULL) AS live_sessions,
          (SELECT count(*)::text FROM fleet_auth.authorization_audit_events
           WHERE principal_id = $1 AND action = 'session.reauthentication') AS audit_count,
          (SELECT jsonb_agg(jsonb_build_object(
             'actor', actor_context,
             'action', action,
             'resource', resource,
             'decision', decision,
             'reason', reason_code
           ) ORDER BY occurred_at, event_id)
           FROM fleet_auth.authorization_audit_events
           WHERE principal_id = $1 AND action = 'session.reauthentication') AS audit_projection
      `, [login.principalId]);
      expect(durable.rows[0]).toMatchObject({ live_sessions: '0', audit_count: '2' });
      expect(durable.rows[0]?.audit_projection).toEqual([
        {
          actor: { kind: 'system', boundary: 'discord_evidence_lifecycle' },
          action: 'session.reauthentication',
          resource: 'fleet',
          decision: 'deny',
          reason: 'discord_evidence_reauthentication_required',
        },
        {
          actor: { kind: 'system', boundary: 'discord_evidence_lifecycle' },
          action: 'session.reauthentication',
          resource: 'fleet',
          decision: 'deny',
          reason: 'discord_evidence_reauthentication_required',
        },
      ]);
      expect(JSON.stringify(durable.rows[0]?.audit_projection))
        .not.toMatch(new RegExp(`${PROVIDER_SUBJECT_ID}|must-be-fenced|token|csrf`, 'iu'));
      await expect(store.rotateSession({
        token: 'must-be-fenced-rotated-token',
        csrfToken: 'must-be-fenced-rotated-csrf',
        nextToken: 'must-not-survive-fence',
        nextCsrfToken: 'must-not-survive-fence-csrf',
        now: new Date(fenceAt.getTime() + 2),
        idleTtlMs: 1_800_000,
      })).rejects.toMatchObject({ code: 'invalid_session' });
    } finally {
      await migration.end();
      await coordinator.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('creates pending no-role principals, rotates once under races, and tombstones provider revocation', async () => {
    const ceremonyId = randomUUID();
    const companionId = randomUUID();
    const { store, runtime, coordinator, migration, authorityFloors } = await createStore({
      accountRoster: [{
        providerSubjectId: PROVIDER_SUBJECT_ID,
        companionId,
        contactId: 'owner-contact',
        role: 'owner',
      }],
    });
    try {
      await migration.query(`
        INSERT INTO fleet_auth.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider,
           expected_provider_subject_id, expected_companion_id,
           expected_contact_id, exact_scope, status, global_auth_epoch,
           created_at, expires_at)
        VALUES ($1, $2, 'first_owner', 'discord', $3, $4, 'owner-contact',
                '{"role":"owner"}'::jsonb, 'pending', 1,
                clock_timestamp(), clock_timestamp() + interval '5 minutes')
      `, [
        ceremonyId,
        'd'.repeat(64),
        PROVIDER_SUBJECT_ID,
        companionId,
      ]);
      const loginInput = await authenticate(store, 'first');
      const login = await store.createLoginSession({
        ...loginInput,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        providerMetadata: { mfaEnabled: true },
        audience: 'fleet',
        now: NOW,
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });
      expect(login.principalStatus).toBe('pending');

      const authority = await runtime.query<{
        status: string;
        bindings: string;
        roles: string;
        verified_provider: string;
        verified_provider_subject_id: string;
      }>(`
        SELECT principal.status,
               (SELECT count(*)::text FROM fleet_auth.principal_contact_bindings
                WHERE principal_id = principal.principal_id) AS bindings,
               (SELECT count(*)::text FROM fleet_auth.principal_role_grants
                WHERE principal_id = principal.principal_id) AS roles,
               transaction.verified_provider,
               transaction.verified_provider_subject_id
        FROM fleet_auth.human_principals AS principal
        JOIN fleet_auth.oauth_transactions AS transaction
          ON transaction.transaction_id = $2
        WHERE principal.principal_id = $1
      `, [login.principalId, loginInput.transactionId]);
      expect(authority.rows[0]).toEqual({
        status: 'pending',
        bindings: '0',
        roles: '0',
        verified_provider: 'discord',
        verified_provider_subject_id: PROVIDER_SUBJECT_ID,
      });

      const rotations = await Promise.allSettled([
        store.rotateSession({
          token: login.token,
          csrfToken: login.csrfToken,
          nextToken: 'rotated-token-a',
          nextCsrfToken: 'rotated-csrf-a',
          now: new Date(NOW.getTime() + 1000),
          idleTtlMs: 1_800_000,
        }),
        store.rotateSession({
          token: login.token,
          csrfToken: login.csrfToken,
          nextToken: 'rotated-token-b',
          nextCsrfToken: 'rotated-csrf-b',
          now: new Date(NOW.getTime() + 1000),
          idleTtlMs: 1_800_000,
        }),
      ]);
      const winner = rotations.find(result => result.status === 'fulfilled');
      expect(rotations.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(rotations.filter(result => result.status === 'rejected')).toHaveLength(1);
      if (!winner) throw new Error('Session rotation had no winner');

      const freshCsrf = await store.issueCsrf({
        token: winner.value.token,
        nextCsrfToken: 'fresh-csrf-token',
        now: new Date(NOW.getTime() + 2000),
      });
      expect(freshCsrf).toBe('fresh-csrf-token');
      const firstOwnerInput = {
        token: winner.value.token,
        csrfToken: freshCsrf,
        ceremonyId,
        principalId: login.principalId,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        companionId,
        contactId: 'owner-contact',
        contactAuthority: {
          schemaVersion: 1 as const,
          contactId: 'owner-contact',
          channel: 'discord' as const,
          providerSubjectId: PROVIDER_SUBJECT_ID,
          identityVersion: 2,
          verificationId: randomUUID(),
          verificationDigest: 'e'.repeat(64),
          contactAuthorityVersion: 3,
          ownershipState: 'verified' as const,
          restoreState: 'live' as const,
        },
        now: new Date(NOW.getTime() + 2500),
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      };
      const expiringCeremonyId = randomUUID();
      await migration.query(`
        INSERT INTO fleet_auth.trusted_host_ceremonies
          (ceremony_id, nonce_digest, kind, expected_provider,
           expected_provider_subject_id, expected_companion_id,
           expected_contact_id, exact_scope, status, global_auth_epoch,
           created_at, expires_at)
        VALUES ($1, $2, 'first_owner', 'discord', $3, $4, 'owner-contact',
                '{"role":"owner"}'::jsonb, 'pending', 1,
                clock_timestamp(), clock_timestamp() + interval '250 milliseconds')
      `, [
        expiringCeremonyId,
        'c'.repeat(64),
        PROVIDER_SUBJECT_ID,
        companionId,
      ]);
      const ceremonyLock = await migration.connect();
      try {
        await ceremonyLock.query('BEGIN');
        await ceremonyLock.query(`
          SELECT ceremony_id
          FROM fleet_auth.trusted_host_ceremonies
          WHERE ceremony_id = $1
          FOR UPDATE
        `, [expiringCeremonyId]);
        const blockedCompletion = store.completeFirstOwnerBootstrap({
          ...firstOwnerInput,
          ceremonyId: expiringCeremonyId,
          nextToken: 'expired-owner-token',
          nextCsrfToken: 'expired-owner-csrf',
        });
        await new Promise(resolve => setTimeout(resolve, 400));
        await ceremonyLock.query('COMMIT');
        await expect(blockedCompletion).rejects.toMatchObject({ code: 'first_owner_denied' });
      } finally {
        await ceremonyLock.query('ROLLBACK').catch(() => undefined);
        ceremonyLock.release();
      }
      const expiredAuthority = await runtime.query<{
        principal_status: string;
        ceremony_status: string;
        deny_audits: string;
      }>(`
        SELECT
          (SELECT status FROM fleet_auth.human_principals WHERE principal_id = $1)
            AS principal_status,
          (SELECT status FROM fleet_auth.trusted_host_ceremonies WHERE ceremony_id = $2)
            AS ceremony_status,
          (SELECT count(*)::text FROM fleet_auth.authorization_audit_events
           WHERE ceremony_id = $2 AND action = 'authority.first_owner'
             AND decision = 'deny') AS deny_audits
      `, [login.principalId, expiringCeremonyId]);
      expect(expiredAuthority.rows[0]).toEqual({
        principal_status: 'pending',
        ceremony_status: 'pending',
        deny_audits: '1',
      });
      await expect(store.completeFirstOwnerBootstrap({
        ...firstOwnerInput,
        companionId: randomUUID(),
        nextToken: 'mismatched-owner-token',
        nextCsrfToken: 'mismatched-owner-csrf',
      })).rejects.toMatchObject({ code: 'first_owner_denied' });
      const ownerAttempts = await Promise.allSettled([
        store.completeFirstOwnerBootstrap({
          ...firstOwnerInput,
          nextToken: 'owner-session-token-a',
          nextCsrfToken: 'owner-session-csrf-a',
        }),
        store.completeFirstOwnerBootstrap({
          ...firstOwnerInput,
          nextToken: 'owner-session-token-b',
          nextCsrfToken: 'owner-session-csrf-b',
        }),
      ]);
      expect(ownerAttempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(ownerAttempts.filter(result => result.status === 'rejected')).toHaveLength(1);
      const ownerWinner = ownerAttempts.find(result => result.status === 'fulfilled');
      if (!ownerWinner) throw new Error('First-owner race had no winner');
      const ownerSession = ownerWinner.value;
      expect(ownerSession.principalStatus).toBe('active');
      const ownerAuthority = await runtime.query<{
        status: string;
        binding_count: string;
        owner_count: string;
        ceremony_status: string;
        global_auth_epoch: string;
      }>(`
        SELECT principal.status,
               (SELECT count(*)::text FROM fleet_auth.principal_contact_bindings
                WHERE principal_id = principal.principal_id AND state = 'active') AS binding_count,
               (SELECT count(*)::text FROM fleet_auth.principal_role_grants
                WHERE principal_id = principal.principal_id AND role = 'owner'
                  AND lifecycle = 'active') AS owner_count,
               (SELECT status FROM fleet_auth.trusted_host_ceremonies
                WHERE ceremony_id = $2) AS ceremony_status,
               (SELECT global_auth_epoch::text FROM fleet_auth.authority_state
                WHERE singleton = TRUE) AS global_auth_epoch
        FROM fleet_auth.human_principals AS principal
        WHERE principal.principal_id = $1
      `, [login.principalId, ceremonyId]);
      expect(ownerAuthority.rows[0]).toEqual({
        status: 'active',
        binding_count: '1',
        owner_count: '1',
        ceremony_status: 'consumed',
        global_auth_epoch: '2',
      });
      await store.revokeProvider({
        token: ownerSession.token,
        csrfToken: ownerSession.csrfToken,
        now: new Date(NOW.getTime() + 3000),
        reasonDigest: 'b'.repeat(64),
      });
      expect(authorityFloors.isAccountAuthorityTombstoned(
        'provider_subject',
        `discord:${PROVIDER_SUBJECT_ID}`,
      )).toBe(true);

      const fenced = await runtime.query<{
        principal_status: string;
        provider_state: string;
        tombstones: string;
        live_sessions: string;
      }>(`
        SELECT principal.status AS principal_status, subject.state AS provider_state,
               (SELECT count(*)::text FROM fleet_auth.provider_subject_tombstones
                WHERE provider = 'discord' AND subject_id = $2) AS tombstones,
               (SELECT count(*)::text FROM fleet_auth.browser_sessions
                WHERE principal_id = principal.principal_id AND revoked_at IS NULL) AS live_sessions
        FROM fleet_auth.human_principals AS principal
        JOIN fleet_auth.provider_subjects AS subject
          ON subject.principal_id = principal.principal_id
        WHERE principal.principal_id = $1
      `, [login.principalId, PROVIDER_SUBJECT_ID]);
      expect(fenced.rows[0]).toEqual({
        principal_status: 'suspended',
        provider_state: 'revoked',
        tombstones: '1',
        live_sessions: '0',
      });

      const replay = await authenticate(store, 'second');
      await expect(store.createLoginSession({
        ...replay,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        providerMetadata: {},
        audience: 'fleet',
        now: NOW,
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      })).rejects.toMatchObject({ code: 'provider_subject_suspended' });
    } finally {
      await migration.end();
      await coordinator.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('immediately over-fences live sessions when reconciliation fails after floor publication', async () => {
    const { store, runtime, coordinator, migration, authorityFloors } = await createStore({
      failDuringReconcile: true,
    });
    try {
      const loginInput = await authenticate(store, 'partial-provider-revoke');
      const login = await store.createLoginSession({
        ...loginInput,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        providerMetadata: {},
        audience: 'fleet',
        now: NOW,
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });
      const before = authorityFloors.read();
      await expect(store.revokeProvider({
        token: login.token,
        csrfToken: login.csrfToken,
        now: new Date(NOW.getTime() + 1000),
        reasonDigest: 'e'.repeat(64),
      })).rejects.toThrow(/injected failure during provider authority reconciliation/);

      const fenced = authorityFloors.read();
      expect(fenced.trustedHost.authorityGeneration)
        .toBe(before.trustedHost.authorityGeneration + 1);
      expect(authorityFloors.isAccountAuthorityTombstoned(
        'provider_subject',
        `discord:${PROVIDER_SUBJECT_ID}`,
        fenced,
      )).toBe(true);
      const beforeRecovery = await runtime.query<{ status: string; state: string; sessions: string }>(`
        SELECT principal.status, subject.state,
               (SELECT count(*)::text FROM fleet_auth.browser_sessions
                WHERE principal_id = principal.principal_id AND revoked_at IS NULL) AS sessions
        FROM fleet_auth.human_principals AS principal
        JOIN fleet_auth.provider_subjects AS subject USING (principal_id)
        WHERE principal.principal_id = $1
      `, [login.principalId]);
      expect(beforeRecovery.rows[0]).toEqual({ status: 'pending', state: 'pending', sessions: '1' });

      const sessionUseAt = new Date(NOW.getTime() + 1500);
      await expect(store.rotateSession({
        token: login.token,
        csrfToken: login.csrfToken,
        nextToken: 'must-not-rotate-after-provider-floor',
        nextCsrfToken: 'must-not-rotate-csrf-after-provider-floor',
        now: sessionUseAt,
        idleTtlMs: 1_800_000,
      })).rejects.toMatchObject({ code: 'invalid_session' });
      await expect(store.issueCsrf({
        token: login.token,
        nextCsrfToken: 'must-not-issue-csrf-after-provider-floor',
        now: sessionUseAt,
      })).rejects.toMatchObject({ code: 'invalid_session' });
      await expect(store.revokeSession({
        token: login.token,
        csrfToken: login.csrfToken,
        now: sessionUseAt,
      })).rejects.toMatchObject({ code: 'invalid_session' });

      await reconcileFleetAuthAuthorityState(coordinator, fenced, randomUUID());
      const recovered = await runtime.query<{ status: string; state: string; sessions: string }>(`
        SELECT principal.status, subject.state,
               (SELECT count(*)::text FROM fleet_auth.browser_sessions
                WHERE principal_id = principal.principal_id) AS sessions
        FROM fleet_auth.human_principals AS principal
        JOIN fleet_auth.provider_subjects AS subject USING (principal_id)
        WHERE principal.principal_id = $1
      `, [login.principalId]);
      expect(recovered.rows[0]).toEqual({
        status: 'quarantined',
        state: 'quarantined',
        sessions: '0',
      });
      await expect(createGatewayAccountReapprovalAuthority(
        runtime,
        authorityFloors,
      )({
        ceremonyId: randomUUID(),
        principalId: login.principalId,
        provider: 'discord',
        providerSubjectId: PROVIDER_SUBJECT_ID,
        companionId: randomUUID(),
        contactId: 'partial-revoke-reapproval-attempt',
        bindingId: randomUUID(),
        roleGrantId: randomUUID(),
        auditEventId: randomUUID(),
        at: new Date(NOW.getTime() + 2000).toISOString(),
      })).rejects.toThrow(/permanently tombstoned by non-restored authority/i);
    } finally {
      await migration.end();
      await coordinator.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('atomically expires and rejects replayed OAuth state', async () => {
    const { store, runtime, coordinator, migration } = await createStore();
    try {
      const transactionId = randomUUID();
      const stateDigest = 'c'.repeat(64);
      const initiatingBrowserDigest = 'd'.repeat(64);
      await store.createOAuthTransaction({
        transactionId,
        stateDigest,
        initiatingBrowserDigest,
        pkceVerifier: 'expired-pkce-verifier',
        callbackUri: 'https://fleet.example.test/auth/discord/callback',
        returnPath: '/fleet',
        kind: 'login',
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 1000),
      });
      await expect(store.consumeOAuthTransaction({
        stateDigest,
        initiatingBrowserDigest,
        now: new Date(NOW.getTime() + 1001),
      })).rejects.toMatchObject({ code: 'expired_oauth_transaction' });
      await expect(store.consumeOAuthTransaction({
        stateDigest,
        initiatingBrowserDigest,
        now: new Date(NOW.getTime() + 1002),
      })).rejects.toMatchObject({ code: 'invalid_oauth_state' });
    } finally {
      await migration.end();
      await coordinator.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('does not consume browser A OAuth state when browser B presents the callback', async () => {
    const { store, runtime, coordinator, migration } = await createStore();
    try {
      const transactionId = randomUUID();
      const stateDigest = 'a'.repeat(64);
      const browserADigest = 'b'.repeat(64);
      await store.createOAuthTransaction({
        transactionId,
        stateDigest,
        initiatingBrowserDigest: browserADigest,
        pkceVerifier: 'browser-bound-pkce-verifier',
        callbackUri: 'https://fleet.example.test/auth/discord/callback',
        returnPath: '/fleet',
        kind: 'login',
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 300_000),
      });

      await expect(store.consumeOAuthTransaction({
        stateDigest,
        initiatingBrowserDigest: 'c'.repeat(64),
        now: NOW,
      })).rejects.toMatchObject({ code: 'invalid_oauth_state' });
      await expect(store.consumeOAuthTransaction({
        stateDigest,
        initiatingBrowserDigest: browserADigest,
        now: NOW,
      })).resolves.toMatchObject({ transactionId, pkceVerifier: 'browser-bound-pkce-verifier' });
    } finally {
      await migration.end();
      await coordinator.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it.each([
    ['pending', 'pending', true],
    ['active', 'active', true],
    ['pending', 'active', false],
    ['active', 'pending', false],
  ] as const)(
    'accepts only coherent provider/principal login state %s/%s',
    async (providerState, principalStatus, allowed) => {
      const { store, runtime, coordinator, migration } = await createStore();
      try {
        const initialInput = await authenticate(store, `matrix-initial-${providerState}-${principalStatus}`);
        const initial = await store.createLoginSession({
          ...initialInput,
          providerSubjectId: PROVIDER_SUBJECT_ID,
          providerMetadata: {},
          audience: 'fleet',
          now: NOW,
          idleTtlMs: 1_800_000,
          absoluteTtlMs: 28_800_000,
        });
        await migration.query(
          `UPDATE fleet_auth.provider_subjects SET state = $2 WHERE principal_id = $1`,
          [initial.principalId, providerState],
        );
        await migration.query(
          `UPDATE fleet_auth.human_principals SET status = $2 WHERE principal_id = $1`,
          [initial.principalId, principalStatus],
        );
        const nextInput = await authenticate(store, `matrix-next-${providerState}-${principalStatus}`);
        const attempt = store.createLoginSession({
          ...nextInput,
          providerSubjectId: PROVIDER_SUBJECT_ID,
          providerMetadata: {},
          audience: 'fleet',
          now: NOW,
          idleTtlMs: 1_800_000,
          absoluteTtlMs: 28_800_000,
        });
        if (allowed) {
          await expect(attempt).resolves.toMatchObject({ principalStatus });
        } else {
          await expect(attempt).rejects.toMatchObject({ code: 'provider_subject_suspended' });
        }
      } finally {
        await migration.end();
        await coordinator.end();
        await runtime.end();
      }
    },
    TIMEOUT_MS,
  );
  it('activates an exact rostered first owner during the first fresh-fleet login', async () => {
    const companionId = randomUUID();
    const { store, runtime, coordinator, migration } = await createStore({
      accountRoster: [{
        providerSubjectId: PROVIDER_SUBJECT_ID,
        companionId,
        contactId: 'owner-contact',
        role: 'owner',
      }, {
        providerSubjectId: SECOND_PROVIDER_SUBJECT_ID,
        companionId,
        contactId: 'second-owner-contact',
        role: 'owner',
      }],
    });
    try {
      const loginInput = await authenticate(store, 'rostered-first-owner');
      const login = await store.createLoginSession({
        ...loginInput,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        providerMetadata: { mfaEnabled: true },
        audience: 'fleet',
        now: NOW,
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });

      expect(login.principalStatus).toBe('active');
      const authority = await runtime.query<{
        principal_status: string;
        provider_state: string;
        authn_version: string;
        authz_version: string;
        binding_version: string;
        grant_version: string;
        policy_version: string;
        global_auth_epoch: string;
        session_global_auth_epoch: string;
        bindings: string;
        grants: string;
        activation_audits: string;
        login_reason: string;
      }>(`
        SELECT principal.status AS principal_status,
               subject.state AS provider_state,
               principal.authn_version::text,
               principal.authz_version::text,
               principal.binding_version::text,
               principal.grant_version::text,
               principal.policy_version::text,
               authority.global_auth_epoch::text,
               session.global_auth_epoch::text AS session_global_auth_epoch,
               (SELECT count(*)::text FROM fleet_auth.principal_contact_bindings
                WHERE principal_id = principal.principal_id) AS bindings,
               (SELECT count(*)::text FROM fleet_auth.principal_role_grants
                WHERE principal_id = principal.principal_id) AS grants,
               (SELECT count(*)::text FROM fleet_auth.authorization_audit_events
                WHERE principal_id = principal.principal_id
                  AND action = 'authority.first_owner'
                  AND reason_code = 'account_roster_first_owner') AS activation_audits,
               (SELECT reason_code FROM fleet_auth.authorization_audit_events
                WHERE principal_id = principal.principal_id AND action = 'session.login'
                ORDER BY occurred_at DESC LIMIT 1) AS login_reason
        FROM fleet_auth.human_principals AS principal
        JOIN fleet_auth.provider_subjects AS subject
          ON subject.principal_id = principal.principal_id
         AND subject.provider = 'discord'
         AND subject.subject_id = $2
        JOIN fleet_auth.browser_sessions AS session
          ON session.record_id = $3
        JOIN fleet_auth.authority_state AS authority ON authority.singleton = TRUE
        WHERE principal.principal_id = $1
      `, [login.principalId, PROVIDER_SUBJECT_ID, login.recordId]);
      expect(authority.rows[0]).toEqual({
        principal_status: 'active',
        provider_state: 'active',
        authn_version: '2',
        authz_version: '2',
        binding_version: '2',
        grant_version: '2',
        policy_version: '2',
        global_auth_epoch: '1',
        session_global_auth_epoch: '1',
        bindings: '0',
        grants: '0',
        activation_audits: '1',
        login_reason: 'rostered_first_owner',
      });

      const secondLoginInput = await authenticate(store, 'rostered-second-owner');
      const secondLogin = await store.createLoginSession({
        ...secondLoginInput,
        providerSubjectId: SECOND_PROVIDER_SUBJECT_ID,
        providerMetadata: {},
        audience: 'fleet',
        now: new Date(NOW.getTime() + 1_000),
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });
      expect(secondLogin.principalStatus).toBe('pending');
    } finally {
      await migration.end();
      await coordinator.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('keeps an unmapped rostered first owner pending until a usable binding exists', async () => {
    const companionId = randomUUID();
    const { store, runtime, coordinator, migration } = await createStore({
      accountRoster: [{
        providerSubjectId: PROVIDER_SUBJECT_ID,
        companionId,
        role: 'owner',
      }],
    });
    try {
      const loginInput = await authenticate(store, 'unmapped-first-owner');
      const login = await store.createLoginSession({
        ...loginInput,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        providerMetadata: {},
        audience: 'fleet',
        now: NOW,
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });

      expect(login.principalStatus).toBe('pending');
      const audits = await runtime.query<{ count: string }>(`
        SELECT count(*)::text
        FROM fleet_auth.authorization_audit_events
        WHERE principal_id = $1 AND action = 'authority.first_owner'
      `, [login.principalId]);
      expect(audits.rows[0]?.count).toBe('0');

      await migration.query(`
        INSERT INTO fleet_auth.principal_contact_bindings
          (binding_id, principal_id, companion_id, contact_id, state,
           verification_provenance, authority_generation)
        VALUES ($1, $2, $3, 'owner-contact', 'active',
                '{"kind":"integration_test"}'::jsonb, 1)
      `, [randomUUID(), login.principalId, companionId]);
      const retryInput = await authenticate(store, 'bound-first-owner');
      const retry = await store.createLoginSession({
        ...retryInput,
        providerSubjectId: PROVIDER_SUBJECT_ID,
        providerMetadata: {},
        audience: 'fleet',
        now: new Date(NOW.getTime() + 1_000),
        idleTtlMs: 1_800_000,
        absoluteTtlMs: 28_800_000,
      });
      expect(retry.principalStatus).toBe('active');
    } finally {
      await migration.end();
      await coordinator.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);
});
