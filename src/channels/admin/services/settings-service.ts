import type { SkillsRuntime } from '../../../skills/runtime.js';
import type { SubstrateConfig } from '../../../types.js';
import {
  applySettings,
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
  saveSkillsConfig,
} from '../../../config/skills-config.js';
import {
  loadSchedulerConfig,
  saveSchedulerConfig,
} from '../../../config/scheduler-config.js';
import {
  loadTrustPolicyConfig,
  saveTrustPolicyConfig,
} from '../../../config/trust-policy-config.js';
import {
  loadCapabilityTierConfig,
  saveCapabilityTierConfig,
} from '../../../config/capability-tier-config.js';
import { resolveRuntimeSchedulerConfig } from '../../../config/scheduler-runtime.js';
import { setRuntimeTrustPolicy } from '../../../trust/runtime-policy.js';
import {
  CAPABILITY_TIER_VALUES,
  isCapabilityTier,
} from '../../../capabilities/tiers.js';
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
    skillsRuntime?: SkillsRuntime | null;
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

  private parseConfigJsonBody(body: string): unknown {
    if (!body.trim()) {
      throw new Error('Configuration payload is empty');
    }
    return JSON.parse(body);
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

      const payload = parsed as Partial<SubstrateConfig>;
      const next = {
        ...current,
        ...payload,
      };
      saveSettings(this.deps.config.dataDir, next);
      applySettings(this.deps.config, next);
      return { ok: true, message: 'Settings updated' };
    } catch (error) {
      return { ok: false, message: toErrorMessage(error) };
    }
  }

  updateModelsConfig(body: string): ConfigUpdateResult {
    try {
      const parsed = this.parseConfigJsonBody(body);
      saveModelsConfig(this.deps.config.dataDir, parsed);
      return { ok: true, message: 'models.json updated' };
    } catch (error) {
      return { ok: false, message: toErrorMessage(error) };
    }
  }

  updateSkillsConfig(body: string): ConfigUpdateResult {
    try {
      const parsed = this.parseConfigJsonBody(body);
      saveSkillsConfig(this.deps.config.dataDir, parsed);
      this.deps.skillsRuntime?.invalidateCache();
      return { ok: true, message: 'skills.json updated' };
    } catch (error) {
      return { ok: false, message: toErrorMessage(error) };
    }
  }

  updateSchedulerConfig(body: string): ConfigUpdateResult {
    try {
      const parsed = this.parseConfigJsonBody(body);
      saveSchedulerConfig(this.deps.config.dataDir, parsed);
      const runtimeScheduler = resolveRuntimeSchedulerConfig(this.deps.config.dataDir, this.deps.config);
      this.deps.config.maintenanceIntervalMs = runtimeScheduler.maintenanceIntervalMs;
      this.deps.config.extractionInterval = runtimeScheduler.extractionIntervalMinutes;
      return { ok: true, message: 'scheduler.json updated' };
    } catch (error) {
      return { ok: false, message: toErrorMessage(error) };
    }
  }

  updateTrustPolicyConfig(body: string): ConfigUpdateResult {
    try {
      const parsed = this.parseConfigJsonBody(body);
      saveTrustPolicyConfig(this.deps.config.dataDir, parsed);
      const runtimeTrustPolicy = loadTrustPolicyConfig(this.deps.config.dataDir);
      setRuntimeTrustPolicy(runtimeTrustPolicy);
      return { ok: true, message: 'trust-policy.json updated' };
    } catch (error) {
      return { ok: false, message: toErrorMessage(error) };
    }
  }

  updateCapabilitiesConfig(body: string): ConfigUpdateResult {
    try {
      const parsed = this.parseConfigJsonBody(body);
      saveCapabilityTierConfig(this.deps.config.dataDir, parsed);
      const runtimeCapabilities = loadCapabilityTierConfig(this.deps.config.dataDir);
      const tier = runtimeCapabilities.tier;
      if (!isCapabilityTier(tier)) {
        return {
          ok: false,
          message: `tier must be one of ${CAPABILITY_TIER_VALUES.join(', ')}`,
        };
      }
      this.deps.config.capabilityTier = tier;
      this.deps.config.runtimeHooks?.refreshCapabilities?.();
      return { ok: true, message: 'capability-tier.json updated' };
    } catch (error) {
      return { ok: false, message: toErrorMessage(error) };
    }
  }
}
