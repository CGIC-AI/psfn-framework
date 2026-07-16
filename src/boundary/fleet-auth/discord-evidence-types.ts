import { createHash } from 'node:crypto';
import { isRecord } from '../../shared/utils/types.js';

export type DiscordEvidenceFailureReason =
  | 'bot_absent'
  | 'incomplete_observation'
  | 'member_specific_deny'
  | 'membership_removed'
  | 'missing_private_thread_access'
  | 'provider_unavailable'
  | 'required_role_missing'
  | 'stale_observation'
  | 'view_channel_denied';

export interface DiscordEvidenceTarget {
  guildId: string;
  channelId?: string;
}

export interface DiscordEvidenceObservationPort {
  observe(input: {
    providerSubjectId: string;
    companionId: string;
    targets: readonly DiscordEvidenceTarget[];
  }): Promise<unknown>;
}

export interface DiscordCompanionEvidenceObserverPort {
  observeDiscordEvidence(input: {
    providerSubjectId: string;
    targets: readonly DiscordEvidenceTarget[];
  }): Promise<unknown>;
}

export type DiscordEvidenceAuthorityChange =
  | { kind: 'ready' }
  | { kind: 'guild'; guildId: string }
  | { kind: 'member'; guildId: string; providerSubjectId: string }
  | { kind: 'channel'; guildId: string; channelId: string };

export interface DiscordEvidenceLifecycleEventSourcePort {
  subscribeDiscordEvidenceLifecycle(
    listener: (event: DiscordEvidenceAuthorityChange) => void,
  ): () => void;
}

export interface DiscordEvidenceProvenance {
  source: 'discord_oauth_and_bot_observation';
  provider: 'discord';
  providerSubjectId: string;
  observationStatus: 'observed' | 'provider_unavailable' | 'bot_absent' | 'invalid';
  observedAt?: string;
  oauthObservedAt?: string;
  observationId?: string;
  botUserId?: string;
}

export interface DiscordEvidenceSnapshot {
  evidenceId: string;
  principalId: string;
  provider: 'discord';
  providerSubjectId: string;
  companionId: string;
  guildId: string;
  channelId?: string;
  threadId?: string;
  permissionInputs: Record<string, unknown>;
  discordPermissionResult: boolean;
  memberSpecificDenyVeto: boolean;
  psfnEvidenceResult: boolean;
  decisionReason?: DiscordEvidenceFailureReason;
  inputDigest: string;
  configDigest: string;
  mappingConfigVersion: number;
  provenance: DiscordEvidenceProvenance;
  fetchedAt: Date;
  expiresAt: Date;
}

export interface DiscordEvidenceLifecycleMutation {
  lifecycleId: string;
  generation: number;
}

export interface DiscordPositiveEvidenceLookup {
  principalId: string;
  providerSubjectId: string;
  companionId: string;
  guildId: string;
  channelId?: string;
  threadId?: string;
  expectedInputDigest: string;
  expectedConfigDigest: string;
  expectedMappingConfigVersion: number;
  now: Date;
}

export interface DiscordEvidenceStorePort {
  activatePrincipalEvidenceLifecycle(input: {
    principalId: string;
    providerSubjectId: string;
    lifecycleId: string;
  }): Promise<void>;
  replacePrincipalEvidence(input: {
    principalId: string;
    providerSubjectId: string;
    mutation: DiscordEvidenceLifecycleMutation;
    snapshots: readonly DiscordEvidenceSnapshot[];
  }): Promise<void>;
  replaceCompanionEvidence(input: {
    principalId: string;
    providerSubjectId: string;
    companionId: string;
    mutation: DiscordEvidenceLifecycleMutation;
    snapshots: readonly DiscordEvidenceSnapshot[];
  }): Promise<void>;
  invalidatePrincipalEvidence(input: {
    principalId: string;
    providerSubjectId: string;
    companionId?: string;
    mutation: DiscordEvidenceLifecycleMutation;
  }): Promise<void>;
  revokePrincipalEvidence(input: {
    principalId: string;
    providerSubjectId: string;
    mutation: DiscordEvidenceLifecycleMutation;
  }): Promise<void>;
  revokeAllEvidence(): Promise<void>;
  loadUsablePositiveEvidence(
    input: DiscordPositiveEvidenceLookup,
  ): Promise<DiscordEvidenceSnapshot | undefined>;
}

export function isUsablePositiveDiscordEvidence(
  snapshot: DiscordEvidenceSnapshot,
  expected: DiscordPositiveEvidenceLookup,
): boolean {
  return snapshot.principalId === expected.principalId
    && snapshot.providerSubjectId === expected.providerSubjectId
    && snapshot.companionId === expected.companionId
    && snapshot.guildId === expected.guildId
    && snapshot.channelId === expected.channelId
    && snapshot.threadId === expected.threadId
    && snapshot.inputDigest === expected.expectedInputDigest
    && snapshot.configDigest === expected.expectedConfigDigest
    && snapshot.mappingConfigVersion === expected.expectedMappingConfigVersion
    && snapshot.discordPermissionResult
    && !snapshot.memberSpecificDenyVeto
    && snapshot.psfnEvidenceResult
    && snapshot.decisionReason === undefined
    && snapshot.expiresAt.getTime() > expected.now.getTime();
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Evidence digest input contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
    );
  }
  throw new Error('Evidence digest input is not canonical JSON');
}

export function digestDiscordEvidence(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}
