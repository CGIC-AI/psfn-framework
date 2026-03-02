import type { LegacyAdminHandlers } from '../handlers-legacy.js';
import type { EnvInfo } from '../types.js';
import { MEMORY_CONFIG } from '../../../memory/types.js';
import {
  loadSettings,
  saveSettings,
  applySettings,
  parseSettingsForm,
  normalizeEditableSettings,
} from '../../../settings.js';
import {
  loadModelsConfig,
  saveModelsConfig,
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
  saveCapabilityTierConfig,
  type CapabilityTierConfig,
} from '../../../config/capability-tier-config.js';
import { resolveRuntimeSchedulerConfig } from '../../../config/scheduler-runtime.js';
import { setRuntimeTrustPolicy } from '../../../trust/runtime-policy.js';
import { CAPABILITY_TIER_VALUES, isCapabilityTier } from '../../../capabilities/tiers.js';
import { isCapabilityToken, type CapabilityToken } from '../../../capabilities/tokens.js';
import { toErrorMessage } from '../../../utils/errors.js';
import * as tpl from '../templates.js';

interface SettingsConfigEditors {
  models: ModelsRuntimeConfig;
  skills: SkillsRuntimeConfig;
  scheduler: SchedulerRuntimeConfig;
  trustPolicy: TrustPolicyConfig;
  capabilities: CapabilityTierConfig;
}

export class AdminSettingsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  private getEnvInfo(): EnvInfo {
    return {
      salienceFloor: MEMORY_CONFIG.salienceFloor,
      maintenanceIntervalMs: MEMORY_CONFIG.maintenanceIntervalMs,
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
    const capabilityTierInput = (params.get('capabilityTier') ?? '').trim();
    if (capabilityTierInput && !isCapabilityTier(capabilityTierInput)) {
      return tpl.settingsFormResult(
        false,
        `capabilityTier must be one of: ${CAPABILITY_TIER_VALUES.join(', ')}`,
      );
    }
    const [settings, errors] = parseSettingsForm(params);

    if (errors.length > 0) {
      return tpl.settingsFormResult(false, errors.join('; '));
    }

    const existing = loadSettings(legacy.config.dataDir);
    const merged = normalizeEditableSettings(
      { ...existing, ...settings },
      { defaultContextWindow: legacy.config.defaultContextWindow },
    );
    saveSettings(legacy.config.dataDir, merged);
    applySettings(legacy.config, merged);
    if (legacy.config.modelCatalog && legacy.config.modelRoleAssignments) {
      try {
        saveModelsConfig(
          legacy.config.dataDir,
          {
            modelCatalog: legacy.config.modelCatalog,
            modelRoleAssignments: legacy.config.modelRoleAssignments,
          },
          { defaultContextWindow: legacy.config.defaultContextWindow },
        );
      } catch (error) {
        const message = toErrorMessage(error);
        return tpl.settingsFormResult(false, `Settings saved but models config write failed: ${message}`);
      }
    }
    try {
      legacy.config.runtimeHooks?.refreshModels?.();
    } catch {
      // Keep settings save successful even if runtime model refresh fails.
      // Next turn will still re-attempt refresh through SubstrateAgent drift detection.
    }

    if (capabilityTierInput) {
      try {
        const current = loadCapabilityTierConfig(legacy.config.dataDir, {
          seedDir: process.env.CONFIG_DIR,
        });

        const customTokens: CapabilityToken[] = [];
        if (capabilityTierInput === 'custom') {
          for (const rawToken of params.getAll('customTokens')) {
            const token = rawToken.trim();
            if (token && isCapabilityToken(token)) {
              customTokens.push(token);
            }
          }
        }

        const saved = saveCapabilityTierConfig(legacy.config.dataDir, {
          ...current,
          tier: capabilityTierInput,
          customTokens: capabilityTierInput === 'custom' ? customTokens : current.customTokens,
        });
        legacy.config.capabilityTier = saved.tier;
        legacy.config.runtimeHooks?.refreshCapabilities?.();
      } catch (error) {
        const message = toErrorMessage(error);
        return tpl.settingsFormResult(false, `Settings saved but capability tier update failed: ${message}`);
      }
    }

    const changedFields = Object.keys(settings).sort();
    if (capabilityTierInput) {
      changedFields.push('capabilityTier');
    }
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
    return JSON.stringify(config, null, 2);
  }

  updateModelsConfig(body: string): string {
    const legacy = this.legacy as any;
    try {
      const payload = this.parseConfigJsonBody(body);
      const saved = saveModelsConfig(
        legacy.config.dataDir,
        payload,
        { defaultContextWindow: legacy.config.defaultContextWindow },
      );
      applySettings(legacy.config, saved);
      try {
        legacy.config.runtimeHooks?.refreshModels?.();
      } catch {
        // Preserve successful save result even when runtime model refresh fails.
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
      const saved = saveCapabilityTierConfig(legacy.config.dataDir, payload);
      legacy.config.capabilityTier = saved.tier;
      legacy.config.runtimeHooks?.refreshCapabilities?.();
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
