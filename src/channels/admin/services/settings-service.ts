import type { SubstrateConfig } from '../../../types.js';
import {
  applySettings,
  type EditableSettings,
  loadSettings,
  normalizeEditableSettings,
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
} from '../../../config/scheduler-config.js';
import {
  loadTrustPolicyConfig,
} from '../../../config/trust-policy-config.js';
import {
  loadCapabilityTierConfig,
  saveCapabilityTierConfig,
} from '../../../config/capability-tier-config.js';
import {
  CAPABILITY_TIER_VALUES,
} from '../../../capabilities/tiers.js';
import { isCapabilityToken, type CapabilityToken } from '../../../capabilities/tokens.js';
import { toErrorMessage } from '../../../utils/errors.js';
import type {
  AdminSettingsData,
  AdminSettingsService,
  ConfigUpdateResult,
  SettingsValidationError,
  SettingsConfigEditors,
} from './types.js';

const IMPORT_ROUTE_MODE_VALUES = new Set(['background', 'openrouter_zdr', 'local_endpoint']);
const SESSION_RESTART_BEHAVIOR_VALUES = new Set(['reuse_latest_session', 'new_session']);
const TTS_PROVIDER_VALUES = new Set(['elevenlabs', 'echo', 'disabled']);
const STT_PROVIDER_VALUES = new Set(['deepgram', 'disabled']);

type SettingsMutationResult =
  | { ok: true }
  | { ok: false; message: string };

export function applyAdminSettingsMutation(options: {
  config: SubstrateConfig;
  settings: EditableSettings;
  capabilityCustomTokens?: readonly CapabilityToken[];
}): SettingsMutationResult {
  const { config, settings, capabilityCustomTokens } = options;

  const existing = loadSettings(config.dataDir);
  const merged = normalizeEditableSettings(
    { ...existing, ...settings },
    { defaultContextWindow: config.defaultContextWindow },
  );

  saveSettings(config.dataDir, merged);
  applySettings(config, merged);

  if (config.modelCatalog && config.modelRoleAssignments) {
    try {
      saveModelsConfig(
        config.dataDir,
        {
          modelCatalog: config.modelCatalog,
          modelRoleAssignments: config.modelRoleAssignments,
        },
        { defaultContextWindow: config.defaultContextWindow },
      );
    } catch (error) {
      return {
        ok: false,
        message: `Settings saved but models config write failed: ${toErrorMessage(error)}`,
      };
    }
  }

  try {
    config.runtimeHooks?.refreshModels?.();
  } catch {
    // Preserve successful settings save even when runtime model refresh fails.
  }

  if (settings.capabilityTier !== undefined) {
    try {
      const current = loadCapabilityTierConfig(config.dataDir, {
        seedDir: process.env.CONFIG_DIR,
      });
      const saved = saveCapabilityTierConfig(config.dataDir, {
        ...current,
        tier: settings.capabilityTier,
        customTokens: settings.capabilityTier === 'custom'
          ? [...(capabilityCustomTokens ?? [])]
          : current.customTokens,
      });
      config.capabilityTier = saved.tier;
      try {
        config.runtimeHooks?.refreshCapabilities?.();
      } catch {
        // Preserve successful settings save even when runtime capability refresh fails.
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

const BOOLEAN_SETTINGS_FIELDS = new Set([
  'importProcessingStrictPolicy',
  'webFetchAllowHttp',
  'webFetchAllowInternalNetwork',
  'webFetchLocalCrawlerEnabled',
  'webFetchLocalCrawlerAllowHttp',
  'discordEnabled',
  'telegramEnabled',
  'obsidianAutoPublish',
  'moaEnabled',
]);

const STRING_ARRAY_SETTINGS_FIELDS = new Set([
  'openRouterProviderOrder',
  'webFetchDomainAllowlist',
  'webFetchLocalCrawlerHostAllowlist',
  'webFetchLocalCrawlerDomainAllowlist',
  'webFetchTlsCaCertPaths',
  'promotedExtendedTools',
  'moaReferenceModels',
]);

export class AdminSettingsDataService implements AdminSettingsService {
  constructor(private readonly deps: {
    config: SubstrateConfig;
  }) {}

  private getEnvInfo() {
    return {
      salienceFloor: Number(process.env.SALIENCE_FLOOR ?? 0.45),
      maintenanceIntervalMs: Number(process.env.MAINTENANCE_INTERVAL_MS ?? this.deps.config.maintenanceIntervalMs),
      discordToken: process.env.DISCORD_TOKEN ? '[set]' : '[not set]',
      apiKey: process.env.API_KEY ? '[set]' : '[not set]',
      adminToken: process.env.ADMIN_TOKEN ? '[set]' : '[not set]',
      openrouterApiKey: process.env.OPENROUTER_API_KEY ? '[set]' : '[not set]',
      litellmBaseUrl: process.env.LITELLM_BASE_URL ? '[set]' : '[not set]',
      litellmApiKey: process.env.LITELLM_API_KEY ? '[set]' : '[not set]',
      ollamaUrl: process.env.OLLAMA_URL ? '[set]' : '[not set]',
      importProcessingLocalApiKey: process.env.IMPORT_PROCESSING_LOCAL_API_KEY ? '[set]' : '[not set]',
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

  private validateSettingsPayload(
    payload: Record<string, unknown>,
    current: Partial<SubstrateConfig>,
  ): SettingsValidationError[] {
    const errors: SettingsValidationError[] = [];

    for (const [field, range] of Object.entries(SETTINGS_VALIDATION)) {
      if (!(field in payload)) continue;
      const value = payload[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        this.pushFieldError(errors, field, `${field} must be ${range.min}-${range.max}`, 'invalid_number');
        continue;
      }
      if (value < range.min || value > range.max) {
        this.pushFieldError(errors, field, `${field} must be ${range.min}-${range.max}`, 'out_of_range');
      }
    }

    for (const field of BOOLEAN_SETTINGS_FIELDS) {
      this.validateBooleanField(payload, field, errors);
    }

    this.validateEnumField(payload, 'importProcessingRouteMode', IMPORT_ROUTE_MODE_VALUES, errors);
    this.validateEnumField(payload, 'sessionRestartBehavior', SESSION_RESTART_BEHAVIOR_VALUES, errors);
    this.validateEnumField(payload, 'capabilityTier', new Set(CAPABILITY_TIER_VALUES), errors);
    this.validateEnumField(payload, 'ttsProvider', TTS_PROVIDER_VALUES, errors);
    this.validateEnumField(payload, 'sttProvider', STT_PROVIDER_VALUES, errors);

    for (const field of STRING_ARRAY_SETTINGS_FIELDS) {
      this.validateStringArrayField(payload, field, errors);
    }

    this.validateHttpUrlField(payload, 'importProcessingLocalEndpointUrl', errors);
    this.validateHttpUrlField(payload, 'chatApiBaseUrl', errors);

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
    await loadSettings(this.deps.config.dataDir);
    const normalizedConfig = normalizeEditableSettings(this.deps.config);
    normalizedConfig.sessionRestartBehavior ??= 'reuse_latest_session';
    return {
      config: normalizedConfig as SubstrateConfig,
      env: this.getEnvInfo(),
      editors: this.loadSettingsConfigEditors(),
    };
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
