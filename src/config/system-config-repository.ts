import type { ProcessEnv } from 'node:process';
import type { RuntimeChannelsConfigOverrides, RuntimeChannelsConfig } from '../channels/config.js';
import { loadRuntimeChannelsConfig } from '../channels/config.js';
import type { CapabilityTierConfig } from './capability-tier-config.js';
import {
  loadCapabilityTierConfig,
  saveCapabilityTierConfig,
} from './capability-tier-config.js';
import type { ModelsRuntimeConfig } from './models-config.js';
import {
  loadModelsConfig,
  saveModelsConfig,
} from './models-config.js';
import type { SchedulerRuntimeConfig } from './scheduler-config.js';
import {
  loadSchedulerConfig,
  saveSchedulerConfig,
} from './scheduler-config.js';
import type { SkillsRuntimeConfig } from './skills-config.js';
import {
  loadSkillsConfig,
  saveSkillsConfig,
} from './skills-config.js';
import type { TrustPolicyConfig } from './trust-policy-config.js';
import {
  loadTrustPolicyConfig,
  saveTrustPolicyConfig,
} from './trust-policy-config.js';
import type { EditableSettings } from '../settings/contracts.js';
import { loadSettings, saveSettings } from '../settings/io.js';

export interface SystemConfigRepositoryOptions {
  dataDir: string;
  seedDir?: string;
  defaultContextWindow?: number;
}

export interface SystemConfigRepository {
  loadRuntimeSettings(): EditableSettings;
  saveRuntimeSettings(settings: EditableSettings): void;
  loadModels(): ModelsRuntimeConfig;
  saveModels(nextConfig: unknown): ModelsRuntimeConfig;
  loadScheduler(): SchedulerRuntimeConfig;
  saveScheduler(nextConfig: unknown): SchedulerRuntimeConfig;
  loadCapabilityTier(): CapabilityTierConfig;
  saveCapabilityTier(nextConfig: unknown): CapabilityTierConfig;
  loadChannels(env?: ProcessEnv, overrides?: RuntimeChannelsConfigOverrides): RuntimeChannelsConfig;
  loadSkills(): SkillsRuntimeConfig;
  saveSkills(nextConfig: unknown): SkillsRuntimeConfig;
  loadTrustPolicy(): TrustPolicyConfig;
  saveTrustPolicy(nextConfig: unknown): TrustPolicyConfig;
}

export function createSystemConfigRepository(
  options: SystemConfigRepositoryOptions,
): SystemConfigRepository {
  const loadOptions = options.seedDir ? { seedDir: options.seedDir } : undefined;
  const modelLoadOptions = {
    ...loadOptions,
    defaultContextWindow: options.defaultContextWindow,
  };

  return {
    loadRuntimeSettings: () => loadSettings(options.dataDir, loadOptions),
    saveRuntimeSettings: (settings) => saveSettings(options.dataDir, settings),
    loadModels: () => loadModelsConfig(options.dataDir, modelLoadOptions),
    saveModels: (nextConfig) => saveModelsConfig(options.dataDir, nextConfig, modelLoadOptions),
    loadScheduler: () => loadSchedulerConfig(options.dataDir, loadOptions),
    saveScheduler: (nextConfig) => saveSchedulerConfig(options.dataDir, nextConfig),
    loadCapabilityTier: () => loadCapabilityTierConfig(options.dataDir, loadOptions),
    saveCapabilityTier: (nextConfig) => saveCapabilityTierConfig(options.dataDir, nextConfig),
    loadChannels: (env, overrides) => loadRuntimeChannelsConfig(
      options.dataDir,
      env,
      overrides,
    ),
    loadSkills: () => loadSkillsConfig(options.dataDir, loadOptions),
    saveSkills: (nextConfig) => saveSkillsConfig(options.dataDir, nextConfig),
    loadTrustPolicy: () => loadTrustPolicyConfig(options.dataDir, loadOptions),
    saveTrustPolicy: (nextConfig) => saveTrustPolicyConfig(options.dataDir, nextConfig),
  };
}
