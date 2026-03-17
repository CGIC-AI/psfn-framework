import type { SubstrateConfig } from '../../../types.js';
import {
  applySettings,
  type EditableSettings,
  hasModelSettings,
  loadSettings,
  MOOD_CONGRUENCE_WEIGHT_RANGE,
  normalizeEditableSettings,
  REMOVED_RUNTIME_SETTINGS_KEYS,
  splitSettingsByDomain,
  SETTINGS_VALIDATION,
  saveSettings,
} from '../../../settings.js';
import {
  loadModelsConfig,
  saveModelsConfig,
} from '../../../config/models-config.js';
import {
  loadSkillsConfig,
} from '../../../config/skills-config.js';
import {
  loadSchedulerConfig,
  saveSchedulerConfig,
} from '../../../config/scheduler-config.js';
import {
  loadTrustPolicyConfig,
} from '../../../config/trust-policy-config.js';
import {
  loadCapabilityTierConfig,
  saveCapabilityTierConfig,
} from '../../../config/capability-tier-config.js';
import {
  buildSettingsContractData,
  IMPORT_PROCESSING_ROUTE_MODE_VALUES,
  SESSION_RESTART_BEHAVIOR_VALUES,
  SETTINGS_BOOLEAN_FIELDS,
  SETTINGS_OWNER_FILE_BY_FIELD,
  SETTINGS_STRING_ARRAY_FIELDS,
} from '../../../config/settings-contract.js';
import {
  validateCompositionalPolicyConfig,
} from '../../../compositional/policy.js';
import { isCapabilityToken, type CapabilityToken } from '../../../capabilities/tokens.js';
import { MEMORY_CONFIG } from '../../../memory/types.js';
import { createComponentLogger } from '../../../logger.js';
import { toErrorMessage } from '../../../utils/errors.js';
import {
  getStreamingSttProviderMetadata,
  isStreamingSttProvider,
  isStreamingSttProviderConfigured,
  listStreamingSttProviders,
} from '../../../voice/connectors/stt/index.js';
import {
  getStreamingTtsProviderMetadata,
  isStreamingTtsProvider,
  isStreamingTtsProviderConfigured,
  listStreamingTtsProviders,
} from '../../../voice/connectors/tts/index.js';
import type {
  AdminSettingsData,
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
};
const log = createComponentLogger('AdminSettingsService');

type SettingsMutationResult =
  | { ok: true }
  | { ok: false; message: string };

function refreshModels(config: SubstrateConfig): void {
  try {
    config.runtimeHooks?.refreshModels?.();
  } catch (error) {
    log.warn('Runtime model refresh hook failed after settings mutation', {
      error: toErrorMessage(error),
    });
  }
}

function refreshCapabilities(config: SubstrateConfig): void {
  try {
    config.runtimeHooks?.refreshCapabilities?.();
  } catch (error) {
    log.warn('Runtime capability refresh hook failed after settings mutation', {
      error: toErrorMessage(error),
    });
  }
}

export function applyAdminModelsConfigMutation(options: {
  config: SubstrateConfig;
  payload: unknown;
}): SettingsMutationResult {
  const { config, payload } = options;
  try {
    const saved = saveModelsConfig(
      config.dataDir,
      payload,
      { defaultContextWindow: config.defaultContextWindow },
    );
    applySettings(config, saved);
    refreshModels(config);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: toErrorMessage(error),
    };
  }
}

export function applyAdminCapabilityTierMutation(options: {
  config: SubstrateConfig;
  payload: unknown;
}): SettingsMutationResult {
  const { config, payload } = options;
  try {
    const saved = saveCapabilityTierConfig(config.dataDir, payload);
    config.capabilityTier = saved.tier;
    refreshCapabilities(config);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: toErrorMessage(error),
    };
  }
}

export function applyAdminSettingsMutation(options: {
  config: SubstrateConfig;
  settings: EditableSettings;
  capabilityCustomTokens?: readonly CapabilityToken[];
}): SettingsMutationResult {
  const { config, settings, capabilityCustomTokens } = options;

  const currentRuntimeSettings = splitSettingsByDomain(loadSettings(config.dataDir)).runtime;
  const domainSplit = splitSettingsByDomain(settings);

  const mergedRuntimeSettings = normalizeEditableSettings(
    { ...currentRuntimeSettings, ...domainSplit.runtime },
    { defaultContextWindow: config.defaultContextWindow },
  );

  saveSettings(config.dataDir, mergedRuntimeSettings);
  applySettings(config, mergedRuntimeSettings);

  if (hasModelSettings(domainSplit.models)) {
    try {
      const currentModels = loadModelsConfig(config.dataDir, {
        seedDir: process.env.CONFIG_DIR,
        defaultContextWindow: config.defaultContextWindow,
      });
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
    } catch (error) {
      return {
        ok: false,
        message: `Settings saved but models config update failed: ${toErrorMessage(error)}`,
      };
    }
  }

  if (domainSplit.maintenanceIntervalMs !== undefined) {
    try {
      const currentScheduler = loadSchedulerConfig(config.dataDir, {
        seedDir: process.env.CONFIG_DIR,
      });
      const savedScheduler = saveSchedulerConfig(config.dataDir, {
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
      const currentCapabilities = loadCapabilityTierConfig(config.dataDir, {
        seedDir: process.env.CONFIG_DIR,
      });
      const capabilityMutation = applyAdminCapabilityTierMutation({
        config,
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
    } catch (error) {
      return {
        ok: false,
        message: `Settings saved but capability tier update failed: ${toErrorMessage(error)}`,
      };
    }
  }

  return { ok: true };
}

export class AdminSettingsDataService implements AdminSettingsService {
  constructor(private readonly deps: {
    config: SubstrateConfig;
  }) {}

  private getEnvInfo() {
    return {
      salienceFloor: Number(process.env.SALIENCE_FLOOR ?? MEMORY_CONFIG.salienceFloor),
      maintenanceIntervalMs: this.deps.config.maintenanceIntervalMs,
      discordToken: process.env.DISCORD_TOKEN ? '[set]' : '[not set]',
      apiKey: process.env.API_KEY ? '[set]' : '[not set]',
      adminToken: process.env.ADMIN_TOKEN ? '[set]' : '[not set]',
      openrouterApiKey: process.env.OPENROUTER_API_KEY ? '[set]' : '[not set]',
      litellmBaseUrl: process.env.LITELLM_BASE_URL ? '[set]' : '[not set]',
      litellmApiKey: process.env.LITELLM_API_KEY ? '[set]' : '[not set]',
      ollamaUrl: process.env.OLLAMA_URL ? '[set]' : '[not set]',
      importProcessingLocalApiKey: process.env.IMPORT_PROCESSING_LOCAL_API_KEY ? '[set]' : '[not set]',
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ? '[set]' : '[not set]',
    };
  }

  private loadSettingsConfigEditors(): SettingsConfigEditors {
    return {
      models: loadModelsConfig(this.deps.config.dataDir),
      skills: loadSkillsConfig(this.deps.config.dataDir),
      scheduler: loadSchedulerConfig(this.deps.config.dataDir),
      trustPolicy: loadTrustPolicyConfig(this.deps.config.dataDir),
      capabilities: loadCapabilityTierConfig(this.deps.config.dataDir),
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
    this.validateCompositionalPolicyField(payload, errors);
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
    const runtimeConfig = splitSettingsByDomain(loadSettings(this.deps.config.dataDir)).runtime;
    runtimeConfig.sessionRestartBehavior ??= 'reuse_latest_session';
    return {
      config: runtimeConfig,
      env: this.getEnvInfo(),
      editors: this.loadSettingsConfigEditors(),
      voiceProviders: this.loadVoiceProviderData(),
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
      const current = loadSettings(this.deps.config.dataDir);
      const validationErrors = this.validateSettingsPayload(parsed, current as Partial<SubstrateConfig>);
      if (validationErrors.length > 0) {
        return this.buildValidationResult(validationErrors);
      }

      const payload = parsed as EditableSettings;
      const mutationResult = applyAdminSettingsMutation({
        config: this.deps.config,
        settings: payload,
        capabilityCustomTokens: this.parseCapabilityCustomTokens(parsed),
      });
      if (!mutationResult.ok) {
        return { ok: false, message: mutationResult.message };
      }
      return { ok: true, message: 'Settings updated' };
    } catch (error) {
      return { ok: false, message: toErrorMessage(error) };
    }
  }
}
