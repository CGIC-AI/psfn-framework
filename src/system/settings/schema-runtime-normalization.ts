import {
  DEFAULT_UI_THEME_ID,
  createDefaultObserverEvalSidecarLeverSettings,
  createDefaultObserverEvalSidecarSettings,
  PROMOTED_EXTENDED_TOOL_SLOTS_MAX,
} from '../config/runtime-config-contracts.js';
import { normalizeGroupMemorySettings } from '../config/group-memory-config.js';
import { normalizeEmotionScopingSettings } from '../config/emotion-scoping-config.js';
import { normalizeImageWorkflowSettings } from '../../primitives/images/types.js';
import {
  MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  SESSION_HISTORY_BUDGET_PCT_RANGE,
} from '../../shared/context-budget.js';
import { normalizeCompositionalPolicyConfig } from '../capabilities/compositional-policy.js';
import { isRecord } from '../../shared/utils/types.js';
import { isCapabilityTier } from '../capabilities/tiers.js';
import {
  OBSERVER_EVAL_SIDECAR_ADAPTER_KINDS,
  OBSERVER_EVAL_SIDECAR_DEPLOYMENT_TARGETS,
  OBSERVER_EVAL_SIDECAR_MODES,
  type ObserverEvalSidecarAdapterKind,
  type ObserverEvalSidecarDeploymentTarget,
  type ObserverEvalSidecarMode,
  type ObserverEvalSidecarOverflowPolicy,
  type ObserverEvalSidecarSettings,
} from '../../shared/contracts/runtime.js';
import {
  normalizeSttProvider,
  normalizeTtsProvider,
  toEmbeddingProvider,
  toBoolean,
  toImportProcessingRouteMode,
  toIntegerInRange,
  toNonEmptyString,
  toNumberInRange,
  toPositiveInteger,
  toSessionRestartBehavior,
  toStringList,
} from './coercion.js';
import {
  COMPACTION_THRESHOLD_PCT_RANGE,
  EXTRACTION_THRESHOLD_PCT_RANGE,
  MOOD_CONGRUENCE_WEIGHT_RANGE,
  REMOVED_RUNTIME_SETTINGS_KEYS,
  type EditableSettings,
} from './contracts.js';

export function toPromotedToolList(value: unknown): string[] {
  return (toStringList(value) ?? []).slice(0, PROMOTED_EXTENDED_TOOL_SLOTS_MAX);
}

const TEXT_EMOTION_DTYPE_VALUES = [
  'auto',
  'fp32',
  'fp16',
  'q8',
  'int8',
  'uint8',
  'q4',
  'bnb4',
  'q4f16',
] as const;
const TEXT_EMOTION_DTYPE_SET = new Set<string>(TEXT_EMOTION_DTYPE_VALUES);
const OBSERVER_EVAL_SIDECAR_ADAPTER_KIND_SET = new Set<string>(
  OBSERVER_EVAL_SIDECAR_ADAPTER_KINDS,
);
const OBSERVER_EVAL_SIDECAR_DEPLOYMENT_TARGET_SET = new Set<string>(
  OBSERVER_EVAL_SIDECAR_DEPLOYMENT_TARGETS,
);
const OBSERVER_EVAL_SIDECAR_MODE_SET = new Set<string>(
  OBSERVER_EVAL_SIDECAR_MODES,
);

function normalizeTextEmotionDtype(
  value: unknown,
): EditableSettings['textEmotionDtype'] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  if (!TEXT_EMOTION_DTYPE_SET.has(normalized)) {
    return undefined;
  }
  return normalized as EditableSettings['textEmotionDtype'];
}

function normalizeBooleanMap(
  value: unknown,
  fieldPath: string,
): Record<string, boolean> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected object`);
  }

  const parsed: Record<string, boolean> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) continue;
    const normalized = toBoolean(rawValue);
    if (normalized === undefined) {
      throw new Error(
        `Invalid settings at ${fieldPath}.${rawKey}: expected boolean`,
      );
    }
    parsed[key] = normalized;
  }

  return parsed;
}

function normalizeWyomingShardRoutingConfig(
  value: unknown,
  fieldPath: string,
): EditableSettings['wyomingShardRouting'] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected object`);
  }

  const enabled =
    value.enabled === undefined ? false : toBoolean(value.enabled);
  if (enabled === undefined) {
    throw new Error(
      `Invalid settings at ${fieldPath}.enabled: expected boolean`,
    );
  }

  const parseAllowlist = (
    name: 'siteAllowlist' | 'satelliteAllowlist',
  ): string[] | undefined => {
    const raw = value[name];
    if (raw === undefined) {
      return undefined;
    }
    if (!Array.isArray(raw)) {
      throw new Error(
        `Invalid settings at ${fieldPath}.${name}: expected array of strings`,
      );
    }
    return toStringList(raw) ?? [];
  };

  const siteAllowlist = parseAllowlist('siteAllowlist');
  const satelliteAllowlist = parseAllowlist('satelliteAllowlist');

  return {
    enabled,
    ...(siteAllowlist ? { siteAllowlist } : {}),
    ...(satelliteAllowlist ? { satelliteAllowlist } : {}),
  };
}

function normalizeShardToolsetConfig(
  value: unknown,
  fieldPath: string,
): EditableSettings['shardToolsets'] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected object`);
  }

  const parsed: NonNullable<EditableSettings['shardToolsets']> = {};
  for (const tier of [
    'nursery',
    'apprentice',
    'autonomous',
    'custom',
  ] as const) {
    const raw = value[tier];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      throw new Error(
        `Invalid settings at ${fieldPath}.${tier}: expected array of strings`,
      );
    }
    parsed[tier] = toStringList(raw) ?? [];
  }

  return parsed;
}

function expectRecord(value: unknown, fieldPath: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected object`);
  }
  return value;
}

function expectBoolean(value: unknown, fieldPath: string): boolean {
  const normalized = toBoolean(value);
  if (normalized === undefined) {
    throw new Error(`Invalid settings at ${fieldPath}: expected boolean`);
  }
  return normalized;
}

function expectNonEmptyString(value: unknown, fieldPath: string): string {
  const normalized = toNonEmptyString(value);
  if (!normalized) {
    throw new Error(`Invalid settings at ${fieldPath}: expected non-empty string`);
  }
  return normalized;
}

function expectIntegerInRange(
  value: unknown,
  fieldPath: string,
  min: number,
  max: number,
): number {
  const normalized = toIntegerInRange(value, min, max);
  if (normalized === undefined) {
    throw new Error(`Invalid settings at ${fieldPath}: expected integer ${min}-${max}`);
  }
  return normalized;
}

function optionalNonEmptyString(value: unknown, fieldPath: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return expectNonEmptyString(value, fieldPath);
}

function expectEnumValue<T extends string>(
  value: unknown,
  fieldPath: string,
  allowed: ReadonlySet<string>,
  description: string,
): T {
  if (typeof value !== 'string') {
    throw new Error(`Invalid settings at ${fieldPath}: expected ${description}`);
  }
  const normalized = value.trim();
  if (!allowed.has(normalized)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected ${description}`);
  }
  return normalized as T;
}

function expectNumberInRange(
  value: unknown,
  fieldPath: string,
  min: number,
  max: number,
): number {
  const normalized = toNumberInRange(value, min, max);
  if (normalized === undefined) {
    throw new Error(`Invalid settings at ${fieldPath}: expected number ${min}..${max}`);
  }
  return normalized;
}

function normalizeObserverEvalSidecarLeverSettings(
  value: unknown,
  fieldPath: string,
  persistenceEnabled: boolean,
): NonNullable<ObserverEvalSidecarSettings['levers']> {
  if (value === undefined) {
    return createDefaultObserverEvalSidecarLeverSettings();
  }
  const root = expectRecord(value, fieldPath);
  const wouldMessage = expectRecord(root.wouldMessage, `${fieldPath}.wouldMessage`);
  const wouldCheckIn = expectRecord(root.wouldCheckIn, `${fieldPath}.wouldCheckIn`);
  const wouldRest = expectRecord(root.wouldRest, `${fieldPath}.wouldRest`);
  const ruminationWatch = expectRecord(root.ruminationWatch, `${fieldPath}.ruminationWatch`);

  const enabled = expectBoolean(root.enabled, `${fieldPath}.enabled`);
  if (enabled && !persistenceEnabled) {
    // Lever events are persistence-only telemetry; without the eval-owned
    // Postgres store there is nowhere non-authoritative to record them.
    throw new Error(
      `Invalid settings at ${fieldPath}.enabled: lever tracking requires observerEvalSidecar.persistence.enabled=true`,
    );
  }

  return {
    enabled,
    cooldownMs: expectIntegerInRange(root.cooldownMs, `${fieldPath}.cooldownMs`, 60_000, 604_800_000),
    wouldMessage: {
      enabled: expectBoolean(wouldMessage.enabled, `${fieldPath}.wouldMessage.enabled`),
      socialNeedThreshold: expectNumberInRange(
        wouldMessage.socialNeedThreshold,
        `${fieldPath}.wouldMessage.socialNeedThreshold`,
        0,
        1,
      ),
      attachmentIntensityThreshold: expectNumberInRange(
        wouldMessage.attachmentIntensityThreshold,
        `${fieldPath}.wouldMessage.attachmentIntensityThreshold`,
        0,
        1,
      ),
      sustainMs: expectIntegerInRange(wouldMessage.sustainMs, `${fieldPath}.wouldMessage.sustainMs`, 0, 604_800_000),
    },
    wouldCheckIn: {
      enabled: expectBoolean(wouldCheckIn.enabled, `${fieldPath}.wouldCheckIn.enabled`),
      valenceThreshold: expectNumberInRange(
        wouldCheckIn.valenceThreshold,
        `${fieldPath}.wouldCheckIn.valenceThreshold`,
        -1,
        1,
      ),
      sustainMs: expectIntegerInRange(wouldCheckIn.sustainMs, `${fieldPath}.wouldCheckIn.sustainMs`, 0, 604_800_000),
    },
    wouldRest: {
      enabled: expectBoolean(wouldRest.enabled, `${fieldPath}.wouldRest.enabled`),
      sleepPressureThreshold: expectNumberInRange(
        wouldRest.sleepPressureThreshold,
        `${fieldPath}.wouldRest.sleepPressureThreshold`,
        0,
        1,
      ),
      arousalThreshold: expectNumberInRange(
        wouldRest.arousalThreshold,
        `${fieldPath}.wouldRest.arousalThreshold`,
        0,
        1,
      ),
      sustainMs: expectIntegerInRange(wouldRest.sustainMs, `${fieldPath}.wouldRest.sustainMs`, 0, 604_800_000),
    },
    ruminationWatch: {
      enabled: expectBoolean(ruminationWatch.enabled, `${fieldPath}.ruminationWatch.enabled`),
      intensityThreshold: expectNumberInRange(
        ruminationWatch.intensityThreshold,
        `${fieldPath}.ruminationWatch.intensityThreshold`,
        0,
        1,
      ),
      sustainMs: expectIntegerInRange(
        ruminationWatch.sustainMs,
        `${fieldPath}.ruminationWatch.sustainMs`,
        0,
        604_800_000,
      ),
    },
  };
}

function normalizeObserverEvalSidecarSettings(
  value: unknown,
  fieldPath: string,
): ObserverEvalSidecarSettings {
  const root = expectRecord(value, fieldPath);
  const queue = expectRecord(root.queue, `${fieldPath}.queue`);
  const adapter = expectRecord(root.adapter, `${fieldPath}.adapter`);
  const persistence = expectRecord(root.persistence, `${fieldPath}.persistence`);
  const garden = expectRecord(root.garden, `${fieldPath}.garden`);
  const defaults = createDefaultObserverEvalSidecarSettings();

  const enabled = expectBoolean(root.enabled, `${fieldPath}.enabled`);
  const sidecarId = expectNonEmptyString(root.sidecarId, `${fieldPath}.sidecarId`);
  const deploymentTarget = expectEnumValue<ObserverEvalSidecarDeploymentTarget>(
    root.deploymentTarget,
    `${fieldPath}.deploymentTarget`,
    OBSERVER_EVAL_SIDECAR_DEPLOYMENT_TARGET_SET,
    `one of: ${OBSERVER_EVAL_SIDECAR_DEPLOYMENT_TARGETS.join(', ')}`,
  );
  const mode = expectEnumValue<ObserverEvalSidecarMode>(
    root.mode,
    `${fieldPath}.mode`,
    OBSERVER_EVAL_SIDECAR_MODE_SET,
    `one of: ${OBSERVER_EVAL_SIDECAR_MODES.join(', ')}`,
  );
  const adapterKind = expectEnumValue<ObserverEvalSidecarAdapterKind>(
    adapter.kind,
    `${fieldPath}.adapter.kind`,
    OBSERVER_EVAL_SIDECAR_ADAPTER_KIND_SET,
    `one of: ${OBSERVER_EVAL_SIDECAR_ADAPTER_KINDS.join(', ')}`,
  );
  const emosimRoot = optionalNonEmptyString(adapter.emosimRoot, `${fieldPath}.adapter.emosimRoot`);
  const pythonExecutable = optionalNonEmptyString(
    adapter.pythonExecutable,
    `${fieldPath}.adapter.pythonExecutable`,
  );
  const deterministicSeed = optionalNonEmptyString(
    adapter.deterministicSeed,
    `${fieldPath}.adapter.deterministicSeed`,
  );
  const adapterTimeoutMs = adapter.timeoutMs === undefined
    ? undefined
    : expectIntegerInRange(adapter.timeoutMs, `${fieldPath}.adapter.timeoutMs`, 1, 600_000);

  if (enabled && adapterKind === 'disabled') {
    throw new Error(
      `Invalid settings at ${fieldPath}.adapter.kind: enabled sidecar requires a non-disabled adapter`,
    );
  }
  if (enabled && adapterKind === 'emosim' && !emosimRoot) {
    throw new Error(
      `Invalid settings at ${fieldPath}.adapter.emosimRoot: required when enabled sidecar uses adapter.kind=emosim`,
    );
  }

  const persistenceEnabled = expectBoolean(
    persistence.enabled,
    `${fieldPath}.persistence.enabled`,
  );
  const persistenceRootDir = optionalNonEmptyString(
    persistence.rootDir,
    `${fieldPath}.persistence.rootDir`,
  );
  if (persistenceEnabled && !persistenceRootDir) {
    throw new Error(
      `Invalid settings at ${fieldPath}.persistence.rootDir: required when persistence.enabled=true`,
    );
  }

  return {
    enabled,
    sidecarId,
    deploymentTarget,
    mode,
    queue: {
      maxQueuedTurns: expectIntegerInRange(
        queue.maxQueuedTurns,
        `${fieldPath}.queue.maxQueuedTurns`,
        0,
        100_000,
      ),
      overflowPolicy: expectEnumValue<ObserverEvalSidecarOverflowPolicy>(
        queue.overflowPolicy,
        `${fieldPath}.queue.overflowPolicy`,
        new Set(['drop_newest']),
        'drop_newest',
      ),
      observerTimeoutMs: expectIntegerInRange(
        queue.observerTimeoutMs,
        `${fieldPath}.queue.observerTimeoutMs`,
        1,
        600_000,
      ),
      maxRetries: expectIntegerInRange(
        queue.maxRetries,
        `${fieldPath}.queue.maxRetries`,
        0,
        10,
      ),
      retryDelayMs: expectIntegerInRange(
        queue.retryDelayMs,
        `${fieldPath}.queue.retryDelayMs`,
        0,
        600_000,
      ),
      shutdownDrainTimeoutMs: expectIntegerInRange(
        queue.shutdownDrainTimeoutMs,
        `${fieldPath}.queue.shutdownDrainTimeoutMs`,
        1,
        600_000,
      ),
    },
    adapter: {
      kind: adapterKind,
      ...(emosimRoot ? { emosimRoot } : {}),
      ...(pythonExecutable ? { pythonExecutable } : {}),
      ...(adapterTimeoutMs !== undefined ? { timeoutMs: adapterTimeoutMs } : {}),
      ...(deterministicSeed ? { deterministicSeed } : {}),
      includeWorldState: adapter.includeWorldState === undefined
        ? defaults.adapter.includeWorldState
        : expectBoolean(adapter.includeWorldState, `${fieldPath}.adapter.includeWorldState`),
    },
    persistence: {
      enabled: persistenceEnabled,
      ...(persistenceRootDir ? { rootDir: persistenceRootDir } : {}),
      retentionDays: expectIntegerInRange(
        persistence.retentionDays,
        `${fieldPath}.persistence.retentionDays`,
        1,
        3650,
      ),
      maxStoredObservations: expectIntegerInRange(
        persistence.maxStoredObservations,
        `${fieldPath}.persistence.maxStoredObservations`,
        1,
        10_000_000,
      ),
    },
    garden: {
      exposeHealth: expectBoolean(garden.exposeHealth, `${fieldPath}.garden.exposeHealth`),
      exposeTelemetry: expectBoolean(garden.exposeTelemetry, `${fieldPath}.garden.exposeTelemetry`),
    },
    levers: normalizeObserverEvalSidecarLeverSettings(
      root.levers,
      `${fieldPath}.levers`,
      persistenceEnabled,
    ),
  };
}

function hasSetting(settings: EditableSettings, key: string): boolean {
  return key in settings;
}

function getSetting(settings: EditableSettings, key: string): unknown {
  return (settings as Record<string, unknown>)[key];
}

function setSetting(
  settings: EditableSettings,
  key: string,
  value: unknown,
): void {
  (settings as Record<string, unknown>)[key] = value;
}

function deleteSetting(settings: EditableSettings, key: string): void {
  delete (settings as Record<string, unknown>)[key];
}

function trimStringSetting(settings: EditableSettings, key: string): string {
  const value = getSetting(settings, key);
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeIntegerRangeSetting(
  normalized: EditableSettings,
  settings: EditableSettings,
  key: string,
  min: number,
  max: number,
): void {
  const value = toIntegerInRange(getSetting(settings, key), min, max);
  if (value !== undefined) {
    setSetting(normalized, key, value);
  } else {
    deleteSetting(normalized, key);
  }
}

function normalizeTrimmedStringSetting(
  normalized: EditableSettings,
  settings: EditableSettings,
  key: string,
): void {
  if (hasSetting(settings, key)) {
    setSetting(normalized, key, trimStringSetting(settings, key));
  }
}

function normalizeStringListSetting(
  normalized: EditableSettings,
  settings: EditableSettings,
  key: string,
): void {
  if (hasSetting(settings, key)) {
    setSetting(normalized, key, toStringList(getSetting(settings, key)) ?? []);
  }
}

function normalizeBooleanSetting(
  normalized: EditableSettings,
  settings: EditableSettings,
  key: string,
): void {
  if (hasSetting(settings, key)) {
    setSetting(normalized, key, toBoolean(getSetting(settings, key)) ?? false);
  }
}

function normalizeEndpointAndGardenSettings(
  normalized: EditableSettings,
  settings: EditableSettings,
): void {
  normalizeTrimmedStringSetting(normalized, settings, 'chatApiBaseUrl');
  normalizeTrimmedStringSetting(normalized, settings, 'comfyUiBaseUrl');
  if ('imageWorkflows' in settings) {
    normalized.imageWorkflows = normalizeImageWorkflowSettings(
      settings.imageWorkflows,
    );
  }
  if ('uiThemeId' in settings) {
    normalized.uiThemeId =
      toNonEmptyString(settings.uiThemeId) ?? DEFAULT_UI_THEME_ID;
  }
  if ('observerEvalSidecar' in settings) {
    normalized.observerEvalSidecar = normalizeObserverEvalSidecarSettings(
      settings.observerEvalSidecar,
      'observerEvalSidecar',
    );
  }
  if ('groupMemory' in settings) {
    normalized.groupMemory = normalizeGroupMemorySettings(
      settings.groupMemory,
      'groupMemory',
    );
  }
  if ('emotionScoping' in settings) {
    normalized.emotionScoping = normalizeEmotionScopingSettings(
      settings.emotionScoping,
      'emotionScoping',
    );
  }
}

function normalizeBudgetAndThresholdSettings(
  normalized: EditableSettings,
  settings: EditableSettings,
): void {
  for (const key of REMOVED_RUNTIME_SETTINGS_KEYS) {
    deleteSetting(normalized, key);
  }

  normalizeIntegerRangeSetting(
    normalized,
    settings,
    'sessionHistoryBudgetPct',
    SESSION_HISTORY_BUDGET_PCT_RANGE.min,
    SESSION_HISTORY_BUDGET_PCT_RANGE.max,
  );
  normalizeIntegerRangeSetting(
    normalized,
    settings,
    'memoryRetrievalBudgetPct',
    MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min,
    MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.max,
  );
  normalizeIntegerRangeSetting(
    normalized,
    settings,
    'extractionThresholdPct',
    EXTRACTION_THRESHOLD_PCT_RANGE.min,
    EXTRACTION_THRESHOLD_PCT_RANGE.max,
  );
  normalizeIntegerRangeSetting(
    normalized,
    settings,
    'compactionThresholdPct',
    COMPACTION_THRESHOLD_PCT_RANGE.min,
    COMPACTION_THRESHOLD_PCT_RANGE.max,
  );

  const moodCongruenceWeight = toNumberInRange(
    settings.moodCongruenceWeight,
    MOOD_CONGRUENCE_WEIGHT_RANGE.min,
    MOOD_CONGRUENCE_WEIGHT_RANGE.max,
  );
  if (moodCongruenceWeight !== undefined) {
    normalized.moodCongruenceWeight = moodCongruenceWeight;
  } else {
    deleteSetting(normalized, 'moodCongruenceWeight');
  }

  if ('adaptiveContextBudgetsEnabled' in settings) {
    const adaptiveContextBudgetsEnabled = toBoolean(
      settings.adaptiveContextBudgetsEnabled,
    );
    if (adaptiveContextBudgetsEnabled !== undefined) {
      normalized.adaptiveContextBudgetsEnabled = adaptiveContextBudgetsEnabled;
    } else {
      deleteSetting(normalized, 'adaptiveContextBudgetsEnabled');
    }
  }

  normalizeIntegerRangeSetting(
    normalized,
    settings,
    'compactionEmotionalSalienceThresholdPct',
    0,
    100,
  );
  normalizeIntegerRangeSetting(
    normalized,
    settings,
    'observationMaskingWindow',
    0,
    200,
  );
}

function normalizeRouterAndProfileSettings(
  normalized: EditableSettings,
  settings: EditableSettings,
): void {
  if ('openRouterProviderOrder' in settings) {
    normalized.openRouterProviderOrder =
      toStringList(settings.openRouterProviderOrder) ?? [];
  }
  normalizeTrimmedStringSetting(normalized, settings, 'openRouterModelsApiUrl');

  const profileSynthesisSourceMemoryLimit = toPositiveInteger(
    settings.profileSynthesisSourceMemoryLimit,
  );
  const profileSynthesisMinSourceMemories = toPositiveInteger(
    settings.profileSynthesisMinSourceMemories,
  );
  if (profileSynthesisMinSourceMemories !== undefined) {
    normalized.profileSynthesisMinSourceMemories =
      profileSynthesisMinSourceMemories;
  } else {
    deleteSetting(normalized, 'profileSynthesisMinSourceMemories');
  }
  if (
    profileSynthesisSourceMemoryLimit !== undefined ||
    profileSynthesisMinSourceMemories !== undefined
  ) {
    const effectiveSourceMemoryLimit =
      profileSynthesisSourceMemoryLimit !== undefined &&
      profileSynthesisMinSourceMemories !== undefined
        ? Math.max(
            profileSynthesisSourceMemoryLimit,
            profileSynthesisMinSourceMemories,
          )
        : profileSynthesisSourceMemoryLimit;
    if (effectiveSourceMemoryLimit !== undefined) {
      normalized.profileSynthesisSourceMemoryLimit = effectiveSourceMemoryLimit;
    } else {
      deleteSetting(normalized, 'profileSynthesisSourceMemoryLimit');
    }
  }
}

function normalizeImportProcessingSettings(
  normalized: EditableSettings,
  settings: EditableSettings,
): void {
  if ('importProcessingRouteMode' in settings) {
    normalized.importProcessingRouteMode = toImportProcessingRouteMode(
      settings.importProcessingRouteMode,
    );
  }

  if ('importProcessingStrictPolicy' in settings) {
    normalized.importProcessingStrictPolicy =
      toBoolean(settings.importProcessingStrictPolicy) ?? false;
  }
  normalizeTrimmedStringSetting(
    normalized,
    settings,
    'importProcessingLocalEndpointUrl',
  );
  normalizeTrimmedStringSetting(
    normalized,
    settings,
    'importProcessingLocalModel',
  );
}

function normalizeEmbeddingSettings(
  normalized: EditableSettings,
  settings: EditableSettings,
): void {
  if ('embeddingProvider' in settings) {
    const provider = toEmbeddingProvider(settings.embeddingProvider);
    if (provider) {
      normalized.embeddingProvider = provider;
    } else {
      deleteSetting(normalized, 'embeddingProvider');
    }
  }

  normalizeTrimmedStringSetting(normalized, settings, 'embeddingModel');
  if ('embeddingDims' in settings) {
    normalized.embeddingDims = toPositiveInteger(settings.embeddingDims);
  }
  normalizeTrimmedStringSetting(normalized, settings, 'embeddingOllamaUrl');
  normalizeTrimmedStringSetting(normalized, settings, 'transformersModel');
  normalizeTrimmedStringSetting(normalized, settings, 'transformersCacheDir');

  if ('textEmotionModel' in settings) {
    const textEmotionModel = toNonEmptyString(settings.textEmotionModel);
    if (textEmotionModel === undefined) {
      throw new Error('textEmotionModel must be a non-empty string');
    }
    normalized.textEmotionModel = textEmotionModel;
  }

  normalizeTrimmedStringSetting(normalized, settings, 'textEmotionCacheDir');

  if ('textEmotionDtype' in settings) {
    const textEmotionDtype = normalizeTextEmotionDtype(
      settings.textEmotionDtype,
    );
    if (textEmotionDtype === undefined) {
      throw new Error(
        `textEmotionDtype must be one of: ${TEXT_EMOTION_DTYPE_VALUES.join(', ')}`,
      );
    }
    normalized.textEmotionDtype = textEmotionDtype;
  }

  normalizeTrimmedStringSetting(normalized, settings, 'embeddingApiUrl');
  normalizeTrimmedStringSetting(normalized, settings, 'embeddingApiModel');
  if ('embeddingApiDims' in settings) {
    normalized.embeddingApiDims = toPositiveInteger(settings.embeddingApiDims);
  }
}

function normalizeWebFetchSettings(
  normalized: EditableSettings,
  settings: EditableSettings,
): void {
  if ('compositionalPolicy' in settings) {
    normalized.compositionalPolicy = normalizeCompositionalPolicyConfig(
      settings.compositionalPolicy,
    );
  }
  normalizeBooleanSetting(normalized, settings, 'webFetchAllowHttp');
  normalizeStringListSetting(normalized, settings, 'webFetchDomainAllowlist');
  normalizeBooleanSetting(normalized, settings, 'webFetchAllowInternalNetwork');
  normalizeBooleanSetting(normalized, settings, 'webFetchLocalCrawlerEnabled');
  normalizeBooleanSetting(
    normalized,
    settings,
    'webFetchLocalCrawlerAllowHttp',
  );
  normalizeStringListSetting(
    normalized,
    settings,
    'webFetchLocalCrawlerHostAllowlist',
  );
  normalizeStringListSetting(
    normalized,
    settings,
    'webFetchLocalCrawlerDomainAllowlist',
  );
  normalizeStringListSetting(normalized, settings, 'webFetchTlsCaCertPaths');
}

function normalizeCapabilityAndSessionSettings(
  normalized: EditableSettings,
  settings: EditableSettings,
): void {
  if ('capabilityTier' in settings) {
    const tier = settings.capabilityTier;
    if (tier !== undefined && isCapabilityTier(tier)) {
      normalized.capabilityTier = tier;
    } else {
      deleteSetting(normalized, 'capabilityTier');
    }
  }

  if ('promotedExtendedTools' in settings) {
    normalized.promotedExtendedTools = toPromotedToolList(
      settings.promotedExtendedTools,
    );
  }

  if ('sessionRestartBehavior' in settings) {
    const behavior = toSessionRestartBehavior(settings.sessionRestartBehavior);
    if (behavior) {
      normalized.sessionRestartBehavior = behavior;
    } else {
      deleteSetting(normalized, 'sessionRestartBehavior');
    }
  }

  normalizeBooleanSetting(normalized, settings, 'sessionMirrorEnabled');
  if ('sessionMirrorMaxChars' in settings) {
    normalized.sessionMirrorMaxChars = toIntegerInRange(
      settings.sessionMirrorMaxChars,
      32,
      1_000_000,
    );
  }
  if ('sessionMirrorActiveWindowMs' in settings) {
    normalized.sessionMirrorActiveWindowMs = toIntegerInRange(
      settings.sessionMirrorActiveWindowMs,
      1_000,
      86_400_000,
    );
  }
  if ('sessionMirrorChannelOverrides' in settings) {
    normalized.sessionMirrorChannelOverrides = normalizeBooleanMap(
      settings.sessionMirrorChannelOverrides,
      'sessionMirrorChannelOverrides',
    );
  }
  if ('continuityMessageLimit' in settings) {
    normalized.continuityMessageLimit = toIntegerInRange(
      settings.continuityMessageLimit,
      1,
      1_000,
    );
  }
}

function normalizeVoiceSettings(
  normalized: EditableSettings,
  settings: EditableSettings,
): void {
  normalizeBooleanSetting(normalized, settings, 'voiceEnabled');
  if ('ttsProvider' in settings) {
    const provider = normalizeTtsProvider(settings.ttsProvider);
    if (provider !== undefined) {
      normalized.ttsProvider = provider;
    } else {
      deleteSetting(normalized, 'ttsProvider');
    }
  }
  normalizeTrimmedStringSetting(normalized, settings, 'voiceId');
  normalizeTrimmedStringSetting(normalized, settings, 'voiceTargetGuildId');
  normalizeTrimmedStringSetting(normalized, settings, 'voiceTargetUserId');
  normalizeTrimmedStringSetting(normalized, settings, 'voiceReadyCueText');
  normalizeTrimmedStringSetting(normalized, settings, 'echoTtsUrl');
  normalizeTrimmedStringSetting(normalized, settings, 'echoTtsVoice');
  normalizeTrimmedStringSetting(normalized, settings, 'echoTtsPreset');
  if ('sttProvider' in settings) {
    const provider = normalizeSttProvider(settings.sttProvider);
    if (provider !== undefined) {
      normalized.sttProvider = provider;
    } else {
      deleteSetting(normalized, 'sttProvider');
    }
  }
  normalizeTrimmedStringSetting(normalized, settings, 'deepgramModel');
  normalizeTrimmedStringSetting(normalized, settings, 'deepgramSttEndpoint');
  normalizeTrimmedStringSetting(normalized, settings, 'deepgramListenEndpoint');
  normalizeTrimmedStringSetting(normalized, settings, 'elevenLabsModelId');
  normalizeTrimmedStringSetting(normalized, settings, 'elevenLabsEndpointBase');
}

function normalizeShardSettings(
  normalized: EditableSettings,
  settings: EditableSettings,
): void {
  if ('wyomingShardRouting' in settings) {
    setSetting(
      normalized,
      'wyomingShardRouting',
      normalizeWyomingShardRoutingConfig(
        getSetting(settings, 'wyomingShardRouting'),
        'wyomingShardRouting',
      ),
    );
  }
  if ('shardToolsets' in settings) {
    setSetting(
      normalized,
      'shardToolsets',
      normalizeShardToolsetConfig(
        getSetting(settings, 'shardToolsets'),
        'shardToolsets',
      ),
    );
  }
}

function normalizeChannelSettings(
  normalized: EditableSettings,
  settings: EditableSettings,
): void {
  if ('discordTriggerWords' in settings) {
    const trimmed = trimStringSetting(settings, 'discordTriggerWords');
    normalized.discordTriggerWords = trimmed || undefined;
  }
  if ('discordTriggerReactions' in settings) {
    const trimmed = trimStringSetting(settings, 'discordTriggerReactions');
    normalized.discordTriggerReactions = trimmed || undefined;
  }
  if ('discordTriggerListenWindowMs' in settings) {
    normalized.discordTriggerListenWindowMs = toIntegerInRange(
      settings.discordTriggerListenWindowMs,
      10_000,
      600_000,
    );
  }
  normalizeBooleanSetting(normalized, settings, 'telegramEnabled');
  if ('telegramAuthorizedUsers' in settings) {
    const trimmed = trimStringSetting(settings, 'telegramAuthorizedUsers');
    normalized.telegramAuthorizedUsers = trimmed || undefined;
  }
}

function normalizeObsidianAndMoaSettings(
  normalized: EditableSettings,
  settings: EditableSettings,
): void {
  if ('obsidianVaultName' in settings) {
    normalized.obsidianVaultName = toNonEmptyString(settings.obsidianVaultName);
  }
  if ('obsidianCliPath' in settings) {
    normalized.obsidianCliPath =
      toNonEmptyString(settings.obsidianCliPath) ?? 'obsidian';
  }
  if ('obsidianAutoPublish' in settings) {
    normalized.obsidianAutoPublish =
      toBoolean(settings.obsidianAutoPublish) ?? false;
  }
  if ('obsidianTimeoutMs' in settings) {
    normalized.obsidianTimeoutMs = toIntegerInRange(
      settings.obsidianTimeoutMs,
      1000,
      30000,
    );
  }

  normalizeBooleanSetting(normalized, settings, 'moaEnabled');
  normalizeStringListSetting(normalized, settings, 'moaReferenceModels');
  if ('moaAggregatorModel' in settings) {
    const trimmed = trimStringSetting(settings, 'moaAggregatorModel');
    normalized.moaAggregatorModel = trimmed || undefined;
  }
}

export function normalizeContextControlSettings(
  settings: EditableSettings,
): EditableSettings {
  const normalized: EditableSettings = { ...settings };
  normalizeBudgetAndThresholdSettings(normalized, settings);
  normalizeRouterAndProfileSettings(normalized, settings);
  normalizeImportProcessingSettings(normalized, settings);
  normalizeEmbeddingSettings(normalized, settings);
  normalizeWebFetchSettings(normalized, settings);
  normalizeCapabilityAndSessionSettings(normalized, settings);
  normalizeEndpointAndGardenSettings(normalized, settings);
  normalizeVoiceSettings(normalized, settings);
  normalizeShardSettings(normalized, settings);
  normalizeChannelSettings(normalized, settings);
  normalizeObsidianAndMoaSettings(normalized, settings);

  return normalized;
}
