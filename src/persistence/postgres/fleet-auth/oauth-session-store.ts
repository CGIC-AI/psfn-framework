import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  FleetAuthBrokerError,
  type FleetAuthBrokerStore,
  type FleetAuthSessionRecord,
  type OAuthTransactionKind,
} from '../../../boundary/gateway/fleet-auth-broker.js';
import {
  lifecycleOAuthKindFor,
  type LifecycleOAuthAction,
  type LifecycleOAuthProofRole,
} from '../../../shared/contracts/fleet-auth-lifecycle-oauth.js';
import {
  completeFirstOwnerAuthority,
  revokeProviderAuthority,
} from './provider-lifecycle-store.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import type {
  PrincipalRow,
  SessionAuthorityRow,
} from './oauth-session-store-types.js';
import { FleetAuthSecretCodec } from './oauth-secret-codec.js';
import {
  consumeOAuthTransaction,
  createOAuthTransaction,
  resolveOAuthCallbackDestination,
} from './oauth-transaction-store.js';
import type { ProviderRevocationAuthorityPort } from './provider-revocation-authority.js';


export interface PostgresFleetAuthBrokerStoreOptions {
  pool: Pool;
  providerAuthorityPool: Pool;
  sessionPepper: string;
  tokenEncryptionKey: string;
  providerRevocationAuthority: ProviderRevocationAuthorityPort;
}

function safeInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid fleet_auth ${field}`);
  }
  return parsed;
}

export class PostgresFleetAuthBrokerStore implements FleetAuthBrokerStore {
  private readonly pool: Pool;
  private readonly providerAuthorityPool: Pool;
  private readonly codec: FleetAuthSecretCodec;
  private readonly providerRevocationAuthority: ProviderRevocationAuthorityPort;

  constructor(options: PostgresFleetAuthBrokerStoreOptions) {
    this.pool = options.pool;
    this.providerAuthorityPool = options.providerAuthorityPool;
    this.codec = new FleetAuthSecretCodec(options);
    this.providerRevocationAuthority = options.providerRevocationAuthority;
  }

  async createOAuthTransaction(
    input: Parameters<FleetAuthBrokerStore['createOAuthTransaction']>[0],
  ): Promise<void> {
    await createOAuthTransaction(this.pool, this.codec, input);
  }

  async consumeOAuthTransaction(
    input: Parameters<FleetAuthBrokerStore['consumeOAuthTransaction']>[0],
  ): ReturnType<FleetAuthBrokerStore['consumeOAuthTransaction']> {
    return await consumeOAuthTransaction(this.pool, this.codec, input);
  }

  async resolveOAuthCallbackDestination(
    input: Parameters<FleetAuthBrokerStore['resolveOAuthCallbackDestination']>[0],
  ): ReturnType<FleetAuthBrokerStore['resolveOAuthCallbackDestination']> {
    return await resolveOAuthCallbackDestination(this.pool, input);
  }

  async createLifecycleOAuthTransaction(
    input: Parameters<FleetAuthBrokerStore['createLifecycleOAuthTransaction']>[0],
  ): Promise<void> {
    const expectedKind = lifecycleOAuthKindFor(
      input.lifecyclePurpose.action,
      input.lifecyclePurpose.proofRole,
    );
    if (input.kind !== expectedKind) {
      throw new FleetAuthBrokerError(
        'oauth_transaction_kind_mismatch',
        400,
        'Lifecycle OAuth kind does not match its exact proof purpose',
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT global_auth_epoch FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()`);
      const session = await this.lockValidSession(
        client,
        input.token,
        input.csrfToken,
        input.createdAt,
      );
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
          (transaction_id, state_digest, initiating_browser_digest, pkce_verifier_digest,
           pkce_verifier_ciphertext, callback_uri, return_path, kind, status,
           global_auth_epoch, created_at, expires_at, lifecycle_ceremony_id,
           lifecycle_action, lifecycle_proof_role, initiating_principal_id,
           initiating_session_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11,
                $12, $13, $14, $15, $16)
      `, [
        input.transactionId,
        input.stateDigest,
        input.initiatingBrowserDigest,
        this.codec.digest(input.pkceVerifier),
        this.codec.encrypt(input.pkceVerifier),
        input.callbackUri,
        input.returnPath,
        input.kind,
        session.global_auth_epoch,
        input.createdAt,
        input.expiresAt,
        input.lifecyclePurpose.ceremonyId,
        input.lifecyclePurpose.action,
        input.lifecyclePurpose.proofRole,
        session.principal_id,
        session.record_id,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeLifecycleOAuthEvidence(
    input: Parameters<FleetAuthBrokerStore['completeLifecycleOAuthEvidence']>[0],
  ): ReturnType<FleetAuthBrokerStore['completeLifecycleOAuthEvidence']> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await client.query<{ global_auth_epoch: string }>(`
        SELECT global_auth_epoch
        FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()
      `);
      const transaction = await client.query<{
        status: string;
        kind: OAuthTransactionKind;
        global_auth_epoch: string;
        expires_at: Date;
        verified_provider: string | null;
        verified_provider_subject_id: string | null;
        lifecycle_ceremony_id: string | null;
        lifecycle_action: LifecycleOAuthAction | null;
        lifecycle_proof_role: LifecycleOAuthProofRole | null;
        initiating_principal_id: string | null;
        initiating_session_id: string | null;
      }>(`
        SELECT status, kind, global_auth_epoch, expires_at, verified_provider,
               verified_provider_subject_id, lifecycle_ceremony_id, lifecycle_action,
               lifecycle_proof_role, initiating_principal_id, initiating_session_id
        FROM ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
        WHERE transaction_id = $1
        FOR UPDATE
      `, [input.transactionId]);
      const row = transaction.rows.at(0);
      if (!row
        || row.status !== 'consumed'
        || row.global_auth_epoch !== authority.rows.at(0)?.global_auth_epoch
        || row.expires_at.getTime() <= input.now.getTime()
        || row.verified_provider !== null
        || row.verified_provider_subject_id !== null
        || !row.lifecycle_ceremony_id
        || !row.lifecycle_action
        || !row.lifecycle_proof_role
        || !row.initiating_principal_id
        || !row.initiating_session_id
        || lifecycleOAuthKindFor(row.lifecycle_action, row.lifecycle_proof_role) !== row.kind) {
        throw new FleetAuthBrokerError('invalid_oauth_state', 400, 'OAuth lifecycle proof is not usable');
      }
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
        SET verified_provider = 'discord', verified_provider_subject_id = $2
        WHERE transaction_id = $1
      `, [input.transactionId, input.providerSubjectId]);
      await client.query('COMMIT');
      return {
        ceremonyId: row.lifecycle_ceremony_id,
        action: row.lifecycle_action,
        proofRole: row.lifecycle_proof_role,
        initiatingPrincipalId: row.initiating_principal_id,
        initiatingSessionId: row.initiating_session_id,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async createLoginSession(
    input: Parameters<FleetAuthBrokerStore['createLoginSession']>[0],
  ): Promise<FleetAuthSessionRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authorityResult = await client.query<{
        authority_generation: string;
        global_auth_epoch: string;
      }>(`
        SELECT authority_generation, global_auth_epoch
        FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()
      `);
      const authority = authorityResult.rows.at(0);
      if (!authority) throw new Error('fleet_auth authority_state singleton is missing');
      const transaction = await client.query<{
        status: string;
        kind: OAuthTransactionKind;
        global_auth_epoch: string;
        completed_session_id: string | null;
        lifecycle_ceremony_id: string | null;
      }>(`
        SELECT status, kind, global_auth_epoch, completed_session_id,
               lifecycle_ceremony_id
        FROM ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
        WHERE transaction_id = $1
        FOR UPDATE
      `, [input.transactionId]);
      const transactionRow = transaction.rows.at(0);
      if (transactionRow?.status !== 'consumed'
        || transactionRow.kind !== 'login'
        || transactionRow.completed_session_id !== null
        || transactionRow.lifecycle_ceremony_id !== null
        || transactionRow.global_auth_epoch !== authority.global_auth_epoch) {
        throw new FleetAuthBrokerError('invalid_oauth_state', 400, 'OAuth transaction is not usable');
      }

      const principal = await this.resolveOrCreatePendingPrincipal(
        client,
        input.providerSubjectId,
        input.providerMetadata,
        safeInteger(authority.authority_generation, 'authority_generation'),
      );
      const session = await this.insertSession(client, {
        principal,
        audience: input.audience,
        token: input.token,
        csrfToken: input.csrfToken,
        now: input.now,
        idleExpiresAt: new Date(input.now.getTime() + input.idleTtlMs),
        absoluteExpiresAt: new Date(input.now.getTime() + input.absoluteTtlMs),
        globalAuthEpoch: safeInteger(authority.global_auth_epoch, 'global_auth_epoch'),
        providerSubjectId: input.providerSubjectId,
      });
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
        SET completed_session_id = $2,
            verified_provider = 'discord',
            verified_provider_subject_id = $3
        WHERE transaction_id = $1
      `, [input.transactionId, session.recordId, input.providerSubjectId]);
      if (input.refreshToken && input.providerTokenExpiresAt) {
        await client.query(`
          INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_token_custody
            (custody_id, principal_id, provider_subject_id, encrypted_token, key_version,
             global_auth_epoch, expires_at, created_at)
          VALUES ($1, $2, $3, $4, 1, $5, $6, $7)
        `, [
          randomUUID(),
          principal.principal_id,
          input.providerSubjectId,
          this.codec.encrypt(input.refreshToken),
          authority.global_auth_epoch,
          input.providerTokenExpiresAt,
          input.now,
        ]);
      }
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
          (event_id, actor_context, action, resource, decision, reason_code,
           principal_id, authority_generation, global_auth_epoch, occurred_at)
        VALUES ($1, $2::jsonb, 'session.login', 'fleet', 'allow', $3,
                $4, $5, $6, $7)
      `, [
        randomUUID(),
        JSON.stringify({ kind: 'provider', provider: 'discord' }),
        principal.status === 'pending' ? 'pending_principal' : 'existing_principal',
        principal.principal_id,
        authority.authority_generation,
        authority.global_auth_epoch,
        input.now,
      ]);
      await client.query('COMMIT');
      return session;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async rotateSession(
    input: Parameters<FleetAuthBrokerStore['rotateSession']>[0],
  ): Promise<FleetAuthSessionRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT global_auth_epoch FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()`);
      const current = await this.lockValidSession(client, input.token, input.csrfToken, input.now);
      const principal: PrincipalRow = {
        principal_id: current.principal_id,
        status: current.principal_status,
        authn_version: current.authn_version,
        authz_version: current.authz_version,
        binding_version: current.binding_version,
        grant_version: current.grant_version,
        policy_version: current.policy_version,
      };
      const nextRecordId = randomUUID();
      const idleExpiresAt = new Date(Math.min(
        input.now.getTime() + input.idleTtlMs,
        current.absolute_expires_at.getTime(),
      ));
      const next = await this.insertSession(client, {
        principal,
        recordId: nextRecordId,
        audience: 'fleet',
        token: input.nextToken,
        csrfToken: input.nextCsrfToken,
        now: input.now,
        idleExpiresAt,
        absoluteExpiresAt: current.absolute_expires_at,
        globalAuthEpoch: safeInteger(current.global_auth_epoch, 'global_auth_epoch'),
        providerSubjectId: current.provider_subject_id,
      });
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
        SET replaced_by = $2, revoked_at = $3
        WHERE record_id = $1
      `, [current.record_id, nextRecordId, input.now]);
      await this.fenceSessionDependents(client, [current.record_id], input.now);
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async issueCsrf(
    input: Parameters<FleetAuthBrokerStore['issueCsrf']>[0],
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<SessionAuthorityRow>(`
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
               subject.state AS provider_state,
               subject.restore_state AS provider_restore_state,
               authority.global_auth_epoch, authority.authority_generation,
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
        JOIN ${FLEET_AUTH_SCHEMA_NAME}.authority_state AS authority
          ON authority.singleton = TRUE
        WHERE session.token_digest = $1
        FOR UPDATE OF session, principal, subject
      `, [this.digest(input.token)]);
      const session = result.rows.at(0);
      if (!this.sessionAuthorityIsValid(session, input.now)) {
        throw new FleetAuthBrokerError('invalid_session', 401, 'Session is invalid or expired');
      }
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
        SET csrf_digest = $2
        WHERE record_id = $1
      `, [session.record_id, this.digest(input.nextCsrfToken)]);
      await client.query('COMMIT');
      return input.nextCsrfToken;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeSession(
    input: Parameters<FleetAuthBrokerStore['revokeSession']>[0],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await this.lockValidSession(client, input.token, input.csrfToken, input.now);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
        SET revoked_at = $2
        WHERE record_id = $1
      `, [current.record_id, input.now]);
      await this.fenceSessionDependents(client, [current.record_id], input.now);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeIssuedSessionForReauthentication(
    input: Parameters<FleetAuthBrokerStore['revokeIssuedSessionForReauthentication']>[0],
  ): Promise<void> {
    await this.fenceDiscordReauthenticationSessions({
      principalId: input.principalId,
      recordId: input.recordId,
      now: input.now,
    });
  }

  async fencePrincipalSessionsForDiscordReauthentication(input: {
    principalId: string;
    now: Date;
  }): Promise<void> {
    await this.fenceDiscordReauthenticationSessions(input);
  }

  async fenceAllSessionsForDiscordReauthentication(input: { now: Date }): Promise<void> {
    await this.fenceDiscordReauthenticationSessions(input);
  }

  async revokeProvider(
    input: Parameters<FleetAuthBrokerStore['revokeProvider']>[0],
  ): Promise<void> {
    await revokeProviderAuthority(
      this.providerAuthorityPool,
      this.providerRevocationAuthority,
      (client, token, csrfToken, now) => this.lockValidSession(
        client,
        token,
        csrfToken,
        now,
      ),
      input,
    );
  }

  async completeFirstOwnerBootstrap(
    input: Parameters<FleetAuthBrokerStore['completeFirstOwnerBootstrap']>[0],
  ): Promise<FleetAuthSessionRecord> {
    return await completeFirstOwnerAuthority(
      this.pool,
      (client, token, csrfToken, now) => this.lockValidSession(
        client,
        token,
        csrfToken,
        now,
      ),
      (client, sessionInput) => this.insertSession(client, sessionInput),
      input,
    );
  }

  private digest(value: string): string {
    return this.codec.digest(value);
  }

  private async resolveOrCreatePendingPrincipal(
    client: PoolClient,
    providerSubjectId: string,
    providerMetadata: { mfaEnabled?: boolean },
    authorityGeneration: number,
  ): Promise<PrincipalRow> {
    const provider = await client.query<{
      principal_id: string;
      provider_state: string;
      principal_status: PrincipalRow['status'];
      authn_version: string;
      authz_version: string;
      binding_version: string;
      grant_version: string;
      policy_version: string;
      provider_restore_state: string;
      principal_restore_state: string;
    }>(`
      SELECT subject.principal_id, subject.state AS provider_state,
             principal.status AS principal_status, principal.authn_version,
             principal.authz_version, principal.binding_version,
             principal.grant_version, principal.policy_version,
             subject.restore_state AS provider_restore_state,
             principal.restore_state AS principal_restore_state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS subject
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.human_principals AS principal
        ON principal.principal_id = subject.principal_id
      WHERE subject.provider = 'discord' AND subject.subject_id = $1
      FOR UPDATE OF subject, principal
    `, [providerSubjectId]);
    const existing = provider.rows.at(0);
    if (existing) {
      if ((existing.provider_state !== 'pending' && existing.provider_state !== 'active')
        || (existing.principal_status !== 'pending' && existing.principal_status !== 'active')
        || existing.provider_state !== existing.principal_status
        || existing.provider_restore_state !== 'live'
        || existing.principal_restore_state !== 'live') {
        throw new FleetAuthBrokerError(
          'provider_subject_suspended',
          403,
          'Provider subject is not eligible for login',
        );
      }
      return {
        principal_id: existing.principal_id,
        status: existing.principal_status,
        authn_version: existing.authn_version,
        authz_version: existing.authz_version,
        binding_version: existing.binding_version,
        grant_version: existing.grant_version,
        policy_version: existing.policy_version,
      };
    }
    // The internal permanent registry is deliberately unreadable by the
    // runtime role. Immutable history/tombstones are its bounded evidence:
    // any subject without a current row but with prior evidence must not be
    // recreated through routine OAuth. The SECURITY DEFINER registry trigger
    // remains the final race-safe enforcement at INSERT.
    const priorIdentity = await client.query<{ present: boolean }>(`
      SELECT (
        EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones
          WHERE provider = 'discord' AND subject_id = $1
        ) OR EXISTS (
          SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_history
          WHERE provider = 'discord' AND subject_id = $1
        )
      ) AS present
    `, [providerSubjectId]);
    if (priorIdentity.rows.at(0)?.present === true) {
      throw new FleetAuthBrokerError(
        'provider_subject_tombstoned',
        403,
        'Provider subject is permanently unavailable',
      );
    }
    const principalId = randomUUID();
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
        (principal_id, status, authority_generation)
      VALUES ($1, 'pending', $2)
    `, [principalId, authorityGeneration]);
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
        (provider, subject_id, principal_id, state, metadata, authority_generation)
      VALUES ('discord', $1, $2, 'pending', $3::jsonb, $4)
    `, [
      providerSubjectId,
      principalId,
      JSON.stringify(providerMetadata),
      authorityGeneration,
    ]);
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_history
        (event_id, provider, subject_id, principal_id, state, event_type,
         authority_generation, payload)
      VALUES ($1, 'discord', $2, $3, 'pending', 'created', $4,
              '{"source":"oauth"}'::jsonb)
    `, [randomUUID(), providerSubjectId, principalId, authorityGeneration]);
    return {
      principal_id: principalId,
      status: 'pending',
      authn_version: '1',
      authz_version: '1',
      binding_version: '1',
      grant_version: '1',
      policy_version: '1',
    };
  }

  private async lockValidSession(
    client: PoolClient,
    token: string,
    csrfToken: string,
    now: Date,
  ): Promise<SessionAuthorityRow> {
    const result = await client.query<SessionAuthorityRow>(`
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
             subject.state AS provider_state,
             subject.restore_state AS provider_restore_state,
             authority.global_auth_epoch, authority.authority_generation,
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
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.authority_state AS authority
        ON authority.singleton = TRUE
      WHERE session.token_digest = $1 AND session.csrf_digest = $2
      FOR UPDATE OF session, principal, subject
    `, [this.digest(token), this.digest(csrfToken)]);
    const session = result.rows.at(0);
    if (!this.sessionAuthorityIsValid(session, now)) {
      throw new FleetAuthBrokerError('invalid_session', 401, 'Session is invalid or expired');
    }
    return session;
  }

  private sessionAuthorityIsValid(
    session: SessionAuthorityRow | undefined,
    now: Date,
  ): session is SessionAuthorityRow {
    return Boolean(session
      && session.revoked_at === null
      && session.replaced_by === null
      && session.idle_expires_at.getTime() > now.getTime()
      && session.absolute_expires_at.getTime() > now.getTime()
      && session.restore_state === 'live'
      && (session.principal_status === 'pending' || session.principal_status === 'active')
      && session.authn_version === session.session_authn_version
      && session.authz_version === session.session_authz_version
      && session.binding_version === session.session_binding_version
      && session.grant_version === session.session_grant_version
      && session.policy_version === session.session_policy_version
      && session.provider === 'discord'
      && session.provider_subject_id !== null
      && (session.provider_state === 'pending' || session.provider_state === 'active')
      && session.provider_restore_state === 'live'
      && this.providerRevocationAuthority.sessionAuthorityGenerationIsCurrent(
        safeInteger(session.authority_generation, 'authority_generation'),
      )
      && session.global_auth_epoch === session.session_global_auth_epoch);
  }

  private async insertSession(
    client: PoolClient,
    input: {
      principal: PrincipalRow;
      recordId?: string;
      audience: string;
      token: string;
      csrfToken: string;
      now: Date;
      idleExpiresAt: Date;
      absoluteExpiresAt: Date;
      globalAuthEpoch: number;
      providerSubjectId: string;
    },
  ): Promise<FleetAuthSessionRecord> {
    const recordId = input.recordId ?? randomUUID();
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
        (record_id, token_digest, csrf_digest, principal_id, audience, assurance,
         authn_version, authz_version, binding_version, grant_version,
         policy_version, provider, provider_subject_id, global_auth_epoch,
         idle_expires_at, absolute_expires_at, created_at)
      VALUES ($1, $2, $3, $4, $5, 'oauth', $6, $7, $8, $9, $10,
              'discord', $11, $12, $13, $14, $15)
    `, [
      recordId,
      this.digest(input.token),
      this.digest(input.csrfToken),
      input.principal.principal_id,
      input.audience,
      input.principal.authn_version,
      input.principal.authz_version,
      input.principal.binding_version,
      input.principal.grant_version,
      input.principal.policy_version,
      input.providerSubjectId,
      input.globalAuthEpoch,
      input.idleExpiresAt,
      input.absoluteExpiresAt,
      input.now,
    ]);
    const superseded = await client.query<{ record_id: string }>(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
      SET replaced_by = $3, revoked_at = $4
      WHERE principal_id = $1
        AND audience = $2
        AND record_id <> $3
        AND revoked_at IS NULL
        AND replaced_by IS NULL
      RETURNING record_id
    `, [
      input.principal.principal_id,
      input.audience,
      recordId,
      input.now,
    ]);
    const supersededIds = superseded.rows.map(row => row.record_id);
    await this.fenceSessionDependents(client, supersededIds, input.now);
    return {
      recordId,
      principalId: input.principal.principal_id,
      principalStatus: input.principal.status === 'active' ? 'active' : 'pending',
      token: input.token,
      csrfToken: input.csrfToken,
      idleExpiresAt: input.idleExpiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
    };
  }

  private async fenceSessionDependents(
    client: PoolClient,
    sessionIds: readonly string[],
    now: Date,
  ): Promise<void> {
    if (sessionIds.length === 0) return;
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
      SET status = CASE WHEN status = 'pending' THEN 'revoked' ELSE status END
      WHERE browser_session_id = ANY($1::uuid[])
    `, [sessionIds]);
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.jit_authorization_grants
      SET revoked_at = COALESCE(revoked_at, $2)
      WHERE browser_session_id = ANY($1::uuid[])
    `, [sessionIds, now]);
  }

  private async fenceDiscordReauthenticationSessions(input: {
    principalId?: string;
    recordId?: string;
    now: Date;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await client.query<{
        authority_generation: string;
        global_auth_epoch: string;
      }>(`
        SELECT authority_generation, global_auth_epoch
        FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()
      `);
      const state = authority.rows.at(0);
      if (!state) throw new Error('fleet_auth authority_state singleton is missing');
      const sessions = await client.query<{ record_id: string; principal_id: string }>(`
        SELECT record_id, principal_id
        FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
        WHERE ($1::uuid IS NULL OR principal_id = $1)
          AND ($2::uuid IS NULL OR record_id = $2)
        FOR UPDATE
      `, [input.principalId ?? null, input.recordId ?? null]);
      if (input.recordId && (sessions.rows.length !== 1
        || sessions.rows[0]?.principal_id !== input.principalId)) {
        throw new Error('Issued fleet session reauthentication binding is missing');
      }
      const recordIds = sessions.rows.map(session => session.record_id);
      if (recordIds.length > 0) {
        await client.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
          SET revoked_at = COALESCE(revoked_at, $2)
          WHERE record_id = ANY($1::uuid[])
        `, [recordIds, input.now]);
        await client.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
          SET status = CASE WHEN status = 'pending' THEN 'revoked' ELSE status END
          WHERE browser_session_id = ANY($1::uuid[])
        `, [recordIds]);
        await client.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.jit_authorization_grants
          SET revoked_at = COALESCE(revoked_at, $2)
          WHERE browser_session_id = ANY($1::uuid[])
        `, [recordIds, input.now]);
      }
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
          (event_id, actor_context, action, resource, decision, reason_code,
           principal_id, authority_generation, global_auth_epoch, occurred_at)
        VALUES ($1, '{"kind":"system","boundary":"discord_evidence_lifecycle"}'::jsonb,
                'session.reauthentication', 'fleet', 'deny',
                'discord_evidence_reauthentication_required', $2, $3, $4, $5)
      `, [
        randomUUID(),
        input.principalId ?? null,
        state.authority_generation,
        state.global_auth_epoch,
        input.now,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
