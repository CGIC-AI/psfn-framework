import type { Pool, PoolClient } from 'pg';
import type {
  DiscordEvidenceSnapshot,
  DiscordEvidenceStorePort,
  DiscordPositiveEvidenceLookup,
} from '../../../boundary/fleet-auth/discord-evidence-types.js';
import { isUsablePositiveDiscordEvidence } from '../../../boundary/fleet-auth/discord-evidence-types.js';
import { digestDiscordEvidence } from '../../../boundary/fleet-auth/discord-evidence-types.js';
import { isCanonicalIsoTimestamp, isRecord } from '../../../shared/utils/types.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

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
  if (snapshot.inputDigest !== digestDiscordEvidence(snapshot.permissionInputs)) {
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
    throw new Error('Positive PSFN evidence is inconsistent with Discord permission evidence');
  }
  if (!snapshot.psfnEvidenceResult && snapshot.decisionReason === undefined) {
    throw new Error('Denied PSFN evidence must record a decision reason');
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

  async replacePrincipalEvidence(input: {
    principalId: string;
    providerSubjectId: string;
    snapshots: readonly DiscordEvidenceSnapshot[];
  }): Promise<void> {
    for (const snapshot of input.snapshots) {
      assertSnapshot(snapshot, input.principalId, input.providerSubjectId);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const globalAuthEpoch = await this.lockActiveSubject(
        client,
        input.principalId,
        input.providerSubjectId,
      );
      await client.query(`
        DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots
        WHERE principal_id = $1 AND provider = 'discord' AND provider_subject_id = $2
      `, [input.principalId, input.providerSubjectId]);
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
          globalAuthEpoch,
          snapshot.fetchedAt,
          snapshot.expiresAt,
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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
    return isUsablePositiveDiscordEvidence(snapshot, input) ? snapshot : undefined;
  }

  private async lockActiveSubject(
    client: PoolClient,
    principalId: string,
    providerSubjectId: string,
  ): Promise<number> {
    const authority = await client.query<{ global_auth_epoch: string }>(`
      SELECT global_auth_epoch
      FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()
    `);
    const epoch = Number(authority.rows.at(0)?.global_auth_epoch);
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      throw new Error('fleet_auth authority_state singleton is missing or invalid');
    }
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
    if (subject.rows.at(0)?.eligible !== true) {
      throw new Error('Discord evidence principal/provider binding is not active and live');
    }
    return epoch;
  }
}
