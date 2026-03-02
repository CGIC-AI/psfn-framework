import type { Scheduler } from '../../../scheduler/scheduler.js';
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
import { CAPABILITY_TIER_VALUES, isCapabilityTier } from '../../../capabilities/tiers.js';
import { isCapabilityToken, type CapabilityToken } from '../../../capabilities/tokens.js';
import { toErrorMessage } from '../../../utils/errors.js';
import * as tpl from '../templates.js';
import type { LegacyAdminHandlers } from '../handlers-legacy.js';

export class AdminSettingsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  private get adapter(): any {
    return this.legacy as any;
  }

  async settingsPage(): Promise<string> {
    const envInfo = this.adapter.getEnvInfo();
    const models = this.adapter.modelDiscovery
      ? await this.adapter.modelDiscovery.getAvailableModels().catch(() => undefined)
      : undefined;
    const configEditors = this.adapter.loadSettingsConfigEditors();
    return tpl.layout(
      'Settings',
      tpl.settingsPage(this.adapter.config, envInfo, configEditors, models),
      'settings',
    );
  }

  skillsPage(): string {
    if (!this.adapter.skillsRuntime) {
      return tpl.layout('Skills', '<div class="empty">Skills runtime not configured</div>', 'skills');
    }
    const snapshot = this.adapter.skillsRuntime.getSnapshot();
    return tpl.layout('Skills', tpl.skillsPage(snapshot), 'skills');
  }

  updateSettings(body: string): string {
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

    // Load existing saved settings, merge, save, and apply to live config
    const existing = loadSettings(this.adapter.config.dataDir);
    const merged = normalizeEditableSettings(
      { ...existing, ...settings },
      { defaultContextWindow: this.adapter.config.defaultContextWindow },
    );
    saveSettings(this.adapter.config.dataDir, merged);
    applySettings(this.adapter.config, merged);
    if (this.adapter.config.modelCatalog && this.adapter.config.modelRoleAssignments) {
      try {
        saveModelsConfig(
          this.adapter.config.dataDir,
          {
            modelCatalog: this.adapter.config.modelCatalog,
            modelRoleAssignments: this.adapter.config.modelRoleAssignments,
          },
          { defaultContextWindow: this.adapter.config.defaultContextWindow },
        );
      } catch (error) {
        const message = toErrorMessage(error);
        return tpl.settingsFormResult(false, `Settings saved but models config write failed: ${message}`);
      }
    }
    try {
      this.adapter.config.runtimeHooks?.refreshModels?.();
    } catch {
      // Keep settings save successful even if runtime model refresh fails.
      // Next turn will still re-attempt refresh through SubstrateAgent drift detection.
    }

    if (capabilityTierInput) {
      try {
        const current = loadCapabilityTierConfig(this.adapter.config.dataDir, {
          seedDir: process.env.CONFIG_DIR,
        });

        // Parse custom token grants from form checkboxes
        const customTokens: CapabilityToken[] = [];
        if (capabilityTierInput === 'custom') {
          for (const rawToken of params.getAll('customTokens')) {
            const token = rawToken.trim();
            if (token && isCapabilityToken(token)) {
              customTokens.push(token);
            }
          }
        }

        const saved = saveCapabilityTierConfig(this.adapter.config.dataDir, {
          ...current,
          tier: capabilityTierInput,
          customTokens: capabilityTierInput === 'custom' ? customTokens : current.customTokens,
        });
        this.adapter.config.capabilityTier = saved.tier;
        this.adapter.config.runtimeHooks?.refreshCapabilities?.();
      } catch (error) {
        const message = toErrorMessage(error);
        return tpl.settingsFormResult(false, `Settings saved but capability tier update failed: ${message}`);
      }
    }

    const changedFields = Object.keys(settings).sort();
    if (capabilityTierInput) {
      changedFields.push('capabilityTier');
    }
    this.adapter.appendAuditTimelineEntry(
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
    const config = loadModelsConfig(this.adapter.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
      defaultContextWindow: this.adapter.config.defaultContextWindow,
    });
    return JSON.stringify(config, null, 2);
  }

  updateModelsConfig(body: string): string {
    try {
      const payload = this.adapter.parseConfigJsonBody(body);
      const saved = saveModelsConfig(
        this.adapter.config.dataDir,
        payload,
        { defaultContextWindow: this.adapter.config.defaultContextWindow },
      );
      applySettings(this.adapter.config, saved);
      try {
        this.adapter.config.runtimeHooks?.refreshModels?.();
      } catch {
        // Preserve successful save result even when runtime model refresh fails.
      }
      return tpl.settingsFormResult(true, 'models.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.adapter.formatConfigError(error));
    }
  }

  skillsConfigJson(): string {
    const config = loadSkillsConfig(this.adapter.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
    });
    return JSON.stringify(config, null, 2);
  }

  updateSkillsConfig(body: string): string {
    try {
      const payload = this.adapter.parseConfigJsonBody(body);
      saveSkillsConfig(this.adapter.config.dataDir, payload);
      this.adapter.skillsRuntime?.invalidate();
      return tpl.settingsFormResult(true, 'skills.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.adapter.formatConfigError(error));
    }
  }

  schedulerConfigJson(): string {
    const config = loadSchedulerConfig(this.adapter.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
    });
    return JSON.stringify(config, null, 2);
  }

  updateSchedulerConfig(body: string): string {
    try {
      const payload = this.adapter.parseConfigJsonBody(body);
      saveSchedulerConfig(this.adapter.config.dataDir, payload);
      const resolved = resolveRuntimeSchedulerConfig({
        dataDir: this.adapter.config.dataDir,
        seedDir: process.env.CONFIG_DIR,
      });

      this.adapter.config.maintenanceIntervalMs = resolved.salienceDecayIntervalMs;

      const schedulerWithConfig = this.adapter.scheduler as Scheduler & {
        updateConfig?: (config: { tickIntervalMs?: number; heartbeatIntervalMs?: number }) => void;
      };
      schedulerWithConfig.updateConfig?.({
        tickIntervalMs: resolved.tickIntervalMs,
        heartbeatIntervalMs: resolved.heartbeatIntervalMs,
      });
      this.adapter.scheduler.updateTask('heartbeat', { intervalMs: resolved.heartbeatIntervalMs });
      this.adapter.scheduler.updateTask('salience-decay', { intervalMs: resolved.salienceDecayIntervalMs });

      return tpl.settingsFormResult(true, 'scheduler.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.adapter.formatConfigError(error));
    }
  }

  trustPolicyConfigJson(): string {
    const config = loadTrustPolicyConfig(this.adapter.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
    });
    return JSON.stringify(config, null, 2);
  }

  updateTrustPolicyConfig(body: string): string {
    try {
      const payload = this.adapter.parseConfigJsonBody(body);
      const saved = saveTrustPolicyConfig(this.adapter.config.dataDir, payload);
      setRuntimeTrustPolicy(saved);
      return tpl.settingsFormResult(true, 'trust-policy.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.adapter.formatConfigError(error));
    }
  }

  capabilitiesConfigJson(): string {
    const config = loadCapabilityTierConfig(this.adapter.config.dataDir, {
      seedDir: process.env.CONFIG_DIR,
    });
    return JSON.stringify(config, null, 2);
  }

  updateCapabilitiesConfig(body: string): string {
    try {
      const payload = this.adapter.parseConfigJsonBody(body);
      const saved = saveCapabilityTierConfig(this.adapter.config.dataDir, payload);
      this.adapter.config.capabilityTier = saved.tier;
      this.adapter.config.runtimeHooks?.refreshCapabilities?.();
      return tpl.settingsFormResult(true, 'capability-tier.json saved');
    } catch (error) {
      return tpl.settingsFormResult(false, this.adapter.formatConfigError(error));
    }
  }

  async modelListJson(): Promise<string> {
    if (!this.adapter.modelDiscovery) return '[]';
    const models = await this.adapter.modelDiscovery.getAvailableModels().catch(() => []);
    return JSON.stringify(models);
  }

  async refreshModels(): Promise<string> {
    if (!this.adapter.modelDiscovery) return '[]';
    this.adapter.modelDiscovery.invalidateCache();
    const models = await this.adapter.modelDiscovery.getAvailableModels().catch(() => []);
    return JSON.stringify(models);
  }
}
