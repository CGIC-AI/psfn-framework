import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import {
  applySettings,
  type EditableSettings,
  hasModelSettings,
  MOOD_CONGRUENCE_WEIGHT_RANGE,
  normalizeEditableSettings,
  REMOVED_RUNTIME_SETTINGS_KEYS,
  splitSettingsByDomain,
  SETTINGS_VALIDATION,
} from '../../../system/settings.js';
import type { ConfigStorePort } from '../../../system/config/config-store.js';
import {
  applyProvidersRuntimeConfig,
} from '../../../system/config/providers-config.js';
import {
  buildSettingsContractData,
  IMPORT_PROCESSING_ROUTE_MODE_VALUES,
  SESSION_RESTART_BEHAVIOR_VALUES,
  SETTINGS_BOOLEAN_FIELDS,
  SETTINGS_OWNER_FILE_BY_FIELD,
  SETTINGS_STRING_ARRAY_FIELDS,
} from '../../../system/config/settings-contract.js';
import {
  validateCompositionalPolicyConfig,
} from '../../../system/capabilities/compositional-policy.js';
import { normalizeImageWorkflowSettings } from '../../../primitives/images/types.js';
import { isCapabilityToken, type CapabilityToken } from '../../../system/capabilities/tokens.js';
import { MEMORY_CONFIG } from '../../../faculties/memory/types.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import {
  getStreamingSttProviderMetadata,
  isStreamingSttProvider,
  isStreamingSttProviderConfigured,
  listStreamingSttProviders,
} from '../../../primitives/voice/connectors/stt/index.js';
import {
  getStreamingTtsProviderMetadata,
  isStreamingTtsProvider,
  isStreamingTtsProviderConfigured,
  listStreamingTtsProviders,
} from '../../../primitives/voice/connectors/tts/index.js';
import type {
  AdminSettingsData,
  AdminSettingsDivergence,
  AdminSettingsStatus,
  AdminSettingsService,
  AdminVoiceProviderData,
  AdminVoiceProviderOption,
  ConfigUpdateResult,
  SettingsValidationError,
  SettingsConfigEditors,
} from './types.js';

const IMPORT_ROUTE_MODE_VALUES = new Set(IMPORT_PROCESSING_ROUTE_MODE_VALUES);
const SESSION_RESTART_BEHAVIOR_VALUES_SET = new Set(SESSION_RESTART_BEHAVIOR_VALUES);
const REMOVED_RUNTIME_SETTINGS_MESSAGES: Partial<Record<string, string>> = {
  memoryBudgetPct:
    'memoryBudgetPct has been removed; use sessionHistoryBudgetPct, memoryRetrievalBudgetPct, and extractionThresholdPct instead',
  defaultContextWindow:
    'defaultContextWindow has been removed from runtime settings; set per-model context windows in models.json instead',
  sessionMessageLimit:
    'sessionMessageLimit has been removed; session history now trims by token budget only',
  memoryRetrievalLimit:
    'memoryRetrievalLimit has been removed; memory retrieval now trims by token budget only',
  discordEnabled:
    'discordEnabled has been removed from runtime settings; Discord activation is controlled by DISCORD_TOKEN and DISCORD_BOT_ID',
  discordHeartbeatChannel:
    'discordHeartbeatChannel has been removed from runtime settings; use channels.json -> discord.heartbeatChannelId instead',
};
const log = createComponentLogger('AdminSettingsService');

type SettingsMutationResult =
  | { ok: true; refreshedKeys: AdminSettingsDivergence['key'][]; divergences: AdminSettingsDivergence[] }
  | { ok: false; message: string };

function refreshModels(config: SubstrateConfig): AdminSettingsDivergence | null {
  try {
    config.runtimeHooks?.refreshModels?.();
    return null;
  } catch (error) {
    const message = toErrorMessage(error);
    log.warn('Runtime model refresh hook failed after settings mutation', { error: message });
    return {
      key: 'models',
      state: 'diverged',
      detail: `models.json persisted but live model refresh failed: ${message}`,
      updatedAt: Date.now(),
    };
  }
}

function refreshCapabilities(config: SubstrateConfig): AdminSettingsDivergence | null {
  try {
    config.runtimeHooks?.refreshCapabilities?.();
    return null;
  } catch (error) {
    const message = toErrorMessage(error);
    log.warn('Runtime capability refresh hook failed after settings mutation', { error: message });
    return {
      key: 'capabilities',
      state: 'diverged',
      detail: `capability-tier.json persisted but live capability refresh failed: ${message}`,
      updatedAt: Date.now(),
    };
  }
}

export function applyAdminModelsConfigMutation(options: {
  config: SubstrateConfig;
  configStore: ConfigStorePort;
  payload: unknown;
}): SettingsMutationResult {
  const { config, configStore, payload } = options;
  try {
    const saved = configStore.saveModels(payload);
    applySettings(config, saved);
    const divergence = refreshModels(config);
    return {
      ok: true,
      refreshedKeys: ['models'],
      divergences: divergence ? [divergence] : [],
    };
  } catch (error) {
    return {
      ok: false,
      message: toErrorMessage(error),
    };
  }
}

export function applyAdminCapabilityTierMutation(options: {
  config: SubstrateConfig;
  configStore: ConfigStorePort;
  payload: unknown;
}): SettingsMutationResult {
  const { config, configStore, payload } = options;
  try {
    const saved = configStore.saveCapabilityTier(payload);
    config.capabilityTier = saved.tier;
    const divergence = refreshCapabilities(config);
    return {
      ok: true,
      refreshedKeys: ['capabilities'],
      divergences: divergence ? [divergence] : [],
    };
  } catch (error) {
    return {
      ok: false,
      message: toErrorMessage(error),
    };
  }
}

export function applyAdminSettingsMutation(options: {
  config: SubstrateConfig;
  configStore: ConfigStorePort;
  settings: EditableSettings;
  capabilityCustomTokens?: readonly CapabilityToken[];
}): SettingsMutationResult {
  const { config, configStore, settings, capabilityCustomTokens } = options;
  const refreshedKeys = new Set<AdminSettingsDivergence['key']>();
  const divergences: AdminSettingsDivergence[] = [];

  const currentRuntimeSettings = splitSettingsByDomain(configStore.loadRuntimeSettings()).runtime;
  const domainSplit = splitSettingsByDomain(settings);

  const mergedRuntimeSettings = normalizeEditableSettings(
    { ...currentRuntimeSettings, ...domainSplit.runtime },
    { defaultContextWindow: config.defaultContextWindow },
  );

  configStore.saveRuntimeSettings(mergedRuntimeSettings);
  applySettings(config, mergedRuntimeSettings);

  if (Object.hasOwn(domainSplit.runtime, 'openRouterModelsApiUrl')) {
    try {
      const currentProviders = configStore.loadProviders();
      const nextRegistry = structuredClone(currentProviders.registry);
      const openrouterProvider = nextRegistry.providers.find((entry) => entry.type === 'openrouter');
      const nextUrl = mergedRuntimeSettings.openRouterModelsApiUrl?.trim();
      if (openrouterProvider && nextUrl) {
        openrouterProvider.modelsApiUrl = nextUrl;
        const savedProviders = configStore.saveProviders(nextRegistry);
        applyProvidersRuntimeConfig(config, savedProviders);
      }
    } catch (error) {
      return {
        ok: false,
        message: `Settings saved but providers config update failed: ${toErrorMessage(error)}`,
      };
    }
  }

  if (hasModelSettings(domainSplit.models)) {
    try {
      const currentModels = configStore.loadModels();
      const modelPatch: EditableSettings = { ...domainSplit.models };
      const hasPrimaryAliasPatch = modelPatch.primaryModel !== undefined
        || modelPatch.primaryProvider !== undefined
        || modelPatch.primaryMaxTokens !== undefined;
      if (hasPrimaryAliasPatch) {
        const currentPrimary = config.modelRoster.chat ?? {
          model: config.primaryModel,
          provider: config.primaryProvider,
          maxTokens: config.primaryMaxTokens,
        };
        modelPatch.primaryModel ??= currentPrimary.model;
        modelPatch.primaryProvider ??= currentPrimary.provider;
        modelPatch.primaryMaxTokens ??= currentPrimary.maxTokens;
      }
      const hasExtractionAliasPatch = modelPatch.extractionModel !== undefined
        || modelPatch.extractionProvider !== undefined
        || modelPatch.extractionMaxTokens !== undefined;
      if (hasExtractionAliasPatch) {
        const currentExtraction = config.modelRoster.background ?? {
          model: config.extractionModel,
          provider: config.extractionProvider,
          maxTokens: config.extractionMaxTokens,
        };
        modelPatch.extractionModel ??= currentExtraction.model;
        modelPatch.extractionProvider ??= currentExtraction.provider;
        modelPatch.extractionMaxTokens ??= currentExtraction.maxTokens;
      }

      const mergedModelSettings = normalizeEditableSettings(
        {
          modelCatalog: currentModels.modelCatalog,
          modelRoleAssignments: currentModels.modelRoleAssignments,
          ...modelPatch,
        },
        { defaultContextWindow: config.defaultContextWindow },
      );
      const modelMutation = applyAdminModelsConfigMutation({
        config,
        configStore,
        payload: {
          modelCatalog: mergedModelSettings.modelCatalog ?? currentModels.modelCatalog,
          modelRoleAssignments: mergedModelSettings.modelRoleAssignments ?? currentModels.modelRoleAssignments,
        },
      });
      if (!modelMutation.ok) {
        return {
          ok: false,
          message: `Settings saved but models config update failed: ${modelMutation.message}`,
        };
      }
      for (const key of modelMutation.refreshedKeys) {
        refreshedKeys.add(key);
      }
      divergences.push(...modelMutation.divergences);
    } catch (error) {
      return {
        ok: false,
        message: `Settings saved but models config update failed: ${toErrorMessage(error)}`,
      };
    }
  }

  if (domainSplit.maintenanceIntervalMs !== undefined) {
    try {
      const currentScheduler = configStore.loadScheduler();
      const savedScheduler = configStore.saveScheduler({
        ...currentScheduler,
        salienceDecayIntervalMs: domainSplit.maintenanceIntervalMs,
      });
      config.maintenanceIntervalMs = savedScheduler.salienceDecayIntervalMs;
    } catch (error) {
      return {
        ok: false,
        message: `Settings saved but scheduler update failed: ${toErrorMessage(error)}`,
      };
    }
  }

  if (domainSplit.capabilityTier !== undefined) {
    try {
      const currentCapabilities = configStore.loadCapabilityTier();
      const capabilityMutation = applyAdminCapabilityTierMutation({
        config,
        configStore,
        payload: {
          ...currentCapabilities,
          tier: domainSplit.capabilityTier,
          customTokens: domainSplit.capabilityTier === 'custom'
            ? [...(capabilityCustomTokens ?? [])]
            : currentCapabilities.customTokens,
        },
      });
      if (!capabilityMutation.ok) {
        return {
          ok: false,
          message: `Settings saved but capability tier update failed: ${capabilityMutation.message}`,
        };
      }
      for (const key of capabilityMutation.refreshedKeys) {
        refreshedKeys.add(key);
      }
      divergences.push(...capabilityMutation.divergences);
    } catch (error) {
      return {
        ok: false,
        message: `Settings saved but capability tier update failed: ${toErrorMessage(error)}`,
      };
    }
  }

  return { ok: true, refreshedKeys: [...refreshedKeys], divergences };
}

export class AdminSettingsDataService implements AdminSettingsService {
  private readonly divergences = new Map<AdminSettingsDivergence['key'], AdminSettingsDivergence>();

  constructor(private readonly deps: {
    config: SubstrateConfig;
    configStore: ConfigStorePort;
  }) {}

  private updateDivergences(
    refreshedKeys: readonly AdminSettingsDivergence['key'][],
    divergences: readonly AdminSettingsDivergence[],
  ): AdminSettingsStatus {
    for (const key of refreshedKeys) {
      this.divergences.delete(key);
    }
    for (const divergence of divergences) {
      this.divergences.set(divergence.key, divergence);
    }
    return this.buildSettingsStatus();
  }

  private buildSettingsStatus(): AdminSettingsStatus {
    const divergences = [...this.divergences.values()].sort((a, b) => a.key.localeCompare(b.key));
    if (divergences.length === 0) {
      return {
        status: 'healthy',
        detail: 'Persisted settings match the live Garden runtime.',
        divergences: [],
      };
    }

    return {
      status: 'degraded',
      detail: divergences.map(entry => entry.detail).join(' '),
      divergences,
    };
  }

  private buildSuccessfulSaveResult(baseMessage: string, status: AdminSettingsStatus): ConfigUpdateResult {
    return {
      ok: true,
      message: status.status === 'degraded'
        ? `${baseMessage} with divergence: ${status.detail}`
        : baseMessage,
      status,
    };
  }

  private getEnvInfo() {
    return {
      salienceFloor: Number(process.env.SALIENCE_FLOOR ?? MEMORY_CONFIG.salienceFloor),
      maintenanceIntervalMs: this.deps.config.maintenanceIntervalMs,
      discordToken: process.env.DISCORD_TOKEN ? '[set]' : '[not set]',
      apiKey: this.deps.config.localApiKey ? '[set]' : '[not set]',
      adminToken: this.deps.config.adminAuthToken ? '[set]' : '[not set]',
      openrouterApiKey: process.env.OPENROUTER_API_KEY ? '[set]' : '[not set]',
      litellmBaseUrl: process.env.LITELLM_BASE_URL ? '[set]' : '[not set]',
      litellmApiKey: process.env.LITELLM_API_KEY ? '[set]' : '[not set]',
      importProcessingLocalApiKey: process.env.IMPORT_PROCESSING_LOCAL_API_KEY ? '[set]' : '[not set]',
      falApiKey: process.env.FAL_API_KEY ? '[set]' : '[not set]',
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ? '[set]' : '[not set]',
    };
  }

  private loadSettingsConfigEditors(): SettingsConfigEditors {
    return {
      models: this.deps.configStore.loadModels(),
      providers: this.deps.configStore.loadProviders(),
      channels: this.deps.configStore.loadChannelsOwnerFile(),
      skills: this.deps.configStore.loadSkills(),
      scheduler: this.deps.configStore.loadScheduler(),
      trustPolicy: this.deps.configStore.loadTrustPolicy(),
      capabilities: this.deps.configStore.loadCapabilityTier(),
      chargePolicy: this.deps.configStore.loadChargePolicy(),
      backup: this.deps.configStore.loadBackup(),
    };
  }

  private buildVoiceProviderOptionList(kind: 'stt' | 'tts'): AdminVoiceProviderOption[] {
    if (kind === 'stt') {
      return listStreamingSttProviders()
        .map((providerId) => {
          const metadata = getStreamingSttProviderMetadata(providerId);
          return {
            id: providerId,
            configured: isStreamingSttProviderConfigured(providerId, this.deps.config),
            requiredTokens: [...(metadata?.eligibility?.requiredTokens ?? [])],
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    return listStreamingTtsProviders()
      .map((providerId) => {
        const metadata = getStreamingTtsProviderMetadata(providerId);
        return {
          id: providerId,
          configured: isStreamingTtsProviderConfigured(providerId, this.deps.config),
          requiredTokens: [...(metadata?.eligibility?.requiredTokens ?? [])],
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private loadVoiceProviderData(): AdminVoiceProviderData {
    return {
      stt: this.buildVoiceProviderOptionList('stt'),
      tts: this.buildVoiceProviderOptionList('tts'),
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private buildValidationResult(errors: SettingsValidationError[]): ConfigUpdateResult {
    return {
      ok: false,
      message: errors.map(error => error.message).join('; '),
      validationErrors: errors,
    };
  }

  private pushFieldError(
    errors: SettingsValidationError[],
    field: string,
    message: string,
    code: string,
  ): void {
    errors.push({ field, message, code });
  }

  private validateBooleanField(
    payload: Record<string, unknown>,
    field: string,
    errors: SettingsValidationError[],
  ): void {
    if (!(field in payload)) return;
    if (typeof payload[field] !== 'boolean') {
      this.pushFieldError(errors, field, `${field} must be true or false`, 'invalid_type');
    }
  }

  private validateEnumField(
    payload: Record<string, unknown>,
    field: string,
    allowedValues: Set<string>,
    errors: SettingsValidationError[],
  ): void {
    if (!(field in payload)) return;
    const value = payload[field];
    if (typeof value !== 'string' || !allowedValues.has(value)) {
      this.pushFieldError(
        errors,
        field,
        `${field} must be one of: ${Array.from(allowedValues).join(', ')}`,
        'invalid_enum',
      );
    }
  }

  private validateSttProviderField(
    payload: Record<string, unknown>,
    errors: SettingsValidationError[],
  ): void {
    if (!('sttProvider' in payload)) return;
    const value = payload.sttProvider;
    if (typeof value !== 'string') {
      this.pushFieldError(errors, 'sttProvider', 'sttProvider must be a string', 'invalid_type');
      return;
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      this.pushFieldError(
        errors,
        'sttProvider',
        'sttProvider must be "disabled" or a registered STT provider id',
        'invalid_stt_provider',
      );
      return;
    }

    if (normalized !== 'disabled' && !isStreamingSttProvider(normalized)) {
      this.pushFieldError(
        errors,
        'sttProvider',
        'sttProvider must be "disabled" or a registered STT provider id',
        'invalid_stt_provider',
      );
    }
  }

  private validateTtsProviderField(
    payload: Record<string, unknown>,
    errors: SettingsValidationError[],
  ): void {
    if (!('ttsProvider' in payload)) return;
    const value = payload.ttsProvider;
    if (typeof value !== 'string') {
      this.pushFieldError(errors, 'ttsProvider', 'ttsProvider must be a string', 'invalid_type');
      return;
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      this.pushFieldError(
        errors,
        'ttsProvider',
        'ttsProvider must be "disabled" or a registered TTS provider id',
        'invalid_tts_provider',
      );
      return;
    }

    if (normalized !== 'disabled' && !isStreamingTtsProvider(normalized)) {
      this.pushFieldError(
        errors,
        'ttsProvider',
        'ttsProvider must be "disabled" or a registered TTS provider id',
        'invalid_tts_provider',
      );
    }
  }

  private validateStringArrayField(
    payload: Record<string, unknown>,
    field: string,
    errors: SettingsValidationError[],
  ): void {
    if (!(field in payload)) return;
    const value = payload[field];
    const isValidArray = Array.isArray(value)
      && value.every(entry => typeof entry === 'string');
    if (!isValidArray) {
      this.pushFieldError(errors, field, `${field} must be an array of strings`, 'invalid_type');
    }
  }

  private validateNonEmptyStringField(
    payload: Record<string, unknown>,
    field: string,
    errors: SettingsValidationError[],
  ): void {
    if (!(field in payload)) return;
    const value = payload[field];
    if (typeof value !== 'string') {
      this.pushFieldError(errors, field, `${field} must be a string`, 'invalid_type');
      return;
    }
    if (!value.trim()) {
      this.pushFieldError(errors, field, `${field} cannot be empty`, 'required');
    }
  }

  private validateHttpUrlField(
    payload: Record<string, unknown>,
    field: string,
    errors: SettingsValidationError[],
  ): void {
    if (!(field in payload)) return;
    const value = payload[field];
    if (typeof value !== 'string') {
      this.pushFieldError(errors, field, `${field} must be a string`, 'invalid_type');
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) return;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        this.pushFieldError(errors, field, `${field} must use http or https`, 'invalid_url');
      }
    } catch {
      this.pushFieldError(errors, field, `${field} must be a valid URL`, 'invalid_url');
    }
  }

  private validateCompositionalPolicyField(
    payload: Record<string, unknown>,
    errors: SettingsValidationError[],
  ): void {
    if (!('compositionalPolicy' in payload)) return;
    for (const message of validateCompositionalPolicyConfig(payload.compositionalPolicy)) {
      const separatorIndex = message.indexOf(' ');
      const field = separatorIndex > 0 ? message.slice(0, separatorIndex) : 'compositionalPolicy';
      this.pushFieldError(
        errors,
        field,
        message,
        message.includes('must be') ? 'invalid_type' : 'invalid_value',
      );
    }
  }

  private validateImageWorkflowsField(
    payload: Record<string, unknown>,
    errors: SettingsValidationError[],
  ): void {
    if (!('imageWorkflows' in payload)) return;
    try {
      normalizeImageWorkflowSettings(payload.imageWorkflows);
    } catch (error) {
      this.pushFieldError(
        errors,
        'imageWorkflows',
        error instanceof Error ? error.message : 'imageWorkflows is invalid',
        'invalid_object',
      );
    }
  }

  private validateModelCatalogRouting(
    payload: Record<string, unknown>,
    errors: SettingsValidationError[],
  ): void {
    if (!('modelCatalog' in payload)) return;
    if (!this.isRecord(payload.modelCatalog)) return;

    for (const [slotKey, rawEntry] of Object.entries(payload.modelCatalog)) {
      if (!this.isRecord(rawEntry) || !('routing' in rawEntry)) continue;
      const fieldPrefix = `modelCatalog.${slotKey}.routing`;
      if (!this.isRecord(rawEntry.routing)) {
        this.pushFieldError(errors, fieldPrefix, `${fieldPrefix} must be an object`, 'invalid_type');
        continue;
      }

      if (!('providerOrder' in rawEntry.routing)) continue;
      const providerOrder = rawEntry.routing.providerOrder;
      const isValid = Array.isArray(providerOrder)
        && providerOrder.every(entry => typeof entry === 'string');
      if (!isValid) {
        this.pushFieldError(
          errors,
          `${fieldPrefix}.providerOrder`,
          `${fieldPrefix}.providerOrder must be an array of strings`,
          'invalid_type',
        );
      }
    }
  }

  private validateNumberRangeField(
    payload: Record<string, unknown>,
    field: string,
    range: { min: number; max: number },
    errors: SettingsValidationError[],
  ): void {
    if (!(field in payload)) return;
    const value = payload[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.pushFieldError(errors, field, `${field} must be ${range.min}-${range.max}`, 'invalid_number');
      return;
    }
    if (value < range.min || value > range.max) {
      this.pushFieldError(errors, field, `${field} must be ${range.min}-${range.max}`, 'out_of_range');
    }
  }

  private validateSettingsPayload(
    payload: Record<string, unknown>,
    current: Partial<SubstrateConfig>,
  ): SettingsValidationError[] {
    const errors: SettingsValidationError[] = [];

    for (const [field, owner] of SETTINGS_OWNER_FILE_BY_FIELD.entries()) {
      if (!(field in payload)) continue;
      this.pushFieldError(
        errors,
        field,
        `${field} is owned by ${owner}; edit that canonical config instead`,
        'wrong_owner',
      );
    }

    for (const field of REMOVED_RUNTIME_SETTINGS_KEYS) {
      if (!(field in payload)) continue;
      this.pushFieldError(
        errors,
        field,
        REMOVED_RUNTIME_SETTINGS_MESSAGES[field]
          ?? `${field} has been removed from runtime settings`,
        'removed_field',
      );
    }

    for (const [field, range] of Object.entries(SETTINGS_VALIDATION)) {
      if (!(field in payload)) continue;
      if (SETTINGS_OWNER_FILE_BY_FIELD.has(field)) continue;
      const value = payload[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        this.pushFieldError(errors, field, `${field} must be ${range.min}-${range.max}`, 'invalid_number');
        continue;
      }
      if (value < range.min || value > range.max) {
        this.pushFieldError(errors, field, `${field} must be ${range.min}-${range.max}`, 'out_of_range');
      }
    }

    for (const field of SETTINGS_BOOLEAN_FIELDS) {
      this.validateBooleanField(payload, field, errors);
    }

    this.validateEnumField(payload, 'importProcessingRouteMode', IMPORT_ROUTE_MODE_VALUES, errors);
    this.validateEnumField(payload, 'sessionRestartBehavior', SESSION_RESTART_BEHAVIOR_VALUES_SET, errors);
    this.validateTtsProviderField(payload, errors);
    this.validateSttProviderField(payload, errors);

    for (const field of SETTINGS_STRING_ARRAY_FIELDS) {
      this.validateStringArrayField(payload, field, errors);
    }

    this.validateNonEmptyStringField(payload, 'uiThemeId', errors);

    this.validateHttpUrlField(payload, 'importProcessingLocalEndpointUrl', errors);
    this.validateHttpUrlField(payload, 'chatApiBaseUrl', errors);
    this.validateHttpUrlField(payload, 'comfyUiBaseUrl', errors);
    this.validateCompositionalPolicyField(payload, errors);
    this.validateImageWorkflowsField(payload, errors);
    this.validateModelCatalogRouting(payload, errors);
    this.validateNumberRangeField(payload, 'moodCongruenceWeight', MOOD_CONGRUENCE_WEIGHT_RANGE, errors);

    const effectiveRouteMode = typeof payload.importProcessingRouteMode === 'string'
      ? payload.importProcessingRouteMode
      : current.importProcessingRouteMode ?? 'background';
    const effectiveLocalEndpointUrl = typeof payload.importProcessingLocalEndpointUrl === 'string'
      ? payload.importProcessingLocalEndpointUrl
      : current.importProcessingLocalEndpointUrl ?? '';
    const effectiveLocalModel = typeof payload.importProcessingLocalModel === 'string'
      ? payload.importProcessingLocalModel
      : current.importProcessingLocalModel ?? '';
    if (effectiveRouteMode === 'local_endpoint') {
      if (!effectiveLocalEndpointUrl.trim()) {
        this.pushFieldError(
          errors,
          'importProcessingLocalEndpointUrl',
          'importProcessingLocalEndpointUrl is required when importProcessingRouteMode=local_endpoint',
          'required',
        );
      }
      if (!effectiveLocalModel.trim()) {
        this.pushFieldError(
          errors,
          'importProcessingLocalModel',
          'importProcessingLocalModel is required when importProcessingRouteMode=local_endpoint',
          'required',
        );
      }
    }

    return errors;
  }

  private parseCapabilityCustomTokens(payload: Record<string, unknown>): CapabilityToken[] | undefined {
    if (!Array.isArray(payload.customTokens)) return undefined;
    return payload.customTokens
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter((entry): entry is CapabilityToken => isCapabilityToken(entry));
  }

  async getSettingsData(): Promise<AdminSettingsData> {
    const runtimeConfig = splitSettingsByDomain(this.deps.configStore.loadRuntimeSettings()).runtime;
    runtimeConfig.sessionRestartBehavior ??= 'reuse_latest_session';
    return {
      config: runtimeConfig,
      env: this.getEnvInfo(),
      editors: this.loadSettingsConfigEditors(),
      voiceProviders: this.loadVoiceProviderData(),
      status: this.buildSettingsStatus(),
    };
  }

  getSettingsContractData() {
    return buildSettingsContractData({
      sttProviderIds: listStreamingSttProviders(),
      ttsProviderIds: listStreamingTtsProviders(),
    });
  }

  updateSettings(body: string): ConfigUpdateResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        ok: false,
        message: 'Request body must be valid JSON',
        validationErrors: [{ field: '$root', message: 'Request body must be valid JSON', code: 'invalid_json' }],
      };
    }

    if (!this.isRecord(parsed)) {
      return {
        ok: false,
        message: 'Settings payload must be a JSON object',
        validationErrors: [{ field: '$root', message: 'Settings payload must be a JSON object', code: 'invalid_payload' }],
      };
    }

    try {
      const current = this.deps.configStore.loadRuntimeSettings();
      const validationErrors = this.validateSettingsPayload(parsed, current as Partial<SubstrateConfig>);
      if (validationErrors.length > 0) {
        return this.buildValidationResult(validationErrors);
      }

      const payload = parsed as EditableSettings;
      const mutationResult = applyAdminSettingsMutation({
        config: this.deps.config,
        configStore: this.deps.configStore,
        settings: payload,
        capabilityCustomTokens: this.parseCapabilityCustomTokens(parsed),
      });
      if (!mutationResult.ok) {
        return { ok: false, message: mutationResult.message };
      }
      const status = this.updateDivergences(mutationResult.refreshedKeys, mutationResult.divergences);
      return this.buildSuccessfulSaveResult('Settings updated', status);
    } catch (error) {
      return { ok: false, message: toErrorMessage(error) };
    }
  }

  /**
   * Returns the raw pretty-printed JSON for a named settings subsystem.
   * Returns null when the key is unknown.
   */
  getSubConfigJson(key: string): string | null {
    try {
      switch (key) {
        case 'settings':
          return JSON.stringify(this.deps.configStore.loadRuntimeSettings(), null, 2);
        case 'models':
          return JSON.stringify(this.deps.configStore.loadModels(), null, 2);
        case 'providers':
          return JSON.stringify(this.deps.configStore.loadProviders().registry, null, 2);
        case 'skills':
          return JSON.stringify(this.deps.configStore.loadSkills(), null, 2);
        case 'scheduler':
          return JSON.stringify(this.deps.configStore.loadScheduler(), null, 2);
        case 'trust-policy':
          return JSON.stringify(this.deps.configStore.loadTrustPolicy(), null, 2);
        case 'capabilities':
          return JSON.stringify(this.deps.configStore.loadCapabilityTier(), null, 2);
        case 'charge-policy':
          return JSON.stringify(this.deps.configStore.loadChargePolicy(), null, 2);
        case 'channels':
          return JSON.stringify(this.deps.configStore.loadChannelsOwnerFile(), null, 2);
        case 'backup':
          return JSON.stringify(this.deps.configStore.loadBackup(), null, 2);
        default:
          return null;
      }
    } catch (error) {
      log.warn('Failed to load sub-config JSON', { key, error: toErrorMessage(error) });
      return null;
    }
  }

  /**
   * Validates and saves a named settings subsystem from raw JSON.
   * Returns a ConfigUpdateResult.
   */
  saveSubConfigJson(key: string, json: string): ConfigUpdateResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, message: 'configJson must be valid JSON' };
    }

    try {
      switch (key) {
        case 'models': {
          const result = applyAdminModelsConfigMutation({
            config: this.deps.config,
            configStore: this.deps.configStore,
            payload: parsed,
          });
          return result.ok
            ? this.buildSuccessfulSaveResult(
              'models.json saved',
              this.updateDivergences(result.refreshedKeys, result.divergences),
            )
            : { ok: false, message: result.message };
        }
        case 'scheduler': {
          const saved = this.deps.configStore.saveScheduler(parsed);
          this.deps.config.maintenanceIntervalMs = saved.salienceDecayIntervalMs;
          return { ok: true, message: 'scheduler.json saved' };
        }
        case 'capabilities': {
          const result = applyAdminCapabilityTierMutation({
            config: this.deps.config,
            configStore: this.deps.configStore,
            payload: parsed,
          });
          return result.ok
            ? this.buildSuccessfulSaveResult(
              'capability-tier.json saved',
              this.updateDivergences(result.refreshedKeys, result.divergences),
            )
            : { ok: false, message: result.message };
        }
        case 'charge-policy': {
          const saved = this.deps.configStore.saveChargePolicy(parsed);
          this.deps.config.chargePolicy = saved;
          return { ok: true, message: 'charge-policy.json saved' };
        }
        case 'backup': {
          this.deps.configStore.saveBackup(parsed);
          return { ok: true, message: 'backup.json saved' };
        }
        case 'providers': {
          const saved = this.deps.configStore.saveProviders(parsed);
          applyProvidersRuntimeConfig(this.deps.config, saved);
          const refreshDivergence = refreshModels(this.deps.config);
          const status = this.updateDivergences(['models'], refreshDivergence ? [refreshDivergence] : []);
          return this.buildSuccessfulSaveResult('providers.json saved', status);
        }
        case 'channels': {
          this.deps.configStore.saveChannelsOwnerFile(parsed);
          return { ok: true, message: 'channels.json saved' };
        }
        case 'skills': {
          this.deps.configStore.saveSkills(parsed);
          return { ok: true, message: 'skills.json saved' };
        }
        case 'trust-policy': {
          this.deps.configStore.saveTrustPolicy(parsed);
          return { ok: true, message: 'trust-policy.json saved' };
        }
        default:
          return { ok: false, message: `Unknown settings subsystem: ${key}` };
      }
    } catch (error) {
      return { ok: false, message: toErrorMessage(error) };
    }
  }
}
