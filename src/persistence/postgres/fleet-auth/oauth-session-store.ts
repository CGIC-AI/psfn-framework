import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  FleetAuthBrokerError,
  type FleetAuthBrokerStore,
  type FleetAuthSessionRecord,
} from '../../../boundary/gateway/fleet-auth-broker.js';
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
} from './oauth-transaction-store.js';
import type { ProviderRevocationAuthorityPort } from './provider-lifecycle-contracts.js';


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
        global_auth_epoch: string;
        completed_session_id: string | null;
      }>(`
        SELECT status, global_auth_epoch, completed_session_id
        FROM ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
        WHERE transaction_id = $1
        FOR UPDATE
      `, [input.transactionId]);
      const transactionRow = transaction.rows.at(0);
      if (transactionRow?.status !== 'consumed'
        || transactionRow.completed_session_id !== null
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
      });
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
        SET completed_session_id = $2
        WHERE transaction_id = $1
      `, [input.transactionId, session.recordId]);
      if (input.refreshToken && input.providerTokenExpiresAt) {
        await client.query(`
          INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_token_custody
            (custody_id, principal_id, encrypted_token, key_version,
             global_auth_epoch, expires_at, created_at)
          VALUES ($1, $2, $3, 1, $4, $5, $6)
        `, [
          randomUUID(),
          principal.principal_id,
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
      const current = await this.lockValidSession(client, input.token, input.csrfToken, input.now);
      const principal: PrincipalRow = {
        principal_id: current.principal_id,
        status: current.principal_status,
        authn_version: current.authn_version,
        authz_version: current.authz_version,
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
      });
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
        SET replaced_by = $2, revoked_at = $3
        WHERE record_id = $1
      `, [current.record_id, nextRecordId, input.now]);
      await this.fenceSessionDependents(client, current.record_id, input.now);
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
               session.authn_version AS session_authn_version,
               session.authz_version AS session_authz_version,
               authority.global_auth_epoch, authority.authority_generation,
               session.global_auth_epoch AS session_global_auth_epoch,
               session.idle_expires_at, session.absolute_expires_at,
               session.revoked_at, session.replaced_by, principal.restore_state
        FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions AS session
        JOIN ${FLEET_AUTH_SCHEMA_NAME}.human_principals AS principal
          ON principal.principal_id = session.principal_id
        JOIN ${FLEET_AUTH_SCHEMA_NAME}.authority_state AS authority
          ON authority.singleton = TRUE
        WHERE session.token_digest = $1
        FOR UPDATE OF session, principal
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
      await this.fenceSessionDependents(client, current.record_id, input.now);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
      provider_restore_state: string;
      principal_restore_state: string;
    }>(`
      SELECT subject.principal_id, subject.state AS provider_state,
             principal.status AS principal_status, principal.authn_version,
             principal.authz_version, subject.restore_state AS provider_restore_state,
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
             session.authn_version AS session_authn_version,
             session.authz_version AS session_authz_version,
             authority.global_auth_epoch, authority.authority_generation,
             session.global_auth_epoch AS session_global_auth_epoch,
             session.idle_expires_at, session.absolute_expires_at,
             session.revoked_at, session.replaced_by, principal.restore_state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions AS session
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.human_principals AS principal
        ON principal.principal_id = session.principal_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.authority_state AS authority
        ON authority.singleton = TRUE
      WHERE session.token_digest = $1 AND session.csrf_digest = $2
      FOR UPDATE OF session, principal
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
    },
  ): Promise<FleetAuthSessionRecord> {
    const recordId = input.recordId ?? randomUUID();
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
        (record_id, token_digest, csrf_digest, principal_id, audience, assurance,
         authn_version, authz_version, global_auth_epoch, idle_expires_at,
         absolute_expires_at, created_at)
      VALUES ($1, $2, $3, $4, $5, 'oauth', $6, $7, $8, $9, $10, $11)
    `, [
      recordId,
      this.digest(input.token),
      this.digest(input.csrfToken),
      input.principal.principal_id,
      input.audience,
      input.principal.authn_version,
      input.principal.authz_version,
      input.globalAuthEpoch,
      input.idleExpiresAt,
      input.absoluteExpiresAt,
      input.now,
    ]);
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
    sessionId: string,
    now: Date,
  ): Promise<void> {
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
      SET status = CASE WHEN status = 'pending' THEN 'revoked' ELSE status END
      WHERE browser_session_id = $1
    `, [sessionId]);
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.jit_authorization_grants
      SET revoked_at = COALESCE(revoked_at, $2)
      WHERE browser_session_id = $1
    `, [sessionId, now]);
  }
}
