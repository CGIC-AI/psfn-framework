import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AccountAuthorityFencePort } from './provider-revocation-authority.js';
import {
  LifecycleMutationDenied,
  type LifecycleVersionBump,
} from './authority-lifecycle-mutation-contract.js';
import { prepareLifecycleMutation } from './authority-lifecycle-mutations.js';
import {
  assertVerifiedFleetAuthLifecycleDecision,
  type FleetAuthLifecycleResult,
  type PrincipalAuthorityClaim,
  type VerifiedFleetAuthLifecycleDecision,
  type VerifiedProviderProof,
} from './authority-lifecycle-types.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

interface AuthorityRow {
  authority_generation: string;
  global_auth_epoch: string;
}

interface PrincipalRow {
  principal_id: string;
  status: string;
  authn_version: string;
  authz_version: string;
  binding_version: string;
  grant_version: string;
  policy_version: string;
  restore_state: string;
}

export class FleetAuthLifecycleDeniedError extends Error {
  constructor(readonly reasonCode: string, options?: ErrorOptions) {
    super('Fleet auth lifecycle transition was denied', options);
    this.name = 'FleetAuthLifecycleDeniedError';
  }
}

function integer(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid fleet_auth lifecycle ${field}`);
  }
  return parsed;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function proofs(decision: VerifiedFleetAuthLifecycleDecision): VerifiedProviderProof[] {
  const result: VerifiedProviderProof[] = [];
  if ('currentProvider' in decision) result.push(decision.currentProvider);
  if ('newProvider' in decision) result.push(decision.newProvider);
  if ('canonicalProvider' in decision) result.push(decision.canonicalProvider);
  if ('sourceProvider' in decision) result.push(decision.sourceProvider);
  return result;
}

function claims(decision: VerifiedFleetAuthLifecycleDecision): PrincipalAuthorityClaim[] {
  const byId = new Map<string, PrincipalAuthorityClaim>();
  const candidates = [
    decision.actor,
    decision.target,
    ...('source' in decision ? [decision.source] : []),
  ];
  for (const claim of candidates) {
    const prior = byId.get(claim.principalId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(claim)) {
      throw new FleetAuthLifecycleDeniedError('conflicting_principal_claims');
    }
    byId.set(claim.principalId, claim);
  }
  return [...byId.values()].sort((left, right) => (
    left.principalId.localeCompare(right.principalId)
  ));
}

function rowMatchesClaim(row: PrincipalRow, claim: PrincipalAuthorityClaim): boolean {
  return row.authn_version === String(claim.authnVersion)
    && row.authz_version === String(claim.authzVersion)
    && row.binding_version === String(claim.bindingVersion)
    && row.grant_version === String(claim.grantVersion)
    && row.policy_version === String(claim.policyVersion);
}

function expectedStatus(
  decision: VerifiedFleetAuthLifecycleDecision,
  principalId: string,
): readonly string[] {
  if (decision.action === 'binding.activate' && principalId === decision.target.principalId) {
    return ['pending'];
  }
  return ['active'];
}

function redactedContext(decision: VerifiedFleetAuthLifecycleDecision): Record<string, unknown> {
  return {
    schemaVersion: 1,
    action: decision.action,
    actorDigest: digest(decision.actor.principalId),
    targetDigest: digest(decision.target.principalId),
    actorIsTarget: decision.actor.principalId === decision.target.principalId,
    ...('source' in decision
      ? { sourceDigest: digest(decision.source.principalId) }
      : {}),
    ...('companionId' in decision
      ? { companionDigest: digest(decision.companionId) }
      : {}),
    providerProofs: proofs(decision).map(proof => ({
      provider: proof.provider,
      subjectDigest: digest(proof.subjectId),
      callbackDigest: digest(proof.callbackTransactionId),
      proofDigest: proof.proofDigest,
    })),
  };
}

function denialReason(error: unknown): string {
  if (error instanceof FleetAuthLifecycleDeniedError
    || error instanceof LifecycleMutationDenied) {
    return error.reasonCode;
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code);
    if (code === '23505') return 'lifecycle_replay_or_conflict';
    if (code === '23503' || code === '23514' || code === '42501') {
      return 'durable_authority_conflict';
    }
  }
  return 'lifecycle_transition_failed';
}

export class GatewayFleetAuthAuthorityLifecycleStore {
  private readonly pool: Pool;
  private readonly accountAuthority: AccountAuthorityFencePort;

  constructor(options: { pool: Pool; accountAuthority: AccountAuthorityFencePort }) {
    this.pool = options.pool;
    this.accountAuthority = options.accountAuthority;
  }

  async execute(input: VerifiedFleetAuthLifecycleDecision): Promise<FleetAuthLifecycleResult> {
    let decision: VerifiedFleetAuthLifecycleDecision;
    try {
      decision = assertVerifiedFleetAuthLifecycleDecision(input);
    } catch (error) {
      throw new FleetAuthLifecycleDeniedError('invalid_verified_decision', { cause: error });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client, decision);
      await this.lockAndValidateProviderProofs(client, decision);
      await this.consumeReceipts(client, decision);
      await this.lockAndValidateClaims(client, decision);
      await this.lockAndValidateActorSession(client, decision);
      const mutation = await prepareLifecycleMutation(client, decision);
      await this.lockAffectedPrincipals(client, mutation.affectedPrincipalIds);

      let authorityGeneration = decision.authorityGeneration;
      if (mutation.revocations.length > 0) {
        const fenced = await this.accountAuthority.fenceMany({
          resources: mutation.revocations,
          reasonDigest: decision.reasonDigest,
          at: decision.decidedAt,
        });
        authorityGeneration = fenced.authorityGeneration;
        if (authorityGeneration !== decision.authorityGeneration + 1) {
          throw new FleetAuthLifecycleDeniedError('non_restored_authority_race');
        }
      }

      await mutation.apply(authorityGeneration);
      await this.bumpPrincipalAuthority(
        client,
        mutation.bumps,
        authorityGeneration,
        decision.decidedAt,
      );
      const globalAuthEpoch = integer(authority.global_auth_epoch, 'global_auth_epoch') + 1;
      const authorityUpdate = await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.authority_state
        SET authority_generation = $3, global_auth_epoch = $4, updated_at = $5
        WHERE singleton = TRUE
          AND authority_generation = $1
          AND global_auth_epoch = $2
      `, [
        decision.authorityGeneration,
        decision.globalAuthEpoch,
        authorityGeneration,
        globalAuthEpoch,
        decision.decidedAt,
      ]);
      if (authorityUpdate.rowCount !== 1) {
        throw new FleetAuthLifecycleDeniedError('authority_changed_during_transition');
      }
      await this.fenceEphemeralAuthority(
        client,
        mutation.affectedPrincipalIds,
        decision.decidedAt,
      );
      await this.insertAudit(client, decision, 'allow', 'lifecycle_transition_applied', {
        authorityGeneration,
        globalAuthEpoch,
      });
      const target = await this.readClaim(client, decision.target.principalId);
      await client.query('COMMIT');
      return {
        decisionId: decision.decisionId,
        action: decision.action,
        authorityGeneration,
        globalAuthEpoch,
        target,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const reasonCode = denialReason(error);
      try {
        await this.persistDenial(decision, reasonCode);
      } catch (auditError) {
        throw new FleetAuthLifecycleDeniedError(
          'denial_audit_persistence_failed',
          { cause: auditError },
        );
      }
      throw error instanceof FleetAuthLifecycleDeniedError
        ? error
        : new FleetAuthLifecycleDeniedError(reasonCode);
    } finally {
      client.release();
    }
  }

  private async lockAuthority(
    client: PoolClient,
    decision: VerifiedFleetAuthLifecycleDecision,
  ): Promise<AuthorityRow> {
    const result = await client.query<AuthorityRow>(`
      SELECT authority_generation, global_auth_epoch
      FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
      WHERE singleton = TRUE
      FOR UPDATE
    `);
    if (result.rowCount !== 1) {
      throw new FleetAuthLifecycleDeniedError('authority_state_missing');
    }
    const row = result.rows[0];
    if (row.authority_generation !== String(decision.authorityGeneration)
      || row.global_auth_epoch !== String(decision.globalAuthEpoch)
      || !this.accountAuthority.sessionAuthorityGenerationIsCurrent(
        integer(row.authority_generation, 'authority_generation'),
      )) {
      throw new FleetAuthLifecycleDeniedError('stale_authority_decision');
    }
    return row;
  }

  private async consumeReceipts(
    client: PoolClient,
    decision: VerifiedFleetAuthLifecycleDecision,
  ): Promise<void> {
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.lifecycle_decision_receipts
        (receipt_id, decision_id, ceremony_id, action, created_at)
      VALUES ($1, $1, $2, $3, $4)
    `, [decision.decisionId, decision.ceremonyId, decision.action, decision.decidedAt]);
    for (const proof of proofs(decision)) {
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.lifecycle_decision_receipts
          (receipt_id, decision_id, ceremony_id, callback_transaction_id,
           action, proof_digest, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        randomUUID(),
        decision.decisionId,
        decision.ceremonyId,
        proof.callbackTransactionId,
        decision.action,
        proof.proofDigest,
        decision.decidedAt,
      ]);
    }
  }

  private async lockAndValidateProviderProofs(
    client: PoolClient,
    decision: VerifiedFleetAuthLifecycleDecision,
  ): Promise<void> {
    for (const proof of proofs(decision)) {
      const result = await client.query<{ transaction_id: string }>(`
        SELECT transaction.transaction_id
        FROM ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions AS transaction
        WHERE transaction.transaction_id = $1
          AND transaction.status = 'consumed'
          AND transaction.consumed_at IS NOT NULL
          AND transaction.consumed_at <= $2
          AND $2 <= clock_timestamp()
          AND transaction.expires_at > clock_timestamp()
          AND transaction.global_auth_epoch = $3
          AND transaction.verified_provider = $4
          AND transaction.verified_provider_subject_id = $5
        FOR UPDATE OF transaction
      `, [
        proof.callbackTransactionId,
        decision.decidedAt,
        decision.globalAuthEpoch,
        proof.provider,
        proof.subjectId,
      ]);
      if (result.rowCount !== 1) {
        throw new FleetAuthLifecycleDeniedError('provider_callback_proof_invalid');
      }
    }
  }

  private async lockAndValidateClaims(
    client: PoolClient,
    decision: VerifiedFleetAuthLifecycleDecision,
  ): Promise<void> {
    const expected = claims(decision);
    const result = await client.query<PrincipalRow>(`
      SELECT principal_id, status, authn_version, authz_version,
             binding_version, grant_version, policy_version, restore_state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
      WHERE principal_id = ANY($1::uuid[])
      ORDER BY principal_id
      FOR UPDATE
    `, [expected.map(claim => claim.principalId)]);
    if (result.rows.length !== expected.length) {
      throw new FleetAuthLifecycleDeniedError('principal_claim_unknown');
    }
    for (const claim of expected) {
      const row = result.rows.find(candidate => candidate.principal_id === claim.principalId);
      if (!row || row.restore_state !== 'live') {
        throw new FleetAuthLifecycleDeniedError('principal_restored_or_missing');
      }
      if (!rowMatchesClaim(row, claim)) {
        throw new FleetAuthLifecycleDeniedError('principal_version_stale');
      }
      if (!expectedStatus(decision, claim.principalId).includes(row.status)) {
        throw new FleetAuthLifecycleDeniedError('principal_lifecycle_invalid');
      }
    }
  }

  private async lockAffectedPrincipals(client: PoolClient, principalIds: string[]): Promise<void> {
    if (principalIds.length === 0) return;
    const result = await client.query<{ principal_id: string; restore_state: string }>(`
      SELECT principal_id, restore_state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
      WHERE principal_id = ANY($1::uuid[])
      ORDER BY principal_id
      FOR UPDATE
    `, [[...new Set(principalIds)].sort()]);
    if (result.rows.length !== new Set(principalIds).size
      || result.rows.some(row => row.restore_state !== 'live')) {
      throw new FleetAuthLifecycleDeniedError('affected_principal_restored_or_missing');
    }
  }

  private async lockAndValidateActorSession(
    client: PoolClient,
    decision: VerifiedFleetAuthLifecycleDecision,
  ): Promise<void> {
    const result = await client.query<{
      principal_id: string;
      authn_version: string;
      authz_version: string;
      binding_version: string;
      grant_version: string;
      policy_version: string;
      global_auth_epoch: string;
      provider: string;
      provider_subject_id: string;
      provider_state: string;
      provider_restore_state: string;
      revoked_at: Date | null;
      replaced_by: string | null;
    }>(`
      SELECT session.principal_id, session.authn_version, session.authz_version,
             session.binding_version, session.grant_version, session.policy_version,
             session.global_auth_epoch, session.provider, session.provider_subject_id,
             subject.state AS provider_state,
             subject.restore_state AS provider_restore_state,
             session.revoked_at, session.replaced_by
      FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions AS session
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS subject
        ON subject.provider = session.provider
       AND subject.subject_id = session.provider_subject_id
       AND subject.principal_id = session.principal_id
      WHERE session.record_id = $1
        AND session.principal_id = $2
        AND session.idle_expires_at > clock_timestamp()
        AND session.absolute_expires_at > clock_timestamp()
      FOR UPDATE OF session, subject
    `, [decision.actorSession.sessionId, decision.actor.principalId]);
    if (result.rowCount !== 1) {
      throw new FleetAuthLifecycleDeniedError('actor_session_stale_or_invalid');
    }
    const row = result.rows[0];
    const session = decision.actorSession;
    if (row.revoked_at !== null
      || row.replaced_by !== null
      || row.provider_state !== 'active'
      || row.provider_restore_state !== 'live'
      || row.authn_version !== String(session.authnVersion)
      || row.authz_version !== String(session.authzVersion)
      || row.binding_version !== String(session.bindingVersion)
      || row.grant_version !== String(session.grantVersion)
      || row.policy_version !== String(session.policyVersion)
      || row.global_auth_epoch !== String(session.globalAuthEpoch)
      || row.provider !== session.provider
      || row.provider_subject_id !== session.providerSubjectId) {
      throw new FleetAuthLifecycleDeniedError('actor_session_stale_or_invalid');
    }
  }

  private async bumpPrincipalAuthority(
    client: PoolClient,
    versionBumps: ReadonlyMap<string, LifecycleVersionBump>,
    authorityGeneration: number,
    at: Date,
  ): Promise<void> {
    for (const [principalId, bump] of [...versionBumps].sort(([left], [right]) => (
      left.localeCompare(right)
    ))) {
      const result = await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals
        SET authn_version = authn_version + $2::integer,
            authz_version = authz_version + $3::integer,
            binding_version = binding_version + $4::integer,
            grant_version = grant_version + $5::integer,
            policy_version = policy_version + $6::integer,
            authority_generation = $7,
            updated_at = $8
        WHERE principal_id = $1 AND restore_state = 'live'
      `, [
        principalId,
        bump.authn ? 1 : 0,
        bump.authz ? 1 : 0,
        bump.binding ? 1 : 0,
        bump.grant ? 1 : 0,
        bump.policy ? 1 : 0,
        authorityGeneration,
        at,
      ]);
      if (result.rowCount !== 1) {
        throw new FleetAuthLifecycleDeniedError('principal_bump_failed');
      }
    }
  }

  private async fenceEphemeralAuthority(
    client: PoolClient,
    principalIds: string[],
    at: Date,
  ): Promise<void> {
    const unique = [...new Set(principalIds)];
    if (unique.length === 0) return;
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
      SET revoked_at = COALESCE(revoked_at, $2)
      WHERE principal_id = ANY($1::uuid[])
    `, [unique, at]);
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.jit_authorization_grants
      SET revoked_at = COALESCE(revoked_at, $2)
      WHERE principal_id = ANY($1::uuid[])
    `, [unique, at]);
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
      SET status = CASE WHEN status = 'pending' THEN 'revoked' ELSE status END
      WHERE principal_id = ANY($1::uuid[])
    `, [unique]);
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.provider_token_custody
      SET revoked_at = COALESCE(revoked_at, $2)
      WHERE principal_id = ANY($1::uuid[])
    `, [unique, at]);
    await client.query(`
      DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots
      WHERE principal_id = ANY($1::uuid[])
    `, [unique]);
    await client.query(`
      DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences
      WHERE principal_id = ANY($1::uuid[])
    `, [unique]);
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
      SET status = 'revoked'
      WHERE status = 'pending'
    `);
  }

  private async readClaim(client: PoolClient, principalId: string): Promise<PrincipalAuthorityClaim> {
    const result = await client.query<PrincipalRow>(`
      SELECT principal_id, status, authn_version, authz_version,
             binding_version, grant_version, policy_version, restore_state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
      WHERE principal_id = $1
    `, [principalId]);
    if (result.rowCount !== 1) {
      throw new Error('Fleet auth lifecycle result target is missing');
    }
    const row = result.rows[0];
    return {
      principalId: row.principal_id,
      authnVersion: integer(row.authn_version, 'authn_version'),
      authzVersion: integer(row.authz_version, 'authz_version'),
      bindingVersion: integer(row.binding_version, 'binding_version'),
      grantVersion: integer(row.grant_version, 'grant_version'),
      policyVersion: integer(row.policy_version, 'policy_version'),
    };
  }

  private async insertAudit(
    client: PoolClient,
    decision: VerifiedFleetAuthLifecycleDecision,
    outcome: 'allow' | 'deny',
    reasonCode: string,
    authority: { authorityGeneration: number; globalAuthEpoch: number },
  ): Promise<void> {
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        (event_id, actor_context, action, resource, decision, reason_code,
         companion_id, principal_id, authority_generation, global_auth_epoch,
         correlation_id, occurred_at, decision_id, ceremony_id, reason_digest,
         decision_context)
      VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16::jsonb)
      ON CONFLICT (decision_id) WHERE decision_id IS NOT NULL DO NOTHING
    `, [
      randomUUID(),
      JSON.stringify({ kind: 'principal', idDigest: digest(decision.actor.principalId) }),
      decision.action,
      `lifecycle:${decision.action}`,
      outcome,
      reasonCode,
      'companionId' in decision ? decision.companionId : null,
      decision.target.principalId,
      authority.authorityGeneration,
      authority.globalAuthEpoch,
      decision.decisionId,
      decision.decidedAt,
      decision.decisionId,
      decision.ceremonyId,
      decision.reasonDigest,
      JSON.stringify(redactedContext(decision)),
    ]);
  }

  private async persistDenial(
    decision: VerifiedFleetAuthLifecycleDecision,
    reasonCode: string,
  ): Promise<void> {
    const result = await this.pool.query<AuthorityRow>(`
      SELECT authority_generation, global_auth_epoch
      FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
      WHERE singleton = TRUE
    `);
    if (result.rowCount !== 1) {
      throw new Error('fleet_auth authority_state singleton is missing during denial audit');
    }
    const authority = result.rows[0];
    const client = await this.pool.connect();
    try {
      await this.insertAudit(client, decision, 'deny', reasonCode, {
        authorityGeneration: integer(authority.authority_generation, 'authority_generation'),
        globalAuthEpoch: integer(authority.global_auth_epoch, 'global_auth_epoch'),
      });
    } finally {
      client.release();
    }
  }
}
