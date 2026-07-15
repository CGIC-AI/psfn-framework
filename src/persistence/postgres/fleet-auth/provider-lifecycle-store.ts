import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  FleetAuthBrokerError,
  type FleetAuthBrokerStore,
  type FleetAuthSessionRecord,
} from '../../../boundary/gateway/fleet-auth-broker.js';
import { isRecord } from '../../../shared/utils/types.js';
import { FLEET_AUTH_FIRST_OWNER_FUNCTION_NAME } from './first-owner-sql.js';
import type { InsertSession, LockValidSession } from './oauth-session-store-types.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

function safeInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid fleet_auth ${field}`);
  }
  return parsed;
}

export async function revokeProviderAuthority(
  pool: Pool,
  lockValidSession: LockValidSession,
  input: Parameters<FleetAuthBrokerStore['revokeProvider']>[0],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await lockValidSession(client, input.token, input.csrfToken, input.now);
    const provider = await client.query<{ subject_id: string; state: string }>(`
      SELECT subject_id, state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
      WHERE provider = 'discord' AND principal_id = $1
      FOR UPDATE
    `, [current.principal_id]);
    const subject = provider.rows.at(0);
    if (!subject || (subject.state !== 'pending' && subject.state !== 'active')) {
      throw new FleetAuthBrokerError('provider_not_active', 409, 'Provider is not active');
    }
    const globalAuthEpoch = safeInteger(current.global_auth_epoch, 'global_auth_epoch');
    const authority = await client.query<{
      authority_generation: string;
      global_auth_epoch: string;
    }>(`
      SELECT authority_generation, global_auth_epoch
      FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
      WHERE singleton = TRUE
      FOR SHARE
    `);
    const authorityRow = authority.rows.at(0);
    if (!authorityRow) throw new Error('fleet_auth authority_state singleton is missing');
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones
        (provider, subject_id, prior_principal_id, authority_generation,
         revoked_at, reason_digest)
      VALUES ('discord', $1, $2, $3, $4, $5)
    `, [
      subject.subject_id,
      current.principal_id,
      authorityRow.authority_generation,
      input.now,
      input.reasonDigest,
    ]);
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_history
        (event_id, provider, subject_id, principal_id, state, event_type,
         authority_generation, payload, recorded_at)
      VALUES ($1, 'discord', $2, $3, 'revoked', 'unlinked', $4,
              '{"reason":"provider_revoked"}'::jsonb, $5)
    `, [
      randomUUID(),
      subject.subject_id,
      current.principal_id,
      authorityRow.authority_generation,
      input.now,
    ]);
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals
      SET status = 'suspended', authn_version = authn_version + 1,
          authz_version = authz_version + 1, updated_at = $2
      WHERE principal_id = $1
    `, [current.principal_id, input.now]);
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
      SET state = CASE WHEN state = 'revoked' THEN state ELSE 'suspended' END,
          version = version + 1, updated_at = $2
      WHERE principal_id = $1
    `, [current.principal_id, input.now]);
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
      SET lifecycle = CASE WHEN lifecycle = 'revoked' THEN lifecycle ELSE 'suspended' END,
          version = version + 1, updated_at = $2
      WHERE principal_id = $1
    `, [current.principal_id, input.now]);
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
      SET revoked_at = COALESCE(revoked_at, $2)
      WHERE principal_id = $1
    `, [current.principal_id, input.now]);
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.jit_authorization_grants
      SET revoked_at = COALESCE(revoked_at, $2)
      WHERE principal_id = $1
    `, [current.principal_id, input.now]);
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
      SET status = CASE WHEN status = 'pending' THEN 'revoked' ELSE status END
      WHERE principal_id = $1
    `, [current.principal_id]);
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.provider_token_custody
      SET revoked_at = COALESCE(revoked_at, $2)
      WHERE principal_id = $1
    `, [current.principal_id, input.now]);
    await client.query(`
      DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots
      WHERE principal_id = $1
    `, [current.principal_id]);
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        (event_id, actor_context, action, resource, decision, reason_code,
         principal_id, authority_generation, global_auth_epoch, occurred_at)
      VALUES ($1, '{"kind":"principal"}'::jsonb, 'provider.revoke',
              'provider:discord', 'allow', 'provider_tombstoned', $2, $3, $4, $5)
    `, [
      randomUUID(),
      current.principal_id,
      authorityRow.authority_generation,
      globalAuthEpoch,
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

export async function completeFirstOwnerAuthority(
  pool: Pool,
  lockValidSession: LockValidSession,
  insertSession: InsertSession,
  input: Parameters<FleetAuthBrokerStore['completeFirstOwnerBootstrap']>[0],
): Promise<FleetAuthSessionRecord> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await lockValidSession(client, input.token, input.csrfToken, input.now);
    if (current.principal_id !== input.principalId
      || current.principal_status !== 'pending') {
      throw new FleetAuthBrokerError(
        'first_owner_binding_mismatch',
        403,
        'First-owner assurance does not match the pending login',
      );
    }
    const provider = await client.query<{ subject_id: string }>(`
      SELECT subject_id
      FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
      WHERE provider = 'discord' AND principal_id = $1
      FOR UPDATE
    `, [current.principal_id]);
    if (provider.rows.length !== 1
      || provider.rows[0]?.subject_id !== input.providerSubjectId) {
      throw new FleetAuthBrokerError(
        'first_owner_binding_mismatch',
        403,
        'First-owner assurance does not match the pending provider',
      );
    }
    const result = await client.query<{ result: unknown }>(`
      SELECT ${FLEET_AUTH_FIRST_OWNER_FUNCTION_NAME}(
        $1::uuid, $2::uuid, $3::text, $4::uuid, $5::text,
        $6::uuid, $7::uuid, $8::uuid, $9::timestamptz
      ) AS result
    `, [
      input.ceremonyId,
      input.principalId,
      input.providerSubjectId,
      input.companionId,
      input.contactId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      input.now,
    ]);
    const completion = result.rows.at(0)?.result;
    if (!isRecord(completion)
      || typeof completion.authnVersion !== 'number'
      || typeof completion.authzVersion !== 'number'
      || typeof completion.globalAuthEpoch !== 'number') {
      throw new Error('Fleet auth first-owner procedure returned an invalid result');
    }
    const session = await insertSession(client, {
      principal: {
        principal_id: input.principalId,
        status: 'active',
        authn_version: String(completion.authnVersion),
        authz_version: String(completion.authzVersion),
      },
      audience: 'fleet',
      token: input.nextToken,
      csrfToken: input.nextCsrfToken,
      now: input.now,
      idleExpiresAt: new Date(input.now.getTime() + input.idleTtlMs),
      absoluteExpiresAt: new Date(input.now.getTime() + input.absoluteTtlMs),
      globalAuthEpoch: completion.globalAuthEpoch,
    });
    await client.query('COMMIT');
    return session;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (!(error instanceof FleetAuthBrokerError)
      && isRecord(error) && error.code === '42501') {
      throw new FleetAuthBrokerError(
        'first_owner_denied',
        403,
        'First-owner bootstrap was denied',
      );
    }
    throw error;
  } finally {
    client.release();
  }
}
