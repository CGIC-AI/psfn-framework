import type { Pool, PoolClient } from 'pg';
import type {
  DiscordEvidenceLifecycleMutation,
  DiscordEvidenceLifecycleMutationOutcome,
  DiscordEvidenceSnapshot,
  DiscordEvidenceStorePort,
  DiscordPositiveEvidenceLookup,
} from '../../../boundary/fleet-auth/discord-evidence-types.js';
import {
  isCanonicalIsoTimestamp,
  isRecord,
  isRfc4122Uuid,
} from '../../../shared/utils/types.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import {
  assertDiscordEvidenceLifecycleMutation,
  parseDiscordEvidenceLifecycleGeneration,
} from './discord-evidence-mutation.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';
import { fleetAuthPersistenceBoundaryValues } from './boundary-values-port.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

interface EvidenceRow {
  evidence_id: string;
  principal_id: string;
  provider_subject_id: string;
  companion_id: string;
  guild_id: string;
  channel_id: string | null;
  thread_id: string | null;
  permission_inputs: unknown;
  discord_permission_result: boolean;
  member_specific_deny_veto: boolean;
  psfn_evidence_result: boolean;
  decision_reason: DiscordEvidenceSnapshot['decisionReason'] | null;
  input_digest: string;
  config_digest: string;
  mapping_config_version: string;
  provenance: unknown;
  fetched_at: Date;
  expires_at: Date;
  authority_generation: string;
}

export interface DiscordEvidenceAuthorityGenerationPort {
  sessionAuthorityGenerationIsCurrent(authorityGeneration: number): boolean;
}

function mappingConfigVersion(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('Invalid fleet_auth Discord evidence mapping_config_version');
  }
  return parsed;
}

function assertSnapshot(
  snapshot: DiscordEvidenceSnapshot,
  principalId: string,
  providerSubjectId: string,
): void {
  const provider: string = snapshot.provider;
  if (snapshot.principalId !== principalId || snapshot.providerSubjectId !== providerSubjectId
    || provider !== 'discord') {
    throw new Error('Discord evidence snapshot authority binding mismatch');
  }
  if (!SHA256_PATTERN.test(snapshot.inputDigest) || !SHA256_PATTERN.test(snapshot.configDigest)) {
    throw new Error('Discord evidence snapshot contains an invalid digest');
  }
  if (snapshot.inputDigest
    !== fleetAuthPersistenceBoundaryValues.digestDiscordEvidence(snapshot.permissionInputs)) {
    throw new Error('Discord evidence snapshot input digest does not match its permission inputs');
  }
  if (!Number.isSafeInteger(snapshot.mappingConfigVersion) || snapshot.mappingConfigVersion < 1) {
    throw new Error('Discord evidence snapshot contains an invalid mapping config version');
  }
  if (snapshot.expiresAt.getTime() <= snapshot.fetchedAt.getTime()) {
    throw new Error('Discord evidence snapshot expiry must be after fetch time');
  }
  if (snapshot.psfnEvidenceResult
    && (!snapshot.discordPermissionResult
      || snapshot.memberSpecificDenyVeto
      || snapshot.decisionReason !== undefined)) {
    throw new Error('Positive fleet authorization evidence conflicts with Discord permission evidence');
  }
  if (!snapshot.psfnEvidenceResult && snapshot.decisionReason === undefined) {
    throw new Error('Denied fleet authorization evidence must record a decision reason');
  }
  const provenance = parseProvenance(snapshot.provenance);
  if (provenance.providerSubjectId !== providerSubjectId
    || (snapshot.psfnEvidenceResult
      && (provenance.observationStatus !== 'observed'
        || !provenance.observedAt
        || !provenance.oauthObservedAt
        || !provenance.observationId
        || !provenance.botUserId))) {
    throw new Error('Discord evidence snapshot provenance is incomplete or misbound');
  }
}

function parseProvenance(value: unknown): DiscordEvidenceSnapshot['provenance'] {
  if (!isRecord(value)
    || value.source !== 'discord_oauth_and_bot_observation'
    || value.provider !== 'discord'
    || typeof value.providerSubjectId !== 'string'
    || (value.observationStatus !== 'observed'
      && value.observationStatus !== 'provider_unavailable'
      && value.observationStatus !== 'bot_absent'
      && value.observationStatus !== 'invalid')
    || (value.observedAt !== undefined && !isCanonicalIsoTimestamp(value.observedAt))
    || (value.oauthObservedAt !== undefined && !isCanonicalIsoTimestamp(value.oauthObservedAt))
    || (value.observationId !== undefined && typeof value.observationId !== 'string')
    || (value.botUserId !== undefined && typeof value.botUserId !== 'string')) {
    throw new Error('Invalid fleet_auth Discord evidence provenance projection');
  }
  if (value.observationStatus === 'observed'
    && (!isCanonicalIsoTimestamp(value.observedAt)
      || !isCanonicalIsoTimestamp(value.oauthObservedAt)
      || typeof value.observationId !== 'string'
      || typeof value.botUserId !== 'string')) {
    throw new Error('Observed fleet_auth Discord evidence provenance is incomplete');
  }
  return {
    source: value.source,
    provider: value.provider,
    providerSubjectId: value.providerSubjectId,
    observationStatus: value.observationStatus,
    ...(typeof value.observedAt === 'string' ? { observedAt: value.observedAt } : {}),
    ...(typeof value.oauthObservedAt === 'string' ? { oauthObservedAt: value.oauthObservedAt } : {}),
    ...(typeof value.observationId === 'string' ? { observationId: value.observationId } : {}),
    ...(typeof value.botUserId === 'string' ? { botUserId: value.botUserId } : {}),
  };
}

function rowToSnapshot(row: EvidenceRow): DiscordEvidenceSnapshot {
  if (!isRecord(row.permission_inputs)) {
    throw new Error('Invalid fleet_auth Discord evidence JSON projection');
  }
  return {
    evidenceId: row.evidence_id,
    principalId: row.principal_id,
    provider: 'discord',
    providerSubjectId: row.provider_subject_id,
    companionId: row.companion_id,
    guildId: row.guild_id,
    ...(row.channel_id ? { channelId: row.channel_id } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    permissionInputs: row.permission_inputs,
    discordPermissionResult: row.discord_permission_result,
    memberSpecificDenyVeto: row.member_specific_deny_veto,
    psfnEvidenceResult: row.psfn_evidence_result,
    ...(row.decision_reason ? { decisionReason: row.decision_reason } : {}),
    inputDigest: row.input_digest,
    configDigest: row.config_digest,
    mappingConfigVersion: mappingConfigVersion(row.mapping_config_version),
    provenance: parseProvenance(row.provenance),
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
  };
}

export class PostgresDiscordEvidenceStore implements DiscordEvidenceStorePort {
  constructor(
    private readonly pool: Pool,
    private readonly authorityGeneration: DiscordEvidenceAuthorityGenerationPort,
  ) {}

  async activatePrincipalEvidenceLifecycle(input: {
    principalId: string;
    providerSubjectId: string;
    lifecycleId: string;
  }): Promise<void> {
    if (!isRfc4122Uuid(input.lifecycleId)) {
      throw new Error('Invalid Discord evidence lifecycle identity');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockSubjectAuthority(
        client,
        input.principalId,
        input.providerSubjectId,
      );
      if (!authority.eligible) {
        throw new Error('Discord evidence principal/provider binding is not active and live');
      }
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences
          (principal_id, provider, provider_subject_id, lifecycle_id, state,
           mutation_generation, global_auth_epoch, updated_at)
        VALUES ($1, 'discord', $2, $3, 'active', 0, $4, clock_timestamp())
        ON CONFLICT (principal_id, provider, provider_subject_id) DO UPDATE
        SET lifecycle_id = EXCLUDED.lifecycle_id,
            state = 'active',
            mutation_generation = 0,
            global_auth_epoch = EXCLUDED.global_auth_epoch,
            updated_at = clock_timestamp()
      `, [input.principalId, input.providerSubjectId, input.lifecycleId, authority.globalAuthEpoch]);
      await this.deleteEvidence(client, input);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async replacePrincipalEvidence(input: {
    principalId: string;
    providerSubjectId: string;
    mutation: DiscordEvidenceLifecycleMutation;
    snapshots: readonly DiscordEvidenceSnapshot[];
  }): Promise<DiscordEvidenceLifecycleMutationOutcome> {
    return await this.replaceEvidence(input);
  }

  async replaceCompanionEvidence(input: {
    principalId: string;
    providerSubjectId: string;
    companionId: string;
    mutation: DiscordEvidenceLifecycleMutation;
    snapshots: readonly DiscordEvidenceSnapshot[];
  }): Promise<DiscordEvidenceLifecycleMutationOutcome> {
    if (input.snapshots.some(snapshot => snapshot.companionId !== input.companionId)) {
      throw new Error('Discord evidence companion replacement is cross-boundary');
    }
    return await this.replaceEvidence(input);
  }

  async invalidatePrincipalEvidence(input: {
    principalId: string;
    providerSubjectId: string;
    companionId?: string;
    mutation: DiscordEvidenceLifecycleMutation;
  }): Promise<DiscordEvidenceLifecycleMutationOutcome> {
    return await this.mutateAndDelete(input, false);
  }

  async revokePrincipalEvidence(input: {
    principalId: string;
    providerSubjectId: string;
    mutation: DiscordEvidenceLifecycleMutation;
  }): Promise<DiscordEvidenceLifecycleMutationOutcome> {
    return await this.mutateAndDelete(input, true);
  }

  async revokeAllEvidence(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockAuthorityState(client);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences
        SET state = 'revoked', mutation_generation = mutation_generation + 1,
            updated_at = clock_timestamp()
        WHERE state = 'active'
      `);
      await client.query(`DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async replaceEvidence(input: {
    principalId: string;
    providerSubjectId: string;
    companionId?: string;
    mutation: DiscordEvidenceLifecycleMutation;
    snapshots: readonly DiscordEvidenceSnapshot[];
  }): Promise<DiscordEvidenceLifecycleMutationOutcome> {
    assertDiscordEvidenceLifecycleMutation(input.mutation);
    for (const snapshot of input.snapshots) {
      assertSnapshot(snapshot, input.principalId, input.providerSubjectId);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.claimMutation(
        client,
        input,
        false,
      );
      if (authority.status === 'retired') {
        await client.query('COMMIT');
        return authority;
      }
      await this.deleteEvidence(client, input);
      for (const snapshot of input.snapshots) {
        await client.query(`
          INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots
            (evidence_id, principal_id, provider, provider_subject_id, companion_id,
             guild_id, channel_id, thread_id, permission_inputs,
             discord_permission_result, member_specific_deny_veto, psfn_evidence_result,
             decision_reason, input_digest, config_digest, mapping_config_version,
             provenance, global_auth_epoch, fetched_at, expires_at)
          VALUES ($1, $2, 'discord', $3, $4, $5, $6, $7, $8::jsonb,
                  $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19)
        `, [
          snapshot.evidenceId,
          snapshot.principalId,
          snapshot.providerSubjectId,
          snapshot.companionId,
          snapshot.guildId,
          snapshot.channelId ?? null,
          snapshot.threadId ?? null,
          JSON.stringify(snapshot.permissionInputs),
          snapshot.discordPermissionResult,
          snapshot.memberSpecificDenyVeto,
          snapshot.psfnEvidenceResult,
          snapshot.decisionReason ?? null,
          snapshot.inputDigest,
          snapshot.configDigest,
          snapshot.mappingConfigVersion,
          JSON.stringify(snapshot.provenance),
          authority.globalAuthEpoch,
          snapshot.fetchedAt,
          snapshot.expiresAt,
        ]);
      }
      await client.query('COMMIT');
      return fleetAuthPersistenceBoundaryValues.DISCORD_EVIDENCE_MUTATION_APPLIED;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async mutateAndDelete(input: {
    principalId: string;
    providerSubjectId: string;
    companionId?: string;
    mutation: DiscordEvidenceLifecycleMutation;
  }, terminal: boolean): Promise<DiscordEvidenceLifecycleMutationOutcome> {
    assertDiscordEvidenceLifecycleMutation(input.mutation);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const outcome = await this.claimMutation(client, input, terminal);
      if (outcome.status === 'retired') {
        await client.query('COMMIT');
        return outcome;
      }
      await this.deleteEvidence(client, input);
      await client.query('COMMIT');
      return fleetAuthPersistenceBoundaryValues.DISCORD_EVIDENCE_MUTATION_APPLIED;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async deleteEvidence(
    client: PoolClient,
    input: { principalId: string; providerSubjectId: string; companionId?: string },
  ): Promise<void> {
    await client.query(`
      DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots
      WHERE principal_id = $1 AND provider = 'discord' AND provider_subject_id = $2
        AND ($3::uuid IS NULL OR companion_id = $3)
    `, [input.principalId, input.providerSubjectId, input.companionId ?? null]);
  }

  private async claimMutation(
    client: PoolClient,
    input: {
      principalId: string;
      providerSubjectId: string;
      mutation: DiscordEvidenceLifecycleMutation;
    },
    terminal: boolean,
  ): Promise<
    | { status: 'applied'; globalAuthEpoch: number }
    | Extract<DiscordEvidenceLifecycleMutationOutcome, { status: 'retired' }>
  > {
    const authority = await this.lockSubjectAuthority(
      client,
      input.principalId,
      input.providerSubjectId,
    );
    if (!authority.eligible) {
      return fleetAuthPersistenceBoundaryValues.DISCORD_EVIDENCE_MUTATION_RETIRED;
    }
    const fence = await client.query<{
      lifecycle_id: string;
      state: string;
      mutation_generation: string;
      global_auth_epoch: string;
    }>(`
      SELECT lifecycle_id, state, mutation_generation, global_auth_epoch
      FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences
      WHERE principal_id = $1 AND provider = 'discord' AND provider_subject_id = $2
      FOR UPDATE
    `, [input.principalId, input.providerSubjectId]);
    const current = fence.rows.at(0);
    if (!current
      || current.lifecycle_id !== input.mutation.lifecycleId
      || current.state !== 'active'
      || parseDiscordEvidenceLifecycleGeneration(current.mutation_generation)
        >= input.mutation.generation
      || Number(current.global_auth_epoch) !== authority.globalAuthEpoch) {
      return fleetAuthPersistenceBoundaryValues.DISCORD_EVIDENCE_MUTATION_RETIRED;
    }
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences
      SET state = $4, mutation_generation = $3, updated_at = clock_timestamp()
      WHERE principal_id = $1 AND provider = 'discord' AND provider_subject_id = $2
    `, [
      input.principalId,
      input.providerSubjectId,
      input.mutation.generation,
      terminal ? 'revoked' : 'active',
    ]);
    return { status: 'applied', globalAuthEpoch: authority.globalAuthEpoch };
  }

  async loadUsablePositiveEvidence(
    input: DiscordPositiveEvidenceLookup,
  ): Promise<DiscordEvidenceSnapshot | undefined> {
    const result = await this.pool.query<EvidenceRow>(`
      SELECT evidence.evidence_id, evidence.principal_id, evidence.provider_subject_id,
             evidence.companion_id, evidence.guild_id, evidence.channel_id,
             evidence.thread_id, evidence.permission_inputs,
             evidence.discord_permission_result, evidence.member_specific_deny_veto,
             evidence.psfn_evidence_result, evidence.decision_reason,
             evidence.input_digest, evidence.config_digest,
             evidence.mapping_config_version, evidence.provenance,
             evidence.fetched_at, evidence.expires_at,
             authority.authority_generation
      FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots AS evidence
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.human_principals AS principal
        ON principal.principal_id = evidence.principal_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS subject
        ON subject.provider = evidence.provider
       AND subject.subject_id = evidence.provider_subject_id
       AND subject.principal_id = evidence.principal_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences AS fence
        ON fence.principal_id = evidence.principal_id
       AND fence.provider = evidence.provider
       AND fence.provider_subject_id = evidence.provider_subject_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.authority_state AS authority
        ON authority.singleton = TRUE
      WHERE evidence.principal_id = $1
        AND evidence.provider = 'discord'
        AND evidence.provider_subject_id = $2
        AND evidence.companion_id = $3
        AND evidence.guild_id = $4
        AND evidence.channel_id IS NOT DISTINCT FROM $5
        AND evidence.thread_id IS NOT DISTINCT FROM $6
        AND evidence.input_digest = $7
        AND evidence.config_digest = $8
        AND evidence.mapping_config_version = $9
        AND evidence.psfn_evidence_result = TRUE
        AND evidence.discord_permission_result = TRUE
        AND evidence.member_specific_deny_veto = FALSE
        AND evidence.decision_reason IS NULL
        AND evidence.expires_at > $10
        AND evidence.global_auth_epoch = authority.global_auth_epoch
        AND fence.state = 'active'
        AND fence.global_auth_epoch = authority.global_auth_epoch
        AND principal.status = 'active'
        AND principal.restore_state = 'live'
        AND subject.state = 'active'
        AND subject.restore_state = 'live'
      ORDER BY evidence.fetched_at DESC, evidence.evidence_id
      LIMIT 1
    `, [
      input.principalId,
      input.providerSubjectId,
      input.companionId,
      input.guildId,
      input.channelId ?? null,
      input.threadId ?? null,
      input.expectedInputDigest,
      input.expectedConfigDigest,
      input.expectedMappingConfigVersion,
      input.now,
    ]);
    const row = result.rows.at(0);
    if (!row) return undefined;
    if (!this.authorityGeneration.sessionAuthorityGenerationIsCurrent(
      mappingConfigVersion(row.authority_generation),
    )) return undefined;
    const snapshot = rowToSnapshot(row);
    return fleetAuthPersistenceBoundaryValues.isUsablePositiveDiscordEvidence(snapshot, input)
      ? snapshot
      : undefined;
  }

  private async lockSubjectAuthority(
    client: PoolClient,
    principalId: string,
    providerSubjectId: string,
  ): Promise<{ globalAuthEpoch: number; eligible: boolean }> {
    const globalAuthEpoch = await this.lockAuthorityState(client);
    const subject = await client.query<{ eligible: boolean }>(`
      SELECT (
        principal.status = 'active'
        AND principal.restore_state = 'live'
        AND subject.state = 'active'
        AND subject.restore_state = 'live'
      ) AS eligible
      FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS subject
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.human_principals AS principal
        ON principal.principal_id = subject.principal_id
      WHERE subject.provider = 'discord'
        AND subject.subject_id = $1
        AND subject.principal_id = $2
      FOR UPDATE OF subject, principal
    `, [providerSubjectId, principalId]);
    const row = subject.rows.at(0);
    if (!row) throw new Error('Discord evidence principal/provider binding does not exist');
    return { globalAuthEpoch, eligible: row.eligible };
  }

  private async lockAuthorityState(client: PoolClient): Promise<number> {
    const authority = await client.query<{ global_auth_epoch: string }>(`
      SELECT global_auth_epoch
      FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()
    `);
    const epoch = Number(authority.rows.at(0)?.global_auth_epoch);
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      throw new Error('fleet_auth authority_state singleton is missing or invalid');
    }
    return epoch;
  }
}
