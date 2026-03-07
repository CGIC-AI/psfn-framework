import type { LegacyAdminHandlers } from '../handlers-legacy.js';
import type { EnvInfo } from '../types.js';
import { MEMORY_CONFIG } from '../../../memory/types.js';
import {
  parseSettingsForm,
} from '../../../settings.js';
import {
  loadModelsConfig,
  type ModelsRuntimeConfig,
} from '../../../config/models-config.js';
import {
  loadSkillsConfig,
  saveSkillsConfig,
  type SkillsRuntimeConfig,
} from '../../../config/skills-config.js';
import {
  loadSchedulerConfig,
  saveSchedulerConfig,
  type SchedulerRuntimeConfig,
} from '../../../config/scheduler-config.js';
import {
  loadTrustPolicyConfig,
  saveTrustPolicyConfig,
  type TrustPolicyConfig,
} from '../../../config/trust-policy-config.js';
import {
  loadCapabilityTierConfig,
  type CapabilityTierConfig,
} from '../../../config/capability-tier-config.js';
import { resolveRuntimeSchedulerConfig } from '../../../config/scheduler-runtime.js';
import { setRuntimeTrustPolicy } from '../../../trust/runtime-policy.js';
import { isCapabilityToken, type CapabilityToken } from '../../../capabilities/tokens.js';
import { toErrorMessage } from '../../../utils/errors.js';
import {
  applyAdminCapabilityTierMutation,
  applyAdminModelsConfigMutation,
  applyAdminSettingsMutation,
} from '../services/settings-service.js';
import * as tpl from '../templates.js';

interface SettingsConfigEditors {
  models: ModelsRuntimeConfig;
  skills: SkillsRuntimeConfig;
  scheduler: SchedulerRuntimeConfig;
  trustPolicy: TrustPolicyConfig;
  capabilities: CapabilityTierConfig;
}

const LEGACY_MODEL_SETTINGS_FORM_KEYS = [
  'primaryModel',
  'primaryProvider',
  'primaryMaxTokens',
  'extractionModel',
  'extractionProvider',
  'extractionMaxTokens',
  'modelCatalogJson',
  'modelRoleAssignmentsJson',
  'modelRosterJson',
] as const;

function hasLegacyModelFormPayload(params: URLSearchParams): boolean {
  for (const key of LEGACY_MODEL_SETTINGS_FORM_KEYS) {
    const raw = params.get(key);
    if (raw === null) continue;
    if (raw.trim().length > 0) {
      return true;
    }
  }
  return false;
}

export class AdminSettingsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  private getEnvInfo(): EnvInfo {
    return {
      salienceFloor: MEMORY_CONFIG.salienceFloor,
      maintenanceIntervalMs: (this.legacy as any).config.maintenanceIntervalMs,
      discordToken: process.env.DISCORD_TOKEN ? 'configured' : 'not set',
      apiKey: process.env.API_KEY ? 'configured' : 'not set',
      adminToken: process.env.ADMIN_TOKEN ? 'configured' : 'not set',
      openrouterApiKey: process.env.OPENROUTER_API_KEY ? 'configured' : 'not set',
      litellmBaseUrl: process.env.LITELLM_BASE_URL ? 'configured' : 'not set',
      litellmApiKey: process.env.LITELLM_API_KEY ? 'configured' : 'not set',
      ollamaUrl: process.env.OLLAMA_URL ? 'configured' : 'not set',
      importProcessingLocalApiKey: process.env.IMPORT_PROCESSING_LOCAL_API_KEY ? 'configured' : 'not set',
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'not set',
    };
  }

  private loadSettingsConfigEditors(): SettingsConfigEditors {
    const legacy = this.legacy as any;
    return {
      models: loadModelsConfig(legacy.config.dataDir, {
        seedDir: process.env.CONFIG_DIR,
        defaultContextWindow: legacy.config.defaultContextWindow,
      }),
      skills: loadSkillsConfig(legacy.config.dataDir, {
        seedDir: process.env.CONFIG_DIR,
      }),
      scheduler: loadSchedulerConfig(legacy.config.dataDir, {
        seedDir: process.env.CONFIG_DIR,
      }),
      trustPolicy: loadTrustPolicyConfig(legacy.config.dataDir, {
        seedDir: process.env.CONFIG_DIR,
      }),
      capabilities: loadCapabilityTierConfig(legacy.config.dataDir, {
        seedDir: process.env.CONFIG_DIR,
      }),
    };
  }

  private parseConfigJsonBody(body: string): unknown {
    const params = new URLSearchParams(body);
    const configJson = (params.get('configJson') ?? '').trim();
    if (!configJson) {
      throw new Error('configJson is required');
    }

    try {
      return JSON.parse(configJson);
    } catch {
      throw new Error('configJson must be valid JSON');
    }
  }

  private formatConfigError(error: unknown): string {
    return toErrorMessage(error);
  }

  async settingsPage(): Promise<string> {
    const legacy = this.legacy as any;
    const envInfo = this.getEnvInfo();
    const models = legacy.modelDiscovery
      ? await legacy.modelDiscovery.getAvailableModels().catch(() => undefined)
      : undefined;
    const configEditors = this.loadSettingsConfigEditors();
    return tpl.layout('Settings', tpl.settingsPage(legacy.config, envInfo, configEditors, models), 'settings');
  }

  skillsPage(): string {
    const legacy = this.legacy as any;
    if (!legacy.skillsRuntime) {
      return tpl.layout('Skills', '<div class="empty">Skills runtime not configured</div>', 'skills');
    }
    const snapshot = legacy.skillsRuntime.getSnapshot();
    return tpl.layout('Skills', tpl.skillsPage(snapshot), 'skills');
  }

  updateSettings(body: string): string {
    const legacy = this.legacy as any;
    const params = new URLSearchParams(body);
    if (hasLegacyModelFormPayload(params)) {
      return tpl.settingsFormResult(
        false,
        'Legacy model settings are not accepted in runtime settings; edit canonical models.json via /api/settings/models',
      );
    }
    const [settings, errors] = parseSettingsForm(params);

    if (errors.length > 0) {
      return tpl.settingsFormResult(false, errors.join('; '));
    }

    let capabilityCustomTokens: CapabilityToken[] | undefined;
    if (settings.capabilityTier === 'custom') {
      capabilityCustomTokens = [];
      for (const rawToken of params.getAll('customTokens')) {
        const token = rawToken.trim();
        if (token && isCapabilityToken(token)) {
          capabilityCustomTokens.push(token);
        }
      }
    }

    const mutationResult = applyAdminSettingsMutation({
      config: legacy.config,
      settings,
      capabilityCustomTokens,
    });
    if (!mutationResult.ok) {
      return tpl.settingsFormResult(false, mutationResult.message);
    }

    const changedFields = Object.keys(settings).sort();
    legacy.appendAuditTimelineEntry(
      'settings_change',
      'allowed',
      'Operator updated runtime settings.',
      [
        changedFields.length > 0 ? `fields=${changedFields.join(',')}` : null,
      ],
      'operator',
    );

    return tpl.settingsFormResult(true, 'Settings saved');
  }

  modelsConfigJson(): string {
    const legacy = this.legacy as any;
    const config = loadModelsConfig(legacy.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
      defaultContextWindow: legacy.config.defaultContextWindow,
    });
    return JSON.stringify(config.modelRegistry, null, 2);
  }

  updateModelsConfig(body: string): string {
    const legacy = this.legacy as any;
    try {
      const payload = this.parseConfigJsonBody(body);
      const mutation = applyAdminModelsConfigMutation({
        config: legacy.config,
        payload,
      });
      if (!mutation.ok) {
        return tpl.settingsFormResult(false, mutation.message);
      }
      return tpl.settingsFormResult(true, 'models.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.formatConfigError(error));
    }
  }

  skillsConfigJson(): string {
    const legacy = this.legacy as any;
    const config = loadSkillsConfig(legacy.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
    });
    return JSON.stringify(config, null, 2);
  }

  updateSkillsConfig(body: string): string {
    const legacy = this.legacy as any;
    try {
      const payload = this.parseConfigJsonBody(body);
      saveSkillsConfig(legacy.config.dataDir, payload);
      legacy.skillsRuntime?.invalidate();
      return tpl.settingsFormResult(true, 'skills.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.formatConfigError(error));
    }
  }

  schedulerConfigJson(): string {
    const legacy = this.legacy as any;
    const config = loadSchedulerConfig(legacy.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
    });
    return JSON.stringify(config, null, 2);
  }

  updateSchedulerConfig(body: string): string {
    const legacy = this.legacy as any;
    try {
      const payload = this.parseConfigJsonBody(body);
      saveSchedulerConfig(legacy.config.dataDir, payload);
      const resolved = resolveRuntimeSchedulerConfig({
        dataDir: legacy.config.dataDir,
        seedDir: process.env.CONFIG_DIR,
      });

      legacy.config.maintenanceIntervalMs = resolved.salienceDecayIntervalMs;

      const schedulerWithConfig = legacy.scheduler as {
        updateConfig?: (config: { tickIntervalMs?: number; heartbeatIntervalMs?: number }) => void;
      };
      schedulerWithConfig.updateConfig?.({
        tickIntervalMs: resolved.tickIntervalMs,
        heartbeatIntervalMs: resolved.heartbeatIntervalMs,
      });
      legacy.scheduler.updateTask('heartbeat', { intervalMs: resolved.heartbeatIntervalMs });
      legacy.scheduler.updateTask('salience-decay', { intervalMs: resolved.salienceDecayIntervalMs });

      return tpl.settingsFormResult(true, 'scheduler.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.formatConfigError(error));
    }
  }

  trustPolicyConfigJson(): string {
    const legacy = this.legacy as any;
    const config = loadTrustPolicyConfig(legacy.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
    });
    return JSON.stringify(config, null, 2);
  }

  updateTrustPolicyConfig(body: string): string {
    const legacy = this.legacy as any;
    try {
      const payload = this.parseConfigJsonBody(body);
      const saved = saveTrustPolicyConfig(legacy.config.dataDir, payload);
      setRuntimeTrustPolicy(saved);
      return tpl.settingsFormResult(true, 'trust-policy.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.formatConfigError(error));
    }
  }

  capabilitiesConfigJson(): string {
    const legacy = this.legacy as any;
    const config = loadCapabilityTierConfig(legacy.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
    });
    return JSON.stringify(config, null, 2);
  }

  updateCapabilitiesConfig(body: string): string {
    const legacy = this.legacy as any;
    try {
      const payload = this.parseConfigJsonBody(body);
      const mutation = applyAdminCapabilityTierMutation({
        config: legacy.config,
        payload,
      });
      if (!mutation.ok) {
        return tpl.settingsFormResult(false, mutation.message);
      }
      return tpl.settingsFormResult(true, 'capability-tier.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.formatConfigError(error));
    }
  }

  async modelListJson(): Promise<string> {
    const legacy = this.legacy as any;
    if (!legacy.modelDiscovery) return '[]';
    const models = await legacy.modelDiscovery.getAvailableModels().catch(() => []);
    return JSON.stringify(models);
  }

  async refreshModels(): Promise<string> {
    const legacy = this.legacy as any;
    if (!legacy.modelDiscovery) return '[]';
    legacy.modelDiscovery.invalidateCache();
    const models = await legacy.modelDiscovery.getAvailableModels().catch(() => []);
    return JSON.stringify(models);
  }
}
