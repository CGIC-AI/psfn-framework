import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FleetAuthConfig } from '../../system/config/fleet-auth-config.js';
import {
  FleetAuthBrokerError,
  GatewayFleetAuthBroker,
  type ConsumedOAuthTransaction,
  type FleetAuthBrokerStore,
  type FleetAuthSessionRecord,
  type OAuthTransactionInput,
  type FirstOwnerAssurancePort,
} from './fleet-auth-broker.js';

const config: FleetAuthConfig = {
  schemaVersion: 1,
  activationGeneration: 1,
  canonicalOrigin: 'https://fleet.example.test',
  callbackPath: '/auth/discord/callback',
  provider: {
    kind: 'discord',
    clientId: '123456789012345678',
    scopes: ['identify'],
    clientSecretRef: { kind: 'env', envName: 'DISCORD_SECRET' },
    tokenCustody: 'discard',
  },
  credentials: {
    tokenEncryptionKeyRef: { kind: 'env', envName: 'TOKEN_KEY' },
    sessionPepperRef: { kind: 'env', envName: 'SESSION_PEPPER' },
    assertionPrivateKeyRef: { kind: 'env', envName: 'ASSERTION_KEY' },
    trustedHostRecoveryCredentialRef: { kind: 'env', envName: 'RECOVERY_KEY' },
    runtimeDatabaseUrlRef: { kind: 'env', envName: 'RUNTIME_DB' },
    migrationDatabaseUrlRef: { kind: 'env', envName: 'MIGRATION_DB' },
    backupRestoreDatabaseUrlRef: { kind: 'env', envName: 'BACKUP_DB' },
    authorityFloorRootRef: { kind: 'env', envName: 'FLOOR_ROOT' },
  },
  databaseRoles: {
    runtime: 'fleet_auth_runtime',
    migration: 'fleet_auth_migration',
    backupRestore: 'fleet_auth_backup',
  },
  verifierKeys: [],
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
    disabledActionsByRole: { owner: [], admin: [], member: [], guest: [] },
  },
  discordEvidenceMappings: [],
};

class FakeStore implements FleetAuthBrokerStore {
  transaction: OAuthTransactionInput | null = null;
  consumed = false;
  session: FleetAuthSessionRecord | null = null;
  principalStatus: 'pending' | 'active' = 'pending';
  lastProviderSubject: string | null = null;

  async createOAuthTransaction(input: OAuthTransactionInput): Promise<void> {
    this.transaction = input;
  }

  async consumeOAuthTransaction(stateDigest: string, now: Date): Promise<ConsumedOAuthTransaction> {
    if (!this.transaction || this.consumed || this.transaction.stateDigest !== stateDigest) {
      throw new FleetAuthBrokerError('invalid_oauth_state', 400);
    }
    if (this.transaction.expiresAt.getTime() <= now.getTime()) {
      throw new FleetAuthBrokerError('expired_oauth_transaction', 400);
    }
    this.consumed = true;
    return {
      transactionId: this.transaction.transactionId,
      kind: this.transaction.kind,
      pkceVerifier: this.transaction.pkceVerifier,
      callbackUri: this.transaction.callbackUri,
      returnPath: this.transaction.returnPath,
    };
  }

  async createLoginSession(input: Parameters<FleetAuthBrokerStore['createLoginSession']>[0]) {
    this.lastProviderSubject = input.providerSubjectId;
    this.session = {
      recordId: '00000000-0000-4000-8000-000000000101',
      principalId: '00000000-0000-4000-8000-000000000102',
      principalStatus: this.principalStatus,
      token: input.token,
      csrfToken: input.csrfToken,
      idleExpiresAt: new Date(input.now.getTime() + config.ttls.sessionIdleMs),
      absoluteExpiresAt: new Date(input.now.getTime() + config.ttls.sessionAbsoluteMs),
    };
    return this.session;
  }

  async rotateSession(input: Parameters<FleetAuthBrokerStore['rotateSession']>[0]) {
    if (!this.session || input.token !== this.session.token || input.csrfToken !== this.session.csrfToken) {
      throw new FleetAuthBrokerError('invalid_session', 401);
    }
    this.session = {
      ...this.session,
      token: input.nextToken,
      csrfToken: input.nextCsrfToken,
      idleExpiresAt: new Date(input.now.getTime() + config.ttls.sessionIdleMs),
    };
    return this.session;
  }

  async issueCsrf(input: Parameters<FleetAuthBrokerStore['issueCsrf']>[0]) {
    if (!this.session || input.token !== this.session.token) {
      throw new FleetAuthBrokerError('invalid_session', 401);
    }
    this.session = { ...this.session, csrfToken: input.nextCsrfToken };
    return input.nextCsrfToken;
  }

  async revokeSession(input: Parameters<FleetAuthBrokerStore['revokeSession']>[0]) {
    if (!this.session || input.token !== this.session.token || input.csrfToken !== this.session.csrfToken) {
      throw new FleetAuthBrokerError('invalid_session', 401);
    }
    this.session = null;
  }

  async revokeProvider(input: Parameters<FleetAuthBrokerStore['revokeProvider']>[0]) {
    if (!this.session || input.token !== this.session.token || input.csrfToken !== this.session.csrfToken) {
      throw new FleetAuthBrokerError('invalid_session', 401);
    }
    this.session = null;
  }

  async completeFirstOwnerBootstrap(
    input: Parameters<FleetAuthBrokerStore['completeFirstOwnerBootstrap']>[0],
  ) {
    if (!this.session || input.token !== this.session.token
      || input.csrfToken !== this.session.csrfToken
      || input.principalId !== this.session.principalId
      || input.providerSubjectId !== this.lastProviderSubject) {
      throw new FleetAuthBrokerError('first_owner_binding_mismatch', 403);
    }
    this.session = {
      ...this.session,
      principalStatus: 'active',
      token: input.nextToken,
      csrfToken: input.nextCsrfToken,
    };
    return this.session;
  }
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeBroker(
  store = new FakeStore(),
  fetchImpl = vi.fn<typeof fetch>(),
  firstOwnerAssurance?: FirstOwnerAssurancePort,
) {
  const bytes = Array.from({ length: 16 }, (_, index) => index + 1);
  let randomOffset = 0;
  const broker = new GatewayFleetAuthBroker({
    config,
    store,
    oauthClientSecret: 'discord-client-secret',
    sessionPepper: 'session-pepper-at-least-thirty-two-bytes',
    fetchImpl,
    now: () => new Date('2026-07-15T12:00:00.000Z'),
    randomBytes: (length) => {
      const result = Buffer.from(Array.from(
        { length },
        (_, index) => bytes[(randomOffset + index) % bytes.length]!,
      )).subarray(0, length);
      randomOffset += 1;
      return result;
    },
    ...(firstOwnerAssurance ? { firstOwnerAssurance } : {}),
  });
  return { broker, store, fetchImpl };
}

describe('gateway fleet auth broker', () => {
  it('starts only login transactions with exact callback, allowlisted return path, and PKCE S256', async () => {
    const { broker, store } = makeBroker();

    const started = await broker.beginLogin({ returnPath: '/fleet?companion=alpha' });

    const authorization = new URL(started.authorizationUrl);
    expect(authorization.origin).toBe('https://discord.com');
    expect(authorization.pathname).toBe('/oauth2/authorize');
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('client_id')).toBe(config.provider.clientId);
    expect(authorization.searchParams.get('redirect_uri')).toBe(
      'https://fleet.example.test/auth/discord/callback',
    );
    expect(authorization.searchParams.get('scope')).toBe('identify');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(store.transaction).toMatchObject({
      kind: 'login',
      callbackUri: 'https://fleet.example.test/auth/discord/callback',
      returnPath: '/fleet?companion=alpha',
    });
    expect(authorization.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(store.transaction!.pkceVerifier).digest('base64url'),
    );
    await expect(broker.beginLogin({ returnPath: '//evil.example' }))
      .rejects.toMatchObject({ code: 'invalid_return_path' });
    await expect(broker.beginLogin({ returnPath: '/%2f%2fevil.example' }))
      .rejects.toMatchObject({ code: 'invalid_return_path' });
  });

  it('exchanges a code server-side, resolves only the stable subject, and creates a pending no-role session', async () => {
    const store = new FakeStore();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, {
        access_token: 'provider-access-secret',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'identify',
      }))
      .mockResolvedValueOnce(response(200, {
        id: '123456789012345679',
        username: 'mutable-display-name',
        mfa_enabled: true,
      }));
    const { broker } = makeBroker(store, fetchImpl);
    const started = await broker.beginLogin({ returnPath: '/fleet' });

    const completed = await broker.completeCallback({
      state: new URL(started.authorizationUrl).searchParams.get('state')!,
      code: 'one-time-code',
      requestOrigin: config.canonicalOrigin,
    });

    expect(completed.returnPath).toBe('/fleet');
    expect(completed.session.principalStatus).toBe('pending');
    expect(store.lastProviderSubject).toBe('123456789012345679');
    expect(JSON.stringify(completed)).not.toContain('provider-access-secret');
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://discord.com/api/v10/oauth2/token', expect.objectContaining({
      method: 'POST',
    }));
    const exchangeBody = fetchImpl.mock.calls[0]?.[1]?.body;
    expect(String(exchangeBody)).toContain('grant_type=authorization_code');
    expect(String(exchangeBody)).toContain('code_verifier=');
    expect(String(exchangeBody)).not.toContain('state=');
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://discord.com/api/v10/users/@me', expect.objectContaining({
      headers: { Authorization: 'Bearer provider-access-secret' },
    }));
  });

  it('consumes state once and fails closed on origin mismatch, expiry, provider outage, and malformed identity', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { broker, store } = makeBroker(new FakeStore(), fetchImpl);
    const started = await broker.beginLogin({ returnPath: '/fleet' });
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;

    await expect(broker.completeCallback({
      state,
      code: 'code',
      requestOrigin: 'https://attacker.example',
    })).rejects.toMatchObject({ code: 'callback_origin_mismatch' });
    expect(store.consumed).toBe(false);

    fetchImpl.mockRejectedValueOnce(new Error('provider failed with provider-access-secret'));
    await expect(broker.completeCallback({
      state,
      code: 'code',
      requestOrigin: config.canonicalOrigin,
    })).rejects.toMatchObject({ code: 'provider_unavailable', message: 'Discord OAuth provider unavailable' });
    await expect(broker.completeCallback({
      state,
      code: 'code',
      requestOrigin: config.canonicalOrigin,
    })).rejects.toMatchObject({ code: 'invalid_oauth_state' });

    const malformedFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, {
        access_token: 'access-secret', token_type: 'Bearer', expires_in: 3600, scope: 'identify',
      }))
      .mockResolvedValueOnce(response(200, { id: 'not-a-snowflake' }));
    const malformed = makeBroker(new FakeStore(), malformedFetch);
    const malformedStart = await malformed.broker.beginLogin({ returnPath: '/fleet' });
    await expect(malformed.broker.completeCallback({
      state: new URL(malformedStart.authorizationUrl).searchParams.get('state')!,
      code: 'code',
      requestOrigin: config.canonicalOrigin,
    })).rejects.toMatchObject({ code: 'malformed_provider_response' });
  });

  it('rotates opaque sessions and requires exact origin plus the session-bound CSRF for mutations', async () => {
    const store = new FakeStore();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, {
        access_token: 'access-secret', token_type: 'Bearer', expires_in: 3600, scope: 'identify',
      }))
      .mockResolvedValueOnce(response(200, { id: '123456789012345679' }));
    const { broker } = makeBroker(store, fetchImpl);
    const started = await broker.beginLogin({ returnPath: '/fleet' });
    const login = await broker.completeCallback({
      state: new URL(started.authorizationUrl).searchParams.get('state')!,
      code: 'code',
      requestOrigin: config.canonicalOrigin,
    });

    await expect(broker.rotateSession({
      token: login.session.token,
      csrfToken: login.session.csrfToken,
      requestOrigin: 'https://attacker.example',
    })).rejects.toMatchObject({ code: 'origin_mismatch' });
    await expect(broker.rotateSession({
      token: login.session.token,
      csrfToken: 'wrong-csrf',
      requestOrigin: config.canonicalOrigin,
    })).rejects.toMatchObject({ code: 'invalid_session' });

    const rotated = await broker.rotateSession({
      token: login.session.token,
      csrfToken: login.session.csrfToken,
      requestOrigin: config.canonicalOrigin,
    });
    expect(rotated.token).not.toBe(login.session.token);
    await expect(broker.logout({
      token: login.session.token,
      csrfToken: login.session.csrfToken,
      requestOrigin: config.canonicalOrigin,
    })).rejects.toMatchObject({ code: 'invalid_session' });
    await expect(broker.logout({
      token: rotated.token,
      csrfToken: rotated.csrfToken,
      requestOrigin: config.canonicalOrigin,
    })).resolves.toBeUndefined();
  });

  it('activates first owner only from gateway-verified exact trusted-host and WebAuthn assurance', async () => {
    const store = new FakeStore();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, {
        access_token: 'access-secret', token_type: 'Bearer', expires_in: 3600, scope: 'identify',
      }))
      .mockResolvedValueOnce(response(200, { id: '123456789012345679' }));
    const assurance: FirstOwnerAssurancePort = {
      verify: vi.fn(async () => ({
        ceremonyId: '00000000-0000-4000-8000-000000000110',
        principalId: '00000000-0000-4000-8000-000000000102',
        providerSubjectId: '123456789012345679',
        companionId: '00000000-0000-4000-8000-000000000111',
        contactId: 'owner-contact',
      })),
    };
    const { broker } = makeBroker(store, fetchImpl, assurance);
    const started = await broker.beginLogin({ returnPath: '/fleet' });
    const login = await broker.completeCallback({
      state: new URL(started.authorizationUrl).searchParams.get('state')!,
      code: 'code',
      requestOrigin: config.canonicalOrigin,
    });

    const elevated = await broker.completeFirstOwnerBootstrap({
      token: login.session.token,
      csrfToken: login.session.csrfToken,
      requestOrigin: config.canonicalOrigin,
      assuranceEvidence: { opaqueWebAuthnAndTrustedHostResponse: true },
    });
    expect(assurance.verify).toHaveBeenCalledWith({
      evidence: { opaqueWebAuthnAndTrustedHostResponse: true },
      expectedOrigin: config.canonicalOrigin,
    });
    expect(elevated.principalStatus).toBe('active');
    expect(elevated.token).not.toBe(login.session.token);

    const unavailable = makeBroker(new FakeStore(), vi.fn<typeof fetch>());
    await expect(unavailable.broker.completeFirstOwnerBootstrap({
      token: 'a'.repeat(43),
      csrfToken: 'b'.repeat(43),
      requestOrigin: config.canonicalOrigin,
      assuranceEvidence: {},
    })).rejects.toMatchObject({ code: 'strong_assurance_unavailable' });
  });
});
