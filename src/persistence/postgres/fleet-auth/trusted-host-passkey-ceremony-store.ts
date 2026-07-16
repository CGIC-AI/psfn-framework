import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  PreparedPasskeyCeremony,
  TrustedHostPasskeyCeremonyStore,
} from '../../../boundary/fleet-auth/trusted-host-passkey-ceremony.js';
import { TrustedHostPasskeyCeremonyError } from '../../../boundary/fleet-auth/trusted-host-passkey-ceremony.js';
import type { PasskeyAuthorityPort } from '../../../boundary/fleet-auth/passkey-authority.js';
import { FleetAuthSecretCodec } from './oauth-secret-codec.js';
import type { ProviderRevocationAuthorityPort } from './provider-revocation-authority.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

interface CeremonyRow {
  ceremony_id: string;
  kind: PreparedPasskeyCeremony['kind'];
  expected_provider: string | null;
  expected_provider_subject_id: string | null;
  expected_companion_id: string | null;
  expected_contact_id: string | null;
  exact_scope: Record<string, unknown>;
  status: string;
  global_auth_epoch: string;
  expires_at: Date;
  webauthn_challenge_digest: string;
  webauthn_challenge_ciphertext: Buffer;
  exact_origin: string;
  rp_id: string;
  credential_floor_generation: string;
  prior_credential_id_hash: string | null;
  attempt_count: number;
}

interface SessionIdentityRow {
  record_id: string;
  principal_id: string;
  principal_status: string;
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

export interface PostgresTrustedHostPasskeyCeremonyStoreOptions {
  authorityPool: Pool;
  sessionPepper: string;
  tokenEncryptionKey: string;
  providerRevocationAuthority: ProviderRevocationAuthorityPort;
  passkeyAuthority: PasskeyAuthorityPort;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function integer(value: string, field: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`Invalid fleet_auth ${field}`);
  }
  return parsed;
}

export class PostgresTrustedHostPasskeyCeremonyStore
implements TrustedHostPasskeyCeremonyStore {
  private readonly codec: FleetAuthSecretCodec;

  constructor(private readonly options: PostgresTrustedHostPasskeyCeremonyStoreOptions) {
    this.codec = new FleetAuthSecretCodec(options);
  }

  async create(
    input: Parameters<TrustedHostPasskeyCeremonyStore['create']>[0],
  ): ReturnType<TrustedHostPasskeyCeremonyStore['create']> {
    const client = await this.options.authorityPool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      const exactScope = input.kind === 'first_owner'
        ? {
            schemaVersion: 1,
            credentialOnly: false,
            role: 'owner',
            companionId: input.expectedCompanionId,
            contactId: input.expectedContactId,
          }
        : {
            schemaVersion: 1,
            credentialOnly: true,
            recovery: input.kind === 'passkey_recovery',
          };
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies (
          ceremony_id, nonce_digest, kind, expected_provider,
          expected_provider_subject_id, expected_companion_id, expected_contact_id,
          exact_scope, status, global_auth_epoch, created_at, expires_at,
          protocol_version, webauthn_challenge_digest,
          webauthn_challenge_ciphertext, exact_origin, rp_id,
          credential_floor_generation, prior_credential_id_hash, confirmed_at
        ) VALUES (
          $1, $2, $3, 'discord', $4, $5, $6, $7, 'pending', $8, $9, $10,
          1, $11, $12, $13, $14, $15, $16, $9
        )
      `, [
        input.ceremonyId,
        digest(input.nonce),
        input.kind,
        input.expectedProviderSubjectId,
        input.expectedCompanionId ?? null,
        input.expectedContactId ?? null,
        JSON.stringify(exactScope),
        authority.globalAuthEpoch,
        input.now,
        input.expiresAt,
        digest(input.challenge),
        this.codec.encrypt(input.challenge),
        input.exactOrigin,
        input.rpId,
        input.credentialFloorGeneration,
        input.priorCredentialIdHash ?? null,
      ]);
      await this.audit(client, {
        action: 'authority.passkey_ceremony.create',
        reason: input.kind,
        resource: `ceremony:${input.ceremonyId}`,
        companionId: input.expectedCompanionId ?? null,
        principalId: null,
        authorityGeneration: authority.authorityGeneration,
        globalAuthEpoch: authority.globalAuthEpoch,
        correlationId: input.ceremonyId,
        at: input.now,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async prepare(
    input: Parameters<TrustedHostPasskeyCeremonyStore['prepare']>[0],
  ): ReturnType<TrustedHostPasskeyCeremonyStore['prepare']> {
    const client = await this.options.authorityPool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      const result = await client.query<CeremonyRow>(`
        SELECT ceremony_id, kind, expected_provider, expected_provider_subject_id,
               expected_companion_id, expected_contact_id, exact_scope, status,
               global_auth_epoch, expires_at, webauthn_challenge_digest,
               webauthn_challenge_ciphertext, exact_origin, rp_id,
               credential_floor_generation, prior_credential_id_hash, attempt_count
        FROM ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
        WHERE nonce_digest = $1 AND protocol_version = 1
        FOR UPDATE
      `, [digest(input.nonce)]);
      const ceremony = result.rows.at(0);
      if (!ceremony || ceremony.kind !== input.kind || ceremony.status !== 'pending'
        || ceremony.expires_at.getTime() <= input.now.getTime()
        || ceremony.global_auth_epoch !== String(authority.globalAuthEpoch)
        || ceremony.expected_provider !== 'discord'
        || !ceremony.expected_provider_subject_id
        || ceremony.exact_origin !== input.exactOrigin
        || ceremony.rp_id !== new URL(input.exactOrigin).hostname
        || ceremony.attempt_count >= 5) {
        throw new TrustedHostPasskeyCeremonyError(
          'ceremony_unavailable',
          'Trusted-host passkey ceremony is unavailable',
        );
      }
      const floor = this.options.passkeyAuthority.readPasskeys();
      const floorGeneration = integer(
        ceremony.credential_floor_generation,
        'credential_floor_generation',
        true,
      );
      if (floor.generation !== floorGeneration) {
        throw new TrustedHostPasskeyCeremonyError(
          'passkey_authority_changed',
          'Passkey authority changed during ceremony',
        );
      }
      let principalId: string;
      let providerSubjectId: string;
      if (input.token !== undefined || input.csrfToken !== undefined) {
        if (!input.token || !input.csrfToken) {
          throw new TrustedHostPasskeyCeremonyError(
            'ceremony_unavailable',
            'Matching OAuth session evidence is incomplete',
          );
        }
        const session = await this.lockSession(client, input.token, input.csrfToken, input.now);
        const expectedStatus = input.kind === 'first_owner' ? 'pending' : 'active';
        if (session.principal_status !== expectedStatus
          || session.provider_subject_id !== ceremony.expected_provider_subject_id) {
          throw new TrustedHostPasskeyCeremonyError(
            'ceremony_unavailable',
            'OAuth session does not match trusted-host ceremony',
          );
        }
        principalId = session.principal_id;
        providerSubjectId = session.provider_subject_id;
      } else {
        if (input.kind !== 'first_owner') {
          throw new TrustedHostPasskeyCeremonyError(
            'ceremony_unavailable',
            'Matching OAuth session is required',
          );
        }
        const subject = await client.query<{
          principal_id: string;
          state: string;
          restore_state: string;
        }>(`
          SELECT principal_id, state, restore_state
          FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
          WHERE provider = 'discord' AND subject_id = $1
          FOR UPDATE
        `, [ceremony.expected_provider_subject_id]);
        const row = subject.rows.at(0);
        if (!row || row.state !== 'pending' || row.restore_state !== 'live') {
          throw new TrustedHostPasskeyCeremonyError(
            'ceremony_unavailable',
            'First-owner OAuth subject is unavailable',
          );
        }
        principalId = row.principal_id;
        providerSubjectId = ceremony.expected_provider_subject_id;
      }
      if (input.kind === 'passkey_recovery') {
        const prior = floor.credentials.find(entry => entry.status === 'current'
          && entry.credentialIdHash === ceremony.prior_credential_id_hash
          && entry.principalId === principalId
          && entry.expectedProviderSubjectId === providerSubjectId);
        if (!prior) {
          throw new TrustedHostPasskeyCeremonyError(
            'passkey_authority_changed',
            'Recovery prior credential is no longer current',
          );
        }
      } else if (input.kind !== 'first_owner'
        && floor.credentials.some(entry => entry.status === 'current'
        && entry.principalId === principalId)) {
        throw new TrustedHostPasskeyCeremonyError(
          'passkey_authority_changed',
          'Passkey enrollment requires an explicit recovery replacement',
        );
      }
      const challenge = this.codec.decrypt(ceremony.webauthn_challenge_ciphertext);
      if (digest(challenge) !== ceremony.webauthn_challenge_digest) {
        throw new TrustedHostPasskeyCeremonyError(
          'ceremony_unavailable',
          'Passkey challenge integrity check failed',
        );
      }
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
        SET attempt_count = attempt_count + 1
        WHERE ceremony_id = $1
      `, [ceremony.ceremony_id]);
      await client.query('COMMIT');
      return {
        ceremonyId: ceremony.ceremony_id,
        kind: ceremony.kind,
        challenge,
        principalId,
        providerSubjectId,
        ...(ceremony.expected_companion_id
          ? { companionId: ceremony.expected_companion_id }
          : {}),
        ...(ceremony.expected_contact_id ? { contactId: ceremony.expected_contact_id } : {}),
        ...(ceremony.prior_credential_id_hash
          ? { priorCredentialIdHash: ceremony.prior_credential_id_hash }
          : {}),
        credentialFloorGeneration: floorGeneration,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async finalizeCredential(
    input: Parameters<TrustedHostPasskeyCeremonyStore['finalizeCredential']>[0],
  ): ReturnType<TrustedHostPasskeyCeremonyStore['finalizeCredential']> {
    const client = await this.options.authorityPool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      const result = await client.query<CeremonyRow>(`
        SELECT ceremony_id, kind, expected_provider, expected_provider_subject_id,
               expected_companion_id, expected_contact_id, exact_scope, status,
               global_auth_epoch, expires_at, webauthn_challenge_digest,
               webauthn_challenge_ciphertext, exact_origin, rp_id,
               credential_floor_generation, prior_credential_id_hash, attempt_count
        FROM ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
        WHERE ceremony_id = $1 AND protocol_version = 1
        FOR UPDATE
      `, [input.ceremony.ceremonyId]);
      const ceremony = result.rows.at(0);
      const floor = this.options.passkeyAuthority.readPasskeys();
      const current = floor.credentials.find(entry => entry.status === 'current'
        && entry.credentialIdHash === input.candidate.credentialIdHash
        && entry.principalId === input.ceremony.principalId
        && entry.expectedProviderSubjectId === input.ceremony.providerSubjectId
        && entry.publicKeyVerifier === input.candidate.publicKeyVerifier
        && entry.rpId === input.candidate.rpId);
      const expectedAdvance = input.ceremony.kind === 'passkey_recovery' ? 2 : 1;
      if (!ceremony || ceremony.status !== 'pending' || ceremony.kind !== input.ceremony.kind
        || ceremony.global_auth_epoch !== String(authority.globalAuthEpoch)
        || ceremony.expected_provider_subject_id !== input.ceremony.providerSubjectId
        || floor.generation !== input.completedCredentialFloorGeneration
        || floor.generation !== input.ceremony.credentialFloorGeneration + expectedAdvance
        || !current || current.generation !== floor.generation) {
        throw new TrustedHostPasskeyCeremonyError(
          'passkey_authority_changed',
          'Passkey authority and ceremony finalization do not match',
        );
      }
      const principal = await client.query<{ status: string; restore_state: string }>(`
        SELECT status, restore_state
        FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
        WHERE principal_id = $1
        FOR UPDATE
      `, [input.ceremony.principalId]);
      if (principal.rows.at(0)?.status !== 'active'
        || principal.rows.at(0)?.restore_state !== 'live') {
        throw new TrustedHostPasskeyCeremonyError(
          'ceremony_unavailable',
          'Passkey principal is unavailable',
        );
      }
      const nextEpoch = authority.globalAuthEpoch + 1;
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals
        SET authn_version = authn_version + 1, updated_at = $2
        WHERE principal_id = $1
      `, [input.ceremony.principalId, input.now]);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.authority_state
        SET global_auth_epoch = $1, updated_at = $2
        WHERE singleton = TRUE
      `, [nextEpoch, input.now]);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
        SET revoked_at = COALESCE(revoked_at, $2)
        WHERE principal_id = $1
      `, [input.ceremony.principalId, input.now]);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.jit_authorization_grants
        SET revoked_at = COALESCE(revoked_at, $2)
        WHERE principal_id = $1
      `, [input.ceremony.principalId, input.now]);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
        SET status = CASE WHEN status = 'pending' THEN 'revoked' ELSE status END
        WHERE principal_id = $1
      `, [input.ceremony.principalId]);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.passkey_credentials
        SET state = 'revoked', updated_at = $2
        WHERE principal_id = $1 AND credential_id_hash <> $3
      `, [input.ceremony.principalId, input.now, input.candidate.credentialIdHash]);
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.passkey_credentials (
          credential_id_hash, principal_id, expected_provider,
          expected_provider_subject_id, rp_id, public_key_projection,
          credential_generation, state, sign_count, backup_eligible, backup_state,
          authority_floor_generation, restore_state, imported_at, updated_at
        ) VALUES (
          $1, $2, 'discord', $3, $4, $5, $6, 'quarantined', $7, $8, $9,
          $6, 'quarantined', $10, $10
        )
        ON CONFLICT (credential_id_hash) DO UPDATE SET
          state = 'quarantined', sign_count = EXCLUDED.sign_count,
          backup_eligible = EXCLUDED.backup_eligible,
          backup_state = EXCLUDED.backup_state,
          authority_floor_generation = EXCLUDED.authority_floor_generation,
          updated_at = EXCLUDED.updated_at
      `, [
        input.candidate.credentialIdHash,
        input.ceremony.principalId,
        input.ceremony.providerSubjectId,
        input.candidate.rpId,
        input.candidate.publicKeyVerifier,
        floor.generation,
        input.candidate.signCount,
        input.candidate.backupEligible,
        input.candidate.backupState,
        input.now,
      ]);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
        SET status = 'consumed', consumed_at = $2,
            credential_floor_generation = $3
        WHERE ceremony_id = $1
      `, [ceremony.ceremony_id, input.now, floor.generation]);
      await this.audit(client, {
        action: input.ceremony.kind === 'passkey_recovery'
          ? 'authority.passkey_recover'
          : 'authority.passkey_enroll',
        reason: 'trusted_host_oauth_webauthn_uv',
        resource: `credential:${input.candidate.credentialIdHash}`,
        companionId: null,
        principalId: input.ceremony.principalId,
        authorityGeneration: authority.authorityGeneration,
        globalAuthEpoch: nextEpoch,
        correlationId: ceremony.ceremony_id,
        at: input.now,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async bindFirstOwnerCredential(
    input: Parameters<TrustedHostPasskeyCeremonyStore['bindFirstOwnerCredential']>[0],
  ): ReturnType<TrustedHostPasskeyCeremonyStore['bindFirstOwnerCredential']> {
    const client = await this.options.authorityPool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      const result = await client.query<CeremonyRow>(`
        SELECT ceremony_id, kind, expected_provider, expected_provider_subject_id,
               expected_companion_id, expected_contact_id, exact_scope, status,
               global_auth_epoch, expires_at, webauthn_challenge_digest,
               webauthn_challenge_ciphertext, exact_origin, rp_id,
               credential_floor_generation, prior_credential_id_hash, attempt_count
        FROM ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
        WHERE ceremony_id = $1 AND protocol_version = 1
        FOR UPDATE
      `, [input.ceremony.ceremonyId]);
      const ceremony = result.rows.at(0);
      const floor = this.options.passkeyAuthority.readPasskeys();
      const current = floor.credentials.find(entry => entry.status === 'current'
        && entry.credentialIdHash === input.candidate.credentialIdHash
        && entry.principalId === input.ceremony.principalId
        && entry.expectedProviderSubjectId === input.ceremony.providerSubjectId
        && entry.publicKeyVerifier === input.candidate.publicKeyVerifier
        && entry.rpId === input.candidate.rpId);
      const storedGeneration = ceremony
        ? integer(ceremony.credential_floor_generation, 'credential_floor_generation', true)
        : -1;
      if (!ceremony || ceremony.kind !== 'first_owner' || ceremony.status !== 'pending'
        || ceremony.global_auth_epoch !== String(authority.globalAuthEpoch)
        || ceremony.expected_provider_subject_id !== input.ceremony.providerSubjectId
        || floor.generation !== input.completedCredentialFloorGeneration
        || (storedGeneration !== floor.generation
          && storedGeneration + 1 !== floor.generation)
        || !current || current.generation !== floor.generation) {
        throw new TrustedHostPasskeyCeremonyError(
          'passkey_authority_changed',
          'First-owner passkey authority does not match the ceremony',
        );
      }
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
        SET credential_floor_generation = $2
        WHERE ceremony_id = $1
      `, [ceremony.ceremony_id, floor.generation]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockAuthority(client: PoolClient): Promise<{
    authorityGeneration: number;
    globalAuthEpoch: number;
  }> {
    const result = await client.query<{
      authority_generation: string;
      global_auth_epoch: string;
    }>(`
      SELECT state.authority_generation, state.global_auth_epoch
      FROM fleet_auth.authority_state AS state
      WHERE state.singleton = TRUE
      FOR UPDATE
    `);
    const row = result.rows.at(0);
    if (!row) throw new Error('fleet_auth authority state is unavailable');
    return {
      authorityGeneration: integer(row.authority_generation, 'authority_generation'),
      globalAuthEpoch: integer(row.global_auth_epoch, 'global_auth_epoch'),
    };
  }

  private async lockSession(
    client: PoolClient,
    token: string,
    csrfToken: string,
    now: Date,
  ): Promise<SessionIdentityRow> {
    const result = await client.query<SessionIdentityRow>(`
      SELECT session.record_id, session.principal_id,
             principal.status AS principal_status,
             principal.authn_version, principal.authz_version,
             principal.binding_version, principal.grant_version, principal.policy_version,
             session.authn_version AS session_authn_version,
             session.authz_version AS session_authz_version,
             session.binding_version AS session_binding_version,
             session.grant_version AS session_grant_version,
             session.policy_version AS session_policy_version,
             session.provider_subject_id, subject.state AS provider_state,
             subject.restore_state AS provider_restore_state,
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
      || row.restore_state !== 'live'
      || (row.principal_status !== 'active' && row.principal_status !== 'pending')
      || !row.provider_subject_id
      || (row.provider_state !== 'active' && row.provider_state !== 'pending')
      || row.provider_restore_state !== 'live'
      || row.authn_version !== row.session_authn_version
      || row.authz_version !== row.session_authz_version
      || row.binding_version !== row.session_binding_version
      || row.grant_version !== row.session_grant_version
      || row.policy_version !== row.session_policy_version
      || row.global_auth_epoch !== row.session_global_auth_epoch
      || !this.options.providerRevocationAuthority.sessionAuthorityGenerationIsCurrent(
        integer(row.authority_generation, 'authority_generation'),
      )) {
      throw new TrustedHostPasskeyCeremonyError(
        'ceremony_unavailable',
        'Matching OAuth session is unavailable',
      );
    }
    return row;
  }

  private async audit(client: PoolClient, input: {
    action: string;
    reason: string;
    resource: string;
    companionId: string | null;
    principalId: string | null;
    authorityGeneration: number;
    globalAuthEpoch: number;
    correlationId: string;
    at: Date;
  }): Promise<void> {
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events (
        event_id, actor_context, action, resource, decision, reason_code,
        companion_id, principal_id, authority_generation, global_auth_epoch,
        correlation_id, occurred_at
      ) VALUES (
        $1, '{"kind":"trusted_host_passkey"}'::jsonb, $2, $3, 'allow', $4,
        $5, $6, $7, $8, $9, $10
      )
    `, [
      randomUUID(), input.action, input.resource, input.reason,
      input.companionId, input.principalId, input.authorityGeneration,
      input.globalAuthEpoch, input.correlationId, input.at,
    ]);
  }
}
