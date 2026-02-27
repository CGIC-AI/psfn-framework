import type { SkillsRuntime } from '../../../skills/runtime.js';
import type { SubstrateConfig } from '../../../types.js';
import {
  applySettings,
  loadSettings,
  normalizeEditableSettings,
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
  SettingsConfigEditors,
} from './types.js';

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

  async getSettingsData(): Promise<AdminSettingsData> {
    await loadSettings(this.deps.config.dataDir);
    return {
      config: normalizeEditableSettings(this.deps.config),
      env: this.getEnvInfo(),
      editors: this.loadSettingsConfigEditors(),
    };
  }

  updateSettings(body: string): ConfigUpdateResult {
    let payload: Partial<SubstrateConfig>;
    try {
      payload = JSON.parse(body) as Partial<SubstrateConfig>;
    } catch {
      return { ok: false, message: 'Request body must be valid JSON' };
    }

    try {
      const current = loadSettings(this.deps.config.dataDir);
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
      const tier = runtimeCapabilities.defaultTier;
      if (!isCapabilityTier(tier)) {
        return {
          ok: false,
          message: `defaultTier must be one of ${CAPABILITY_TIER_VALUES.join(', ')}`,
        };
      }
      return { ok: true, message: 'capability-tier.json updated' };
    } catch (error) {
      return { ok: false, message: toErrorMessage(error) };
    }
  }
}
