import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  TrustedHostProviderRecoveryError,
  type PreparedProviderRecovery,
  type ProviderRecoveryOAuthProof,
  type TrustedHostProviderRecoveryStore,
} from '../../../boundary/fleet-auth/trusted-host-provider-recovery.js';
import type { PasskeyAuthorityPort } from '../../../boundary/fleet-auth/passkey-authority.js';
import {
  assertNoUnknownKeys,
  isRecord,
  isRfc4122Uuid,
} from '../../../shared/utils/types.js';
import { digestFleetAuthVerifiedProviderProof } from '../../../shared/contracts/fleet-auth-lifecycle-oauth.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';
import { FleetAuthSecretCodec } from './oauth-secret-codec.js';
import type { ProviderRevocationAuthorityPort } from './provider-revocation-authority.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

interface AuthorityRow {
  authority_generation: string;
  global_auth_epoch: string;
}

interface SessionRow {
  record_id: string;
  principal_id: string;
  principal_status: string;
  provider_subject_id: string;
  provider_authority_generation: string;
  provider_state: string;
  provider_restore_state: string;
  authority_generation: string;
  global_auth_epoch: string;
  session_global_auth_epoch: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
  restore_state: string;
  authn_version: string;
  authz_version: string;
  binding_version: string;
  grant_version: string;
  policy_version: string;
  session_authn_version: string;
  session_authz_version: string;
  session_binding_version: string;
  session_grant_version: string;
  session_policy_version: string;
}

interface RecoveryScope {
  schemaVersion: 1;
  action: 'provider.recover';
  principalId: string;
  currentProviderSubjectId: string;
  currentProviderAuthorityGeneration: number;
  expectedNewProviderSubjectId: string;
  authorityGeneration: number;
  globalAuthEpoch: number;
  reasonDigest: string;
  principal: PreparedProviderRecovery['principal'];
  credentialIdHash: string;
  credentialFloorGeneration: number;
}

interface CeremonyRow {
  ceremony_id: string;
  expected_provider_subject_id: string;
  expected_companion_id: string;
  exact_scope: unknown;
  status: string;
  global_auth_epoch: string;
  expires_at: Date;
  webauthn_challenge_digest: string | null;
  webauthn_challenge_ciphertext: Buffer | null;
  exact_origin: string;
  rp_id: string;
  credential_floor_generation: string;
  prior_credential_id_hash: string;
  recovery_receipt_digest: string | null;
  recovery_credential_id_hash: string | null;
  recovery_credential_generation: string | null;
  attempt_count: number;
}

export interface PostgresTrustedHostProviderRecoveryStoreOptions {
  authorityPool: Pool;
  sessionPepper: string;
  tokenEncryptionKey: string;
  providerRevocationAuthority: ProviderRevocationAuthorityPort;
  passkeyAuthority: PasskeyAuthorityPort;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function integer(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid fleet_auth provider recovery ${field}`);
  }
  return parsed;
}

function parseScope(value: unknown): RecoveryScope {
  if (!isRecord(value)) {
    throw new TrustedHostProviderRecoveryError(
      'ceremony_unavailable',
      'Recovery ceremony scope is invalid',
    );
  }
  assertNoUnknownKeys(value, [
    'schemaVersion',
    'action',
    'principalId',
    'currentProviderSubjectId',
    'currentProviderAuthorityGeneration',
    'expectedNewProviderSubjectId',
    'authorityGeneration',
    'globalAuthEpoch',
    'reasonDigest',
    'principal',
    'credentialIdHash',
    'credentialFloorGeneration',
  ], 'providerRecoveryScope');
  if (value.schemaVersion !== 1 || value.action !== 'provider.recover'
    || typeof value.principalId !== 'string'
    || typeof value.currentProviderSubjectId !== 'string'
    || typeof value.expectedNewProviderSubjectId !== 'string'
    || typeof value.reasonDigest !== 'string'
    || typeof value.credentialIdHash !== 'string'
    || !Number.isSafeInteger(value.currentProviderAuthorityGeneration)
    || !Number.isSafeInteger(value.authorityGeneration)
    || !Number.isSafeInteger(value.globalAuthEpoch)
    || !Number.isSafeInteger(value.credentialFloorGeneration)
    || Number(value.currentProviderAuthorityGeneration) < 1
    || Number(value.authorityGeneration) < 1
    || Number(value.globalAuthEpoch) < 1
    || Number(value.credentialFloorGeneration) < 1
    || !isRfc4122Uuid(value.principalId)
    || !/^[1-9][0-9]{16,19}$/u.test(value.currentProviderSubjectId)
    || !/^[1-9][0-9]{16,19}$/u.test(value.expectedNewProviderSubjectId)
    || !/^[0-9a-f]{64}$/u.test(value.reasonDigest)
    || !/^[0-9a-f]{64}$/u.test(value.credentialIdHash)
    || !isRecord(value.principal)) {
    throw new TrustedHostProviderRecoveryError(
      'ceremony_unavailable',
      'Recovery ceremony scope is invalid',
    );
  }
  const principal = value.principal;
  assertNoUnknownKeys(principal, [
    'principalId',
    'authnVersion',
    'authzVersion',
    'bindingVersion',
    'grantVersion',
    'policyVersion',
  ], 'providerRecoveryScope.principal');
  if (principal.principalId !== value.principalId
    || !Number.isSafeInteger(principal.authnVersion)
    || !Number.isSafeInteger(principal.authzVersion)
    || !Number.isSafeInteger(principal.bindingVersion)
    || !Number.isSafeInteger(principal.grantVersion)
    || !Number.isSafeInteger(principal.policyVersion)
    || Number(principal.authnVersion) < 1
    || Number(principal.authzVersion) < 1
    || Number(principal.bindingVersion) < 1
    || Number(principal.grantVersion) < 1
    || Number(principal.policyVersion) < 1) {
    throw new TrustedHostProviderRecoveryError(
      'ceremony_unavailable',
      'Recovery principal scope is invalid',
    );
  }
  return value as unknown as RecoveryScope;
}

export class PostgresTrustedHostProviderRecoveryStore
implements TrustedHostProviderRecoveryStore {
  private readonly codec: FleetAuthSecretCodec;

  constructor(private readonly options: PostgresTrustedHostProviderRecoveryStoreOptions) {
    this.codec = new FleetAuthSecretCodec(options);
  }

  async auditDenial(
    input: Parameters<TrustedHostProviderRecoveryStore['auditDenial']>[0],
  ): ReturnType<TrustedHostProviderRecoveryStore['auditDenial']> {
    await this.persistDeny(
      'authority.provider_recovery.browser',
      input.oneTimeCredential,
      input.now,
      input.reasonCode,
    );
  }

  async create(
    input: Parameters<TrustedHostProviderRecoveryStore['create']>[0],
  ): ReturnType<TrustedHostProviderRecoveryStore['create']> {
    const client = await this.options.authorityPool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      const principal = await client.query<{
        status: string;
        restore_state: string;
        authn_version: string;
        authz_version: string;
        binding_version: string;
        grant_version: string;
        policy_version: string;
      }>(`
        SELECT status, restore_state, authn_version, authz_version,
               binding_version, grant_version, policy_version
        FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
        WHERE principal_id = $1
        FOR UPDATE
      `, [input.principalId]);
      const principalRow = principal.rows.at(0);
      const provider = await client.query<{
        state: string;
        restore_state: string;
        authority_generation: string;
      }>(`
        SELECT state, restore_state, authority_generation
        FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
        WHERE provider = 'discord' AND subject_id = $1 AND principal_id = $2
        FOR UPDATE
      `, [input.currentProviderSubjectId, input.principalId]);
      const providerRow = provider.rows.at(0);
      const companion = await client.query<{ present: boolean }>(`
        SELECT EXISTS (
          SELECT 1
          FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants AS role_grant
          JOIN ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state AS companion
            ON companion.companion_id = role_grant.companion_id
          WHERE role_grant.principal_id = $1 AND role_grant.companion_id = $2
            AND role_grant.lifecycle = 'active' AND role_grant.restore_state = 'live'
            AND companion.lifecycle = 'active' AND companion.restore_state = 'live'
        ) AS present
      `, [input.principalId, input.companionId]);
      const newSubject = await client.query<{ unavailable: boolean }>(`
        SELECT (
          EXISTS (SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
            WHERE provider = 'discord' AND subject_id = $1)
          OR EXISTS (SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_history
            WHERE provider = 'discord' AND subject_id = $1)
          OR EXISTS (SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones
            WHERE provider = 'discord' AND subject_id = $1)
        ) AS unavailable
      `, [input.expectedNewProviderSubjectId]);
      const floor = this.options.passkeyAuthority.readPasskeys();
      const credential = floor.credentials.find(entry => entry.status === 'current'
        && timingSafeStringEqual(entry.credentialIdHash, input.credentialIdHash)
        && entry.principalId === input.principalId
        && entry.expectedProviderSubjectId === input.currentProviderSubjectId);
      if (!principalRow || principalRow.status !== 'active' || principalRow.restore_state !== 'live'
        || !providerRow || providerRow.state !== 'active' || providerRow.restore_state !== 'live'
        || providerRow.authority_generation !== String(input.currentProviderAuthorityGeneration)
        || companion.rows.at(0)?.present !== true
        || newSubject.rows.at(0)?.unavailable !== false
        || floor.generation !== input.credentialFloorGeneration
        || !credential) {
        throw new TrustedHostProviderRecoveryError(
          'provider_authority_changed',
          'Recovery authority binding is not exact and current',
        );
      }
      const claim = {
        principalId: input.principalId,
        authnVersion: integer(principalRow.authn_version, 'authn_version'),
        authzVersion: integer(principalRow.authz_version, 'authz_version'),
        bindingVersion: integer(principalRow.binding_version, 'binding_version'),
        grantVersion: integer(principalRow.grant_version, 'grant_version'),
        policyVersion: integer(principalRow.policy_version, 'policy_version'),
      };
      const scope: RecoveryScope = {
        schemaVersion: 1,
        action: 'provider.recover',
        principalId: input.principalId,
        currentProviderSubjectId: input.currentProviderSubjectId,
        currentProviderAuthorityGeneration: input.currentProviderAuthorityGeneration,
        expectedNewProviderSubjectId: input.expectedNewProviderSubjectId,
        authorityGeneration: authority.authorityGeneration,
        globalAuthEpoch: authority.globalAuthEpoch,
        reasonDigest: input.reasonDigest,
        principal: claim,
        credentialIdHash: input.credentialIdHash,
        credentialFloorGeneration: input.credentialFloorGeneration,
      };
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies (
          ceremony_id, nonce_digest, kind, expected_provider,
          expected_provider_subject_id, expected_companion_id, exact_scope,
          status, global_auth_epoch, created_at, expires_at, protocol_version,
          exact_origin, rp_id, credential_floor_generation,
          prior_credential_id_hash, confirmed_at
        ) VALUES (
          $1, $2, 'provider_recovery', 'discord', $3, $4, $5::jsonb,
          'pending', $6, $7, $8, 2, $9, $10, $11, $12, $7
        )
      `, [
        input.ceremonyId,
        digest(input.oneTimeCredential),
        input.expectedNewProviderSubjectId,
        input.companionId,
        JSON.stringify(scope),
        authority.globalAuthEpoch,
        input.now,
        input.expiresAt,
        input.exactOrigin,
        input.rpId,
        input.credentialFloorGeneration,
        input.credentialIdHash,
      ]);
      await this.audit(client, {
        action: 'authority.provider_recovery.create',
        decision: 'allow',
        reason: 'trusted_host_confirmed',
        resource: `ceremony:${digest(input.ceremonyId)}`,
        companionId: input.companionId,
        principalId: input.principalId,
        authority,
        correlationId: input.ceremonyId,
        at: input.now,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      await this.persistDeny('authority.provider_recovery.create', input.oneTimeCredential, input.now);
      throw error;
    } finally {
      client.release();
    }
  }

  async createChallenge(
    input: Parameters<TrustedHostProviderRecoveryStore['createChallenge']>[0],
  ): ReturnType<TrustedHostProviderRecoveryStore['createChallenge']> {
    return await this.withBrowserAttempt(
      'authority.provider_recovery.challenge.create',
      input.oneTimeCredential,
      input.now,
      async client => {
        const { authority, ceremony, scope, session } = await this.lockExactBrowserAttempt(
          client,
          input,
        );
        if (ceremony.webauthn_challenge_digest || ceremony.webauthn_challenge_ciphertext
          || ceremony.recovery_receipt_digest
          || input.credentialFloorGeneration !== scope.credentialFloorGeneration) {
          throw new TrustedHostProviderRecoveryError(
            'ceremony_unavailable',
            'Recovery challenge is unavailable',
          );
        }
        const floor = this.options.passkeyAuthority.readPasskeys();
        if (floor.generation !== input.credentialFloorGeneration
          || !floor.credentials.some(entry => entry.status === 'current'
            && timingSafeStringEqual(entry.credentialIdHash, scope.credentialIdHash)
            && entry.principalId === scope.principalId
            && entry.expectedProviderSubjectId === scope.currentProviderSubjectId)) {
          throw new TrustedHostProviderRecoveryError(
            'provider_authority_changed',
            'Recovery passkey authority changed before challenge creation',
          );
        }
        await client.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          SET webauthn_challenge_digest = $2,
              webauthn_challenge_ciphertext = $3,
              attempt_count = attempt_count + 1
          WHERE ceremony_id = $1
        `, [ceremony.ceremony_id, digest(input.challenge), this.codec.encrypt(input.challenge)]);
        await this.audit(client, {
          action: 'authority.provider_recovery.challenge.create',
          decision: 'allow',
          reason: 'trusted_host_oauth_bound',
          resource: `ceremony:${digest(ceremony.ceremony_id)}`,
          companionId: ceremony.expected_companion_id,
          principalId: scope.principalId,
          authority,
          correlationId: ceremony.ceremony_id,
          at: input.now,
        });
        return this.prepared(ceremony, scope, session, input.challenge);
      },
    );
  }

  async prepareChallenge(
    input: Parameters<TrustedHostProviderRecoveryStore['prepareChallenge']>[0],
  ): ReturnType<TrustedHostProviderRecoveryStore['prepareChallenge']> {
    return await this.withBrowserAttempt(
      'authority.provider_recovery.challenge.prepare',
      input.oneTimeCredential,
      input.now,
      async client => {
        const { ceremony, scope, session } = await this.lockExactBrowserAttempt(client, input);
        if (!ceremony.webauthn_challenge_digest || !ceremony.webauthn_challenge_ciphertext
          || ceremony.recovery_receipt_digest || ceremony.attempt_count >= 5) {
          throw new TrustedHostProviderRecoveryError(
            'ceremony_unavailable',
            'Recovery challenge is unavailable',
          );
        }
        const challenge = this.codec.decrypt(ceremony.webauthn_challenge_ciphertext);
        if (!timingSafeStringEqual(digest(challenge), ceremony.webauthn_challenge_digest)) {
          throw new TrustedHostProviderRecoveryError(
            'ceremony_unavailable',
            'Recovery challenge integrity check failed',
          );
        }
        await client.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          SET attempt_count = attempt_count + 1
          WHERE ceremony_id = $1
        `, [ceremony.ceremony_id]);
        return this.prepared(ceremony, scope, session, challenge);
      },
    );
  }

  async recordWebAuthn(
    input: Parameters<TrustedHostProviderRecoveryStore['recordWebAuthn']>[0],
  ): ReturnType<TrustedHostProviderRecoveryStore['recordWebAuthn']> {
    await this.withBrowserAttempt(
      'authority.provider_recovery.webauthn.verify',
      input.oneTimeCredential,
      input.now,
      async client => {
        const common = await this.lockExactBrowserAttempt(client, {
          oneTimeCredential: input.oneTimeCredential,
          confirmation: 'provider.recover',
          reasonDigest: input.prepared.reasonDigest,
          newProvider: input.newProvider,
          token: input.token,
          csrfToken: input.csrfToken,
          exactOrigin: input.exactOrigin,
          now: input.now,
        });
        const { authority, ceremony, scope, session } = common;
        const challenge = ceremony.webauthn_challenge_ciphertext
          ? this.codec.decrypt(ceremony.webauthn_challenge_ciphertext)
          : undefined;
        if (!ceremony.webauthn_challenge_digest || ceremony.recovery_receipt_digest
          || typeof challenge !== 'string'
          || !timingSafeStringEqual(challenge, input.prepared.challenge)
          || !timingSafeStringEqual(
            digest(input.prepared.challenge),
            ceremony.webauthn_challenge_digest,
          )
          || !timingSafeStringEqual(input.credentialIdHash, scope.credentialIdHash)
          || input.prepared.ceremonyId !== ceremony.ceremony_id
          || input.prepared.actorSession.sessionId !== session.record_id) {
          throw new TrustedHostProviderRecoveryError(
            'ceremony_unavailable',
            'Recovery verification receipt is unavailable',
          );
        }
        const floor = this.options.passkeyAuthority.readPasskeys();
        const credential = floor.credentials.find(entry => entry.status === 'current'
          && timingSafeStringEqual(entry.credentialIdHash, input.credentialIdHash)
          && entry.generation === input.credentialGeneration
          && entry.principalId === scope.principalId
          && entry.expectedProviderSubjectId === scope.currentProviderSubjectId);
        if (floor.generation !== input.completedCredentialFloorGeneration || !credential) {
          throw new TrustedHostProviderRecoveryError(
            'provider_authority_changed',
            'Recovery passkey authority changed during verification',
          );
        }
        await client.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
          SET recovery_receipt_digest = $2,
              recovery_credential_id_hash = $3,
              recovery_credential_generation = $4,
              credential_floor_generation = $5
          WHERE ceremony_id = $1
        `, [
          ceremony.ceremony_id,
          digest(input.webAuthnReceipt),
          input.credentialIdHash,
          input.credentialGeneration,
          input.completedCredentialFloorGeneration,
        ]);
        await this.audit(client, {
          action: 'authority.provider_recovery.webauthn.verify',
          decision: 'allow',
          reason: 'webauthn_uv',
          resource: `ceremony:${digest(ceremony.ceremony_id)}`,
          companionId: ceremony.expected_companion_id,
          principalId: scope.principalId,
          authority,
          correlationId: ceremony.ceremony_id,
          at: input.now,
        });
      },
    );
  }

  private async withBrowserAttempt<T>(
    action: string,
    credential: string,
    now: Date,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.options.authorityPool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      await this.persistDeny(action, credential, now);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockExactBrowserAttempt(
    client: PoolClient,
    input: {
      oneTimeCredential: string;
      confirmation: 'provider.recover';
      reasonDigest: string;
      newProvider: ProviderRecoveryOAuthProof;
      token: string;
      csrfToken: string;
      exactOrigin: string;
      now: Date;
    },
  ): Promise<{
    authority: { authorityGeneration: number; globalAuthEpoch: number };
    ceremony: CeremonyRow;
    scope: RecoveryScope;
    session: SessionRow;
  }> {
    const authority = await this.lockAuthority(client);
    const result = await client.query<CeremonyRow>(`
      SELECT ceremony_id, expected_provider_subject_id, expected_companion_id,
             exact_scope, status, global_auth_epoch, expires_at,
             webauthn_challenge_digest, webauthn_challenge_ciphertext,
             exact_origin, rp_id, credential_floor_generation,
             prior_credential_id_hash, recovery_receipt_digest,
             recovery_credential_id_hash, recovery_credential_generation,
             attempt_count
      FROM ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
      WHERE nonce_digest = $1 AND kind = 'provider_recovery' AND protocol_version = 2
      FOR UPDATE
    `, [digest(input.oneTimeCredential)]);
    const ceremony = result.rows.at(0);
    if (!ceremony || ceremony.status !== 'pending'
      || ceremony.expires_at.getTime() <= input.now.getTime()
      || ceremony.global_auth_epoch !== String(authority.globalAuthEpoch)
      || ceremony.exact_origin !== input.exactOrigin
      || ceremony.rp_id !== new URL(input.exactOrigin).hostname) {
      throw new TrustedHostProviderRecoveryError(
        'ceremony_unavailable',
        'Recovery ceremony is unavailable',
      );
    }
    const scope = parseScope(ceremony.exact_scope);
    const session = await this.lockSession(client, input.token, input.csrfToken, input.now);
    if (!timingSafeStringEqual(input.reasonDigest, scope.reasonDigest)
      || ceremony.expected_provider_subject_id !== scope.expectedNewProviderSubjectId
      || ceremony.expected_companion_id.length === 0
      || typeof ceremony.prior_credential_id_hash !== 'string'
      || !timingSafeStringEqual(ceremony.prior_credential_id_hash, scope.credentialIdHash)
      || authority.authorityGeneration !== scope.authorityGeneration
      || authority.globalAuthEpoch !== scope.globalAuthEpoch
      || session.principal_id !== scope.principalId
      || session.provider_subject_id !== scope.currentProviderSubjectId
      || session.provider_authority_generation
        !== String(scope.currentProviderAuthorityGeneration)
      || session.record_id.length === 0
      || session.authn_version !== String(scope.principal.authnVersion)
      || session.authz_version !== String(scope.principal.authzVersion)
      || session.binding_version !== String(scope.principal.bindingVersion)
      || session.grant_version !== String(scope.principal.grantVersion)
      || session.policy_version !== String(scope.principal.policyVersion)
      || input.newProvider.subjectId !== scope.expectedNewProviderSubjectId) {
      throw new TrustedHostProviderRecoveryError(
        'provider_authority_changed',
        'Recovery browser authority does not match its trusted-host binding',
      );
    }
    await this.lockOAuthProof(client, ceremony.ceremony_id, session, input.newProvider, input.now);
    return { authority, ceremony, scope, session };
  }

  private async lockOAuthProof(
    client: PoolClient,
    ceremonyId: string,
    session: SessionRow,
    proof: ProviderRecoveryOAuthProof,
    now: Date,
  ): Promise<void> {
    const result = await client.query<{
      verified_provider: string;
      verified_provider_subject_id: string;
    }>(`
      SELECT transaction.verified_provider, transaction.verified_provider_subject_id
      FROM ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions AS transaction
      WHERE transaction.transaction_id = $1
        AND transaction.status = 'consumed'
        AND transaction.consumed_at IS NOT NULL
        AND transaction.consumed_at <= $2
        AND transaction.expires_at > clock_timestamp()
        AND transaction.global_auth_epoch = $3
        AND transaction.verified_provider = 'discord'
        AND transaction.verified_provider_subject_id = $4
        AND transaction.lifecycle_ceremony_id = $5
        AND transaction.lifecycle_action = 'provider.recover'
        AND transaction.lifecycle_proof_role = 'new'
        AND transaction.initiating_principal_id = $6
        AND transaction.initiating_session_id = $7
        AND transaction.kind = 'recovery'
      FOR UPDATE OF transaction
    `, [
      proof.callbackTransactionId,
      now,
      session.global_auth_epoch,
      proof.subjectId,
      ceremonyId,
      session.principal_id,
      session.record_id,
    ]);
    const row = result.rows.at(0);
    if (!row || row.verified_provider !== proof.provider
      || row.verified_provider_subject_id !== proof.subjectId
      || !timingSafeStringEqual(
        proof.proofDigest,
        digestFleetAuthVerifiedProviderProof({
          provider: proof.provider,
          subjectId: proof.subjectId,
          callbackTransactionId: proof.callbackTransactionId,
        }),
      )) {
      throw new TrustedHostProviderRecoveryError(
        'ceremony_unavailable',
        'Recovery OAuth proof is unavailable',
      );
    }
  }

  private async lockSession(
    client: PoolClient,
    token: string,
    csrfToken: string,
    now: Date,
  ): Promise<SessionRow> {
    const result = await client.query<SessionRow>(`
      SELECT session.record_id, session.principal_id,
             principal.status AS principal_status,
             principal.authn_version, principal.authz_version,
             principal.binding_version, principal.grant_version, principal.policy_version,
             session.authn_version AS session_authn_version,
             session.authz_version AS session_authz_version,
             session.binding_version AS session_binding_version,
             session.grant_version AS session_grant_version,
             session.policy_version AS session_policy_version,
             session.provider_subject_id, subject.authority_generation AS provider_authority_generation,
             subject.state AS provider_state, subject.restore_state AS provider_restore_state,
             authority.authority_generation, authority.global_auth_epoch,
             session.global_auth_epoch AS session_global_auth_epoch,
             session.idle_expires_at, session.absolute_expires_at,
             session.revoked_at, session.replaced_by, principal.restore_state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions AS session
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.human_principals AS principal
        ON principal.principal_id = session.principal_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS subject
        ON subject.provider = 'discord'
       AND subject.subject_id = session.provider_subject_id
       AND subject.principal_id = session.principal_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.authority_state AS authority ON authority.singleton = TRUE
      WHERE session.token_digest = $1 AND session.csrf_digest = $2
      FOR UPDATE OF session, principal, subject
    `, [this.codec.digest(token), this.codec.digest(csrfToken)]);
    const row = result.rows.at(0);
    if (!row || row.revoked_at || row.replaced_by
      || row.idle_expires_at.getTime() <= now.getTime()
      || row.absolute_expires_at.getTime() <= now.getTime()
      || row.restore_state !== 'live' || row.principal_status !== 'active'
      || row.provider_state !== 'active' || row.provider_restore_state !== 'live'
      || row.authn_version !== row.session_authn_version
      || row.authz_version !== row.session_authz_version
      || row.binding_version !== row.session_binding_version
      || row.grant_version !== row.session_grant_version
      || row.policy_version !== row.session_policy_version
      || row.global_auth_epoch !== row.session_global_auth_epoch
      || !this.options.providerRevocationAuthority.sessionAuthorityGenerationIsCurrent(
        integer(row.authority_generation, 'authority_generation'),
      )) {
      throw new TrustedHostProviderRecoveryError(
        'ceremony_unavailable',
        'Recovery session authority is unavailable',
      );
    }
    return row;
  }

  private async lockAuthority(client: PoolClient): Promise<{
    authorityGeneration: number;
    globalAuthEpoch: number;
  }> {
    const result = await client.query<AuthorityRow>(`
      SELECT authority_generation, global_auth_epoch
      FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
      WHERE singleton = TRUE
      FOR UPDATE
    `);
    const row = result.rows.at(0);
    if (!row) throw new Error('fleet_auth authority state is unavailable');
    return {
      authorityGeneration: integer(row.authority_generation, 'authority_generation'),
      globalAuthEpoch: integer(row.global_auth_epoch, 'global_auth_epoch'),
    };
  }

  private prepared(
    ceremony: CeremonyRow,
    scope: RecoveryScope,
    session: SessionRow,
    challenge: string,
  ): PreparedProviderRecovery {
    return {
      ceremonyId: ceremony.ceremony_id,
      challenge,
      companionId: ceremony.expected_companion_id,
      principal: scope.principal,
      actorSession: {
        sessionId: session.record_id,
        authnVersion: scope.principal.authnVersion,
        authzVersion: scope.principal.authzVersion,
        bindingVersion: scope.principal.bindingVersion,
        grantVersion: scope.principal.grantVersion,
        policyVersion: scope.principal.policyVersion,
        globalAuthEpoch: scope.globalAuthEpoch,
        provider: 'discord',
        providerSubjectId: scope.currentProviderSubjectId,
      },
      currentProviderSubjectId: scope.currentProviderSubjectId,
      currentProviderAuthorityGeneration: scope.currentProviderAuthorityGeneration,
      expectedNewProviderSubjectId: scope.expectedNewProviderSubjectId,
      authorityGeneration: scope.authorityGeneration,
      globalAuthEpoch: scope.globalAuthEpoch,
      reasonDigest: scope.reasonDigest,
      credentialIdHash: scope.credentialIdHash,
      credentialFloorGeneration: scope.credentialFloorGeneration,
    };
  }

  private async persistDeny(
    action: string,
    credential: string,
    at: Date,
    reason = 'trusted_host_provider_recovery_denied',
  ): Promise<void> {
    const client = await this.options.authorityPool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      await this.audit(client, {
        action,
        decision: 'deny',
        reason,
        resource: `credential:${digest(credential)}`,
        companionId: null,
        principalId: null,
        authority,
        correlationId: digest(credential),
        at,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new TrustedHostProviderRecoveryError(
        'ceremony_unavailable',
        `Recovery denial audit failed: ${String(error)}`,
      );
    } finally {
      client.release();
    }
  }

  private async audit(client: PoolClient, input: {
    action: string;
    decision: 'allow' | 'deny';
    reason: string;
    resource: string;
    companionId: string | null;
    principalId: string | null;
    authority: { authorityGeneration: number; globalAuthEpoch: number };
    correlationId: string;
    at: Date;
  }): Promise<void> {
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events (
        event_id, actor_context, action, resource, decision, reason_code,
        companion_id, principal_id, authority_generation, global_auth_epoch,
        correlation_id, occurred_at
      ) VALUES (
        $1, '{"kind":"trusted_host_provider_recovery"}'::jsonb,
        $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      )
    `, [
      randomUUID(),
      input.action,
      input.resource,
      input.decision,
      input.reason,
      input.companionId,
      input.principalId,
      input.authority.authorityGeneration,
      input.authority.globalAuthEpoch,
      input.correlationId,
      input.at,
    ]);
  }
}
