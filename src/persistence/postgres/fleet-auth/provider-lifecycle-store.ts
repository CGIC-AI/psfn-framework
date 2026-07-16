import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  FleetAuthBrokerError,
  type FleetAuthBrokerStore,
  type FleetAuthSessionRecord,
} from '../../../boundary/gateway/fleet-auth-broker.js';
import { isRecord } from '../../../shared/utils/types.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import { FLEET_AUTH_FIRST_OWNER_FUNCTION_NAME } from './first-owner-sql.js';
import type { InsertSession, LockValidSession } from './oauth-session-store-types.js';
import type { ProviderRevocationAuthorityPort } from './provider-revocation-authority.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

export async function revokeExactProviderSubject(
  client: PoolClient,
  input: {
    principalId: string;
    subjectId: string;
    authorityGeneration: number;
    reasonDigest: string;
    at: Date;
    eventType: 'unlinked' | 'replaced';
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones
      (provider, subject_id, prior_principal_id, authority_generation,
       revoked_at, reason_digest)
    VALUES ('discord', $1, $2, $3, $4, $5)
  `, [
    input.subjectId,
    input.principalId,
    input.authorityGeneration,
    input.at,
    input.reasonDigest,
  ]);
  await client.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_history
      (event_id, provider, subject_id, principal_id, state, event_type,
       authority_generation, payload, recorded_at)
    VALUES ($1, 'discord', $2, $3, 'revoked', $4, $5, $6::jsonb, $7)
  `, [
    randomUUID(),
    input.subjectId,
    input.principalId,
    input.eventType,
    input.authorityGeneration,
    JSON.stringify(input.payload),
    input.at,
  ]);
}

export async function revokeProviderAuthority(
  pool: Pool,
  providerRevocationAuthority: ProviderRevocationAuthorityPort,
  lockValidSession: LockValidSession,
  input: Parameters<FleetAuthBrokerStore['revokeProvider']>[0],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      SELECT global_auth_epoch
      FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
      WHERE singleton = TRUE
      FOR UPDATE
    `);
    const current = await lockValidSession(client, input.token, input.csrfToken, input.now);
    if (current.provider !== 'discord' || current.provider_subject_id === null) {
      throw new FleetAuthBrokerError('provider_not_active', 409, 'Provider is not active');
    }
    const provider = await client.query<{ subject_id: string; state: string }>(`
      SELECT subject_id, state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
      WHERE provider = 'discord' AND principal_id = $1 AND subject_id = $2
      FOR UPDATE
    `, [current.principal_id, current.provider_subject_id]);
    if (provider.rowCount !== 1) {
      throw new FleetAuthBrokerError('provider_not_active', 409, 'Provider is not active');
    }
    const subject = provider.rows[0];
    if (subject.state !== 'pending' && subject.state !== 'active') {
      throw new FleetAuthBrokerError('provider_not_active', 409, 'Provider is not active');
    }
    // Publish the non-restored provider tombstone before any database mutation.
    // If reconciliation or later SQL fails, the durable floor remains advanced
    // and the next startup quarantines the stale database (safe over-fencing).
    const authorityFence = await providerRevocationAuthority.fence({
      provider: 'discord',
      subjectId: subject.subject_id,
      reasonDigest: input.reasonDigest,
      at: input.now,
    });
    await revokeExactProviderSubject(client, {
      principalId: current.principal_id,
      subjectId: subject.subject_id,
      authorityGeneration: authorityFence.authorityGeneration,
      reasonDigest: input.reasonDigest,
      at: input.now,
      eventType: 'unlinked',
      payload: { reason: 'provider_revoked' },
    });
    const remaining = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
      WHERE provider = 'discord' AND principal_id = $1 AND subject_id <> $2
        AND state IN ('pending', 'active') AND restore_state = 'live'
    `, [current.principal_id, subject.subject_id]);
    const suspendAccount = remaining.rows[0]?.count === '0';
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals
      SET status = CASE WHEN $2::boolean THEN 'suspended' ELSE status END,
          authn_version = authn_version + 1,
          authz_version = authz_version + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
          binding_version = binding_version + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
          grant_version = grant_version + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
          policy_version = policy_version + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
          authority_generation = $3, updated_at = $4
      WHERE principal_id = $1
    `, [
      current.principal_id,
      suspendAccount,
      authorityFence.authorityGeneration,
      input.now,
    ]);
    if (suspendAccount) {
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
    }
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
      DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences
      WHERE principal_id = $1
    `, [current.principal_id]);
    const reconciledAuthority = await authorityFence.reconcile(client);
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        (event_id, actor_context, action, resource, decision, reason_code,
         principal_id, authority_generation, global_auth_epoch, occurred_at)
      VALUES ($1, '{"kind":"principal"}'::jsonb, 'provider.revoke',
              'provider:discord', 'allow', 'provider_tombstoned', $2, $3, $4, $5)
    `, [
      randomUUID(),
      current.principal_id,
      authorityFence.authorityGeneration,
      reconciledAuthority.globalAuthEpoch,
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
    await client.query(`
      SELECT global_auth_epoch
      FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()
    `);
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
        $6::bigint, $7::bigint, $8::uuid, $9::text,
        $10::uuid, $11::uuid, $12::uuid, $13::timestamptz,
        $14::text, $15::text, $16::text, $17::text, $18::text
      ) AS result
    `, [
      input.ceremonyId,
      input.principalId,
      input.providerSubjectId,
      input.companionId,
      input.contactId,
      input.contactAuthority.contactAuthorityVersion,
      input.contactAuthority.identityVersion,
      input.contactAuthority.verificationId,
      input.contactAuthority.verificationDigest,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      input.now,
      createHash('sha256').update(input.ceremonyId).digest('hex'),
      createHash('sha256').update(input.providerSubjectId).digest('hex'),
      createHash('sha256').update(input.companionId).digest('hex'),
      createHash('sha256').update(input.contactId).digest('hex'),
      createHash('sha256').update(input.contactAuthority.verificationId).digest('hex'),
    ]);
    const completion = result.rows.at(0)?.result;
    if (!isRecord(completion)
      || typeof completion.authnVersion !== 'number'
      || typeof completion.authzVersion !== 'number'
      || typeof completion.bindingVersion !== 'number'
      || typeof completion.grantVersion !== 'number'
      || typeof completion.policyVersion !== 'number'
      || typeof completion.globalAuthEpoch !== 'number') {
      throw new Error('Fleet auth first-owner procedure returned an invalid result');
    }
    const session = await insertSession(client, {
      principal: {
        principal_id: input.principalId,
        status: 'active',
        authn_version: String(completion.authnVersion),
        authz_version: String(completion.authzVersion),
        binding_version: String(completion.bindingVersion),
        grant_version: String(completion.grantVersion),
        policy_version: String(completion.policyVersion),
      },
      audience: 'fleet',
      token: input.nextToken,
      csrfToken: input.nextCsrfToken,
      now: input.now,
      idleExpiresAt: new Date(input.now.getTime() + input.idleTtlMs),
      absoluteExpiresAt: new Date(input.now.getTime() + input.absoluteTtlMs),
      globalAuthEpoch: completion.globalAuthEpoch,
      providerSubjectId: input.providerSubjectId,
    });
    await client.query('COMMIT');
    return session;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    try {
      const authority = await client.query<{
        authority_generation: string;
        global_auth_epoch: string;
      }>(`
        SELECT authority_generation, global_auth_epoch
        FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
        WHERE singleton = TRUE
      `);
      const row = authority.rows.at(0);
      if (!row) throw new Error('fleet_auth authority is missing during first-owner denial audit');
      const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
          (event_id, actor_context, action, resource, decision, reason_code,
           companion_id, principal_id, authority_generation, global_auth_epoch,
           occurred_at, decision_id, ceremony_id, decision_context)
        VALUES ($1, $2::jsonb, 'authority.first_owner', 'first-owner-exact-tuple',
                'deny', 'first_owner_denied', $3, $4, $5, $6,
                clock_timestamp(), $1, $7, $8::jsonb)
      `, [
        randomUUID(),
        JSON.stringify({ kind: 'trusted_host', id: 'first_owner' }),
        input.companionId,
        input.principalId,
        row.authority_generation,
        row.global_auth_epoch,
        input.ceremonyId,
        JSON.stringify({
          schemaVersion: 1,
          provider: 'discord',
          providerSubjectDigest: sha256(input.providerSubjectId),
          companionDigest: sha256(input.companionId),
          contactDigest: sha256(input.contactId),
          role: 'owner',
          ceremonyDigest: sha256(input.ceremonyId),
          contactAuthorityVersion: input.contactAuthority.contactAuthorityVersion,
          identityVersion: input.contactAuthority.identityVersion,
          verificationIdDigest: sha256(input.contactAuthority.verificationId),
          verificationDigest: input.contactAuthority.verificationDigest,
          authorityGeneration: Number(row.authority_generation),
          globalAuthEpoch: Number(row.global_auth_epoch),
          decision: 'deny',
        }),
      ]);
    } catch (auditError) {
      const failure = new FleetAuthBrokerError(
        'first_owner_denial_audit_failed',
        503,
        'First-owner denial audit could not be persisted',
      );
      failure.cause = auditError;
      throw failure;
    }
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
