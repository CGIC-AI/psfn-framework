import type { Pool } from 'pg';
import {
  FleetAuthBrokerError,
  type ConsumedOAuthTransaction,
  type FleetAuthBrokerStore,
  type OAuthTransactionInput,
} from '../../../boundary/gateway/fleet-auth-broker.js';
import {
  lifecycleOAuthKindFor,
  type LifecycleOAuthAction,
  type LifecycleOAuthProofRole,
  type LifecycleOAuthPurpose,
} from '../../../shared/contracts/fleet-auth-lifecycle-oauth.js';
import type { FleetAuthSecretCodec } from './oauth-secret-codec.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';

interface OAuthTransactionRow {
  transaction_id: string;
  kind: ConsumedOAuthTransaction['kind'];
  pkce_verifier_ciphertext: Buffer | null;
  callback_uri: string;
  return_path: string;
  status: 'pending' | 'consumed' | 'expired' | 'revoked';
  expires_at: Date;
  global_auth_epoch: string;
  lifecycle_ceremony_id: string | null;
  lifecycle_action: LifecycleOAuthAction | null;
  lifecycle_proof_role: LifecycleOAuthProofRole | null;
  initiating_principal_id: string | null;
  initiating_session_id: string | null;
}

function lifecyclePurpose(row: OAuthTransactionRow): LifecycleOAuthPurpose | undefined {
  const values = [
    row.lifecycle_ceremony_id,
    row.lifecycle_action,
    row.lifecycle_proof_role,
    row.initiating_principal_id,
    row.initiating_session_id,
  ];
  if (values.every(value => value === null)) return undefined;
  if (values.some(value => value === null)) {
    throw new FleetAuthBrokerError('invalid_oauth_state', 400, 'OAuth purpose is incomplete');
  }
  const action = row.lifecycle_action!;
  const proofRole = row.lifecycle_proof_role!;
  if (lifecycleOAuthKindFor(action, proofRole) !== row.kind) {
    throw new FleetAuthBrokerError('invalid_oauth_state', 400, 'OAuth purpose is inconsistent');
  }
  return {
    ceremonyId: row.lifecycle_ceremony_id!,
    action,
    proofRole,
    initiatingPrincipalId: row.initiating_principal_id!,
    initiatingSessionId: row.initiating_session_id!,
  };
}

export async function createOAuthTransaction(
  pool: Pool,
  codec: FleetAuthSecretCodec,
  input: OAuthTransactionInput,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const authority = await client.query<{ global_auth_epoch: string }>(`
      SELECT global_auth_epoch
      FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()
    `);
    const globalAuthEpoch = authority.rows.at(0)?.global_auth_epoch;
    if (!globalAuthEpoch) throw new Error('fleet_auth authority_state singleton is missing');
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
        (transaction_id, state_digest, initiating_browser_digest, pkce_verifier_digest,
         pkce_verifier_ciphertext, callback_uri, return_path, kind, status,
         global_auth_epoch, created_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11)
    `, [
      input.transactionId,
      input.stateDigest,
      input.initiatingBrowserDigest,
      codec.digest(input.pkceVerifier),
      codec.encrypt(input.pkceVerifier),
      input.callbackUri,
      input.returnPath,
      input.kind,
      globalAuthEpoch,
      input.createdAt,
      input.expiresAt,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function consumeOAuthTransaction(
  pool: Pool,
  codec: FleetAuthSecretCodec,
  input: Parameters<FleetAuthBrokerStore['consumeOAuthTransaction']>[0],
): Promise<ConsumedOAuthTransaction> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<OAuthTransactionRow>(`
      SELECT transaction.transaction_id, transaction.kind,
             transaction.pkce_verifier_ciphertext, transaction.callback_uri,
             transaction.return_path, transaction.status,
             transaction.expires_at, transaction.global_auth_epoch,
             transaction.lifecycle_ceremony_id, transaction.lifecycle_action,
             transaction.lifecycle_proof_role, transaction.initiating_principal_id,
             transaction.initiating_session_id
      FROM ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions AS transaction
      WHERE transaction.state_digest = $1
        AND transaction.initiating_browser_digest = $2
      FOR UPDATE
    `, [input.stateDigest, input.initiatingBrowserDigest]);
    const transaction = result.rows.at(0);
    if (!transaction || transaction.status !== 'pending') {
      throw new FleetAuthBrokerError('invalid_oauth_state', 400, 'OAuth state is invalid or already used');
    }
    if (transaction.expires_at.getTime() <= input.now.getTime()) {
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
        SET status = 'expired', consumed_at = $2
        WHERE transaction_id = $1
      `, [transaction.transaction_id, input.now]);
      await client.query('COMMIT');
      throw new FleetAuthBrokerError(
        'expired_oauth_transaction',
        400,
        'OAuth transaction has expired',
      );
    }
    const authority = await client.query<{ global_auth_epoch: string }>(`
      SELECT global_auth_epoch
      FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()
    `);
    if (authority.rows.at(0)?.global_auth_epoch !== transaction.global_auth_epoch) {
      throw new FleetAuthBrokerError('invalid_oauth_state', 400, 'OAuth authority epoch is stale');
    }
    if (!transaction.pkce_verifier_ciphertext) {
      throw new FleetAuthBrokerError('invalid_oauth_state', 400, 'OAuth transaction is not usable');
    }
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
      SET status = 'consumed', consumed_at = $2
      WHERE transaction_id = $1
    `, [transaction.transaction_id, input.now]);
    await client.query('COMMIT');
    const purpose = lifecyclePurpose(transaction);
    return {
      transactionId: transaction.transaction_id,
      kind: transaction.kind,
      pkceVerifier: codec.decrypt(transaction.pkce_verifier_ciphertext),
      callbackUri: transaction.callback_uri,
      returnPath: transaction.return_path,
      ...(purpose ? { lifecyclePurpose: purpose } : {}),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
