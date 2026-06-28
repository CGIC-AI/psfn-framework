import {
  CHANNEL_TYPES,
  type ChannelType,
} from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';

export const GROUP_MEMORY_MODE_VALUES = ['direct', 'group', 'auto'] as const;
export type GroupMemoryMode = typeof GROUP_MEMORY_MODE_VALUES[number];

export const GROUP_MEMORY_FALLBACK_MODE_VALUES = ['direct', 'group'] as const;
export type GroupMemoryFallbackMode =
  typeof GROUP_MEMORY_FALLBACK_MODE_VALUES[number];

export interface GroupMemoryAutoDetectionSettings {
  recentParticipantWindowMessages: number;
  recentParticipantWindowMs: number;
  minDistinctHumanContacts: number;
  groupCapableChannelTypes: ChannelType[];
  fallbackModeWhenOneHuman: GroupMemoryFallbackMode;
  excludeCompanionContact: boolean;
  excludeSystemContacts: boolean;
  excludeApiPrincipals: boolean;
  excludeBotContacts: boolean;
  includeAiCompanions: boolean;
}

export interface GroupMemoryOnlineExtractionSettings {
  observedMessageTriggerCount: number;
  observedTimeTriggerMs: number;
  maxMessagesPerChunk: number;
  maxEstimatedTokensPerChunk: number;
  chunkOverlapMessages: number;
  cooldownMs: number;
  backlogLagTriggerMessages: number;
  maxBacklogChunksPerRun: number;
}

export interface GroupMemorySalienceSettings {
  minImportance: number;
  minConfidence: number;
  minNovelty: number;
  minCandidateScore: number;
  maxCandidateSpansPerChunk: number;
  neighboringContextMessages: number;
  reasonWeights: GroupMemorySalienceReasonWeights;
  lowSignalRules: GroupMemorySalienceLowSignalRules;
}

export interface GroupMemorySalienceReasonWeights {
  companionMention: number;
  directAddress: number;
  participantFact: number;
  explicitPreference: number;
  relationshipClaim: number;
  boundarySafety: number;
  commitment: number;
  emotionalEvent: number;
  durablePlan: number;
}

export interface GroupMemorySalienceLowSignalRules {
  enabled: boolean;
  shortMessageMaxChars: number;
  repeatWindowMessages: number;
  repeatThreshold: number;
  lowInformationPenalty: number;
}

export interface GroupMemorySalienceSettingsPatch {
  minImportance?: number;
  minConfidence?: number;
  minNovelty?: number;
  minCandidateScore?: number;
  maxCandidateSpansPerChunk?: number;
  neighboringContextMessages?: number;
  reasonWeights?: Partial<GroupMemorySalienceReasonWeights>;
  lowSignalRules?: Partial<GroupMemorySalienceLowSignalRules>;
}

export interface GroupMemoryWriteCapSettings {
  maxWritesPerRun: number;
  maxWritesPerChunk: number;
  maxWritesPerContact: number;
  maxWritesPerSubject: number;
  maxLowSalienceWritesPerRun: number;
  maxWritesPerBackfillRun: number;
  maxWritesPerTimeWindow: number;
  timeWindowMs: number;
  lowSalienceThreshold: number;
  rankingWeights: GroupMemoryWriteRankingWeights;
  addressModeWeights: GroupMemoryWriteAddressModeWeights;
}

export interface GroupMemoryWriteRankingWeights {
  importance: number;
  novelty: number;
  confidence: number;
  addressMode: number;
  relationshipRelevance: number;
  emotionalIntensity: number;
  perContactCoverage: number;
}

export interface GroupMemoryWriteAddressModeWeights {
  directToCompanion: number;
  mentionOfCompanion: number;
  replyToUser: number;
  overheardRoomContext: number;
  systemApi: number;
}

export interface GroupMemoryWriteCapSettingsPatch {
  maxWritesPerRun?: number;
  maxWritesPerChunk?: number;
  maxWritesPerContact?: number;
  maxWritesPerSubject?: number;
  maxLowSalienceWritesPerRun?: number;
  maxWritesPerBackfillRun?: number;
  maxWritesPerTimeWindow?: number;
  timeWindowMs?: number;
  lowSalienceThreshold?: number;
  rankingWeights?: Partial<GroupMemoryWriteRankingWeights>;
  addressModeWeights?: Partial<GroupMemoryWriteAddressModeWeights>;
}

export interface GroupMemoryProfileRefreshSettings {
  enabled: boolean;
  minAcceptedWritesPerContact: number;
  minSourceMemories: number;
  cooldownMs: number;
}

export interface GroupMemoryTelemetrySettings {
  enabled: boolean;
  exposeGardenDiagnostics: boolean;
}

export interface GroupMemoryBackfillSettings {
  maxMessagesPerRun: number;
  maxChunksPerRun: number;
  maxLlmCallsPerRun: number;
  cooldownMs: number;
}

export interface GroupMemorySettings {
  enabled: boolean;
  memoryMode: GroupMemoryMode;
  autoDetection: GroupMemoryAutoDetectionSettings;
  onlineExtraction: GroupMemoryOnlineExtractionSettings;
  salience: GroupMemorySalienceSettings;
  writeCaps: GroupMemoryWriteCapSettings;
  profileRefresh: GroupMemoryProfileRefreshSettings;
  telemetry: GroupMemoryTelemetrySettings;
  backfill: GroupMemoryBackfillSettings;
}

export interface GroupMemorySettingsPatch {
  enabled?: boolean;
  memoryMode?: GroupMemoryMode;
  autoDetection?: Partial<GroupMemoryAutoDetectionSettings>;
  onlineExtraction?: Partial<GroupMemoryOnlineExtractionSettings>;
  salience?: GroupMemorySalienceSettingsPatch;
  writeCaps?: GroupMemoryWriteCapSettingsPatch;
  profileRefresh?: Partial<GroupMemoryProfileRefreshSettings>;
  telemetry?: Partial<GroupMemoryTelemetrySettings>;
  backfill?: Partial<GroupMemoryBackfillSettings>;
}

export interface ChannelGroupMemoryConfig {
  memoryMode?: GroupMemoryMode;
  channelOverrides: Record<string, GroupMemorySettingsPatch>;
}

const GROUP_MEMORY_MODE_SET = new Set<string>(GROUP_MEMORY_MODE_VALUES);
const GROUP_MEMORY_FALLBACK_MODE_SET = new Set<string>(
  GROUP_MEMORY_FALLBACK_MODE_VALUES,
);
const CHANNEL_TYPE_SET = new Set<string>(CHANNEL_TYPES);

const ROOT_KEYS = new Set<string>([
  'enabled',
  'memoryMode',
  'autoDetection',
  'onlineExtraction',
  'salience',
  'writeCaps',
  'profileRefresh',
  'telemetry',
  'backfill',
]);
const CHANNEL_GROUP_MEMORY_KEYS = new Set<string>([
  'memoryMode',
  'channelOverrides',
]);
const AUTO_DETECTION_KEYS = new Set<string>([
  'recentParticipantWindowMessages',
  'recentParticipantWindowMs',
  'minDistinctHumanContacts',
  'groupCapableChannelTypes',
  'fallbackModeWhenOneHuman',
  'excludeCompanionContact',
  'excludeSystemContacts',
  'excludeApiPrincipals',
  'excludeBotContacts',
  'includeAiCompanions',
]);
const ONLINE_EXTRACTION_KEYS = new Set<string>([
  'observedMessageTriggerCount',
  'observedTimeTriggerMs',
  'maxMessagesPerChunk',
  'maxEstimatedTokensPerChunk',
  'chunkOverlapMessages',
  'cooldownMs',
  'backlogLagTriggerMessages',
  'maxBacklogChunksPerRun',
]);
const SALIENCE_KEYS = new Set<string>([
  'minImportance',
  'minConfidence',
  'minNovelty',
  'minCandidateScore',
  'maxCandidateSpansPerChunk',
  'neighboringContextMessages',
  'reasonWeights',
  'lowSignalRules',
]);
const SALIENCE_REASON_WEIGHT_KEYS = new Set<string>([
  'companionMention',
  'directAddress',
  'participantFact',
  'explicitPreference',
  'relationshipClaim',
  'boundarySafety',
  'commitment',
  'emotionalEvent',
  'durablePlan',
]);
const SALIENCE_LOW_SIGNAL_RULE_KEYS = new Set<string>([
  'enabled',
  'shortMessageMaxChars',
  'repeatWindowMessages',
  'repeatThreshold',
  'lowInformationPenalty',
]);
const WRITE_CAP_KEYS = new Set<string>([
  'maxWritesPerRun',
  'maxWritesPerChunk',
  'maxWritesPerContact',
  'maxWritesPerSubject',
  'maxLowSalienceWritesPerRun',
  'maxWritesPerBackfillRun',
  'maxWritesPerTimeWindow',
  'timeWindowMs',
  'lowSalienceThreshold',
  'rankingWeights',
  'addressModeWeights',
]);
const WRITE_RANKING_WEIGHT_KEYS = new Set<string>([
  'importance',
  'novelty',
  'confidence',
  'addressMode',
  'relationshipRelevance',
  'emotionalIntensity',
  'perContactCoverage',
]);
const WRITE_ADDRESS_MODE_WEIGHT_KEYS = new Set<string>([
  'directToCompanion',
  'mentionOfCompanion',
  'replyToUser',
  'overheardRoomContext',
  'systemApi',
]);
const PROFILE_REFRESH_KEYS = new Set<string>([
  'enabled',
  'minAcceptedWritesPerContact',
  'minSourceMemories',
  'cooldownMs',
]);
const TELEMETRY_KEYS = new Set<string>(['enabled', 'exposeGardenDiagnostics']);
const BACKFILL_KEYS = new Set<string>([
  'maxMessagesPerRun',
  'maxChunksPerRun',
  'maxLlmCallsPerRun',
  'cooldownMs',
]);

export function createDefaultGroupMemorySettings(): GroupMemorySettings {
  return {
    enabled: true,
    memoryMode: 'auto',
    autoDetection: {
      recentParticipantWindowMessages: 75,
      recentParticipantWindowMs: 6 * 60 * 60 * 1000,
      minDistinctHumanContacts: 2,
      groupCapableChannelTypes: ['discord'],
      fallbackModeWhenOneHuman: 'direct',
      excludeCompanionContact: true,
      excludeSystemContacts: true,
      excludeApiPrincipals: true,
      excludeBotContacts: true,
      includeAiCompanions: false,
    },
    onlineExtraction: {
      observedMessageTriggerCount: 50,
      observedTimeTriggerMs: 10 * 60 * 1000,
      maxMessagesPerChunk: 75,
      maxEstimatedTokensPerChunk: 12_000,
      chunkOverlapMessages: 5,
      cooldownMs: 2 * 60 * 1000,
      backlogLagTriggerMessages: 100,
      maxBacklogChunksPerRun: 2,
    },
    salience: {
      minImportance: 0.55,
      minConfidence: 0.65,
      minNovelty: 0.35,
      minCandidateScore: 0.7,
      maxCandidateSpansPerChunk: 12,
      neighboringContextMessages: 2,
      reasonWeights: {
        companionMention: 0.8,
        directAddress: 1,
        participantFact: 0.45,
        explicitPreference: 0.75,
        relationshipClaim: 0.8,
        boundarySafety: 0.9,
        commitment: 0.75,
        emotionalEvent: 0.7,
        durablePlan: 0.65,
      },
      lowSignalRules: {
        enabled: true,
        shortMessageMaxChars: 16,
        repeatWindowMessages: 12,
        repeatThreshold: 3,
        lowInformationPenalty: 0.45,
      },
    },
    writeCaps: {
      maxWritesPerRun: 8,
      maxWritesPerChunk: 4,
      maxWritesPerContact: 2,
      maxWritesPerSubject: 2,
      maxLowSalienceWritesPerRun: 1,
      maxWritesPerBackfillRun: 12,
      maxWritesPerTimeWindow: 24,
      timeWindowMs: 60 * 60 * 1000,
      lowSalienceThreshold: 0.55,
      rankingWeights: {
        importance: 1,
        novelty: 0.7,
        confidence: 0.7,
        addressMode: 0.4,
        relationshipRelevance: 0.4,
        emotionalIntensity: 0.3,
        perContactCoverage: 0.5,
      },
      addressModeWeights: {
        directToCompanion: 1,
        mentionOfCompanion: 0.8,
        replyToUser: 0.7,
        overheardRoomContext: 0.45,
        systemApi: 0.2,
      },
    },
    profileRefresh: {
      enabled: true,
      minAcceptedWritesPerContact: 1,
      minSourceMemories: 2,
      cooldownMs: 10 * 60 * 1000,
    },
    telemetry: {
      enabled: true,
      exposeGardenDiagnostics: true,
    },
    backfill: {
      maxMessagesPerRun: 250,
      maxChunksPerRun: 4,
      maxLlmCallsPerRun: 4,
      cooldownMs: 30 * 60 * 1000,
    },
  };
}

export function createDefaultChannelGroupMemoryConfig(): ChannelGroupMemoryConfig {
  return {
    channelOverrides: {},
  };
}

export function cloneGroupMemorySettings(
  settings: GroupMemorySettings,
): GroupMemorySettings {
  return mergeGroupMemorySettingsPatch(settings, {});
}

export function normalizeGroupMemoryMode(
  value: unknown,
  fieldPath: string,
): GroupMemoryMode {
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid group memory config at ${fieldPath}: expected one of ${GROUP_MEMORY_MODE_VALUES.join(', ')}`,
    );
  }
  const normalized = value.trim();
  if (!GROUP_MEMORY_MODE_SET.has(normalized)) {
    throw new Error(
      `Invalid group memory config at ${fieldPath}: expected one of ${GROUP_MEMORY_MODE_VALUES.join(', ')}`,
    );
  }
  return normalized as GroupMemoryMode;
}

export function normalizeGroupMemorySettings(
  value: unknown,
  fieldPath = 'groupMemory',
): GroupMemorySettings {
  const defaults = createDefaultGroupMemorySettings();
  return mergeGroupMemorySettingsPatch(
    defaults,
    normalizeGroupMemorySettingsPatch(value, fieldPath),
  );
}

export function normalizeGroupMemorySettingsPatch(
  value: unknown,
  fieldPath: string,
): GroupMemorySettingsPatch {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, ROOT_KEYS, fieldPath);

  const patch: GroupMemorySettingsPatch = {};
  if (Object.hasOwn(root, 'enabled')) {
    patch.enabled = parseBoolean(root.enabled, `${fieldPath}.enabled`);
  }
  if (Object.hasOwn(root, 'memoryMode')) {
    patch.memoryMode = normalizeGroupMemoryMode(
      root.memoryMode,
      `${fieldPath}.memoryMode`,
    );
  }
  if (Object.hasOwn(root, 'autoDetection')) {
    patch.autoDetection = normalizeAutoDetectionPatch(
      root.autoDetection,
      `${fieldPath}.autoDetection`,
    );
  }
  if (Object.hasOwn(root, 'onlineExtraction')) {
    patch.onlineExtraction = normalizeOnlineExtractionPatch(
      root.onlineExtraction,
      `${fieldPath}.onlineExtraction`,
    );
  }
  if (Object.hasOwn(root, 'salience')) {
    patch.salience = normalizeSaliencePatch(
      root.salience,
      `${fieldPath}.salience`,
    );
  }
  if (Object.hasOwn(root, 'writeCaps')) {
    patch.writeCaps = normalizeWriteCapsPatch(
      root.writeCaps,
      `${fieldPath}.writeCaps`,
    );
  }
  if (Object.hasOwn(root, 'profileRefresh')) {
    patch.profileRefresh = normalizeProfileRefreshPatch(
      root.profileRefresh,
      `${fieldPath}.profileRefresh`,
    );
  }
  if (Object.hasOwn(root, 'telemetry')) {
    patch.telemetry = normalizeTelemetryPatch(
      root.telemetry,
      `${fieldPath}.telemetry`,
    );
  }
  if (Object.hasOwn(root, 'backfill')) {
    patch.backfill = normalizeBackfillPatch(
      root.backfill,
      `${fieldPath}.backfill`,
    );
  }
  return patch;
}

export function mergeGroupMemorySettingsPatch(
  base: GroupMemorySettings,
  patch: GroupMemorySettingsPatch,
): GroupMemorySettings {
  const autoDetection = patch.autoDetection ?? {};
  const onlineExtraction = patch.onlineExtraction ?? {};
  const salience = patch.salience ?? {};
  const writeCaps = patch.writeCaps ?? {};
  const profileRefresh = patch.profileRefresh ?? {};
  const telemetry = patch.telemetry ?? {};
  const backfill = patch.backfill ?? {};

  return {
    enabled: patch.enabled ?? base.enabled,
    memoryMode: patch.memoryMode ?? base.memoryMode,
    autoDetection: {
      recentParticipantWindowMessages:
        autoDetection.recentParticipantWindowMessages
        ?? base.autoDetection.recentParticipantWindowMessages,
      recentParticipantWindowMs:
        autoDetection.recentParticipantWindowMs
        ?? base.autoDetection.recentParticipantWindowMs,
      minDistinctHumanContacts:
        autoDetection.minDistinctHumanContacts
        ?? base.autoDetection.minDistinctHumanContacts,
      groupCapableChannelTypes: [
        ...(autoDetection.groupCapableChannelTypes
          ?? base.autoDetection.groupCapableChannelTypes),
      ],
      fallbackModeWhenOneHuman:
        autoDetection.fallbackModeWhenOneHuman
        ?? base.autoDetection.fallbackModeWhenOneHuman,
      excludeCompanionContact:
        autoDetection.excludeCompanionContact
        ?? base.autoDetection.excludeCompanionContact,
      excludeSystemContacts:
        autoDetection.excludeSystemContacts
        ?? base.autoDetection.excludeSystemContacts,
      excludeApiPrincipals:
        autoDetection.excludeApiPrincipals
        ?? base.autoDetection.excludeApiPrincipals,
      excludeBotContacts:
        autoDetection.excludeBotContacts
        ?? base.autoDetection.excludeBotContacts,
      includeAiCompanions:
        autoDetection.includeAiCompanions
        ?? base.autoDetection.includeAiCompanions,
    },
    onlineExtraction: {
      observedMessageTriggerCount:
        onlineExtraction.observedMessageTriggerCount
        ?? base.onlineExtraction.observedMessageTriggerCount,
      observedTimeTriggerMs:
        onlineExtraction.observedTimeTriggerMs
        ?? base.onlineExtraction.observedTimeTriggerMs,
      maxMessagesPerChunk:
        onlineExtraction.maxMessagesPerChunk
        ?? base.onlineExtraction.maxMessagesPerChunk,
      maxEstimatedTokensPerChunk:
        onlineExtraction.maxEstimatedTokensPerChunk
        ?? base.onlineExtraction.maxEstimatedTokensPerChunk,
      chunkOverlapMessages:
        onlineExtraction.chunkOverlapMessages
        ?? base.onlineExtraction.chunkOverlapMessages,
      cooldownMs: onlineExtraction.cooldownMs ?? base.onlineExtraction.cooldownMs,
      backlogLagTriggerMessages:
        onlineExtraction.backlogLagTriggerMessages
        ?? base.onlineExtraction.backlogLagTriggerMessages,
      maxBacklogChunksPerRun:
        onlineExtraction.maxBacklogChunksPerRun
        ?? base.onlineExtraction.maxBacklogChunksPerRun,
    },
    salience: {
      minImportance: salience.minImportance ?? base.salience.minImportance,
      minConfidence: salience.minConfidence ?? base.salience.minConfidence,
      minNovelty: salience.minNovelty ?? base.salience.minNovelty,
      minCandidateScore:
        salience.minCandidateScore ?? base.salience.minCandidateScore,
      maxCandidateSpansPerChunk:
        salience.maxCandidateSpansPerChunk
        ?? base.salience.maxCandidateSpansPerChunk,
      neighboringContextMessages:
        salience.neighboringContextMessages
        ?? base.salience.neighboringContextMessages,
      reasonWeights: {
        ...base.salience.reasonWeights,
        ...(salience.reasonWeights ?? {}),
      },
      lowSignalRules: {
        ...base.salience.lowSignalRules,
        ...(salience.lowSignalRules ?? {}),
      },
    },
    writeCaps: {
      maxWritesPerRun:
        writeCaps.maxWritesPerRun ?? base.writeCaps.maxWritesPerRun,
      maxWritesPerChunk:
        writeCaps.maxWritesPerChunk ?? base.writeCaps.maxWritesPerChunk,
      maxWritesPerContact:
        writeCaps.maxWritesPerContact ?? base.writeCaps.maxWritesPerContact,
      maxWritesPerSubject:
        writeCaps.maxWritesPerSubject ?? base.writeCaps.maxWritesPerSubject,
      maxLowSalienceWritesPerRun:
        writeCaps.maxLowSalienceWritesPerRun
        ?? base.writeCaps.maxLowSalienceWritesPerRun,
      maxWritesPerBackfillRun:
        writeCaps.maxWritesPerBackfillRun
        ?? base.writeCaps.maxWritesPerBackfillRun,
      maxWritesPerTimeWindow:
        writeCaps.maxWritesPerTimeWindow
        ?? base.writeCaps.maxWritesPerTimeWindow,
      timeWindowMs: writeCaps.timeWindowMs ?? base.writeCaps.timeWindowMs,
      lowSalienceThreshold:
        writeCaps.lowSalienceThreshold ?? base.writeCaps.lowSalienceThreshold,
      rankingWeights: {
        ...base.writeCaps.rankingWeights,
        ...(writeCaps.rankingWeights ?? {}),
      },
      addressModeWeights: {
        ...base.writeCaps.addressModeWeights,
        ...(writeCaps.addressModeWeights ?? {}),
      },
    },
    profileRefresh: {
      enabled: profileRefresh.enabled ?? base.profileRefresh.enabled,
      minAcceptedWritesPerContact:
        profileRefresh.minAcceptedWritesPerContact
        ?? base.profileRefresh.minAcceptedWritesPerContact,
      minSourceMemories:
        profileRefresh.minSourceMemories
        ?? base.profileRefresh.minSourceMemories,
      cooldownMs: profileRefresh.cooldownMs ?? base.profileRefresh.cooldownMs,
    },
    telemetry: {
      enabled: telemetry.enabled ?? base.telemetry.enabled,
      exposeGardenDiagnostics:
        telemetry.exposeGardenDiagnostics
        ?? base.telemetry.exposeGardenDiagnostics,
    },
    backfill: {
      maxMessagesPerRun:
        backfill.maxMessagesPerRun ?? base.backfill.maxMessagesPerRun,
      maxChunksPerRun:
        backfill.maxChunksPerRun ?? base.backfill.maxChunksPerRun,
      maxLlmCallsPerRun:
        backfill.maxLlmCallsPerRun ?? base.backfill.maxLlmCallsPerRun,
      cooldownMs: backfill.cooldownMs ?? base.backfill.cooldownMs,
    },
  };
}

export function normalizeChannelGroupMemoryConfig(
  value: unknown,
  fieldPath: string,
): ChannelGroupMemoryConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, CHANNEL_GROUP_MEMORY_KEYS, fieldPath);

  const memoryMode = Object.hasOwn(root, 'memoryMode')
    ? normalizeGroupMemoryMode(root.memoryMode, `${fieldPath}.memoryMode`)
    : undefined;
  const channelOverrides =
    Object.hasOwn(root, 'channelOverrides')
      ? normalizeChannelOverrides(
        root.channelOverrides,
        `${fieldPath}.channelOverrides`,
      )
      : {};

  return {
    ...(memoryMode ? { memoryMode } : {}),
    channelOverrides,
  };
}

function normalizeAutoDetectionPatch(
  value: unknown,
  fieldPath: string,
): Partial<GroupMemoryAutoDetectionSettings> {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, AUTO_DETECTION_KEYS, fieldPath);
  const patch: Partial<GroupMemoryAutoDetectionSettings> = {};
  setIntegerIfPresent(
    patch,
    root,
    'recentParticipantWindowMessages',
    fieldPath,
    1,
    10_000,
  );
  setIntegerIfPresent(
    patch,
    root,
    'recentParticipantWindowMs',
    fieldPath,
    1_000,
    30 * 24 * 60 * 60 * 1000,
  );
  setIntegerIfPresent(
    patch,
    root,
    'minDistinctHumanContacts',
    fieldPath,
    1,
    100,
  );
  if (Object.hasOwn(root, 'groupCapableChannelTypes')) {
    patch.groupCapableChannelTypes = parseChannelTypeList(
      root.groupCapableChannelTypes,
      `${fieldPath}.groupCapableChannelTypes`,
    );
  }
  if (Object.hasOwn(root, 'fallbackModeWhenOneHuman')) {
    patch.fallbackModeWhenOneHuman = parseFallbackMode(
      root.fallbackModeWhenOneHuman,
      `${fieldPath}.fallbackModeWhenOneHuman`,
    );
  }
  setBooleanIfPresent(patch, root, 'excludeCompanionContact', fieldPath);
  setBooleanIfPresent(patch, root, 'excludeSystemContacts', fieldPath);
  setBooleanIfPresent(patch, root, 'excludeApiPrincipals', fieldPath);
  setBooleanIfPresent(patch, root, 'excludeBotContacts', fieldPath);
  setBooleanIfPresent(patch, root, 'includeAiCompanions', fieldPath);
  return patch;
}

function normalizeOnlineExtractionPatch(
  value: unknown,
  fieldPath: string,
): Partial<GroupMemoryOnlineExtractionSettings> {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, ONLINE_EXTRACTION_KEYS, fieldPath);
  const patch: Partial<GroupMemoryOnlineExtractionSettings> = {};
  setIntegerIfPresent(patch, root, 'observedMessageTriggerCount', fieldPath, 1, 10_000);
  setIntegerIfPresent(patch, root, 'observedTimeTriggerMs', fieldPath, 1_000, 86_400_000);
  setIntegerIfPresent(patch, root, 'maxMessagesPerChunk', fieldPath, 1, 10_000);
  setIntegerIfPresent(patch, root, 'maxEstimatedTokensPerChunk', fieldPath, 1_000, 1_000_000);
  setIntegerIfPresent(patch, root, 'chunkOverlapMessages', fieldPath, 0, 1_000);
  setIntegerIfPresent(patch, root, 'cooldownMs', fieldPath, 0, 86_400_000);
  setIntegerIfPresent(patch, root, 'backlogLagTriggerMessages', fieldPath, 1, 1_000_000);
  setIntegerIfPresent(patch, root, 'maxBacklogChunksPerRun', fieldPath, 1, 10_000);
  return patch;
}

function normalizeSaliencePatch(
  value: unknown,
  fieldPath: string,
): GroupMemorySalienceSettingsPatch {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, SALIENCE_KEYS, fieldPath);
  const patch: Partial<GroupMemorySalienceSettings> = {};
  setNumberIfPresent(patch, root, 'minImportance', fieldPath, 0, 1);
  setNumberIfPresent(patch, root, 'minConfidence', fieldPath, 0, 1);
  setNumberIfPresent(patch, root, 'minNovelty', fieldPath, 0, 1);
  setNumberIfPresent(patch, root, 'minCandidateScore', fieldPath, 0, 10);
  setIntegerIfPresent(patch, root, 'maxCandidateSpansPerChunk', fieldPath, 1, 10_000);
  setIntegerIfPresent(patch, root, 'neighboringContextMessages', fieldPath, 0, 1_000);
  if (Object.hasOwn(root, 'reasonWeights')) {
    patch.reasonWeights = normalizeSalienceReasonWeightsPatch(
      root.reasonWeights,
      `${fieldPath}.reasonWeights`,
    );
  }
  if (Object.hasOwn(root, 'lowSignalRules')) {
    patch.lowSignalRules = normalizeSalienceLowSignalRulesPatch(
      root.lowSignalRules,
      `${fieldPath}.lowSignalRules`,
    );
  }
  return patch;
}

function normalizeSalienceReasonWeightsPatch(
  value: unknown,
  fieldPath: string,
): Partial<GroupMemorySalienceReasonWeights> {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, SALIENCE_REASON_WEIGHT_KEYS, fieldPath);
  const patch: Partial<GroupMemorySalienceReasonWeights> = {};
  setNumberIfPresent(patch, root, 'companionMention', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'directAddress', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'participantFact', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'explicitPreference', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'relationshipClaim', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'boundarySafety', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'commitment', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'emotionalEvent', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'durablePlan', fieldPath, 0, 10);
  return patch;
}

function normalizeSalienceLowSignalRulesPatch(
  value: unknown,
  fieldPath: string,
): Partial<GroupMemorySalienceLowSignalRules> {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, SALIENCE_LOW_SIGNAL_RULE_KEYS, fieldPath);
  const patch: Partial<GroupMemorySalienceLowSignalRules> = {};
  setBooleanIfPresent(patch, root, 'enabled', fieldPath);
  setIntegerIfPresent(patch, root, 'shortMessageMaxChars', fieldPath, 0, 10_000);
  setIntegerIfPresent(patch, root, 'repeatWindowMessages', fieldPath, 1, 10_000);
  setIntegerIfPresent(patch, root, 'repeatThreshold', fieldPath, 1, 10_000);
  setNumberIfPresent(patch, root, 'lowInformationPenalty', fieldPath, 0, 10);
  return patch;
}

function normalizeWriteCapsPatch(
  value: unknown,
  fieldPath: string,
): GroupMemoryWriteCapSettingsPatch {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, WRITE_CAP_KEYS, fieldPath);
  const patch: GroupMemoryWriteCapSettingsPatch = {};
  setIntegerIfPresent(patch, root, 'maxWritesPerRun', fieldPath, 0, 10_000);
  setIntegerIfPresent(patch, root, 'maxWritesPerChunk', fieldPath, 0, 10_000);
  setIntegerIfPresent(patch, root, 'maxWritesPerContact', fieldPath, 0, 10_000);
  setIntegerIfPresent(patch, root, 'maxWritesPerSubject', fieldPath, 0, 10_000);
  setIntegerIfPresent(patch, root, 'maxLowSalienceWritesPerRun', fieldPath, 0, 10_000);
  setIntegerIfPresent(patch, root, 'maxWritesPerBackfillRun', fieldPath, 0, 10_000);
  setIntegerIfPresent(patch, root, 'maxWritesPerTimeWindow', fieldPath, 0, 10_000);
  setIntegerIfPresent(patch, root, 'timeWindowMs', fieldPath, 1_000, 30 * 24 * 60 * 60 * 1000);
  setNumberIfPresent(patch, root, 'lowSalienceThreshold', fieldPath, 0, 1);
  if (Object.hasOwn(root, 'rankingWeights')) {
    patch.rankingWeights = normalizeWriteRankingWeightsPatch(
      root.rankingWeights,
      `${fieldPath}.rankingWeights`,
    );
  }
  if (Object.hasOwn(root, 'addressModeWeights')) {
    patch.addressModeWeights = normalizeWriteAddressModeWeightsPatch(
      root.addressModeWeights,
      `${fieldPath}.addressModeWeights`,
    );
  }
  return patch;
}

function normalizeWriteRankingWeightsPatch(
  value: unknown,
  fieldPath: string,
): Partial<GroupMemoryWriteRankingWeights> {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, WRITE_RANKING_WEIGHT_KEYS, fieldPath);
  const patch: Partial<GroupMemoryWriteRankingWeights> = {};
  setNumberIfPresent(patch, root, 'importance', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'novelty', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'confidence', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'addressMode', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'relationshipRelevance', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'emotionalIntensity', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'perContactCoverage', fieldPath, 0, 10);
  return patch;
}

function normalizeWriteAddressModeWeightsPatch(
  value: unknown,
  fieldPath: string,
): Partial<GroupMemoryWriteAddressModeWeights> {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, WRITE_ADDRESS_MODE_WEIGHT_KEYS, fieldPath);
  const patch: Partial<GroupMemoryWriteAddressModeWeights> = {};
  setNumberIfPresent(patch, root, 'directToCompanion', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'mentionOfCompanion', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'replyToUser', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'overheardRoomContext', fieldPath, 0, 10);
  setNumberIfPresent(patch, root, 'systemApi', fieldPath, 0, 10);
  return patch;
}

function normalizeProfileRefreshPatch(
  value: unknown,
  fieldPath: string,
): Partial<GroupMemoryProfileRefreshSettings> {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, PROFILE_REFRESH_KEYS, fieldPath);
  const patch: Partial<GroupMemoryProfileRefreshSettings> = {};
  setBooleanIfPresent(patch, root, 'enabled', fieldPath);
  setIntegerIfPresent(patch, root, 'minAcceptedWritesPerContact', fieldPath, 0, 10_000);
  setIntegerIfPresent(patch, root, 'minSourceMemories', fieldPath, 0, 10_000);
  setIntegerIfPresent(patch, root, 'cooldownMs', fieldPath, 0, 86_400_000);
  return patch;
}

function normalizeTelemetryPatch(
  value: unknown,
  fieldPath: string,
): Partial<GroupMemoryTelemetrySettings> {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, TELEMETRY_KEYS, fieldPath);
  const patch: Partial<GroupMemoryTelemetrySettings> = {};
  setBooleanIfPresent(patch, root, 'enabled', fieldPath);
  setBooleanIfPresent(patch, root, 'exposeGardenDiagnostics', fieldPath);
  return patch;
}

function normalizeBackfillPatch(
  value: unknown,
  fieldPath: string,
): Partial<GroupMemoryBackfillSettings> {
  const root = expectRecord(value, fieldPath);
  rejectUnknownKeys(root, BACKFILL_KEYS, fieldPath);
  const patch: Partial<GroupMemoryBackfillSettings> = {};
  setIntegerIfPresent(patch, root, 'maxMessagesPerRun', fieldPath, 1, 1_000_000);
  setIntegerIfPresent(patch, root, 'maxChunksPerRun', fieldPath, 1, 10_000);
  setIntegerIfPresent(patch, root, 'maxLlmCallsPerRun', fieldPath, 0, 10_000);
  setIntegerIfPresent(patch, root, 'cooldownMs', fieldPath, 0, 30 * 24 * 60 * 60 * 1000);
  return patch;
}

function normalizeChannelOverrides(
  value: unknown,
  fieldPath: string,
): Record<string, GroupMemorySettingsPatch> {
  const root = expectRecord(value, fieldPath);
  const overrides: Record<string, GroupMemorySettingsPatch> = {};
  for (const [rawChannelId, rawOverride] of Object.entries(root)) {
    const channelId = rawChannelId.trim();
    if (!channelId) {
      throw new Error(`Invalid group memory config at ${fieldPath}: channel id must not be empty`);
    }
    overrides[channelId] = normalizeGroupMemorySettingsPatch(
      rawOverride,
      `${fieldPath}.${rawChannelId}`,
    );
  }
  return overrides;
}

function rejectUnknownKeys(
  root: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  fieldPath: string,
): void {
  const unknown = Object.keys(root).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid group memory config at ${fieldPath}: unknown field ${unknown.join(', ')}`,
    );
  }
}

function expectRecord(
  value: unknown,
  fieldPath: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid group memory config at ${fieldPath}: expected object`);
  }
  return value;
}

function parseBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  throw new Error(`Invalid group memory config at ${fieldPath}: expected boolean`);
}

function parseInteger(
  value: unknown,
  fieldPath: string,
  min: number,
  max: number,
): number {
  let parsed: number | undefined;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string') {
    const normalized = value.trim();
    if (/^-?\d+$/u.test(normalized)) {
      parsed = Number(normalized);
    }
  }
  if (
    parsed === undefined
    || !Number.isInteger(parsed)
    || parsed < min
    || parsed > max
  ) {
    throw new Error(
      `Invalid group memory config at ${fieldPath}: expected integer ${min}-${max}`,
    );
  }
  return parsed;
}

function parseNumber(
  value: unknown,
  fieldPath: string,
  min: number,
  max: number,
): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Invalid group memory config at ${fieldPath}: expected number ${min}-${max}`,
    );
  }
  return parsed;
}

function parseChannelTypeList(
  value: unknown,
  fieldPath: string,
): ChannelType[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid group memory config at ${fieldPath}: expected array of channel types`,
    );
  }
  const parsed: ChannelType[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') {
      throw new Error(
        `Invalid group memory config at ${fieldPath}.${index}: expected channel type`,
      );
    }
    const channelType = entry.trim();
    if (!CHANNEL_TYPE_SET.has(channelType)) {
      throw new Error(
        `Invalid group memory config at ${fieldPath}.${index}: expected one of ${CHANNEL_TYPES.join(', ')}`,
      );
    }
    if (!parsed.includes(channelType as ChannelType)) {
      parsed.push(channelType as ChannelType);
    }
  }
  return parsed;
}

function parseFallbackMode(
  value: unknown,
  fieldPath: string,
): GroupMemoryFallbackMode {
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid group memory config at ${fieldPath}: expected one of ${GROUP_MEMORY_FALLBACK_MODE_VALUES.join(', ')}`,
    );
  }
  const normalized = value.trim();
  if (!GROUP_MEMORY_FALLBACK_MODE_SET.has(normalized)) {
    throw new Error(
      `Invalid group memory config at ${fieldPath}: expected one of ${GROUP_MEMORY_FALLBACK_MODE_VALUES.join(', ')}`,
    );
  }
  return normalized as GroupMemoryFallbackMode;
}

function setBooleanIfPresent<T extends Record<string, unknown>>(
  patch: T,
  root: Record<string, unknown>,
  key: keyof T & string,
  fieldPath: string,
): void {
  if (Object.hasOwn(root, key)) {
    patch[key] = parseBoolean(root[key], `${fieldPath}.${key}`) as T[typeof key];
  }
}

function setIntegerIfPresent<T extends Record<string, unknown>>(
  patch: T,
  root: Record<string, unknown>,
  key: keyof T & string,
  fieldPath: string,
  min: number,
  max: number,
): void {
  if (Object.hasOwn(root, key)) {
    patch[key] = parseInteger(
      root[key],
      `${fieldPath}.${key}`,
      min,
      max,
    ) as T[typeof key];
  }
}

function setNumberIfPresent<T extends Record<string, unknown>>(
  patch: T,
  root: Record<string, unknown>,
  key: keyof T & string,
  fieldPath: string,
  min: number,
  max: number,
): void {
  if (Object.hasOwn(root, key)) {
    patch[key] = parseNumber(
      root[key],
      `${fieldPath}.${key}`,
      min,
      max,
    ) as T[typeof key];
  }
}
