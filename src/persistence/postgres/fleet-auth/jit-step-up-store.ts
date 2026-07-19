import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  FleetJitStepUpError,
  type FleetJitDurableRequestBinding,
  type FleetJitGrantBinding,
  type FleetJitPendingChallenge,
  type FleetJitStepUpStore,
} from '../../../boundary/fleet-auth/jit-step-up.js';
import type { PasskeyAuthorityPort } from '../../../boundary/fleet-auth/passkey-authority.js';
import { FLEET_AUTH_ACTIONS, type FleetAuthAction } from '../../../system/config/fleet-auth-config.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import { FleetAuthSecretCodec } from './oauth-secret-codec.js';
import type { ProviderRevocationAuthorityPort } from './provider-revocation-authority.js';
import { createPositiveIntegerCoercer } from './row-utils.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

const ACTIONS = new Set<string>(FLEET_AUTH_ACTIONS);

interface LockedSession {
  record_id: string;
  principal_id: string;
  principal_status: string;
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
  provider: string | null;
  provider_subject_id: string | null;
  provider_state: string | null;
  provider_restore_state: string | null;
  authority_generation: string;
  global_auth_epoch: string;
  session_global_auth_epoch: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
  restore_state: string;
}

interface ChallengeRow {
  challenge_id: string;
  principal_id: string;
  browser_session_id: string;
  challenge_digest: string;
  challenge_ciphertext: Buffer;
  kind: 'webauthn_uv' | 'discord_possession';
  action: string;
  resource_digest: string;
  request_nonce_digest: string;
  companion_id: string;
  target_digest: string;
  authorization_digest: string;
  assurance_requirement: FleetJitDurableRequestBinding['assuranceRequirement'];
  subject_scope_digest: string;
  purpose_digest: string;
  exact_origin: string;
  credential_floor_generation: string;
  memory_revision: string;
  classifier_evidence_digest: string;
  global_auth_epoch: string;
  status: string;
  attempt_count: number;
  expires_at: Date;
}

interface GrantRow {
  grant_id: string;
  principal_id: string;
  browser_session_id: string;
  assurance: 'webauthn_uv' | 'discord_possession';
  credential_floor_generation: string;
  expires_at: Date;
}

export interface PostgresFleetJitStepUpStoreOptions {
  pool: Pool;
  sessionPepper: string;
  tokenEncryptionKey: string;
  providerRevocationAuthority: ProviderRevocationAuthorityPort;
  passkeyAuthority: PasskeyAuthorityPort;
}

const positiveInteger = createPositiveIntegerCoercer('jit-step-up');

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function grant(row: GrantRow): FleetJitGrantBinding {
  return {
    grantId: row.grant_id,
    principalId: row.principal_id,
    browserSessionId: row.browser_session_id,
    assurance: row.assurance,
    credentialFloorGeneration: positiveInteger(
      row.credential_floor_generation,
      'credential_floor_generation',
      row.assurance === 'discord_possession',
    ),
    expiresAt: row.expires_at,
  };
}

/** Runtime DML is bounded to exact challenges and one-shot grants; no Pool escapes. */
export class PostgresFleetJitStepUpStore implements FleetJitStepUpStore {
  private readonly codec: FleetAuthSecretCodec;

  constructor(private readonly options: PostgresFleetJitStepUpStoreOptions) {
    this.codec = new FleetAuthSecretCodec(options);
  }

  async createChallenge(
    input: Parameters<FleetJitStepUpStore['createChallenge']>[0],
  ): ReturnType<FleetJitStepUpStore['createChallenge']> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockAuthority(client);
      const session = await this.lockSession(client, input.token, input.csrfToken, input.now);
      await this.requireCompanionAuthority(
        client,
        session.principal_id,
        input.binding.companionId,
      );
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
        SET status = 'expired'
        WHERE protocol_version = 1 AND status = 'pending' AND expires_at <= $1
      `, [input.now]);
      const recent = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
        WHERE protocol_version = 1
          AND browser_session_id = $1
          AND created_at > $2::timestamptz - interval '10 minutes'
          AND status IN ('pending', 'consumed', 'failed')
      `, [session.record_id, input.now]);
      if (positiveInteger(recent.rows.at(0)?.count ?? '0', 'challenge rate count', true) >= 5) {
        throw new FleetJitStepUpError('challenge_unavailable', 'JIT challenge rate limit exceeded');
      }
      if (input.assurance === 'webauthn_uv') {
        const floor = this.options.passkeyAuthority.readPasskeys();
        if (floor.generation !== input.credentialFloorGeneration
          || !floor.credentials.some(entry => entry.status === 'current'
            && entry.principalId === session.principal_id
            && entry.expectedProviderSubjectId === session.provider_subject_id)) {
          throw new FleetJitStepUpError(
            'strong_assurance_required',
            'No exact current passkey is available for this session',
          );
        }
      } else if (input.binding.assuranceRequirement === 'webauthn_uv'
        || input.binding.assuranceRequirement === 'privacy_break_glass') {
        throw new FleetJitStepUpError(
          'strong_assurance_required',
          'This action requires a user-verifying passkey',
        );
      }
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges (
          challenge_id, principal_id, browser_session_id, challenge_digest,
          challenge_ciphertext, kind, action, resource_digest, global_auth_epoch,
          status, created_at, expires_at, protocol_version, request_nonce_digest,
          companion_id, target_digest, authorization_digest, assurance_requirement,
          subject_scope_digest, purpose_digest, exact_origin,
          credential_floor_generation, memory_revision, classifier_evidence_digest
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          'pending', $10, $11, 1, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22
        )
      `, [
        input.challengeId,
        session.principal_id,
        session.record_id,
        digest(input.challenge),
        this.codec.encrypt(input.challenge),
        input.assurance,
        input.binding.action,
        input.binding.resourceDigest,
        session.global_auth_epoch,
        input.now,
        input.expiresAt,
        input.requestNonceDigest,
        input.binding.companionId,
        input.binding.targetDigest,
        input.binding.authorizationDigest,
        input.binding.assuranceRequirement,
        input.binding.subjectScopeDigest,
        input.binding.purposeDigest,
        input.exactOrigin,
        input.credentialFloorGeneration,
        input.binding.memoryRevision,
        input.binding.classifierEvidenceDigest,
      ]);
      await this.audit(client, {
        action: 'jit.challenge.create',
        resource: `target:${input.binding.targetDigest}`,
        decision: 'allow',
        reason: input.assurance,
        companionId: input.binding.companionId,
        principalId: session.principal_id,
        authorityGeneration: session.authority_generation,
        globalAuthEpoch: session.global_auth_epoch,
        correlationId: input.challengeId,
        at: input.now,
      });
      await client.query('COMMIT');
      return {
        principalId: session.principal_id,
        providerSubjectId: session.provider_subject_id!,
        browserSessionId: session.record_id,
        globalAuthEpoch: positiveInteger(session.global_auth_epoch, 'global_auth_epoch'),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async prepareChallenge(
    input: Parameters<FleetJitStepUpStore['prepareChallenge']>[0],
  ): ReturnType<FleetJitStepUpStore['prepareChallenge']> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockAuthority(client);
      const session = await this.lockSession(client, input.token, input.csrfToken, input.now);
      const result = await client.query<ChallengeRow>(`
        SELECT challenge_id, principal_id, browser_session_id, challenge_digest,
               challenge_ciphertext, kind, action, resource_digest,
               request_nonce_digest, companion_id, target_digest,
               authorization_digest, assurance_requirement, subject_scope_digest,
               purpose_digest, exact_origin, credential_floor_generation,
               memory_revision, classifier_evidence_digest, global_auth_epoch,
               status, attempt_count, expires_at
        FROM ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
        WHERE challenge_id = $1 AND protocol_version = 1
        FOR UPDATE
      `, [input.challengeId]);
      const row = result.rows.at(0);
      if (!row || row.status !== 'pending' || row.expires_at.getTime() <= input.now.getTime()
        || row.principal_id !== session.principal_id
        || row.browser_session_id !== session.record_id
        || row.global_auth_epoch !== session.global_auth_epoch
        || row.request_nonce_digest !== input.requestNonceDigest
        || row.exact_origin !== input.exactOrigin
        || row.attempt_count >= 5) {
        if (row?.status === 'pending' && row.expires_at.getTime() <= input.now.getTime()) {
          await client.query(`
            UPDATE ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges SET status = 'expired'
            WHERE challenge_id = $1
          `, [input.challengeId]);
        }
        throw new FleetJitStepUpError('challenge_unavailable', 'JIT challenge is unavailable');
      }
      const challenge = this.codec.decrypt(row.challenge_ciphertext);
      if (digest(challenge) !== row.challenge_digest) {
        await client.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges SET status = 'failed'
          WHERE challenge_id = $1
        `, [input.challengeId]);
        throw new FleetJitStepUpError('challenge_unavailable', 'JIT challenge integrity check failed');
      }
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
        SET attempt_count = attempt_count + 1
        WHERE challenge_id = $1
      `, [input.challengeId]);
      await client.query('COMMIT');
      return this.pending(row, challenge, session.provider_subject_id!);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeChallenge(
    input: Parameters<FleetJitStepUpStore['completeChallenge']>[0],
  ): ReturnType<FleetJitStepUpStore['completeChallenge']> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockAuthority(client);
      const session = await this.lockSession(client, input.token, input.csrfToken, input.now);
      const result = await client.query<ChallengeRow>(`
        SELECT challenge_id, principal_id, browser_session_id, challenge_digest,
               challenge_ciphertext, kind, action, resource_digest,
               request_nonce_digest, companion_id, target_digest,
               authorization_digest, assurance_requirement, subject_scope_digest,
               purpose_digest, exact_origin, credential_floor_generation,
               memory_revision, classifier_evidence_digest, global_auth_epoch,
               status, attempt_count, expires_at
        FROM ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
        WHERE challenge_id = $1 AND protocol_version = 1
        FOR UPDATE
      `, [input.challenge.challengeId]);
      const row = result.rows.at(0);
      if (!row || !this.samePending(row, input.challenge)
        || row.status !== 'pending' || row.expires_at.getTime() <= input.now.getTime()
        || row.principal_id !== session.principal_id
        || row.browser_session_id !== session.record_id
        || row.global_auth_epoch !== session.global_auth_epoch) {
        throw new FleetJitStepUpError('challenge_unavailable', 'JIT challenge changed during verification');
      }
      const floor = this.options.passkeyAuthority.readPasskeys();
      if (row.kind === 'webauthn_uv') {
        const startedAt = positiveInteger(row.credential_floor_generation, 'credential_floor_generation');
        if (input.completedCredentialFloorGeneration !== startedAt + 1
          || floor.generation !== input.completedCredentialFloorGeneration
          || !floor.credentials.some(entry => entry.status === 'current'
            && entry.generation === input.completedCredentialFloorGeneration
            && entry.principalId === session.principal_id
            && entry.expectedProviderSubjectId === session.provider_subject_id)) {
          throw new FleetJitStepUpError('challenge_unavailable', 'Passkey authority changed during JIT verification');
        }
      } else if (floor.generation !== input.completedCredentialFloorGeneration
        || positiveInteger(row.credential_floor_generation, 'credential_floor_generation', true)
          !== input.completedCredentialFloorGeneration) {
        throw new FleetJitStepUpError('challenge_unavailable', 'Passkey authority changed during approval');
      }
      const grantId = randomUUID();
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
        SET status = 'consumed', consumed_at = $2,
            credential_floor_generation = $3
        WHERE challenge_id = $1
      `, [row.challenge_id, input.now, input.completedCredentialFloorGeneration]);
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.jit_authorization_grants (
          grant_id, principal_id, browser_session_id, companion_id,
          subject_scope, action, resource_selector, purpose, assurance,
          memory_revision, classifier_evidence_digest, authz_version,
          binding_version, global_auth_epoch, issued_at, expires_at,
          grant_version, policy_version, protocol_version, challenge_id,
          target_digest, authorization_digest, subject_scope_digest,
          purpose_digest, exact_origin, credential_floor_generation
        ) VALUES (
          $1, $2, $3, $4, jsonb_build_object('digest', $5::text), $6,
          jsonb_build_object('digest', $7::text), $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17, $18, 1, $19,
          $20, $21, $5, $22, $23, $24
        )
      `, [
        grantId,
        session.principal_id,
        session.record_id,
        row.companion_id,
        row.subject_scope_digest,
        row.action,
        row.resource_digest,
        `sha256:${row.purpose_digest}`,
        row.kind,
        positiveInteger(row.memory_revision, 'memory_revision'),
        row.classifier_evidence_digest,
        positiveInteger(session.authz_version, 'authz_version'),
        positiveInteger(session.binding_version, 'binding_version'),
        positiveInteger(session.global_auth_epoch, 'global_auth_epoch'),
        input.now,
        input.grantExpiresAt,
        positiveInteger(session.grant_version, 'grant_version'),
        positiveInteger(session.policy_version, 'policy_version'),
        row.challenge_id,
        row.target_digest,
        row.authorization_digest,
        row.purpose_digest,
        row.exact_origin,
        input.completedCredentialFloorGeneration,
      ]);
      await this.audit(client, {
        action: 'jit.challenge.consume',
        resource: `target:${row.target_digest}`,
        decision: 'allow',
        reason: row.kind,
        companionId: row.companion_id,
        principalId: session.principal_id,
        authorityGeneration: session.authority_generation,
        globalAuthEpoch: session.global_auth_epoch,
        correlationId: row.challenge_id,
        at: input.now,
      });
      await client.query('COMMIT');
      return {
        grantId,
        principalId: session.principal_id,
        browserSessionId: session.record_id,
        assurance: row.kind,
        credentialFloorGeneration: input.completedCredentialFloorGeneration,
        expiresAt: input.grantExpiresAt,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelChallenge(
    input: Parameters<FleetJitStepUpStore['cancelChallenge']>[0],
  ): ReturnType<FleetJitStepUpStore['cancelChallenge']> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockAuthority(client);
      const session = await this.lockSession(client, input.token, input.csrfToken, input.now);
      const result = await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
        SET status = 'cancelled', cancelled_at = $4
        WHERE challenge_id = $1 AND protocol_version = 1 AND status = 'pending'
          AND browser_session_id = $2 AND principal_id = $3 AND exact_origin = $5
      `, [input.challengeId, session.record_id, session.principal_id, input.now, input.exactOrigin]);
      if (result.rowCount !== 1) {
        throw new FleetJitStepUpError('challenge_unavailable', 'JIT challenge is unavailable');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeGrant(
    input: Parameters<FleetJitStepUpStore['consumeGrant']>[0],
  ): ReturnType<FleetJitStepUpStore['consumeGrant']> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockAuthority(client);
      const session = await this.lockSessionByToken(client, input.token, input.now);
      const purposeDigest = digest(input.binding.purpose.trim());
      const result = await client.query<GrantRow>(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.jit_authorization_grants
        SET consumed_at = $2
        WHERE grant_id = $1 AND protocol_version = 1
          AND principal_id = $3 AND browser_session_id = $4
          AND companion_id = $5 AND action = $6
          AND target_digest = $7 AND authorization_digest = $8
          AND subject_scope_digest = $9 AND purpose_digest = $10
          AND classifier_evidence_digest = $11 AND memory_revision = $12
          AND exact_origin = $13
          AND authz_version = $14 AND binding_version = $15
          AND grant_version = $16 AND policy_version = $17
          AND global_auth_epoch = $18
          AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > $2
          AND credential_floor_generation = $19
        RETURNING grant_id, principal_id, browser_session_id, assurance,
                  credential_floor_generation, expires_at
      `, [
        input.grantId,
        input.now,
        session.principal_id,
        session.record_id,
        input.binding.target.companionId,
        input.binding.target.action,
        input.binding.target.targetDigest,
        input.binding.target.authorizationDigest,
        input.binding.subjectScopeDigest,
        purposeDigest,
        input.binding.classifierEvidenceDigest,
        input.binding.memoryRevision,
        input.exactOrigin,
        session.authz_version,
        session.binding_version,
        session.grant_version,
        session.policy_version,
        session.global_auth_epoch,
        this.options.passkeyAuthority.readPasskeys().generation,
      ]);
      const row = result.rows.at(0);
      if (!row) {
        throw new FleetJitStepUpError('grant_unavailable', 'JIT grant is unavailable');
      }
      await this.audit(client, {
        action: 'jit.grant.consume',
        resource: `target:${input.binding.target.targetDigest}`,
        decision: 'allow',
        reason: row.assurance,
        companionId: input.binding.target.companionId,
        principalId: session.principal_id,
        authorityGeneration: session.authority_generation,
        globalAuthEpoch: session.global_auth_epoch,
        correlationId: row.grant_id,
        at: input.now,
      });
      await client.query('COMMIT');
      return grant(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private pending(
    row: ChallengeRow,
    challenge: string,
    providerSubjectId: string,
  ): FleetJitPendingChallenge {
    if (!ACTIONS.has(row.action)) throw new Error('Invalid fleet_auth step-up action');
    return {
      challengeId: row.challenge_id,
      challenge,
      requestNonceDigest: row.request_nonce_digest,
      assurance: row.kind,
      principalId: row.principal_id,
      providerSubjectId,
      browserSessionId: row.browser_session_id,
      globalAuthEpoch: positiveInteger(row.global_auth_epoch, 'global_auth_epoch'),
      credentialFloorGeneration: positiveInteger(
        row.credential_floor_generation,
        'credential_floor_generation',
        row.kind === 'discord_possession',
      ),
      binding: {
        companionId: row.companion_id,
        action: row.action as FleetAuthAction,
        resourceDigest: row.resource_digest,
        authorizationDigest: row.authorization_digest,
        targetDigest: row.target_digest,
        subjectScopeDigest: row.subject_scope_digest,
        purposeDigest: row.purpose_digest,
        memoryRevision: positiveInteger(row.memory_revision, 'memory_revision'),
        classifierEvidenceDigest: row.classifier_evidence_digest,
        assuranceRequirement: row.assurance_requirement,
      },
    };
  }

  private samePending(row: ChallengeRow, pending: FleetJitPendingChallenge): boolean {
    return row.challenge_id === pending.challengeId
      && row.principal_id === pending.principalId
      && row.browser_session_id === pending.browserSessionId
      && row.kind === pending.assurance
      && row.action === pending.binding.action
      && row.resource_digest === pending.binding.resourceDigest
      && row.companion_id === pending.binding.companionId
      && row.target_digest === pending.binding.targetDigest
      && row.authorization_digest === pending.binding.authorizationDigest
      && row.assurance_requirement === pending.binding.assuranceRequirement
      && row.subject_scope_digest === pending.binding.subjectScopeDigest
      && row.purpose_digest === pending.binding.purposeDigest
      && row.classifier_evidence_digest === pending.binding.classifierEvidenceDigest
      && positiveInteger(row.memory_revision, 'memory_revision') === pending.binding.memoryRevision
      && positiveInteger(row.global_auth_epoch, 'global_auth_epoch') === pending.globalAuthEpoch
      && digest(pending.challenge) === row.challenge_digest;
  }

  private async lockAuthority(client: PoolClient): Promise<void> {
    await client.query(`SELECT global_auth_epoch FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()`);
  }

  private lockSession(
    client: PoolClient,
    token: string,
    csrfToken: string,
    now: Date,
  ): Promise<LockedSession> {
    return this.lockSessionWithDigest(client, this.codec.digest(token), this.codec.digest(csrfToken), now);
  }

  private lockSessionByToken(
    client: PoolClient,
    token: string,
    now: Date,
  ): Promise<LockedSession> {
    return this.lockSessionWithDigest(client, this.codec.digest(token), undefined, now);
  }

  private async lockSessionWithDigest(
    client: PoolClient,
    tokenDigest: string,
    csrfDigest: string | undefined,
    now: Date,
  ): Promise<LockedSession> {
    const result = await client.query<LockedSession>(`
      SELECT session.record_id, session.principal_id,
             principal.status AS principal_status,
             principal.authn_version, principal.authz_version,
             principal.binding_version, principal.grant_version, principal.policy_version,
             session.authn_version AS session_authn_version,
             session.authz_version AS session_authz_version,
             session.binding_version AS session_binding_version,
             session.grant_version AS session_grant_version,
             session.policy_version AS session_policy_version,
             session.provider, session.provider_subject_id,
             subject.state AS provider_state, subject.restore_state AS provider_restore_state,
             authority.authority_generation, authority.global_auth_epoch,
             session.global_auth_epoch AS session_global_auth_epoch,
             session.idle_expires_at, session.absolute_expires_at,
             session.revoked_at, session.replaced_by, principal.restore_state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions AS session
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.human_principals AS principal
        ON principal.principal_id = session.principal_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS subject
        ON subject.provider = session.provider
       AND subject.subject_id = session.provider_subject_id
       AND subject.principal_id = session.principal_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.authority_state AS authority ON authority.singleton = TRUE
      WHERE session.token_digest = $1
        AND ($2::text IS NULL OR session.csrf_digest = $2)
      FOR UPDATE OF session, principal, subject
    `, [tokenDigest, csrfDigest ?? null]);
    const row = result.rows.at(0);
    if (!row || row.revoked_at || row.replaced_by
      || row.idle_expires_at.getTime() <= now.getTime()
      || row.absolute_expires_at.getTime() <= now.getTime()
      || row.restore_state !== 'live' || row.principal_status !== 'active'
      || row.provider !== 'discord' || !row.provider_subject_id
      || row.provider_state !== 'active' || row.provider_restore_state !== 'live'
      || row.authn_version !== row.session_authn_version
      || row.authz_version !== row.session_authz_version
      || row.binding_version !== row.session_binding_version
      || row.grant_version !== row.session_grant_version
      || row.policy_version !== row.session_policy_version
      || row.global_auth_epoch !== row.session_global_auth_epoch
      || !this.options.providerRevocationAuthority.sessionAuthorityGenerationIsCurrent(
        positiveInteger(row.authority_generation, 'authority_generation'),
      )) {
      throw new FleetJitStepUpError('challenge_unavailable', 'Fleet session is unavailable');
    }
    return row;
  }

  private async requireCompanionAuthority(
    client: PoolClient,
    principalId: string,
    companionId: string,
  ): Promise<void> {
    const result = await client.query(`
      SELECT 1
      FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings AS binding
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants AS role
        ON role.principal_id = binding.principal_id
       AND role.companion_id = binding.companion_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state AS companion
        ON companion.companion_id = binding.companion_id
      WHERE binding.principal_id = $1 AND binding.companion_id = $2
        AND binding.state = 'active' AND binding.restore_state = 'live'
        AND role.lifecycle = 'active' AND role.restore_state = 'live'
        AND companion.lifecycle = 'active' AND companion.restore_state = 'live'
      FOR SHARE OF binding, role, companion
    `, [principalId, companionId]);
    if (result.rowCount !== 1) {
      throw new FleetJitStepUpError('challenge_unavailable', 'Companion authority is unavailable');
    }
  }

  private async audit(client: PoolClient, input: {
    action: string;
    resource: string;
    decision: 'allow' | 'deny';
    reason: string;
    companionId: string;
    principalId: string;
    authorityGeneration: string;
    globalAuthEpoch: string;
    correlationId: string;
    at: Date;
  }): Promise<void> {
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events (
        event_id, actor_context, action, resource, decision, reason_code,
        companion_id, principal_id, authority_generation, global_auth_epoch,
        correlation_id, occurred_at
      ) VALUES (
        $1, '{"kind":"fleet_jit_step_up"}'::jsonb, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11
      )
    `, [
      randomUUID(), input.action, input.resource, input.decision, input.reason,
      input.companionId, input.principalId, input.authorityGeneration,
      input.globalAuthEpoch, input.correlationId, input.at,
    ]);
  }
}
