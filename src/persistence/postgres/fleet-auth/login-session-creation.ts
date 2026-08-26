import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  FleetAuthBrokerStore,
  FleetAuthSessionRecord,
  OAuthTransactionKind,
} from '../../../boundary/gateway/fleet-auth-broker.js';
import type { FleetAuthAccountRosterEntry } from '../../../system/config/fleet-auth-config.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import { requireFleetAuthInteger } from '../row-guards.js';
import type { PrincipalRow } from './oauth-session-store-types.js';
import type { FleetAuthSecretCodec } from './oauth-secret-codec.js';
import { activateRosteredFirstOwner } from './rostered-first-owner-activation.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';
import { fleetAuthPersistenceBoundaryValues } from './boundary-values-port.js';

export interface SessionInsertInput {
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
}

interface LoginSessionCreationDependencies {
  pool: Pool;
  codec: FleetAuthSecretCodec;
  accountRoster: readonly FleetAuthAccountRosterEntry[];
  resolvePrincipal: (
    client: PoolClient,
    providerSubjectId: string,
    providerMetadata: { mfaEnabled?: boolean },
    authorityGeneration: number,
  ) => Promise<PrincipalRow>;
  insertSession: (
    client: PoolClient,
    input: SessionInsertInput,
  ) => Promise<FleetAuthSessionRecord>;
}

export async function createLoginSession(
  dependencies: LoginSessionCreationDependencies,
  input: Parameters<FleetAuthBrokerStore['createLoginSession']>[0],
): Promise<FleetAuthSessionRecord> {
  const client = await dependencies.pool.connect();
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
      throw new fleetAuthPersistenceBoundaryValues.FleetAuthBrokerError(
        'invalid_oauth_state',
        400,
        'OAuth transaction is not usable',
      );
    }

    const authorityGeneration = requireFleetAuthInteger(
      authority.authority_generation,
      'authority_generation',
    );
    const globalAuthEpoch = requireFleetAuthInteger(
      authority.global_auth_epoch,
      'global_auth_epoch',
    );
    const pendingPrincipal = await dependencies.resolvePrincipal(
      client,
      input.providerSubjectId,
      input.providerMetadata,
      authorityGeneration,
    );
    const activation = await activateRosteredFirstOwner(client, {
      accountRoster: dependencies.accountRoster,
      principal: pendingPrincipal,
      providerSubjectId: input.providerSubjectId,
      authorityGeneration,
      globalAuthEpoch,
      now: input.now,
    });
    const principal = activation.principal;
    const session = await dependencies.insertSession(client, {
      principal,
      audience: input.audience,
      token: input.token,
      csrfToken: input.csrfToken,
      now: input.now,
      idleExpiresAt: new Date(input.now.getTime() + input.idleTtlMs),
      absoluteExpiresAt: new Date(input.now.getTime() + input.absoluteTtlMs),
      globalAuthEpoch,
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
        dependencies.codec.encrypt(input.refreshToken),
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
      activation.activated
        ? 'rostered_first_owner'
        : principal.status === 'pending' ? 'pending_principal' : 'existing_principal',
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

export async function createLocalOperatorSession(
  dependencies: LoginSessionCreationDependencies,
  input: Parameters<FleetAuthBrokerStore['createLocalOperatorSession']>[0],
): Promise<FleetAuthSessionRecord> {
  const client = await dependencies.pool.connect();
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
    const authorityGeneration = requireFleetAuthInteger(
      authority.authority_generation,
      'authority_generation',
    );
    const globalAuthEpoch = requireFleetAuthInteger(
      authority.global_auth_epoch,
      'global_auth_epoch',
    );
    const pendingPrincipal = await dependencies.resolvePrincipal(
      client,
      input.providerSubjectId,
      {},
      authorityGeneration,
    );
    const activation = await activateRosteredFirstOwner(client, {
      accountRoster: dependencies.accountRoster,
      principal: pendingPrincipal,
      providerSubjectId: input.providerSubjectId,
      authorityGeneration,
      globalAuthEpoch,
      now: input.now,
    });
    const session = await dependencies.insertSession(client, {
      principal: activation.principal,
      audience: input.audience,
      token: input.token,
      csrfToken: input.csrfToken,
      now: input.now,
      idleExpiresAt: new Date(input.now.getTime() + input.idleTtlMs),
      absoluteExpiresAt: new Date(input.now.getTime() + input.absoluteTtlMs),
      globalAuthEpoch,
      providerSubjectId: input.providerSubjectId,
    });
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        (event_id, actor_context, action, resource, decision, reason_code,
         principal_id, authority_generation, global_auth_epoch, occurred_at)
      VALUES ($1, $2::jsonb, 'session.local_operator_login', 'fleet', 'allow',
              'local_operator_token_authenticated', $3, $4, $5, $6)
    `, [
      randomUUID(),
      JSON.stringify({ kind: 'local_operator_token' }),
      activation.principal.principal_id,
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
