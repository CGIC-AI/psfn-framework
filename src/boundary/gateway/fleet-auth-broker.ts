import {
  createHash,
  createHmac,
  randomBytes as cryptoRandomBytes,
  randomUUID,
} from 'node:crypto';
import type { FleetAuthConfig } from '../../system/config/fleet-auth-config.js';
import { isRecord } from '../../shared/utils/types.js';

const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/v10/users/@me';
const DISCORD_GUILDS_URL = 'https://discord.com/api/v10/users/@me/guilds?limit=200';
const DISCORD_SNOWFLAKE = /^[1-9][0-9]{16,19}$/u;
const OPAQUE_TOKEN_BYTES = 32;
const OAUTH_CODE_MAX_LENGTH = 2048;

export type OAuthTransactionKind = 'login' | 'provider_link' | 'provider_replace' | 'first_owner' | 'recovery';

export class FleetAuthBrokerError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = 'FleetAuthBrokerError';
  }
}

export interface OAuthTransactionInput {
  transactionId: string;
  stateDigest: string;
  initiatingBrowserDigest: string;
  pkceVerifier: string;
  callbackUri: string;
  returnPath: string;
  kind: OAuthTransactionKind;
  createdAt: Date;
  expiresAt: Date;
}

export interface ConsumedOAuthTransaction {
  transactionId: string;
  pkceVerifier: string;
  callbackUri: string;
  returnPath: string;
  kind: OAuthTransactionKind;
}

export interface FleetAuthSessionRecord {
  recordId: string;
  principalId: string;
  principalStatus: 'pending' | 'active';
  token: string;
  csrfToken: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface FleetAuthBrokerStore {
  createOAuthTransaction(input: OAuthTransactionInput): Promise<void>;
  consumeOAuthTransaction(input: {
    stateDigest: string;
    initiatingBrowserDigest: string;
    now: Date;
  }): Promise<ConsumedOAuthTransaction>;
  createLoginSession(input: {
    transactionId: string;
    providerSubjectId: string;
    providerMetadata: { mfaEnabled?: boolean };
    token: string;
    csrfToken: string;
    audience: 'fleet';
    now: Date;
    idleTtlMs: number;
    absoluteTtlMs: number;
    refreshToken?: string;
    providerTokenExpiresAt?: Date;
  }): Promise<FleetAuthSessionRecord>;
  rotateSession(input: {
    token: string;
    csrfToken: string;
    nextToken: string;
    nextCsrfToken: string;
    now: Date;
    idleTtlMs: number;
  }): Promise<FleetAuthSessionRecord>;
  issueCsrf(input: {
    token: string;
    nextCsrfToken: string;
    now: Date;
  }): Promise<string>;
  revokeSession(input: {
    token: string;
    csrfToken: string;
    now: Date;
  }): Promise<void>;
  revokeProvider(input: {
    token: string;
    csrfToken: string;
    now: Date;
    reasonDigest: string;
  }): Promise<void>;
  completeFirstOwnerBootstrap(input: {
    token: string;
    csrfToken: string;
    ceremonyId: string;
    principalId: string;
    providerSubjectId: string;
    companionId: string;
    contactId: string;
    nextToken: string;
    nextCsrfToken: string;
    now: Date;
    idleTtlMs: number;
    absoluteTtlMs: number;
  }): Promise<FleetAuthSessionRecord>;
}

export interface VerifiedFirstOwnerAssurance {
  ceremonyId: string;
  principalId: string;
  providerSubjectId: string;
  companionId: string;
  contactId: string;
}

/**
 * Implemented by the gateway-owned trusted-host/WebAuthn lane (opl1.10).
 * The broker never accepts caller booleans for UV or host confirmation; it
 * receives only the exact binding returned by this verifier.
 */
export interface FirstOwnerAssurancePort {
  verify(input: {
    evidence: unknown;
    expectedOrigin: string;
  }): Promise<VerifiedFirstOwnerAssurance>;
}

interface DiscordTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
}

interface DiscordIdentity {
  subjectId: string;
  mfaEnabled?: boolean;
}

export interface GatewayFleetAuthBrokerOptions {
  config: FleetAuthConfig;
  store: FleetAuthBrokerStore;
  oauthClientSecret: string;
  sessionPepper: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  randomBytes?: (length: number) => Buffer;
  firstOwnerAssurance?: FirstOwnerAssurancePort;
  discordEvidenceLifecycle?: {
    recordActiveOAuthSession(input: {
      principalId: string;
      providerSubjectId: string;
      providerMembershipEvidence: unknown;
      idleExpiresAt: Date;
      absoluteExpiresAt: Date;
    }): Promise<void>;
    recordSessionRotation(input: {
      principalId: string;
      idleExpiresAt: Date;
      absoluteExpiresAt: Date;
    }): Promise<void>;
  };
}

function opaqueToken(randomBytes: (length: number) => Buffer): string {
  const token = randomBytes(OPAQUE_TOKEN_BYTES).toString('base64url');
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new Error('Fleet auth random source returned an invalid opaque token');
  }
  return token;
}

function isSafeOAuthValue(value: string, maxLength = OAUTH_CODE_MAX_LENGTH): boolean {
  return value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new FleetAuthBrokerError(
      'malformed_provider_response',
      502,
      'Discord OAuth provider returned a malformed response',
    );
  }
  return value;
}

function parseReturnPath(value: string, canonicalOrigin: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')
    || /%2f|%5c/iu.test(value) || value.includes('#')) {
    throw new FleetAuthBrokerError('invalid_return_path', 400, 'Return path is not allowlisted');
  }
  let parsed: URL;
  try {
    parsed = new URL(value, canonicalOrigin);
  } catch {
    throw new FleetAuthBrokerError('invalid_return_path', 400, 'Return path is not allowlisted');
  }
  const normalized = `${parsed.pathname}${parsed.search}`;
  if (parsed.origin !== canonicalOrigin || normalized !== value || parsed.hash) {
    throw new FleetAuthBrokerError('invalid_return_path', 400, 'Return path is not allowlisted');
  }
  return normalized;
}

export class GatewayFleetAuthBroker {
  private readonly config: FleetAuthConfig;
  private readonly store: FleetAuthBrokerStore;
  private readonly oauthClientSecret: string;
  private readonly sessionPepper: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly randomBytes: (length: number) => Buffer;
  private readonly firstOwnerAssurance?: FirstOwnerAssurancePort;
  private readonly discordEvidenceLifecycle?: GatewayFleetAuthBrokerOptions['discordEvidenceLifecycle'];

  constructor(options: GatewayFleetAuthBrokerOptions) {
    this.config = options.config;
    this.store = options.store;
    this.oauthClientSecret = options.oauthClientSecret;
    this.sessionPepper = options.sessionPepper;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? cryptoRandomBytes;
    this.firstOwnerAssurance = options.firstOwnerAssurance;
    this.discordEvidenceLifecycle = options.discordEvidenceLifecycle;
  }

  async beginLogin(input: { returnPath: string }): Promise<{
    authorizationUrl: string;
    initiatingBrowserToken: string;
    expiresAt: Date;
  }> {
    const returnPath = parseReturnPath(input.returnPath, this.config.canonicalOrigin);
    const state = opaqueToken(this.randomBytes);
    const initiatingBrowserToken = opaqueToken(this.randomBytes);
    const pkceVerifier = opaqueToken(this.randomBytes);
    const callbackUri = `${this.config.canonicalOrigin}${this.config.callbackPath}`;
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.config.ttls.oauthTransactionMs);
    await this.store.createOAuthTransaction({
      transactionId: randomUUID(),
      stateDigest: this.digest(state),
      initiatingBrowserDigest: this.digest(initiatingBrowserToken),
      pkceVerifier,
      callbackUri,
      returnPath,
      kind: 'login',
      createdAt,
      expiresAt,
    });

    const authorization = new URL(DISCORD_AUTHORIZE_URL);
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('client_id', this.config.provider.clientId);
    authorization.searchParams.set('scope', this.config.provider.scopes.join(' '));
    authorization.searchParams.set('redirect_uri', callbackUri);
    authorization.searchParams.set('state', state);
    authorization.searchParams.set(
      'code_challenge',
      createHash('sha256').update(pkceVerifier).digest('base64url'),
    );
    authorization.searchParams.set('code_challenge_method', 'S256');
    return { authorizationUrl: authorization.toString(), initiatingBrowserToken, expiresAt };
  }

  async completeCallback(input: {
    state: string;
    code: string;
    requestOrigin: string;
    initiatingBrowserToken: string;
  }): Promise<{ returnPath: string; session: FleetAuthSessionRecord }> {
    if (input.requestOrigin !== this.config.canonicalOrigin) {
      throw new FleetAuthBrokerError(
        'callback_origin_mismatch',
        400,
        'OAuth callback origin does not match the configured fleet origin',
      );
    }
    if (!isSafeOAuthValue(input.state, 128) || !isSafeOAuthValue(input.code)
      || !/^[A-Za-z0-9_-]{43}$/u.test(input.initiatingBrowserToken)) {
      throw new FleetAuthBrokerError('invalid_oauth_callback', 400, 'OAuth callback is malformed');
    }
    const now = this.now();
    const transaction = await this.store.consumeOAuthTransaction({
      stateDigest: this.digest(input.state),
      initiatingBrowserDigest: this.digest(input.initiatingBrowserToken),
      now,
    });
    if (transaction.kind !== 'login') {
      throw new FleetAuthBrokerError(
        'oauth_transaction_kind_mismatch',
        400,
        'OAuth transaction cannot create a routine session',
      );
    }
    const providerTokens = await this.exchangeCode(input.code, transaction);
    const identity = await this.resolveDiscordIdentity(providerTokens.accessToken);
    const providerMembershipEvidence = await this.resolveDiscordGuildMembershipEvidence(
      providerTokens.accessToken,
      identity.subjectId,
    );
    if (this.config.provider.tokenCustody === 'encrypted_refresh'
      && providerTokens.refreshToken === undefined) {
      throw new FleetAuthBrokerError(
        'malformed_provider_response',
        502,
        'Discord OAuth provider did not return configured refresh custody',
      );
    }
    const token = opaqueToken(this.randomBytes);
    const csrfToken = opaqueToken(this.randomBytes);
    const session = await this.store.createLoginSession({
      transactionId: transaction.transactionId,
      providerSubjectId: identity.subjectId,
      providerMetadata: {
        ...(identity.mfaEnabled === undefined ? {} : { mfaEnabled: identity.mfaEnabled }),
      },
      token,
      csrfToken,
      audience: 'fleet',
      now,
      idleTtlMs: this.config.ttls.sessionIdleMs,
      absoluteTtlMs: this.config.ttls.sessionAbsoluteMs,
      ...(this.config.provider.tokenCustody === 'encrypted_refresh' && providerTokens.refreshToken
        ? {
            refreshToken: providerTokens.refreshToken,
            providerTokenExpiresAt: new Date(
              now.getTime() + providerTokens.expiresInSeconds * 1000,
            ),
          }
        : {}),
    });
    if (session.principalStatus === 'active' && this.discordEvidenceLifecycle) {
      await this.discordEvidenceLifecycle.recordActiveOAuthSession({
        principalId: session.principalId,
        providerSubjectId: identity.subjectId,
        providerMembershipEvidence,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
      });
    }
    return { returnPath: transaction.returnPath, session };
  }

  async rotateSession(input: {
    token: string;
    csrfToken: string;
    requestOrigin: string;
  }): Promise<FleetAuthSessionRecord> {
    this.assertMutationOrigin(input.requestOrigin);
    const rotated = await this.store.rotateSession({
      token: input.token,
      csrfToken: input.csrfToken,
      nextToken: opaqueToken(this.randomBytes),
      nextCsrfToken: opaqueToken(this.randomBytes),
      now: this.now(),
      idleTtlMs: this.config.ttls.sessionIdleMs,
    });
    await this.discordEvidenceLifecycle?.recordSessionRotation({
      principalId: rotated.principalId,
      idleExpiresAt: rotated.idleExpiresAt,
      absoluteExpiresAt: rotated.absoluteExpiresAt,
    });
    return rotated;
  }

  async issueCsrf(input: {
    token: string;
    requestOrigin: string;
  }): Promise<string> {
    this.assertMutationOrigin(input.requestOrigin);
    return await this.store.issueCsrf({
      token: input.token,
      nextCsrfToken: opaqueToken(this.randomBytes),
      now: this.now(),
    });
  }

  async logout(input: {
    token: string;
    csrfToken: string;
    requestOrigin: string;
  }): Promise<void> {
    this.assertMutationOrigin(input.requestOrigin);
    await this.store.revokeSession({
      token: input.token,
      csrfToken: input.csrfToken,
      now: this.now(),
    });
  }

  async revokeProvider(input: {
    token: string;
    csrfToken: string;
    requestOrigin: string;
    reason: string;
  }): Promise<void> {
    this.assertMutationOrigin(input.requestOrigin);
    if (!input.reason.trim() || input.reason.length > 512) {
      throw new FleetAuthBrokerError('invalid_revocation_reason', 400);
    }
    await this.store.revokeProvider({
      token: input.token,
      csrfToken: input.csrfToken,
      now: this.now(),
      reasonDigest: createHash('sha256').update(input.reason.trim()).digest('hex'),
    });
  }

  async completeFirstOwnerBootstrap(input: {
    token: string;
    csrfToken: string;
    requestOrigin: string;
    assuranceEvidence: unknown;
  }): Promise<FleetAuthSessionRecord> {
    this.assertMutationOrigin(input.requestOrigin);
    if (!this.firstOwnerAssurance) {
      throw new FleetAuthBrokerError(
        'strong_assurance_unavailable',
        503,
        'First-owner assurance is unavailable',
      );
    }
    const verified = await this.firstOwnerAssurance.verify({
      evidence: input.assuranceEvidence,
      expectedOrigin: this.config.canonicalOrigin,
    });
    return await this.store.completeFirstOwnerBootstrap({
      token: input.token,
      csrfToken: input.csrfToken,
      ...verified,
      nextToken: opaqueToken(this.randomBytes),
      nextCsrfToken: opaqueToken(this.randomBytes),
      now: this.now(),
      idleTtlMs: this.config.ttls.sessionIdleMs,
      absoluteTtlMs: this.config.ttls.sessionAbsoluteMs,
    });
  }

  private assertMutationOrigin(requestOrigin: string): void {
    if (requestOrigin !== this.config.canonicalOrigin) {
      throw new FleetAuthBrokerError(
        'origin_mismatch',
        403,
        'Mutation origin does not match the configured fleet origin',
      );
    }
  }

  private digest(value: string): string {
    return createHmac('sha256', this.sessionPepper).update(value).digest('hex');
  }

  private async exchangeCode(
    code: string,
    transaction: ConsumedOAuthTransaction,
  ): Promise<DiscordTokenResponse> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: transaction.callbackUri,
      client_id: this.config.provider.clientId,
      client_secret: this.oauthClientSecret,
      code_verifier: transaction.pkceVerifier,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(DISCORD_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        redirect: 'error',
      });
    } catch {
      throw new FleetAuthBrokerError(
        'provider_unavailable',
        502,
        'Discord OAuth provider unavailable',
      );
    }
    if (!response.ok) {
      throw new FleetAuthBrokerError(
        'provider_exchange_denied',
        502,
        'Discord OAuth code exchange was denied',
      );
    }
    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      throw new FleetAuthBrokerError(
        'malformed_provider_response',
        502,
        'Discord OAuth provider returned a malformed response',
      );
    }
    const body = parseJsonRecord(decoded);
    if (typeof body.access_token !== 'string' || !isSafeOAuthValue(body.access_token, 8192)
      || body.token_type !== 'Bearer'
      || !Number.isSafeInteger(body.expires_in) || Number(body.expires_in) <= 0
      || typeof body.scope !== 'string') {
      throw new FleetAuthBrokerError(
        'malformed_provider_response',
        502,
        'Discord OAuth provider returned a malformed response',
      );
    }
    const returnedScopes = body.scope.split(/\s+/u).filter(Boolean).sort();
    const configuredScopes = [...this.config.provider.scopes].sort();
    if (returnedScopes.length !== configuredScopes.length
      || returnedScopes.some((scope, index) => scope !== configuredScopes[index])) {
      throw new FleetAuthBrokerError(
        'provider_scope_mismatch',
        502,
        'Discord OAuth provider returned an unexpected scope set',
      );
    }
    const refreshToken = body.refresh_token;
    if (refreshToken !== undefined
      && (typeof refreshToken !== 'string' || !isSafeOAuthValue(refreshToken, 8192))) {
      throw new FleetAuthBrokerError(
        'malformed_provider_response',
        502,
        'Discord OAuth provider returned a malformed response',
      );
    }
    return {
      accessToken: body.access_token,
      expiresInSeconds: Number(body.expires_in),
      ...(typeof refreshToken === 'string' ? { refreshToken } : {}),
    };
  }

  private async resolveDiscordGuildMembershipEvidence(
    accessToken: string,
    providerSubjectId: string,
  ): Promise<unknown> {
    const mappedGuildIds = [...new Set(
      this.config.discordEvidenceMappings.map(mapping => mapping.guildId),
    )].sort();
    const observedAt = this.now().toISOString();
    if (mappedGuildIds.length === 0) {
      return {
        status: 'observed',
        providerSubjectId,
        observedAt,
        guilds: [],
      };
    }
    let guildsResponse: Response;
    try {
      guildsResponse = await this.fetchImpl(DISCORD_GUILDS_URL, {
        headers: { authorization: `Bearer ${accessToken}` },
        redirect: 'error',
      });
    } catch {
      return { status: 'provider_unavailable' };
    }
    if (!guildsResponse.ok) return { status: 'provider_unavailable' };
    let decodedGuilds: unknown;
    try {
      decodedGuilds = await guildsResponse.json();
    } catch {
      return { status: 'provider_unavailable' };
    }
    if (!Array.isArray(decodedGuilds) || decodedGuilds.length > 200) {
      return { status: 'provider_unavailable' };
    }
    const consentedGuildIds = new Set<string>();
    for (const guild of decodedGuilds) {
      if (!isRecord(guild) || typeof guild.id !== 'string' || !DISCORD_SNOWFLAKE.test(guild.id)) {
        return { status: 'provider_unavailable' };
      }
      consentedGuildIds.add(guild.id);
    }
    const guilds: Array<{ guildId: string; roleIds: string[] }> = [];
    for (const guildId of mappedGuildIds) {
      if (!consentedGuildIds.has(guildId)) continue;
      let memberResponse: Response;
      try {
        memberResponse = await this.fetchImpl(
          `https://discord.com/api/v10/users/@me/guilds/${guildId}/member`,
          {
            headers: { authorization: `Bearer ${accessToken}` },
            redirect: 'error',
          },
        );
      } catch {
        return { status: 'provider_unavailable' };
      }
      if (memberResponse.status === 404) continue;
      if (!memberResponse.ok) return { status: 'provider_unavailable' };
      let decodedMember: unknown;
      try {
        decodedMember = await memberResponse.json();
      } catch {
        return { status: 'provider_unavailable' };
      }
      if (!isRecord(decodedMember) || !Array.isArray(decodedMember.roles)
        || decodedMember.roles.length > 250
        || !isRecord(decodedMember.user)
        || decodedMember.user.id !== providerSubjectId) {
        return { status: 'provider_unavailable' };
      }
      const roleIds = decodedMember.roles.map((roleId) => {
        if (typeof roleId !== 'string' || !DISCORD_SNOWFLAKE.test(roleId)) {
          throw new FleetAuthBrokerError(
            'malformed_provider_response',
            502,
            'Discord guild membership response was malformed',
          );
        }
        return roleId;
      }).sort();
      if (new Set(roleIds).size !== roleIds.length) return { status: 'provider_unavailable' };
      guilds.push({ guildId, roleIds });
    }
    return {
      status: 'observed',
      providerSubjectId,
      observedAt,
      guilds,
    };
  }

  private async resolveDiscordIdentity(accessToken: string): Promise<DiscordIdentity> {
    let response: Response;
    try {
      response = await this.fetchImpl(DISCORD_USER_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: 'error',
      });
    } catch {
      throw new FleetAuthBrokerError(
        'provider_unavailable',
        502,
        'Discord OAuth provider unavailable',
      );
    }
    if (!response.ok) {
      throw new FleetAuthBrokerError(
        'provider_identity_denied',
        502,
        'Discord identity lookup was denied',
      );
    }
    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      throw new FleetAuthBrokerError(
        'malformed_provider_response',
        502,
        'Discord OAuth provider returned a malformed response',
      );
    }
    const body = parseJsonRecord(decoded);
    if (typeof body.id !== 'string' || !DISCORD_SNOWFLAKE.test(body.id)
      || (body.mfa_enabled !== undefined && typeof body.mfa_enabled !== 'boolean')) {
      throw new FleetAuthBrokerError(
        'malformed_provider_response',
        502,
        'Discord OAuth provider returned a malformed response',
      );
    }
    return {
      subjectId: body.id,
      ...(typeof body.mfa_enabled === 'boolean' ? { mfaEnabled: body.mfa_enabled } : {}),
    };
  }
}
