import {
  MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT,
  SESSION_HISTORY_BUDGET_PCT_DEFAULT,
} from '../../shared/context-budget.js';
import {
  createEnvCredentialVault,
  resolveCredentialVaultBackend,
  resolveOptionalEnvCredential,
} from '../../boundary/custody/credential-vault.js';
import { resolveCompanionStateDir, resolveRuntimePathLayout } from '../../persistence/layout.js';
import { parseOptionalStringEnv } from '../../shared/utils/env.js';
import type {
  CanonicalModelRegistry,
  ImportProcessingRouteMode,
  ModelCatalogEntry,
  ModelRoleAssignments,
  ResponseStyle,
  ResponseStyleOverrides,
} from '../../shared/contracts/runtime.js';
import {
  type CapabilityTier,
  createDefaultCompositionalPolicyConfig,
  DEFAULT_MOOD_CONGRUENCE_WEIGHT,
  type PersistenceBackend,
  DEFAULT_UI_THEME_ID,
  type SubstrateConfig,
  sanitizeCoreSubstrateConfig,
} from './runtime-config-contracts.js';
import {
  DEFAULT_COMPANION_CARD_FILE_NAME,
} from '../../core/identity/companion-naming.js';

const DEFAULT_MODEL_ROLE_ASSIGNMENTS: ModelRoleAssignments = {
  chat: 'primary',
  background: 'extraction',
  memory: 'extraction',
  context: 'extraction',
  extraction: 'extraction',
  summary: 'primary',
  reasoning: 'primary',
  longContext: 'primary',
  vision: 'primary',
  import_processing: 'extraction',
};
const DEFAULT_EXTRACTION_INTERVAL = 5;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 300_000;
const DEFAULT_EXTRACTION_THRESHOLD_PCT = 30;
const DEFAULT_COMPACTION_THRESHOLD_PCT = 70;
const DEFAULT_OBSERVATION_MASKING_WINDOW = 1;
const DEFAULT_COMPACTION_EMOTIONAL_SALIENCE_THRESHOLD_PCT = 75;
const DEFAULT_MEMORY_EXTRACTION_MIN_IMPORTANCE = 0.45;
const DEFAULT_MEMORY_EXTRACTION_MIN_CONFIDENCE = 0.6;
const DEFAULT_MEMORY_EXTRACTION_MIN_NOVELTY = 0.35;
const DEFAULT_MEMORY_EXTRACTION_EMOTIONAL_INTENSITY_WEIGHT = 0.2;
const DEFAULT_MEMORY_EXTRACTION_MAX_WRITES = 2;
const DEFAULT_PROFILE_SYNTHESIS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PROFILE_SYNTHESIS_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_PROFILE_SYNTHESIS_MIN_WRITES = 1;
const DEFAULT_PROFILE_SYNTHESIS_MIN_IMPORTANCE = 0.65;
const DEFAULT_PROFILE_SYNTHESIS_MIN_CONFIDENCE = 0.7;
const DEFAULT_PROFILE_SYNTHESIS_MIN_NOVELTY = 0.12;
const DEFAULT_PROFILE_SYNTHESIS_SOURCE_MEMORY_LIMIT = 16;
const DEFAULT_PROFILE_SYNTHESIS_MIN_SOURCE_MEMORIES = 2;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_IMPORT_PROCESSING_ROUTE_MODE: ImportProcessingRouteMode = 'background';
const DEFAULT_DISCORD_TRIGGER_REACTIONS = ['👆'] as const;
const DEFAULT_DISCORD_TRIGGER_LISTEN_WINDOW_MS = 120_000;
const DEFAULT_CAPABILITY_TIER: CapabilityTier = 'nursery';
const DEFAULT_OBSIDIAN_TIMEOUT_MS = 10_000;
const OWNER_FILE_REQUIRED_SENTINEL = '__owner_file_required__';
const BOOTSTRAP_CONTEXT_WINDOW = 128_000;
const BOOTSTRAP_MAX_OUTPUT_TOKENS = 1;
const DEFAULT_CONTINUITY_MESSAGE_LIMIT = 10;
const DEFAULT_SESSION_MIRROR_ENABLED = true;
const DEFAULT_SESSION_MIRROR_MAX_CHARS = 220;
const DEFAULT_SESSION_MIRROR_ACTIVE_WINDOW_MS = 1_800_000;
const DEFAULT_THINK_MAX_TOKENS = 76_000;
const DEFAULT_THINK_MAX_WALL_TIME_MS = 180_000;
const DEFAULT_THINK_MAX_SUB_QUERIES = 12;
type LoadConfigMode = 'gateway' | 'agent';

function requireCompanionId(env: NodeJS.ProcessEnv): string {
  const companionId = parseOptionalStringEnv(env.COMPANION_ID);
  if (companionId) return companionId;
  throw new Error(
    'COMPANION_ID is required. Set an explicit deployment identity in .env before startup.',
  );
}

function parsePersistenceBackendEnv(value: string | undefined): PersistenceBackend {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (!normalized || normalized === 'sqlite') {
    return 'sqlite';
  }
  if (normalized === 'postgres' || normalized === 'postgresql' || normalized === 'pg') {
    return 'postgres';
  }
  throw new Error(
    `Unsupported PERSISTENCE_BACKEND "${value}". Expected "sqlite" or "postgres".`,
  );
}

function loadConfigForMode(mode: LoadConfigMode, env: NodeJS.ProcessEnv = process.env): SubstrateConfig {
  const includeSecretBearingConfig = mode === 'gateway';
  const credentialVaultBackend = includeSecretBearingConfig
    ? resolveCredentialVaultBackend(env)
    : 'env';
  const materializeEnvBackedSecrets = includeSecretBearingConfig && credentialVaultBackend === 'env';
  const credentialVault = materializeEnvBackedSecrets
    ? createEnvCredentialVault(env)
    : undefined;
  const primaryModel = OWNER_FILE_REQUIRED_SENTINEL;
  const primaryProvider = OWNER_FILE_REQUIRED_SENTINEL;
  const primaryMaxTokens = BOOTSTRAP_MAX_OUTPUT_TOKENS;
  const defaultContextWindow = BOOTSTRAP_CONTEXT_WINDOW;
  const extractionModel = OWNER_FILE_REQUIRED_SENTINEL;
  const extractionProvider = OWNER_FILE_REQUIRED_SENTINEL;
  const extractionMaxTokens = BOOTSTRAP_MAX_OUTPUT_TOKENS;
  const modelCatalog = {
    primary: {
      model: primaryModel,
      provider: primaryProvider,
      defaults: {
        maxTokens: primaryMaxTokens,
        contextWindow: defaultContextWindow,
      },
      overrides: {
        maxTokens: primaryMaxTokens,
      },
    },
    extraction: {
      model: extractionModel,
      provider: extractionProvider,
      defaults: {
        maxTokens: extractionMaxTokens,
      },
      overrides: {
        maxTokens: extractionMaxTokens,
      },
    },
  } satisfies Record<string, ModelCatalogEntry>;
  const modelRoleAssignments: ModelRoleAssignments = {
    ...DEFAULT_MODEL_ROLE_ASSIGNMENTS,
  };
  const modelRegistry: CanonicalModelRegistry = {
    schemaVersion: 1,
    models: [
      {
        id: 'primary',
        rank: 100,
        identity: {
          provider: primaryProvider,
          model: primaryModel,
          source: { type: 'openrouter' },
        },
        purposes: [
          { purpose: 'chat', primary: true },
          { purpose: 'summary', primary: true },
          { purpose: 'reasoning', primary: true },
          { purpose: 'longContext', primary: true },
          { purpose: 'vision', primary: true },
          { purpose: 'moa', primary: true },
        ],
        capabilities: {
          maxOutputTokens: primaryMaxTokens,
          contextWindow: defaultContextWindow,
        },
        tuning: {
          maxOutputTokens: primaryMaxTokens,
        },
      },
      {
        id: 'extraction',
        rank: 80,
        identity: {
          provider: extractionProvider,
          model: extractionModel,
          source: { type: 'openrouter' },
        },
        purposes: [
          { purpose: 'background', primary: true },
          { purpose: 'memory', primary: true },
          { purpose: 'extraction', primary: true },
          { purpose: 'import_processing', primary: true },
        ],
        capabilities: {
          maxOutputTokens: extractionMaxTokens,
          contextWindow: defaultContextWindow,
        },
        tuning: {
          maxOutputTokens: extractionMaxTokens,
        },
      },
    ],
  };
  const responseStyleOverrides = parseResponseStyleOverridesEnv(env.RESPONSE_STYLE_OVERRIDES);
  const gatewayTlsCaPath = parseOptionalStringEnv(env.GATEWAY_TLS_CA_PATH);
  const gatewayTlsRejectUnauthorized = parseOptionalBooleanEnv(env.GATEWAY_TLS_REJECT_UNAUTHORIZED);
  const discordToken = includeSecretBearingConfig
    ? resolveOptionalEnvCredential(credentialVault, 'DISCORD_TOKEN', env)
    : undefined;
  const discordBotId = includeSecretBearingConfig
    ? resolveOptionalEnvCredential(credentialVault, 'DISCORD_BOT_ID', env)
    : undefined;
  if (materializeEnvBackedSecrets) {
    assertMutuallyRequiredEnvPair('DISCORD_TOKEN', discordToken, 'DISCORD_BOT_ID', discordBotId);
  }
  const wyomingEnabled = parseOptionalBooleanEnv(env.WYOMING_ENABLED) ?? false;
  const wyomingHost = parseOptionalStringEnv(env.WYOMING_HOST) ?? '127.0.0.1';
  const wyomingPort = parseOptionalIntegerEnv(env.WYOMING_PORT, 1);
  const voiceDaveEncryption = parseOptionalBooleanEnv(env.DISCORD_VOICE_DAVE_ENCRYPTION) ?? true;
  const voiceDecryptionFailureTolerance = parseIntegerEnv(
    env.DISCORD_VOICE_DECRYPTION_FAILURE_TOLERANCE,
    24,
    0,
  );
  const echoTtsModel = parseOptionalStringEnv(env.ECHO_TTS_MODEL);
  const runtimePathLayout = resolveRuntimePathLayout({
    mode: env.PSFN_RUNTIME_LAYOUT_MODE,
    nodeEnv: env.NODE_ENV,
    runtimeRootDir: env.PSFN_RUNTIME_ROOT,
    systemDataDir: env.SYSTEM_DATA_DIR,
    companionDataDir: env.COMPANION_DATA_DIR,
    legacyDataDir: env.DATA_DIR,
    workspacePath: env.WORKSPACE_PATH,
    logsDir: env.PSFN_LOGS_DIR,
    tempDir: env.PSFN_TEMP_DIR,
    backupsDir: env.BACKUP_ROOT_DIR,
  });
  const dataDir = runtimePathLayout.systemDataDir;
  const companionDataDir = runtimePathLayout.companionDataDir;
  const companionId = requireCompanionId(env);
  const characterCardPath = env.CHARACTER_CARD_PATH
    ?? `${companionDataDir}/${DEFAULT_COMPANION_CARD_FILE_NAME}`;
  const databaseBasename = sanitizeDatabaseBasename(env.DATABASE_BASENAME);
  const databasePath = env.DATABASE_PATH
    ?? `${resolveCompanionStateDir(companionDataDir)}/${databaseBasename}.db`;
  const persistenceBackend = parsePersistenceBackendEnv(env.PERSISTENCE_BACKEND);
  const postgresDatabaseUrl = parseOptionalStringEnv(env.POSTGRES_DATABASE_URL);
  if (persistenceBackend === 'postgres' && !postgresDatabaseUrl) {
    throw new Error('POSTGRES_DATABASE_URL is required when PERSISTENCE_BACKEND=postgres');
  }

  return {
    primaryModel,
    primaryProvider,
    extractionModel,
    extractionProvider,
    primaryMaxTokens,
    extractionMaxTokens,
    ...(includeSecretBearingConfig
      ? {
        discordToken: discordToken ?? '',
        discordBotId: discordBotId ?? '',
      }
      : {}),
    characterCardPath,
    companionId,
    systemDataDir: runtimePathLayout.systemDataDir,
    companionDataDir,
    dataDir,
    databasePath,
    persistenceBackend,
    ...(postgresDatabaseUrl ? { postgresDatabaseUrl } : {}),
    sessionMessageLimit: 30,
    sessionRestartBehavior: 'reuse_latest_session',
    continuityMessageLimit: DEFAULT_CONTINUITY_MESSAGE_LIMIT,
    sessionHistoryBudgetPct: SESSION_HISTORY_BUDGET_PCT_DEFAULT,
    memoryRetrievalBudgetPct: MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT,
    moodCongruenceWeight: DEFAULT_MOOD_CONGRUENCE_WEIGHT,
    adaptiveContextBudgetsEnabled: false,
    sessionMirrorEnabled: DEFAULT_SESSION_MIRROR_ENABLED,
    sessionMirrorMaxChars: DEFAULT_SESSION_MIRROR_MAX_CHARS,
    sessionMirrorActiveWindowMs: DEFAULT_SESSION_MIRROR_ACTIVE_WINDOW_MS,
    sessionMirrorChannelOverrides: {},
    extractionInterval: DEFAULT_EXTRACTION_INTERVAL,
    maintenanceIntervalMs: DEFAULT_MAINTENANCE_INTERVAL_MS,
    defaultContextWindow,
    extractionThresholdPct: DEFAULT_EXTRACTION_THRESHOLD_PCT,
    compactionThresholdPct: DEFAULT_COMPACTION_THRESHOLD_PCT,
    observationMaskingWindow: DEFAULT_OBSERVATION_MASKING_WINDOW,
    compactionEmotionalSalienceThresholdPct: DEFAULT_COMPACTION_EMOTIONAL_SALIENCE_THRESHOLD_PCT,
    memoryExtractionMinImportance: DEFAULT_MEMORY_EXTRACTION_MIN_IMPORTANCE,
    memoryExtractionMinConfidence: DEFAULT_MEMORY_EXTRACTION_MIN_CONFIDENCE,
    memoryExtractionMinNovelty: DEFAULT_MEMORY_EXTRACTION_MIN_NOVELTY,
    memoryExtractionEmotionalIntensityWeight: DEFAULT_MEMORY_EXTRACTION_EMOTIONAL_INTENSITY_WEIGHT,
    memoryExtractionMaxWrites: DEFAULT_MEMORY_EXTRACTION_MAX_WRITES,
    memoryExtractionTelemetryEnabled: true,
    memoryRetrievalTelemetryEnabled: true,
    profileSynthesisEnabled: true,
    profileSynthesisRefreshIntervalMs: DEFAULT_PROFILE_SYNTHESIS_REFRESH_INTERVAL_MS,
    profileSynthesisCooldownMs: DEFAULT_PROFILE_SYNTHESIS_COOLDOWN_MS,
    profileSynthesisMinWrites: DEFAULT_PROFILE_SYNTHESIS_MIN_WRITES,
    profileSynthesisMinImportance: DEFAULT_PROFILE_SYNTHESIS_MIN_IMPORTANCE,
    profileSynthesisMinConfidence: DEFAULT_PROFILE_SYNTHESIS_MIN_CONFIDENCE,
    profileSynthesisMinNovelty: DEFAULT_PROFILE_SYNTHESIS_MIN_NOVELTY,
    profileSynthesisSourceMemoryLimit: DEFAULT_PROFILE_SYNTHESIS_SOURCE_MEMORY_LIMIT,
    profileSynthesisMinSourceMemories: DEFAULT_PROFILE_SYNTHESIS_MIN_SOURCE_MEMORIES,
    thinkMaxTokens: DEFAULT_THINK_MAX_TOKENS,
    thinkMaxWallTimeMs: DEFAULT_THINK_MAX_WALL_TIME_MS,
    thinkMaxSubQueries: DEFAULT_THINK_MAX_SUB_QUERIES,
    modelCatalog,
    modelRoleAssignments,
    modelRegistry,
    ...(credentialVault ? { credentialVault } : {}),
    modelRoster: {
      chat: { model: primaryModel, provider: primaryProvider, maxTokens: primaryMaxTokens, contextWindow: defaultContextWindow },
      background: { model: extractionModel, provider: extractionProvider, maxTokens: extractionMaxTokens },
      memory: { model: extractionModel, provider: extractionProvider, maxTokens: extractionMaxTokens },
      context: { model: extractionModel, provider: extractionProvider, maxTokens: extractionMaxTokens },
    },
    voiceEnabled: false,
    discordBackfillOnStartup: process.env.DISCORD_BACKFILL_ON_STARTUP !== 'false',
    discordTriggerWords: undefined,
    discordTriggerReactions: [...DEFAULT_DISCORD_TRIGGER_REACTIONS],
    discordTriggerListenWindowMs: DEFAULT_DISCORD_TRIGGER_LISTEN_WINDOW_MS,
    characterName: '',
    uiThemeId: DEFAULT_UI_THEME_ID,
    voiceTargetGuildId: '',
    voiceTargetUserId: '',
    voiceReadyCueText: '',
    voiceDaveEncryption,
    voiceDecryptionFailureTolerance,
    ...(materializeEnvBackedSecrets
      ? { deepgramApiKey: resolveOptionalEnvCredential(credentialVault, 'DEEPGRAM_API_KEY', env) }
      : {}),
    deepgramModel: undefined,
    deepgramSttEndpoint: undefined,
    deepgramListenEndpoint: undefined,
    ...(materializeEnvBackedSecrets
      ? { elevenLabsApiKey: resolveOptionalEnvCredential(credentialVault, 'ELEVENLABS_API_KEY', env) }
      : {}),
    elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID,
    elevenLabsModelId: undefined,
    elevenLabsEndpointBase: undefined,
    ...(materializeEnvBackedSecrets
      ? { falApiKey: resolveOptionalEnvCredential(credentialVault, 'FAL_API_KEY', env) }
      : {}),
    imageWorkflows: {},
    ...(echoTtsModel ? { echoTtsModel } : {}),
    retryMaxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS,
    retryBaseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
    openRouterModelsApiUrl: undefined,
    ...(responseStyleOverrides ? { responseStyleOverrides } : {}),
    importProcessingRouteMode: DEFAULT_IMPORT_PROCESSING_ROUTE_MODE,
    importProcessingStrictPolicy: false,
    embeddingProvider: undefined,
    embeddingModel: undefined,
    embeddingDims: undefined,
    embeddingOllamaUrl: undefined,
    transformersModel: undefined,
    textEmotionModel: undefined,
    textEmotionCacheDir: undefined,
    textEmotionDtype: undefined,
    embeddingApiModel: undefined,
    embeddingApiDims: undefined,
    compositionalPolicy: createDefaultCompositionalPolicyConfig(),
    webFetchAllowHttp: false,
    webFetchAllowInternalNetwork: false,
    webFetchLocalCrawlerEnabled: false,
    webFetchLocalCrawlerAllowHttp: false,
    ...(gatewayTlsCaPath ? { gatewayTlsCaPath } : {}),
    ...(gatewayTlsRejectUnauthorized !== undefined ? { gatewayTlsRejectUnauthorized } : {}),
    wyomingShardRouting: { enabled: false },
    wyomingEnabled,
    wyomingHost,
    ...(wyomingPort !== undefined ? { wyomingPort } : {}),
    telegramEnabled: false,
    capabilityTier: DEFAULT_CAPABILITY_TIER,
    shardToolsets: {},
    // Obsidian vault
    obsidianAutoPublish: false,
    obsidianTimeoutMs: DEFAULT_OBSIDIAN_TIMEOUT_MS,
  };
}

export function loadConfig(): SubstrateConfig {
  return loadConfigForMode('gateway');
}

export function loadAgentConfig(): SubstrateConfig {
  return sanitizeCoreSubstrateConfig(loadConfigForMode('agent')) as SubstrateConfig;
}

function parseIntegerEnv(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function parseOptionalIntegerEnv(value: string | undefined, min: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed >= min ? parsed : undefined;
}

function parseOptionalBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
}

function assertMutuallyRequiredEnvPair(
  primaryName: string,
  primaryValue: string | undefined,
  secondaryName: string,
  secondaryValue: string | undefined,
): void {
  const hasPrimary = typeof primaryValue === 'string' && primaryValue.length > 0;
  const hasSecondary = typeof secondaryValue === 'string' && secondaryValue.length > 0;
  if (hasPrimary === hasSecondary) return;

  if (!hasPrimary) {
    throw new Error(`${primaryName} is required when ${secondaryName} is configured`);
  }
  throw new Error(`${secondaryName} is required when ${primaryName} is configured`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseResponseStyle(value: unknown): ResponseStyle | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'concise' || normalized === 'expressive') {
    return normalized;
  }
  return undefined;
}

function parseResponseStyleMap(value: unknown): Record<string, ResponseStyle> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const parsed: Record<string, ResponseStyle> = {};
  for (const [rawKey, rawStyle] of Object.entries(value)) {
    const key = rawKey.trim();
    const style = parseResponseStyle(rawStyle);
    if (!key || !style) continue;
    parsed[key] = style;
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseResponseStyleOverridesEnv(value: string | undefined): ResponseStyleOverrides | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (!isPlainRecord(parsed)) return undefined;
    const exact = parseResponseStyleMap(parsed.exact);
    const prefix = parseResponseStyleMap(parsed.prefix);
    const channelType = parseResponseStyleMap(parsed.channelType);
    const defaultStyle = parseResponseStyle(parsed.defaultStyle);

    if (!exact && !prefix && !channelType && !defaultStyle) return undefined;
    return {
      ...(exact ? { exact } : {}),
      ...(prefix ? { prefix } : {}),
      ...(channelType ? { channelType } : {}),
      ...(defaultStyle ? { defaultStyle } : {}),
    };
  } catch {
    return undefined;
  }
}

function sanitizeDatabaseBasename(value: string | undefined): string {
  if (typeof value !== 'string') return 'companion';
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'companion';
}
