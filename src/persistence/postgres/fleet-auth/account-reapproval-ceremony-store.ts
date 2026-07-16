import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  TrustedHostAccountReapprovalError,
  type PreparedAccountReapprovalCeremony,
  type TrustedHostAccountReapprovalProviderProof,
  type TrustedHostAccountReapprovalStore,
} from '../../../boundary/fleet-auth/trusted-host-account-reapproval.js';
import { FLEET_AUTH_ROLES, type FleetAuthRole } from '../../../system/config/fleet-auth-config.js';
import { isRecord, isRfc4122Uuid } from '../../../shared/utils/types.js';
import type { PasskeyAuthorityPort } from '../../../boundary/fleet-auth/passkey-authority.js';
import type { ProviderRevocationAuthorityPort } from './provider-revocation-authority.js';
import type { SessionAuthorityRow } from './oauth-session-store-types.js';
import { FleetAuthSecretCodec } from './oauth-secret-codec.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const AUDIT_CODE_PATTERN = /^[a-z_]{1,64}$/u;

interface AuthorityRow {
  authority_generation: string;
  global_auth_epoch: string;
  restore_checkpoint: string;
  authority_lineage_id: string | null;
}

interface TargetRow {
  principal_status: string;
  principal_restore_state: string;
  provider_principal_id: string;
  provider_state: string;
  provider_restore_state: string;
  companion_lifecycle: string;
  companion_restore_state: string;
  companion_version: string;
  binding_principal_id: string;
  binding_companion_id: string;
  binding_contact_id: string;
  binding_state: string;
  binding_restore_state: string;
  binding_version: string;
  contact_verification_digest: string;
  grant_principal_id: string;
  grant_companion_id: string;
  grant_role: FleetAuthRole;
  grant_lifecycle: string;
  grant_restore_state: string;
  grant_version: string;
}

interface ContactProofRow {
  intent_id: string;
  request_digest: string;
}

interface CeremonyRow {
  ceremony_id: string;
  expected_provider: string | null;
  expected_provider_subject_id: string | null;
  expected_companion_id: string | null;
  expected_contact_id: string | null;
  exact_scope: unknown;
  status: string;
  global_auth_epoch: string;
  expires_at: Date;
  webauthn_challenge_digest: string | null;
  webauthn_challenge_ciphertext: Buffer | null;
  exact_origin: string | null;
  rp_id: string | null;
  credential_floor_generation: string | null;
  attempt_count: number;
  reapproval_verified_at: Date | null;
}

interface OAuthProofRow {
  status: string;
  kind: string;
  global_auth_epoch: string;
  expires_at: Date;
  verified_provider: string | null;
  verified_provider_subject_id: string | null;
  lifecycle_ceremony_id: string | null;
  lifecycle_action: string | null;
  lifecycle_proof_role: string | null;
  initiating_principal_id: string | null;
  initiating_session_id: string | null;
}

interface AccountScope {
  schemaVersion: 4;
  principalId: string;
  provider: 'discord';
  providerSubjectId: string;
  companionId: string;
  contactId: string;
  bindingId: string;
  roleGrantId: string;
  role: FleetAuthRole;
  companionVersion: number;
  bindingVersion: number;
  roleGrantVersion: number;
  contactOwnershipIntentId: string;
  contactOwnershipRequestDigest: string;
  contactVerificationDigest: string;
  authorityLineageId: string;
  authorityGeneration: number;
  restoreCheckpoint: number;
  reasonDigest: string;
}

export interface PostgresAccountReapprovalCeremonyStoreOptions {
  authorityPool: Pool;
  sessionPepper: string;
  tokenEncryptionKey: string;
  providerRevocationAuthority: ProviderRevocationAuthorityPort;
  passkeyAuthority: Pick<PasskeyAuthorityPort, 'readPasskeys'>;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function integer(value: string | null, field: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`Invalid fleet_auth account reapproval ${field}`);
  }
  return parsed;
}

function scopeInteger(value: unknown, field: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
    throw new TrustedHostAccountReapprovalError(
      'ceremony_unavailable',
      `Account reapproval ${field} is invalid`,
    );
  }
  return Number(value);
}

function scopeString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new TrustedHostAccountReapprovalError(
      'ceremony_unavailable',
      `Account reapproval ${field} is invalid`,
    );
  }
  return value;
}

function parseScope(value: unknown): AccountScope {
  if (!isRecord(value)) {
    throw new TrustedHostAccountReapprovalError(
      'ceremony_unavailable',
      'Account reapproval exact scope is unavailable',
    );
  }
  const keys = [
    'schemaVersion', 'principalId', 'provider', 'providerSubjectId', 'companionId',
    'contactId', 'bindingId', 'roleGrantId', 'role', 'companionVersion',
    'bindingVersion', 'roleGrantVersion', 'contactOwnershipIntentId',
    'contactOwnershipRequestDigest', 'contactVerificationDigest', 'authorityLineageId',
    'authorityGeneration', 'restoreCheckpoint', 'reasonDigest',
  ] as const;
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TrustedHostAccountReapprovalError(
      'ceremony_unavailable',
      'Account reapproval exact scope is not closed',
    );
  }
  const principalId = scopeString(value.principalId, 'principalId');
  const companionId = scopeString(value.companionId, 'companionId');
  const bindingId = scopeString(value.bindingId, 'bindingId');
  const roleGrantId = scopeString(value.roleGrantId, 'roleGrantId');
  const contactOwnershipIntentId = scopeString(
    value.contactOwnershipIntentId,
    'contactOwnershipIntentId',
  );
  const role = value.role;
  if (value.schemaVersion !== 4 || value.provider !== 'discord'
    || !isRfc4122Uuid(principalId) || !isRfc4122Uuid(companionId)
    || !isRfc4122Uuid(bindingId) || !isRfc4122Uuid(roleGrantId)
    || !isRfc4122Uuid(contactOwnershipIntentId)
    || !FLEET_AUTH_ROLES.includes(role as FleetAuthRole)) {
    throw new TrustedHostAccountReapprovalError(
      'ceremony_unavailable',
      'Account reapproval exact scope is invalid',
    );
  }
  const contactOwnershipRequestDigest = scopeString(
    value.contactOwnershipRequestDigest,
    'contactOwnershipRequestDigest',
  );
  const contactVerificationDigest = scopeString(
    value.contactVerificationDigest,
    'contactVerificationDigest',
  );
  const authorityLineageId = scopeString(value.authorityLineageId, 'authorityLineageId');
  const reasonDigest = scopeString(value.reasonDigest, 'reasonDigest');
  if (![contactOwnershipRequestDigest, contactVerificationDigest, authorityLineageId, reasonDigest]
    .every(entry => DIGEST_PATTERN.test(entry))) {
    throw new TrustedHostAccountReapprovalError(
      'ceremony_unavailable',
      'Account reapproval digest scope is invalid',
    );
  }
  return {
    schemaVersion: 4,
    principalId,
    provider: 'discord',
    providerSubjectId: scopeString(value.providerSubjectId, 'providerSubjectId'),
    companionId,
    contactId: scopeString(value.contactId, 'contactId'),
    bindingId,
    roleGrantId,
    role: role as FleetAuthRole,
    companionVersion: scopeInteger(value.companionVersion, 'companionVersion'),
    bindingVersion: scopeInteger(value.bindingVersion, 'bindingVersion'),
    roleGrantVersion: scopeInteger(value.roleGrantVersion, 'roleGrantVersion'),
    contactOwnershipIntentId,
    contactOwnershipRequestDigest,
    contactVerificationDigest,
    authorityLineageId,
    authorityGeneration: scopeInteger(value.authorityGeneration, 'authorityGeneration'),
    restoreCheckpoint: scopeInteger(value.restoreCheckpoint, 'restoreCheckpoint', true),
    reasonDigest,
  };
}

export class PostgresAccountReapprovalCeremonyStore
implements TrustedHostAccountReapprovalStore {
  private readonly codec: FleetAuthSecretCodec;

  constructor(private readonly options: PostgresAccountReapprovalCeremonyStoreOptions) {
    this.codec = new FleetAuthSecretCodec(options);
  }

  async create(
    input: Parameters<TrustedHostAccountReapprovalStore['create']>[0],
  ): ReturnType<TrustedHostAccountReapprovalStore['create']> {
    const client = await this.options.authorityPool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      const target = await this.lockTarget(client, input);
      const contactProof = await this.lockContactProof(
        client,
        input.expectedCompanionId,
        input.expectedContactId,
        input.expectedProviderSubjectId,
      );
      const scope: AccountScope = {
        schemaVersion: 4,
        principalId: input.expectedPrincipalId,
        provider: 'discord',
        providerSubjectId: input.expectedProviderSubjectId,
        companionId: input.expectedCompanionId,
        contactId: input.expectedContactId,
        bindingId: input.expectedBindingId,
        roleGrantId: input.expectedRoleGrantId,
        role: target.grant_role,
        companionVersion: integer(target.companion_version, 'companion version'),
        bindingVersion: integer(target.binding_version, 'binding version'),
        roleGrantVersion: integer(target.grant_version, 'role grant version'),
        contactOwnershipIntentId: contactProof.intent_id,
        contactOwnershipRequestDigest: contactProof.request_digest,
        contactVerificationDigest: target.contact_verification_digest,
        authorityLineageId: authority.authority_lineage_id!,
        authorityGeneration: integer(authority.authority_generation, 'authority generation'),
        restoreCheckpoint: integer(authority.restore_checkpoint, 'restore checkpoint', true),
        reasonDigest: input.reasonDigest,
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
          $1, $2, 'account_reapproval', 'discord', $3, $4, $5, $6::jsonb,
          'pending', $7, $8, $9, 1, $10, $11, $12, $13, $14, NULL, $8
        )
      `, [
        input.ceremonyId,
        digest(input.nonce),
        input.expectedProviderSubjectId,
        input.expectedCompanionId,
        input.expectedContactId,
        JSON.stringify(scope),
        authority.global_auth_epoch,
        input.now,
        input.expiresAt,
        digest(input.challenge),
        this.codec.encrypt(input.challenge),
        input.exactOrigin,
        input.rpId,
        input.credentialFloorGeneration,
      ]);
      await this.audit(client, {
        decision: 'allow',
        action: 'authority.account_reapproval.create',
        reasonCode: 'trusted_host_scope_confirmed',
        resource: `account_reapproval_scope:${digest(JSON.stringify(scope))}`,
        companionId: input.expectedCompanionId,
        principalId: input.expectedPrincipalId,
        authorityGeneration: integer(authority.authority_generation, 'authority generation'),
        globalAuthEpoch: integer(authority.global_auth_epoch, 'global auth epoch'),
        correlationId: input.ceremonyId,
        at: input.now,
        decisionContext: this.auditScope(scope, input.credentialFloorGeneration),
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
    input: Parameters<TrustedHostAccountReapprovalStore['prepare']>[0],
  ): ReturnType<TrustedHostAccountReapprovalStore['prepare']> {
    const client = await this.options.authorityPool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      const ceremony = await this.lockCeremonyByNonce(client, input.nonce);
      const scope = this.validatePending(ceremony, authority, input.exactOrigin, input.now);
      const session = await this.lockActiveSession(
        client,
        input.token,
        input.csrfToken,
        input.now,
      );
      await this.lockProviderProof(client, input.providerProof, ceremony, session, input.now);
      const challenge = this.decryptChallenge(ceremony);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
        SET attempt_count = attempt_count + 1
        WHERE ceremony_id = $1
      `, [ceremony.ceremony_id]);
      await client.query('COMMIT');
      return this.prepared(ceremony, scope, challenge, session, input.providerProof);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async confirm(
    input: Parameters<TrustedHostAccountReapprovalStore['confirm']>[0],
  ): ReturnType<TrustedHostAccountReapprovalStore['confirm']> {
    const client = await this.options.authorityPool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      const ceremony = await this.lockCeremonyById(client, input.ceremony.ceremonyId);
      const databaseNow = await this.databaseNow(client);
      const scope = this.validatePending(ceremony, authority, ceremony.exact_origin ?? '', databaseNow);
      const session = await this.lockActiveSession(
        client,
        input.token,
        input.csrfToken,
        databaseNow,
      );
      await this.lockProviderProof(client, input.providerProof, ceremony, session, databaseNow);
      if (!this.matchesPrepared(input.ceremony, ceremony, scope, session, input.providerProof)) {
        throw new TrustedHostAccountReapprovalError(
          'ceremony_unavailable',
          'Account reapproval changed during verification',
        );
      }
      const floor = this.options.passkeyAuthority.readPasskeys();
      const storedFloor = integer(
        ceremony.credential_floor_generation,
        'credential floor generation',
        true,
      );
      const credential = floor.credentials.find(entry => entry.status === 'current'
        && entry.credentialIdHash === input.credentialIdHash
        && entry.principalId === scope.principalId
        && entry.expectedProviderSubjectId === scope.providerSubjectId);
      const unchangedFloor = floor.generation === storedFloor;
      const exactSignalAdvance = floor.generation === storedFloor + 1
        && credential?.generation === floor.generation;
      if ((!unchangedFloor && !exactSignalAdvance)
        || floor.generation !== input.credentialFloorGeneration
        || credential?.generation !== input.credentialGeneration) {
        throw new TrustedHostAccountReapprovalError(
          'passkey_authority_changed',
          'Passkey authority changed during account reapproval',
        );
      }
      const updated = await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
        SET reapproval_verified_at = $2,
            reapproval_actor_principal_id = $3,
            reapproval_actor_session_id = $4,
            reapproval_oauth_transaction_id = $5,
            reapproval_oauth_proof_digest = $6,
            reapproval_credential_id_hash = $7,
            reapproval_credential_generation = $8,
            reapproval_credential_floor_generation = $9
        WHERE ceremony_id = $1 AND status = 'pending'
          AND reapproval_verified_at IS NULL
      `, [
        ceremony.ceremony_id,
        databaseNow,
        session.principal_id,
        session.record_id,
        input.providerProof.callbackTransactionId,
        input.providerProof.proofDigest,
        input.credentialIdHash,
        input.credentialGeneration,
        input.credentialFloorGeneration,
      ]);
      if (updated.rowCount !== 1) {
        throw new TrustedHostAccountReapprovalError(
          'ceremony_unavailable',
          'Account reapproval confirmation is unavailable',
        );
      }
      await this.audit(client, {
        decision: 'allow',
        action: 'authority.account_reapproval.confirm',
        reasonCode: 'oauth_webauthn_uv_confirmed',
        resource: `account_reapproval_scope:${digest(JSON.stringify(scope))}`,
        companionId: scope.companionId,
        principalId: scope.principalId,
        authorityGeneration: integer(authority.authority_generation, 'authority generation'),
        globalAuthEpoch: integer(authority.global_auth_epoch, 'global auth epoch'),
        correlationId: ceremony.ceremony_id,
        at: databaseNow,
        decisionContext: {
          ...this.auditScope(scope, input.credentialFloorGeneration),
          credentialIdDigest: digest(input.credentialIdHash),
          credentialGeneration: input.credentialGeneration,
          actorPrincipalId: session.principal_id,
        },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordDenial(
    input: Parameters<TrustedHostAccountReapprovalStore['recordDenial']>[0],
  ): ReturnType<TrustedHostAccountReapprovalStore['recordDenial']> {
    const reasonCode = AUDIT_CODE_PATTERN.test(input.reasonCode)
      ? input.reasonCode
      : 'reapproval_denied';
    const client = await this.options.authorityPool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      const result = await client.query<{
        ceremony_id: string;
        exact_scope: unknown;
        scope_digest: string;
        credential_floor_generation: string | null;
      }>(`
        SELECT ceremony_id, exact_scope,
               encode(sha256(convert_to(exact_scope::text, 'UTF8')), 'hex') AS scope_digest,
               credential_floor_generation
        FROM ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
        WHERE nonce_digest = $1 AND kind = 'account_reapproval'
      `, [digest(input.nonce)]);
      const row = result.rows.at(0);
      let scope: AccountScope | undefined;
      try {
        scope = row ? parseScope(row.exact_scope) : undefined;
      } catch {
        scope = undefined;
      }
      const eventId = randomUUID();
      await this.audit(client, {
        decision: 'deny',
        action: 'authority.account_reapproval.complete',
        reasonCode: `account_reapproval_${input.stage}_${reasonCode}`,
        resource: `account_reapproval_scope:${row?.scope_digest ?? 'unknown'}`,
        companionId: scope?.companionId ?? null,
        principalId: scope?.principalId ?? null,
        authorityGeneration: integer(authority.authority_generation, 'authority generation'),
        globalAuthEpoch: integer(authority.global_auth_epoch, 'global auth epoch'),
        correlationId: row?.ceremony_id ?? eventId,
        at: input.now,
        decisionContext: {
          schemaVersion: 1,
          stage: input.stage,
          scopeDigest: row?.scope_digest ?? 'unknown',
          ...(scope ? this.auditScope(
            scope,
            integer(row?.credential_floor_generation ?? null, 'credential floor generation', true),
          ) : {}),
        },
        eventId,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockAuthority(client: PoolClient): Promise<AuthorityRow> {
    const result = await client.query<AuthorityRow>(`
      SELECT authority_generation, global_auth_epoch, restore_checkpoint,
             authority_lineage_id
      FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
      WHERE singleton = TRUE
      FOR UPDATE
    `);
    const row = result.rows.at(0);
    if (!row?.authority_lineage_id) {
      throw new TrustedHostAccountReapprovalError(
        'ceremony_unavailable',
        'Fleet authority is unavailable',
      );
    }
    return row;
  }

  private async lockTarget(
    client: PoolClient,
    input: Parameters<TrustedHostAccountReapprovalStore['create']>[0],
  ): Promise<TargetRow> {
    const result = await client.query<TargetRow>(`
      SELECT principal.status AS principal_status,
             principal.restore_state AS principal_restore_state,
             subject.principal_id::text AS provider_principal_id,
             subject.state AS provider_state,
             subject.restore_state AS provider_restore_state,
             companion.lifecycle AS companion_lifecycle,
             companion.restore_state AS companion_restore_state,
             companion.version::text AS companion_version,
             binding.principal_id::text AS binding_principal_id,
             binding.companion_id::text AS binding_companion_id,
             binding.contact_id AS binding_contact_id,
             binding.state AS binding_state,
             binding.restore_state AS binding_restore_state,
             binding.version::text AS binding_version,
             encode(sha256(convert_to(binding.verification_provenance::text, 'UTF8')), 'hex')
               AS contact_verification_digest,
             role_grant.principal_id::text AS grant_principal_id,
             role_grant.companion_id::text AS grant_companion_id,
             role_grant.role AS grant_role,
             role_grant.lifecycle AS grant_lifecycle,
             role_grant.restore_state AS grant_restore_state,
             role_grant.version::text AS grant_version
      FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals AS principal
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS subject
        ON subject.provider = 'discord' AND subject.subject_id = $2
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state AS companion
        ON companion.companion_id = $3
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings AS binding
        ON binding.binding_id = $5
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants AS role_grant
        ON role_grant.grant_id = $6
      WHERE principal.principal_id = $1
        AND binding.contact_id = $4
      FOR UPDATE OF principal, subject, companion, binding, role_grant
    `, [
      input.expectedPrincipalId,
      input.expectedProviderSubjectId,
      input.expectedCompanionId,
      input.expectedContactId,
      input.expectedBindingId,
      input.expectedRoleGrantId,
    ]);
    const row = result.rows.at(0);
    if (!row || row.principal_status !== 'quarantined'
      || row.principal_restore_state !== 'quarantined'
      || row.provider_principal_id !== input.expectedPrincipalId
      || row.provider_state !== 'quarantined' || row.provider_restore_state !== 'quarantined'
      || !((row.companion_lifecycle === 'quarantined'
        && row.companion_restore_state === 'quarantined')
        || (row.companion_lifecycle === 'active' && row.companion_restore_state === 'live'))
      || row.binding_principal_id !== input.expectedPrincipalId
      || row.binding_companion_id !== input.expectedCompanionId
      || row.binding_contact_id !== input.expectedContactId
      || row.binding_state !== 'quarantined' || row.binding_restore_state !== 'quarantined'
      || row.grant_principal_id !== input.expectedPrincipalId
      || row.grant_companion_id !== input.expectedCompanionId
      || row.grant_lifecycle !== 'quarantined' || row.grant_restore_state !== 'quarantined'
      || !FLEET_AUTH_ROLES.includes(row.grant_role)) {
      throw new TrustedHostAccountReapprovalError(
        'ceremony_unavailable',
        'Restored account authority is not exactly reapprovable',
      );
    }
    return row;
  }

  private async lockContactProof(
    client: PoolClient,
    companionId: string,
    contactId: string,
    providerSubjectId: string,
  ): Promise<ContactProofRow> {
    const result = await client.query<ContactProofRow>(`
      SELECT intent.intent_id::text AS intent_id, receipt.request_digest
      FROM ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_intents AS intent
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_receipts AS receipt
        ON receipt.companion_id = intent.companion_id
       AND receipt.intent_id = intent.intent_id
       AND receipt.phase = 'finalize'
      WHERE intent.companion_id = $1
        AND intent.action = 'contact.reapprove'
        AND intent.contact_id = $2
        AND intent.provider_subject_id = $3
        AND intent.state = 'released'
        AND intent.restore_state = 'live'
        AND receipt.restore_state = 'live'
        AND receipt.result->>'status' = 'finalized'
        AND NOT EXISTS (
          SELECT 1
          FROM ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_intents AS newer
          WHERE newer.companion_id = intent.companion_id
            AND newer.intent_id <> intent.intent_id
            AND newer.created_at > intent.updated_at
            AND (newer.contact_id = intent.contact_id
              OR newer.provider_subject_id = intent.provider_subject_id)
        )
      ORDER BY intent.updated_at DESC, intent.intent_id DESC
      LIMIT 1
      FOR UPDATE OF intent
    `, [companionId, contactId, providerSubjectId]);
    const row = result.rows.at(0);
    if (!row || !DIGEST_PATTERN.test(row.request_digest)) {
      throw new TrustedHostAccountReapprovalError(
        'ceremony_unavailable',
        'Current companion contact proof is unavailable',
      );
    }
    return row;
  }

  private async lockCeremonyByNonce(client: PoolClient, nonce: string): Promise<CeremonyRow> {
    return await this.lockCeremony(client, 'nonce_digest = $1', digest(nonce));
  }

  private async lockCeremonyById(client: PoolClient, ceremonyId: string): Promise<CeremonyRow> {
    return await this.lockCeremony(client, 'ceremony_id = $1', ceremonyId);
  }

  private async lockCeremony(
    client: PoolClient,
    predicate: string,
    value: string,
  ): Promise<CeremonyRow> {
    const result = await client.query<CeremonyRow>(`
      SELECT ceremony_id, expected_provider, expected_provider_subject_id,
             expected_companion_id, expected_contact_id, exact_scope, status,
             global_auth_epoch, expires_at, webauthn_challenge_digest,
             webauthn_challenge_ciphertext, exact_origin, rp_id,
             credential_floor_generation, attempt_count, reapproval_verified_at
      FROM ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
      WHERE ${predicate} AND kind = 'account_reapproval' AND protocol_version = 1
      FOR UPDATE
    `, [value]);
    const row = result.rows.at(0);
    if (!row) {
      throw new TrustedHostAccountReapprovalError(
        'ceremony_unavailable',
        'Account reapproval ceremony is unavailable',
      );
    }
    return row;
  }

  private validatePending(
    ceremony: CeremonyRow,
    authority: AuthorityRow,
    exactOrigin: string,
    now: Date,
  ): AccountScope {
    const scope = parseScope(ceremony.exact_scope);
    const floor = this.options.passkeyAuthority.readPasskeys();
    if (ceremony.status !== 'pending' || ceremony.reapproval_verified_at
      || ceremony.expires_at.getTime() <= now.getTime()
      || ceremony.global_auth_epoch !== authority.global_auth_epoch
      || ceremony.expected_provider !== 'discord'
      || ceremony.expected_provider_subject_id !== scope.providerSubjectId
      || ceremony.expected_companion_id !== scope.companionId
      || ceremony.expected_contact_id !== scope.contactId
      || ceremony.exact_origin !== exactOrigin
      || ceremony.rp_id !== new URL(exactOrigin).hostname
      || ceremony.attempt_count >= 5
      || integer(ceremony.credential_floor_generation, 'credential floor generation', true)
        !== floor.generation
      || scope.authorityLineageId !== authority.authority_lineage_id
      || scope.authorityGeneration
        !== integer(authority.authority_generation, 'authority generation')
      || scope.restoreCheckpoint !== integer(authority.restore_checkpoint, 'restore checkpoint', true)) {
      throw new TrustedHostAccountReapprovalError(
        'ceremony_unavailable',
        'Account reapproval ceremony is stale or unavailable',
      );
    }
    return scope;
  }

  private async lockActiveSession(
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
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.authority_state AS authority ON authority.singleton = TRUE
      WHERE session.token_digest = $1 AND session.csrf_digest = $2
      FOR UPDATE OF session, principal, subject
    `, [this.codec.digest(token), this.codec.digest(csrfToken)]);
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
        integer(row.authority_generation, 'authority generation'),
      )) {
      throw new TrustedHostAccountReapprovalError(
        'ceremony_unavailable',
        'Active browser authority is unavailable',
      );
    }
    return row;
  }

  private async lockProviderProof(
    client: PoolClient,
    proof: TrustedHostAccountReapprovalProviderProof,
    ceremony: CeremonyRow,
    session: SessionAuthorityRow,
    now: Date,
  ): Promise<void> {
    const result = await client.query<OAuthProofRow>(`
      SELECT status, kind, global_auth_epoch, expires_at, verified_provider,
             verified_provider_subject_id, lifecycle_ceremony_id, lifecycle_action,
             lifecycle_proof_role, initiating_principal_id, initiating_session_id
      FROM ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
      WHERE transaction_id = $1
      FOR UPDATE
    `, [proof.callbackTransactionId]);
    const row = result.rows.at(0);
    if (!row || row.status !== 'consumed' || row.kind !== 'recovery'
      || row.global_auth_epoch !== ceremony.global_auth_epoch
      || row.expires_at.getTime() <= now.getTime()
      || row.verified_provider !== 'discord'
      || row.verified_provider_subject_id !== ceremony.expected_provider_subject_id
      || proof.subjectId !== ceremony.expected_provider_subject_id
      || row.lifecycle_ceremony_id !== ceremony.ceremony_id
      || row.lifecycle_action !== 'provider.relink' || row.lifecycle_proof_role !== 'new'
      || row.initiating_principal_id !== session.principal_id
      || row.initiating_session_id !== session.record_id) {
      throw new TrustedHostAccountReapprovalError(
        'ceremony_unavailable',
        'Current Discord provider proof is unavailable',
      );
    }
  }

  private decryptChallenge(ceremony: CeremonyRow): string {
    if (!ceremony.webauthn_challenge_ciphertext || !ceremony.webauthn_challenge_digest) {
      throw new TrustedHostAccountReapprovalError(
        'ceremony_unavailable',
        'Account reapproval challenge is unavailable',
      );
    }
    const challenge = this.codec.decrypt(ceremony.webauthn_challenge_ciphertext);
    if (digest(challenge) !== ceremony.webauthn_challenge_digest) {
      throw new TrustedHostAccountReapprovalError(
        'ceremony_unavailable',
        'Account reapproval challenge integrity check failed',
      );
    }
    return challenge;
  }

  private prepared(
    ceremony: CeremonyRow,
    scope: AccountScope,
    challenge: string,
    session: SessionAuthorityRow,
    proof: TrustedHostAccountReapprovalProviderProof,
  ): PreparedAccountReapprovalCeremony {
    return {
      ceremonyId: ceremony.ceremony_id,
      challenge,
      principalId: scope.principalId,
      providerSubjectId: scope.providerSubjectId,
      companionId: scope.companionId,
      contactId: scope.contactId,
      bindingId: scope.bindingId,
      roleGrantId: scope.roleGrantId,
      credentialFloorGeneration: integer(
        ceremony.credential_floor_generation,
        'credential floor generation',
        true,
      ),
      actorPrincipalId: session.principal_id,
      actorSessionId: session.record_id,
      oauthTransactionId: proof.callbackTransactionId,
      oauthProofDigest: proof.proofDigest,
    };
  }

  private matchesPrepared(
    prepared: PreparedAccountReapprovalCeremony,
    ceremony: CeremonyRow,
    scope: AccountScope,
    session: SessionAuthorityRow,
    proof: TrustedHostAccountReapprovalProviderProof,
  ): boolean {
    return prepared.ceremonyId === ceremony.ceremony_id
      && prepared.principalId === scope.principalId
      && prepared.providerSubjectId === scope.providerSubjectId
      && prepared.companionId === scope.companionId
      && prepared.contactId === scope.contactId
      && prepared.bindingId === scope.bindingId
      && prepared.roleGrantId === scope.roleGrantId
      && prepared.actorPrincipalId === session.principal_id
      && prepared.actorSessionId === session.record_id
      && prepared.oauthTransactionId === proof.callbackTransactionId
      && prepared.oauthProofDigest === proof.proofDigest;
  }

  private async databaseNow(client: PoolClient): Promise<Date> {
    const result = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const value = result.rows.at(0)?.now;
    if (!value) throw new Error('Fleet database clock is unavailable');
    return value;
  }

  private auditScope(scope: AccountScope, credentialFloorGeneration: number): Record<string, unknown> {
    return {
      schemaVersion: 1,
      reasonDigest: scope.reasonDigest,
      companionVersion: scope.companionVersion,
      bindingVersion: scope.bindingVersion,
      roleGrantVersion: scope.roleGrantVersion,
      contactOwnershipRequestDigest: scope.contactOwnershipRequestDigest,
      contactVerificationDigest: scope.contactVerificationDigest,
      authorityLineageId: scope.authorityLineageId,
      authorityGeneration: scope.authorityGeneration,
      restoreCheckpoint: scope.restoreCheckpoint,
      credentialFloorGeneration,
    };
  }

  private async audit(client: PoolClient, input: {
    decision: 'allow' | 'deny';
    action: string;
    reasonCode: string;
    resource: string;
    companionId: string | null;
    principalId: string | null;
    authorityGeneration: number;
    globalAuthEpoch: number;
    correlationId: string;
    at: Date;
    decisionContext: Record<string, unknown>;
    eventId?: string;
  }): Promise<void> {
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events (
        event_id, actor_context, action, resource, decision, reason_code,
        companion_id, principal_id, authority_generation, global_auth_epoch,
        correlation_id, occurred_at, decision_context
      ) VALUES (
        $1, '{"kind":"trusted_host","boundary":"account_reapproval_v1"}'::jsonb,
        $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb
      )
    `, [
      input.eventId ?? randomUUID(),
      input.action,
      input.resource,
      input.decision,
      input.reasonCode,
      input.companionId,
      input.principalId,
      input.authorityGeneration,
      input.globalAuthEpoch,
      input.correlationId,
      input.at,
      JSON.stringify(input.decisionContext),
    ]);
  }
}
