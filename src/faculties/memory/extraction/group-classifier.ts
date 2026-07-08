import type { SessionEntry } from '../../../core/session/types.js';
import type { Contact } from '../../../core/contacts/types.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import {
  cloneGroupMemorySettings,
  createDefaultChannelGroupMemoryConfig,
  createDefaultGroupMemorySettings,
  mergeGroupMemorySettingsPatch,
  type ChannelGroupMemoryConfig,
  type GroupMemorySettingsPatch,
  type GroupMemoryMode,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { ChannelType } from '../../../shared/contracts/runtime.js';
import { isRecord } from '../../../shared/utils/types.js';

export type GroupMemoryClassificationMode =
  | 'direct'
  | 'group'
  | 'group_capable_direct_tail';

export type GroupMemoryModeSource =
  | 'settings'
  | 'provider'
  | 'channel';

export type GroupMemoryTopologyKind =
  | 'direct_message'
  | 'group_channel'
  | 'thread'
  | 'group_dm'
  | 'unknown';

export type GroupMemoryTopologySource =
  | 'provider_metadata'
  | 'channel_visibility'
  | 'channel_type'
  | 'manual'
  | 'unknown';

export type GroupMemoryClassificationReason =
  | 'disabled'
  | 'manual_direct'
  | 'manual_group'
  | 'topology_direct'
  | 'topology_not_group_capable'
  | 'recent_participant_threshold'
  | 'group_capable_single_recent_human'
  | 'group_capable_no_recent_humans'
  | 'group_capable_fallback_group';

export interface GroupMemoryChannelTopology {
  kind?: GroupMemoryTopologyKind;
  source?: GroupMemoryTopologySource;
  channelVisibility?: ChannelPrivacy;
}

export interface GroupMemoryRecentParticipant {
  stableId: string;
  contactId?: string;
  authorId?: string;
  authorName?: string;
  entryIds: number[];
  lastSeenAt: number;
  source: 'contact' | 'channel_identity' | 'author_name';
  contactRelationshipType?: Contact['relationshipType'];
  isMachineIntelligence?: boolean;
}

export interface GroupMemoryParticipantWindow {
  requestedMessageLimit: number;
  requestedTimeWindowMs: number;
  newestTimestamp: number | null;
  cutoffTimestamp: number | null;
  scannedEntryCount: number;
  eligibleEntryCount: number;
  oldestEntryId: number | null;
  newestEntryId: number | null;
}

export interface GroupMemoryResolvedSettings {
  settings: GroupMemorySettings;
  configuredMemoryMode: GroupMemoryMode;
  configuredMemoryModeSource: GroupMemoryModeSource;
  manualOverrideSource?: GroupMemoryModeSource;
  channelOverrideApplied: boolean;
}

export interface GroupMemoryTopologyResolution {
  kind: GroupMemoryTopologyKind;
  source: GroupMemoryTopologySource;
  isDirect: boolean;
  isGroupCapable: boolean;
}

export interface GroupMemoryClassification {
  mode: GroupMemoryClassificationMode;
  reason: GroupMemoryClassificationReason;
  channelId: string;
  channelType: ChannelType;
  topology: GroupMemoryTopologyResolution;
  configuredMemoryMode: GroupMemoryMode;
  configuredMemoryModeSource: GroupMemoryModeSource;
  manualOverrideSource?: GroupMemoryModeSource;
  recentParticipantCount: number;
  recentParticipants: GroupMemoryRecentParticipant[];
  recentParticipantContactIds: string[];
  participantWindow: GroupMemoryParticipantWindow;
}

export interface GroupMemorySessionReader {
  getRecent(channelId: string, limit: number): SessionEntry[] | Promise<SessionEntry[]>;
}

export interface GroupMemoryClassifierOptions {
  channelId: string;
  channelType: ChannelType;
  groupMemory?: GroupMemorySettings;
  channelGroupMemory?: ChannelGroupMemoryConfig;
  channelTopology?: GroupMemoryChannelTopology;
  sessionReader?: GroupMemorySessionReader;
  recentEntries?: readonly SessionEntry[];
  contactStore?: Pick<ContactStorePort, 'getByChannelIdentity'>;
  companionAuthorIds?: readonly string[];
  botAuthorIds?: readonly string[];
  systemAuthorIds?: readonly string[];
  apiPrincipalAuthorIds?: readonly string[];
  nowMs?: number;
}

interface ParticipantCandidate {
  entry: SessionEntry;
  contact?: Contact;
}

interface ExclusionSets {
  companionAuthorIds: ReadonlySet<string>;
  botAuthorIds: ReadonlySet<string>;
  systemAuthorIds: ReadonlySet<string>;
  apiPrincipalAuthorIds: ReadonlySet<string>;
}

export function resolveGroupMemorySettingsForChannel(params: {
  base?: GroupMemorySettings;
  channelConfig?: ChannelGroupMemoryConfig;
  channelId: string;
}): GroupMemoryResolvedSettings {
  const base = cloneGroupMemorySettings(
    params.base ?? createDefaultGroupMemorySettings(),
  );
  const channelConfig =
    params.channelConfig ?? createDefaultChannelGroupMemoryConfig();
  let resolved = base;
  let configuredMemoryMode = base.memoryMode;
  let configuredMemoryModeSource: GroupMemoryModeSource = 'settings';
  let manualOverrideSource: GroupMemoryModeSource | undefined =
    base.memoryMode === 'auto' ? undefined : 'settings';

  if (channelConfig.memoryMode) {
    resolved = {
      ...resolved,
      memoryMode: channelConfig.memoryMode,
    };
    configuredMemoryMode = channelConfig.memoryMode;
    configuredMemoryModeSource = 'provider';
    manualOverrideSource =
      channelConfig.memoryMode === 'auto' ? undefined : 'provider';
  }

  const channelOverrides = channelConfig.channelOverrides as Partial<
    Record<string, GroupMemorySettingsPatch>
  >;
  const channelOverride = channelOverrides[params.channelId];
  const channelOverrideApplied = channelOverride !== undefined;
  if (channelOverride) {
    resolved = mergeGroupMemorySettingsPatch(resolved, channelOverride);
    if (channelOverride.memoryMode) {
      configuredMemoryMode = channelOverride.memoryMode;
      configuredMemoryModeSource = 'channel';
      manualOverrideSource =
        channelOverride.memoryMode === 'auto' ? undefined : 'channel';
    }
  }

  return {
    settings: resolved,
    configuredMemoryMode,
    configuredMemoryModeSource,
    ...(manualOverrideSource ? { manualOverrideSource } : {}),
    channelOverrideApplied,
  };
}

export async function classifyGroupMemoryChannel(
  options: GroupMemoryClassifierOptions,
): Promise<GroupMemoryClassification> {
  const resolvedSettings = resolveGroupMemorySettingsForChannel({
    base: options.groupMemory,
    channelConfig: options.channelGroupMemory,
    channelId: options.channelId,
  });
  const settings = resolvedSettings.settings;
  const topology = resolveGroupMemoryTopology({
    channelType: options.channelType,
    configuredMode: settings.memoryMode,
    settings,
    topology: options.channelTopology,
  });
  const recentEntries = await readRecentEntries(options, settings);
  const participants = await collectRecentParticipants({
    entries: recentEntries,
    channelType: options.channelType,
    channelId: options.channelId,
    settings,
    contactStore: options.contactStore,
    exclusionSets: buildExclusionSets(options),
    nowMs: options.nowMs,
  });
  const resultBase = {
    channelId: options.channelId,
    channelType: options.channelType,
    topology,
    configuredMemoryMode: resolvedSettings.configuredMemoryMode,
    configuredMemoryModeSource: resolvedSettings.configuredMemoryModeSource,
    ...(resolvedSettings.manualOverrideSource
      ? { manualOverrideSource: resolvedSettings.manualOverrideSource }
      : {}),
    recentParticipantCount: participants.participants.length,
    recentParticipants: participants.participants,
    recentParticipantContactIds: participants.participants
      .map(participant => participant.contactId)
      .filter((contactId): contactId is string => Boolean(contactId)),
    participantWindow: participants.window,
  };

  if (!settings.enabled) {
    return {
      ...resultBase,
      mode: 'direct',
      reason: 'disabled',
    };
  }

  if (settings.memoryMode === 'direct') {
    return {
      ...resultBase,
      mode: 'direct',
      reason: 'manual_direct',
    };
  }
  if (settings.memoryMode === 'group') {
    return {
      ...resultBase,
      mode: 'group',
      reason: 'manual_group',
    };
  }

  if (topology.isDirect) {
    return {
      ...resultBase,
      mode: 'direct',
      reason: 'topology_direct',
    };
  }
  if (!topology.isGroupCapable) {
    return {
      ...resultBase,
      mode: 'direct',
      reason: 'topology_not_group_capable',
    };
  }

  if (
    participants.participants.length
    >= settings.autoDetection.minDistinctHumanContacts
  ) {
    return {
      ...resultBase,
      mode: 'group',
      reason: 'recent_participant_threshold',
    };
  }

  if (settings.autoDetection.fallbackModeWhenOneHuman === 'group') {
    return {
      ...resultBase,
      mode: 'group',
      reason: 'group_capable_fallback_group',
    };
  }

  return {
    ...resultBase,
    mode: 'group_capable_direct_tail',
    reason: participants.participants.length === 0
      ? 'group_capable_no_recent_humans'
      : 'group_capable_single_recent_human',
  };
}

function resolveGroupMemoryTopology(params: {
  channelType: ChannelType;
  configuredMode: GroupMemoryMode;
  settings: GroupMemorySettings;
  topology?: GroupMemoryChannelTopology;
}): GroupMemoryTopologyResolution {
  if (params.configuredMode === 'direct') {
    return {
      kind: params.topology?.kind ?? 'direct_message',
      source: 'manual',
      isDirect: true,
      isGroupCapable: false,
    };
  }
  if (params.configuredMode === 'group') {
    return {
      kind: params.topology?.kind ?? 'group_channel',
      source: 'manual',
      isDirect: false,
      isGroupCapable: true,
    };
  }

  const explicitKind = params.topology?.kind;
  if (explicitKind) {
    return topologyResolutionFromKind(
      explicitKind,
      params.topology?.source ?? 'provider_metadata',
    );
  }

  if (params.topology?.channelVisibility === 'private') {
    return {
      kind: 'direct_message',
      source: 'channel_visibility',
      isDirect: true,
      isGroupCapable: false,
    };
  }

  if (
    params.settings.autoDetection.groupCapableChannelTypes
      .includes(params.channelType)
  ) {
    return {
      kind: 'unknown',
      source: params.topology?.channelVisibility
        ? 'channel_visibility'
        : 'channel_type',
      isDirect: false,
      isGroupCapable: true,
    };
  }

  return {
    kind: 'unknown',
    source: 'channel_type',
    isDirect: false,
    isGroupCapable: false,
  };
}

function topologyResolutionFromKind(
  kind: GroupMemoryTopologyKind,
  source: GroupMemoryTopologySource,
): GroupMemoryTopologyResolution {
  switch (kind) {
    case 'direct_message':
      return {
        kind,
        source,
        isDirect: true,
        isGroupCapable: false,
      };
    case 'group_channel':
    case 'thread':
    case 'group_dm':
      return {
        kind,
        source,
        isDirect: false,
        isGroupCapable: true,
      };
    case 'unknown':
      return {
        kind,
        source,
        isDirect: false,
        isGroupCapable: false,
      };
  }
}

async function readRecentEntries(
  options: GroupMemoryClassifierOptions,
  settings: GroupMemorySettings,
): Promise<readonly SessionEntry[]> {
  if (options.recentEntries) {
    return options.recentEntries;
  }
  if (!options.sessionReader) {
    return [];
  }
  return await options.sessionReader.getRecent(
    options.channelId,
    settings.autoDetection.recentParticipantWindowMessages,
  );
}

async function collectRecentParticipants(params: {
  entries: readonly SessionEntry[];
  channelType: ChannelType;
  channelId: string;
  settings: GroupMemorySettings;
  contactStore?: Pick<ContactStorePort, 'getByChannelIdentity'>;
  exclusionSets: ExclusionSets;
  nowMs?: number;
}): Promise<{
  participants: GroupMemoryRecentParticipant[];
  window: GroupMemoryParticipantWindow;
}> {
  const newestTimestamp = newestEntryTimestamp(params.entries);
  const windowEnd = params.nowMs ?? newestTimestamp ?? Date.now();
  const cutoffTimestamp =
    windowEnd - params.settings.autoDetection.recentParticipantWindowMs;
  const windowedEntries = params.entries.filter(entry => (
    entry.timestamp >= cutoffTimestamp
    && entry.timestamp <= windowEnd
  ));
  const candidates = await resolveParticipantCandidates({
    entries: windowedEntries,
    channelType: params.channelType,
    contactStore: params.contactStore,
  });
  const participantsByStableId = new Map<string, GroupMemoryRecentParticipant>();

  for (const candidate of candidates) {
    const exclusion = shouldExcludeParticipant(candidate, params);
    if (exclusion) continue;

    const identity = buildParticipantIdentity(
      candidate,
      params.channelType,
      params.channelId,
    );
    const existing = participantsByStableId.get(identity.stableId);
    if (existing) {
      existing.entryIds.push(candidate.entry.id);
      existing.lastSeenAt = Math.max(existing.lastSeenAt, candidate.entry.timestamp);
      if (!existing.authorName && identity.authorName) {
        existing.authorName = identity.authorName;
      }
      continue;
    }
    participantsByStableId.set(identity.stableId, identity);
  }

  const participants = [...participantsByStableId.values()]
    .sort((a, b) => a.stableId.localeCompare(b.stableId));

  return {
    participants,
    window: {
      requestedMessageLimit:
        params.settings.autoDetection.recentParticipantWindowMessages,
      requestedTimeWindowMs:
        params.settings.autoDetection.recentParticipantWindowMs,
      newestTimestamp,
      cutoffTimestamp: newestTimestamp === null ? null : cutoffTimestamp,
      scannedEntryCount: params.entries.length,
      eligibleEntryCount: windowedEntries.length,
      oldestEntryId: minEntryId(windowedEntries),
      newestEntryId: maxEntryId(windowedEntries),
    },
  };
}

async function resolveParticipantCandidates(params: {
  entries: readonly SessionEntry[];
  channelType: ChannelType;
  contactStore?: Pick<ContactStorePort, 'getByChannelIdentity'>;
}): Promise<ParticipantCandidate[]> {
  const userEntries = params.entries.filter(entry => entry.role === 'user');
  if (!params.contactStore) {
    return userEntries.map(entry => ({ entry }));
  }

  const contactsByAuthorId = new Map<string, Contact | undefined>();
  for (const entry of userEntries) {
    const authorId = normalizeOptionalText(entry.authorId);
    if (!authorId || contactsByAuthorId.has(authorId)) continue;
    contactsByAuthorId.set(
      authorId,
      await params.contactStore.getByChannelIdentity(
        params.channelType,
        authorId,
      ),
    );
  }

  return userEntries.map(entry => {
    const authorId = normalizeOptionalText(entry.authorId);
    const contact = authorId ? contactsByAuthorId.get(authorId) : undefined;
    return {
      entry,
      ...(contact ? { contact } : {}),
    };
  });
}

function shouldExcludeParticipant(
  candidate: ParticipantCandidate,
  params: {
    settings: GroupMemorySettings;
    exclusionSets: ExclusionSets;
  },
): string | null {
  const authorId = normalizeOptionalText(candidate.entry.authorId);
  const metadata = parseSessionMetadata(candidate.entry.metadata);
  if (
    params.settings.autoDetection.excludeCompanionContact
    && authorId
    && params.exclusionSets.companionAuthorIds.has(authorId)
  ) {
    return 'companion';
  }
  if (
    params.settings.autoDetection.excludeSystemContacts
    && authorId
    && params.exclusionSets.systemAuthorIds.has(authorId)
  ) {
    return 'system';
  }
  if (
    params.settings.autoDetection.excludeApiPrincipals
    && authorId
    && params.exclusionSets.apiPrincipalAuthorIds.has(authorId)
  ) {
    return 'api_principal';
  }
  if (
    params.settings.autoDetection.excludeBotContacts
    && (
      (authorId && params.exclusionSets.botAuthorIds.has(authorId))
      || metadata.authorIsBot === true
      || metadata.bot === true
    )
  ) {
    return 'bot';
  }
  if (
    !params.settings.autoDetection.includeAiCompanions
    && (
      candidate.contact?.isMachineIntelligence === true
      || candidate.contact?.relationshipType === 'ai_companion'
    )
  ) {
    return 'ai_companion';
  }
  return null;
}

function buildParticipantIdentity(
  candidate: ParticipantCandidate,
  channelType: ChannelType,
  channelId: string,
): GroupMemoryRecentParticipant {
  const authorId = normalizeOptionalText(candidate.entry.authorId);
  const authorName = normalizeOptionalText(candidate.entry.authorName);
  const contact = candidate.contact;
  if (contact) {
    return {
      stableId: `contact:${contact.id}`,
      contactId: contact.id,
      ...(authorId ? { authorId } : {}),
      ...(authorName ? { authorName } : {}),
      entryIds: [candidate.entry.id],
      lastSeenAt: candidate.entry.timestamp,
      source: 'contact',
      contactRelationshipType: contact.relationshipType,
      ...(contact.isMachineIntelligence !== undefined
        ? { isMachineIntelligence: contact.isMachineIntelligence }
        : {}),
    };
  }
  if (authorId) {
    return {
      stableId: `${channelType}:${authorId}`,
      authorId,
      ...(authorName ? { authorName } : {}),
      entryIds: [candidate.entry.id],
      lastSeenAt: candidate.entry.timestamp,
      source: 'channel_identity',
    };
  }
  return {
    stableId: `${channelId}:author_name:${authorName ?? 'unknown'}`,
    ...(authorName ? { authorName } : {}),
    entryIds: [candidate.entry.id],
    lastSeenAt: candidate.entry.timestamp,
    source: 'author_name',
  };
}

function buildExclusionSets(options: GroupMemoryClassifierOptions): ExclusionSets {
  return {
    companionAuthorIds: new Set(normalizeTextList(options.companionAuthorIds)),
    botAuthorIds: new Set(normalizeTextList(options.botAuthorIds)),
    systemAuthorIds: new Set(normalizeTextList(options.systemAuthorIds)),
    apiPrincipalAuthorIds: new Set(normalizeTextList(options.apiPrincipalAuthorIds)),
  };
}

function normalizeTextList(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map(value => value.trim())
    .filter(Boolean);
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function parseSessionMetadata(metadata: string | undefined): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function newestEntryTimestamp(entries: readonly SessionEntry[]): number | null {
  const timestamps = entries
    .map(entry => entry.timestamp)
    .filter(timestamp => Number.isFinite(timestamp));
  if (timestamps.length === 0) return null;
  return Math.max(...timestamps);
}

function minEntryId(entries: readonly SessionEntry[]): number | null {
  if (entries.length === 0) return null;
  return Math.min(...entries.map(entry => entry.id));
}

function maxEntryId(entries: readonly SessionEntry[]): number | null {
  if (entries.length === 0) return null;
  return Math.max(...entries.map(entry => entry.id));
}
