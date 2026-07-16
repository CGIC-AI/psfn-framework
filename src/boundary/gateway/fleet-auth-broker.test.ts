import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FleetAuthConfig } from '../../system/config/fleet-auth-config.js';
import type { DiscordEvidenceLifecyclePort } from './discord-evidence-broker-boundary.js';
import type { LifecycleOAuthPurpose } from '../../shared/contracts/fleet-auth-lifecycle-oauth.js';
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
  hubDeviceAssertions: {
    issuer: 'psfn-satellite-hub',
    audience: 'https://fleet.example.test',
    maxTtlSeconds: 60,
    clockSkewSeconds: 2,
    keys: [],
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
    disabledActionsByRole: { owner: [], admin: [], member: [], guest: [] },
  },
  discordEvidenceMappings: [],
};

const mappedConfig: FleetAuthConfig = {
  ...config,
  provider: { ...config.provider, scopes: ['identify', 'guilds', 'guilds.members.read'] },
  discordEvidenceMappings: [{
    guildId: '223456789012345678',
    channelId: '323456789012345678',
    companionId: '00000000-0000-4000-8000-000000000201',
    requiredRoleIds: ['423456789012345678'],
  }],
};

function mappedLoginFetch() {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response(200, {
      access_token: 'provider-access-secret',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'identify guilds guilds.members.read',
    }))
    .mockResolvedValueOnce(response(200, { id: '123456789012345679' }))
    .mockResolvedValueOnce(response(200, [{ id: '223456789012345678' }]))
    .mockResolvedValueOnce(response(200, {
      user: { id: '123456789012345679' },
      roles: ['423456789012345678'],
    }));
}

class FakeStore implements FleetAuthBrokerStore {
  transaction: OAuthTransactionInput | null = null;
  consumed = false;
  session: FleetAuthSessionRecord | null = null;
  principalStatus: 'pending' | 'active' = 'pending';
  lastProviderSubject: string | null = null;
  providerRevocationError: Error | undefined;
  lifecyclePurpose: LifecycleOAuthPurpose | null = null;

  async createOAuthTransaction(input: OAuthTransactionInput): Promise<void> {
    this.transaction = input;
  }

  async resolveOAuthCallbackDestination(
    input: Parameters<FleetAuthBrokerStore['resolveOAuthCallbackDestination']>[0],
  ): ReturnType<FleetAuthBrokerStore['resolveOAuthCallbackDestination']> {
    if (!this.transaction || this.consumed
      || this.transaction.stateDigest !== input.stateDigest
      || this.transaction.initiatingBrowserDigest !== input.initiatingBrowserDigest) {
      throw new FleetAuthBrokerError('invalid_oauth_state', 400);
    }
    if (this.transaction.expiresAt.getTime() <= input.now.getTime()) {
      throw new FleetAuthBrokerError('expired_oauth_transaction', 400);
    }
    if (this.transaction.kind === 'login' && !this.lifecyclePurpose) return 'login';
    if (this.transaction.kind !== 'first_owner' && this.lifecyclePurpose) return 'lifecycle';
    throw new FleetAuthBrokerError('oauth_transaction_kind_mismatch', 400);
  }

  async createLifecycleOAuthTransaction(
    input: Parameters<FleetAuthBrokerStore['createLifecycleOAuthTransaction']>[0],
  ): Promise<void> {
    this.transaction = input;
    this.lifecyclePurpose = {
      ...input.lifecyclePurpose,
      initiatingPrincipalId: '00000000-0000-4000-8000-000000000102',
      initiatingSessionId: '00000000-0000-4000-8000-000000000101',
    };
  }

  async consumeOAuthTransaction(
    input: Parameters<FleetAuthBrokerStore['consumeOAuthTransaction']>[0],
  ): Promise<ConsumedOAuthTransaction> {
    if (!this.transaction || this.consumed
      || this.transaction.stateDigest !== input.stateDigest
      || this.transaction.initiatingBrowserDigest !== input.initiatingBrowserDigest) {
      throw new FleetAuthBrokerError('invalid_oauth_state', 400);
    }
    if (this.transaction.expiresAt.getTime() <= input.now.getTime()) {
      throw new FleetAuthBrokerError('expired_oauth_transaction', 400);
    }
    this.consumed = true;
    return {
      transactionId: this.transaction.transactionId,
      kind: this.transaction.kind,
      pkceVerifier: this.transaction.pkceVerifier,
      callbackUri: this.transaction.callbackUri,
      returnPath: this.transaction.returnPath,
      ...(this.lifecyclePurpose ? { lifecyclePurpose: this.lifecyclePurpose } : {}),
    };
  }

  async completeLifecycleOAuthEvidence(
    input: Parameters<FleetAuthBrokerStore['completeLifecycleOAuthEvidence']>[0],
  ): ReturnType<FleetAuthBrokerStore['completeLifecycleOAuthEvidence']> {
    if (!this.transaction || !this.lifecyclePurpose
      || this.transaction.transactionId !== input.transactionId) {
      throw new FleetAuthBrokerError('invalid_oauth_state', 400);
    }
    this.lastProviderSubject = input.providerSubjectId;
    return this.lifecyclePurpose;
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

  async revokeIssuedSessionForReauthentication(
    input: Parameters<FleetAuthBrokerStore['revokeIssuedSessionForReauthentication']>[0],
  ) {
    if (!this.session || this.session.recordId !== input.recordId
      || this.session.principalId !== input.principalId) {
      throw new Error('Issued session binding is missing');
    }
    this.session = null;
  }

  async revokeProvider(input: Parameters<FleetAuthBrokerStore['revokeProvider']>[0]) {
    if (!this.session || input.token !== this.session.token || input.csrfToken !== this.session.csrfToken) {
      throw new FleetAuthBrokerError('invalid_session', 401);
    }
    if (this.providerRevocationError) throw this.providerRevocationError;
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
  options: {
    config?: FleetAuthConfig;
    discordEvidenceLifecycle?: DiscordEvidenceLifecyclePort;
  } = {},
) {
  const bytes = Array.from({ length: 16 }, (_, index) => index + 1);
  let randomOffset = 0;
  const broker = new GatewayFleetAuthBroker({
    config: options.config ?? config,
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
    ...(options.discordEvidenceLifecycle
      ? { discordEvidenceLifecycle: options.discordEvidenceLifecycle }
      : {}),
  });
  return { broker, store, fetchImpl };
}

describe('gateway fleet auth broker', () => {
  it('produces lifecycle-scoped OAuth proof without creating a login session', async () => {
    const { broker, store } = makeBroker(new FakeStore(), vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, {
        access_token: 'provider-access-secret',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'identify',
      }))
      .mockResolvedValueOnce(response(200, { id: '123456789012345679' })));

    const started = await broker.beginLifecycleOAuth({
      token: 'session-token',
      csrfToken: 'csrf-token',
      requestOrigin: config.canonicalOrigin,
      returnPath: '/fleet/security',
      ceremonyId: '00000000-0000-4000-8000-000000000301',
      action: 'provider.add',
      proofRole: 'new',
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    const completed = await broker.completeOAuthCallback({
      state,
      code: 'discord-code',
      requestOrigin: config.canonicalOrigin,
      initiatingBrowserToken: started.initiatingBrowserToken,
    });

    expect(completed).toMatchObject({
      kind: 'lifecycle',
      returnPath: '/fleet/security',
      ceremonyId: '00000000-0000-4000-8000-000000000301',
      action: 'provider.add',
      proofRole: 'new',
      proof: {
        provider: 'discord',
        subjectId: '123456789012345679',
      },
    });
    expect(store.session).toBeNull();
  });

  it('classifies a login callback before consuming it and preserves routine session creation', async () => {
    const { broker, store } = makeBroker(new FakeStore(), vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, {
        access_token: 'provider-access-secret',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'identify',
      }))
      .mockResolvedValueOnce(response(200, { id: '123456789012345679' })));
    const started = await broker.beginLogin({ returnPath: '/fleet' });

    const completed = await broker.completeOAuthCallback({
      state: new URL(started.authorizationUrl).searchParams.get('state')!,
      code: 'discord-code',
      requestOrigin: config.canonicalOrigin,
      initiatingBrowserToken: started.initiatingBrowserToken,
    });

    expect(completed).toMatchObject({
      kind: 'login',
      returnPath: '/fleet',
      session: { principalStatus: 'pending' },
    });
    expect(store.consumed).toBe(true);
  });

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
      initiatingBrowserToken: started.initiatingBrowserToken,
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

  it('collects consented current guild roles before refreshing active Discord evidence', async () => {
    const store = new FakeStore();
    store.principalStatus = 'active';
    const fetchImpl = mappedLoginFetch();
    const recordActiveOAuthSession = vi.fn(async () => ({ status: 'admitted' as const }));
    const { broker } = makeBroker(store, fetchImpl, undefined, {
      config: mappedConfig,
      discordEvidenceLifecycle: {
        recordActiveOAuthSession,
        recordSessionRotation: vi.fn(async () => ({ status: 'admitted' as const })),
        commitGlobalAuthorityReset: vi.fn(async reset => await reset()),
      },
    });
    const started = await broker.beginLogin({ returnPath: '/fleet' });
    expect(new URL(started.authorizationUrl).searchParams.get('scope'))
      .toBe('identify guilds guilds.members.read');
    await broker.completeCallback({
      state: new URL(started.authorizationUrl).searchParams.get('state')!,
      code: 'one-time-code',
      requestOrigin: mappedConfig.canonicalOrigin,
      initiatingBrowserToken: started.initiatingBrowserToken,
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://discord.com/api/v10/users/@me/guilds?limit=200',
      expect.objectContaining({ headers: { authorization: 'Bearer provider-access-secret' } }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      'https://discord.com/api/v10/users/@me/guilds/223456789012345678/member',
      expect.objectContaining({ headers: { authorization: 'Bearer provider-access-secret' } }),
    );
    expect(recordActiveOAuthSession).toHaveBeenCalledWith({
      principalId: '00000000-0000-4000-8000-000000000102',
      providerSubjectId: '123456789012345679',
      providerMembershipEvidence: {
        status: 'observed',
        providerSubjectId: '123456789012345679',
        observedAt: '2026-07-15T12:00:00.000Z',
        guilds: [{
          guildId: '223456789012345678',
          roleIds: ['423456789012345678'],
        }],
      },
      idleExpiresAt: expect.any(Date),
      absoluteExpiresAt: expect.any(Date),
    });
  });

  it('revokes a callback session before returning a stable reauthentication denial', async () => {
    const store = new FakeStore();
    store.principalStatus = 'active';
    const recordActiveOAuthSession = vi.fn(async () => ({
      status: 'reauthentication_required' as const,
    }));
    const { broker } = makeBroker(store, mappedLoginFetch(), undefined, {
      config: mappedConfig,
      discordEvidenceLifecycle: {
        recordActiveOAuthSession,
        recordSessionRotation: vi.fn(async () => ({ status: 'admitted' as const })),
        commitGlobalAuthorityReset: vi.fn(async reset => await reset()),
      },
    });
    const started = await broker.beginLogin({ returnPath: '/fleet' });

    await expect(broker.completeCallback({
      state: new URL(started.authorizationUrl).searchParams.get('state')!,
      code: 'one-time-code',
      requestOrigin: mappedConfig.canonicalOrigin,
      initiatingBrowserToken: started.initiatingBrowserToken,
    })).rejects.toMatchObject({
      code: 'reauthentication_required',
      status: 401,
      message: 'Reauthentication is required',
    });
    expect(recordActiveOAuthSession).toHaveBeenCalledOnce();
    expect(store.session).toBeNull();
  });

  it('compensates a callback lifecycle failure by revoking the issued session', async () => {
    const store = new FakeStore();
    store.principalStatus = 'active';
    const { broker } = makeBroker(store, mappedLoginFetch(), undefined, {
      config: mappedConfig,
      discordEvidenceLifecycle: {
        recordActiveOAuthSession: vi.fn(async () => {
          throw new Error('injected lifecycle failure containing provider-access-secret');
        }),
        recordSessionRotation: vi.fn(async () => ({ status: 'admitted' as const })),
        commitGlobalAuthorityReset: vi.fn(async reset => await reset()),
      },
    });
    const started = await broker.beginLogin({ returnPath: '/fleet' });

    await expect(broker.completeCallback({
      state: new URL(started.authorizationUrl).searchParams.get('state')!,
      code: 'one-time-code',
      requestOrigin: mappedConfig.canonicalOrigin,
      initiatingBrowserToken: started.initiatingBrowserToken,
    })).rejects.toThrow('injected lifecycle failure');
    expect(store.session).toBeNull();
  });

  it('binds callback state to the opaque initiating browser without consuming it on mismatch', async () => {
    const store = new FakeStore();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, {
        access_token: 'access-secret', token_type: 'Bearer', expires_in: 3600, scope: 'identify',
      }))
      .mockResolvedValueOnce(response(200, { id: '123456789012345679' }));
    const { broker } = makeBroker(store, fetchImpl);
    const started = await broker.beginLogin({ returnPath: '/fleet' });
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;

    expect(started.initiatingBrowserToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(store.transaction?.initiatingBrowserDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(store.transaction)).not.toContain(started.initiatingBrowserToken);

    await expect(broker.completeCallback({
      state,
      code: 'code',
      requestOrigin: config.canonicalOrigin,
      initiatingBrowserToken: 'z'.repeat(43),
    })).rejects.toMatchObject({ code: 'invalid_oauth_state' });
    expect(store.consumed).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(broker.completeCallback({
      state,
      code: 'code',
      requestOrigin: config.canonicalOrigin,
      initiatingBrowserToken: started.initiatingBrowserToken,
    })).resolves.toMatchObject({ session: { principalStatus: 'pending' } });
    expect(store.consumed).toBe(true);
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
      initiatingBrowserToken: started.initiatingBrowserToken,
    })).rejects.toMatchObject({ code: 'callback_origin_mismatch' });
    expect(store.consumed).toBe(false);

    fetchImpl.mockRejectedValueOnce(new Error('provider failed with provider-access-secret'));
    await expect(broker.completeCallback({
      state,
      code: 'code',
      requestOrigin: config.canonicalOrigin,
      initiatingBrowserToken: started.initiatingBrowserToken,
    })).rejects.toMatchObject({ code: 'provider_unavailable', message: 'Discord OAuth provider unavailable' });
    await expect(broker.completeCallback({
      state,
      code: 'code',
      requestOrigin: config.canonicalOrigin,
      initiatingBrowserToken: started.initiatingBrowserToken,
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
      initiatingBrowserToken: malformedStart.initiatingBrowserToken,
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
      initiatingBrowserToken: started.initiatingBrowserToken,
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

  it('revokes a rotated session when lifecycle authority requires a new OAuth ceremony', async () => {
    const store = new FakeStore();
    store.principalStatus = 'active';
    const recordSessionRotation = vi.fn(async () => ({
      status: 'reauthentication_required' as const,
    }));
    const { broker } = makeBroker(store, mappedLoginFetch(), undefined, {
      config: mappedConfig,
      discordEvidenceLifecycle: {
        recordActiveOAuthSession: vi.fn(async () => ({ status: 'admitted' as const })),
        recordSessionRotation,
        commitGlobalAuthorityReset: vi.fn(async reset => await reset()),
      },
    });
    const started = await broker.beginLogin({ returnPath: '/fleet' });
    const login = await broker.completeCallback({
      state: new URL(started.authorizationUrl).searchParams.get('state')!,
      code: 'code',
      requestOrigin: mappedConfig.canonicalOrigin,
      initiatingBrowserToken: started.initiatingBrowserToken,
    });

    await expect(broker.rotateSession({
      token: login.session.token,
      csrfToken: login.session.csrfToken,
      requestOrigin: mappedConfig.canonicalOrigin,
    })).rejects.toMatchObject({ code: 'reauthentication_required', status: 401 });
    expect(recordSessionRotation).toHaveBeenCalledOnce();
    expect(store.session).toBeNull();
  });

  it('retires Discord lifecycle authority only after provider revocation commits', async () => {
    const retirement = vi.fn();
    const lifecycle: DiscordEvidenceLifecyclePort = {
      recordActiveOAuthSession: vi.fn(async () => ({ status: 'admitted' })),
      recordSessionRotation: vi.fn(async () => ({ status: 'admitted' })),
      commitGlobalAuthorityReset: vi.fn(async (reset) => {
        await reset();
        retirement();
      }),
    };
    const store = new FakeStore();
    const originalSession: FleetAuthSessionRecord = {
      recordId: '00000000-0000-4000-8000-000000000101',
      principalId: '00000000-0000-4000-8000-000000000102',
      principalStatus: 'active',
      token: 'a'.repeat(43),
      csrfToken: 'b'.repeat(43),
      idleExpiresAt: new Date('2026-07-15T12:30:00.000Z'),
      absoluteExpiresAt: new Date('2026-07-15T20:00:00.000Z'),
    };
    store.session = originalSession;
    const { broker } = makeBroker(store, vi.fn<typeof fetch>(), undefined, {
      config: mappedConfig,
      discordEvidenceLifecycle: lifecycle,
    });

    await broker.revokeProvider({
      token: store.session.token,
      csrfToken: store.session.csrfToken,
      requestOrigin: mappedConfig.canonicalOrigin,
      reason: 'operator revocation',
    });
    expect(lifecycle.commitGlobalAuthorityReset).toHaveBeenCalledOnce();
    expect(retirement).toHaveBeenCalledOnce();

    const failedRetirement = vi.fn();
    const failedLifecycle = {
      ...lifecycle,
      commitGlobalAuthorityReset: vi.fn(async (reset: () => Promise<void>) => {
        await reset();
        failedRetirement();
      }),
    };
    const failedStore = new FakeStore();
    failedStore.session = { ...originalSession, token: 'c'.repeat(43), csrfToken: 'd'.repeat(43) };
    failedStore.providerRevocationError = new Error('transaction rolled back');
    const failed = makeBroker(failedStore, vi.fn<typeof fetch>(), undefined, {
      config: mappedConfig,
      discordEvidenceLifecycle: failedLifecycle,
    });
    await expect(failed.broker.revokeProvider({
      token: failedStore.session.token,
      csrfToken: failedStore.session.csrfToken,
      requestOrigin: mappedConfig.canonicalOrigin,
      reason: 'operator revocation',
    })).rejects.toThrow('transaction rolled back');
    expect(failedLifecycle.commitGlobalAuthorityReset).toHaveBeenCalledOnce();
    expect(failedRetirement).not.toHaveBeenCalled();
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
      initiatingBrowserToken: started.initiatingBrowserToken,
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

  it('fences first-owner activation until a mapped fresh OAuth ceremony is admitted', async () => {
    const store = new FakeStore();
    const assurance: FirstOwnerAssurancePort = {
      verify: vi.fn(async () => ({
        ceremonyId: '00000000-0000-4000-8000-000000000110',
        principalId: '00000000-0000-4000-8000-000000000102',
        providerSubjectId: '123456789012345679',
        companionId: '00000000-0000-4000-8000-000000000111',
        contactId: 'owner-contact',
      })),
    };
    const { broker } = makeBroker(store, mappedLoginFetch(), assurance, {
      config: mappedConfig,
      discordEvidenceLifecycle: {
        recordActiveOAuthSession: vi.fn(async () => ({ status: 'admitted' as const })),
        recordSessionRotation: vi.fn(async () => ({ status: 'admitted' as const })),
        commitGlobalAuthorityReset: vi.fn(async reset => await reset()),
      },
    });
    const started = await broker.beginLogin({ returnPath: '/fleet' });
    const login = await broker.completeCallback({
      state: new URL(started.authorizationUrl).searchParams.get('state')!,
      code: 'code',
      requestOrigin: mappedConfig.canonicalOrigin,
      initiatingBrowserToken: started.initiatingBrowserToken,
    });

    await expect(broker.completeFirstOwnerBootstrap({
      token: login.session.token,
      csrfToken: login.session.csrfToken,
      requestOrigin: mappedConfig.canonicalOrigin,
      assuranceEvidence: { opaqueWebAuthnAndTrustedHostResponse: true },
    })).rejects.toMatchObject({ code: 'reauthentication_required', status: 401 });
    expect(store.session).toBeNull();
  });
});
