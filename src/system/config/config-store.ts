import type {
  RuntimeChannelsConfig,
  RuntimeChannelsConfigOverrides,
} from '../../channels/backplane/config.js';
import {
  loadChannelsOwnerFile,
  loadRuntimeChannelsConfig,
  saveChannelsOwnerFile,
} from '../../channels/backplane/config.js';
import type { EditableSettings } from '../settings/contracts.js';
import { loadSettings, saveSettings } from '../settings/io.js';
import type { BackupJsonConfig } from './backup-config.js';
import { loadBackupConfig, saveBackupConfig } from './backup-config.js';
import type { CapabilityTierConfig } from './capability-tier-config.js';
import {
  loadCapabilityTierConfig,
  saveCapabilityTierConfig,
} from './capability-tier-config.js';
import type { ChargePolicyConfig } from './charge-policy-config.js';
import {
  loadChargePolicyConfig,
  saveChargePolicyConfig,
} from './charge-policy-config.js';
import type { ModelsLoadResult, ModelsRuntimeConfig } from './models-config.js';
import {
  loadModelsConfig,
  saveModelsConfig,
} from './models-config.js';
import type { ProvidersLoadResult, ProvidersRuntimeConfig } from './providers-config.js';
import {
  loadProvidersConfig,
  saveProvidersConfig,
} from './providers-config.js';
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
import {
  loadStartupCapabilityTierOwnerFile,
  loadStartupIntakePolicyOwnerFile,
  loadStartupModelsOwnerFile,
  loadStartupProvidersOwnerFile,
  loadStartupRuntimeSettingsOwnerFile,
  loadStartupSchedulerOwnerFile,
  loadStartupTrustPolicyOwnerFile,
  loadStartupChargePolicyOwnerFile,
  type StartupOwnerFileState,
} from './startup-owner-files.js';
import type { IntakePolicyConfig } from './intake-policy-config.js';
import {
  loadIntakePolicyConfig,
  saveIntakePolicyConfig,
} from './intake-policy-config.js';
import type { TrustPolicyConfig } from './trust-policy-config.js';
import {
  loadTrustPolicyConfig,
  saveTrustPolicyConfig,
} from './trust-policy-config.js';

export interface ConfigStorePort {
  loadRuntimeSettings(): EditableSettings;
  saveRuntimeSettings(settings: EditableSettings): void;
  loadModels(): ModelsRuntimeConfig;
  saveModels(nextConfig: unknown): ModelsRuntimeConfig;
  loadProviders(): ProvidersRuntimeConfig;
  saveProviders(nextConfig: unknown): ProvidersRuntimeConfig;
  loadScheduler(): SchedulerRuntimeConfig;
  saveScheduler(nextConfig: unknown): SchedulerRuntimeConfig;
  loadCapabilityTier(): CapabilityTierConfig;
  saveCapabilityTier(nextConfig: unknown): CapabilityTierConfig;
  loadChargePolicy(): ChargePolicyConfig;
  saveChargePolicy(nextConfig: unknown): ChargePolicyConfig;
  loadChannels(env?: NodeJS.ProcessEnv, overrides?: RuntimeChannelsConfigOverrides): RuntimeChannelsConfig;
  loadChannelsOwnerFile(): Record<string, unknown>;
  saveChannelsOwnerFile(nextConfig: unknown): Record<string, unknown>;
  loadBackup(): BackupJsonConfig;
  saveBackup(nextConfig: unknown): BackupJsonConfig;
  loadSkills(): SkillsRuntimeConfig;
  saveSkills(nextConfig: unknown): SkillsRuntimeConfig;
  loadTrustPolicy(): TrustPolicyConfig;
  saveTrustPolicy(nextConfig: unknown): TrustPolicyConfig;
  loadIntakePolicy(): IntakePolicyConfig;
  saveIntakePolicy(nextConfig: unknown): IntakePolicyConfig;
  loadStartupRuntimeSettings(): Pick<StartupOwnerFileState, 'runtimeSettings' | 'settingsDomains'>;
  loadStartupModels(): ModelsLoadResult;
  loadStartupProviders(): ProvidersLoadResult;
  loadStartupTrustPolicy(): TrustPolicyConfig;
  loadStartupScheduler(): SchedulerRuntimeConfig;
  loadStartupCapabilityTier(): CapabilityTierConfig;
  loadStartupChargePolicy(): ChargePolicyConfig;
  loadStartupIntakePolicy(): IntakePolicyConfig;
}

export interface OwnerFileConfigStoreOptions {
  /** System-owned config root (systemDataDir). Roots the cluster-global owner files. */
  dataDir: string;
  /**
   * Companion-owned config root (companionDataDir). Roots the per-companion
   * owner files — capability-tier.json (bead dnll.2) and scheduler.json (bead
   * dnll.3). When
   * omitted it resolves to {@link OwnerFileConfigStoreOptions.dataDir}, matching
   * the legacy shared-root layout where systemDataDir === companionDataDir. This
   * mirrors `resolveConfiguredCompanionDataDir` and is NOT a config fallback:
   * the underlying loader still fails closed on a missing per-companion file.
   */
  companionDataDir?: string;
  seedDir?: string;
  defaultContextWindow?: number;
}

export function createOwnerFileConfigStore(
  options: OwnerFileConfigStoreOptions,
): ConfigStorePort {
  const loadOptions = options.seedDir ? { seedDir: options.seedDir } : undefined;
  const modelLoadOptions = {
    ...loadOptions,
    defaultContextWindow: options.defaultContextWindow,
  };
  // Whole-file per-companion owners are routed at the companion root, not the
  // shared system root. Their membership is governed by settings-contract.ts.
  const companionDataDir = options.companionDataDir ?? options.dataDir;

  return {
    loadRuntimeSettings: () => loadSettings(options.dataDir, loadOptions),
    saveRuntimeSettings: (settings) => saveSettings(options.dataDir, settings),
    loadModels: () => loadModelsConfig(options.dataDir, modelLoadOptions),
    saveModels: (nextConfig) => saveModelsConfig(options.dataDir, nextConfig, modelLoadOptions),
    loadProviders: () => loadProvidersConfig(options.dataDir, loadOptions),
    saveProviders: (nextConfig) => saveProvidersConfig(options.dataDir, nextConfig),
    loadScheduler: () => loadSchedulerConfig(companionDataDir, loadOptions),
    saveScheduler: (nextConfig) => saveSchedulerConfig(companionDataDir, nextConfig),
    loadCapabilityTier: () => loadCapabilityTierConfig(companionDataDir, loadOptions),
    saveCapabilityTier: (nextConfig) => saveCapabilityTierConfig(companionDataDir, nextConfig),
    loadChargePolicy: () => loadChargePolicyConfig(companionDataDir, loadOptions),
    saveChargePolicy: (nextConfig) => saveChargePolicyConfig(companionDataDir, nextConfig),
    loadChannels: (env, overrides) => loadRuntimeChannelsConfig(
      options.dataDir,
      env,
      overrides,
    ),
    loadChannelsOwnerFile: () => loadChannelsOwnerFile(options.dataDir),
    saveChannelsOwnerFile: (nextConfig) => saveChannelsOwnerFile(options.dataDir, nextConfig),
    loadBackup: () => loadBackupConfig(options.dataDir, loadOptions),
    saveBackup: (nextConfig) => saveBackupConfig(options.dataDir, nextConfig),
    loadSkills: () => loadSkillsConfig(companionDataDir, loadOptions),
    saveSkills: (nextConfig) => saveSkillsConfig(companionDataDir, nextConfig),
    loadTrustPolicy: () => loadTrustPolicyConfig(options.dataDir, loadOptions),
    saveTrustPolicy: (nextConfig) => saveTrustPolicyConfig(options.dataDir, nextConfig),
    loadIntakePolicy: () => loadIntakePolicyConfig(options.dataDir, loadOptions),
    saveIntakePolicy: (nextConfig) => saveIntakePolicyConfig(options.dataDir, nextConfig),
    loadStartupRuntimeSettings: () => loadStartupRuntimeSettingsOwnerFile({
      dataDir: options.dataDir,
      seedDir: options.seedDir,
    }),
    loadStartupModels: () => loadStartupModelsOwnerFile({
      dataDir: options.dataDir,
      seedDir: options.seedDir,
      defaultContextWindow: options.defaultContextWindow,
    }),
    loadStartupProviders: () => loadStartupProvidersOwnerFile({
      dataDir: options.dataDir,
      seedDir: options.seedDir,
    }),
    loadStartupTrustPolicy: () => loadStartupTrustPolicyOwnerFile(options.dataDir, options.seedDir),
    loadStartupScheduler: () => loadStartupSchedulerOwnerFile(companionDataDir, options.seedDir),
    loadStartupCapabilityTier: () => loadStartupCapabilityTierOwnerFile(
      companionDataDir,
      options.seedDir,
    ),
    loadStartupChargePolicy: () => loadStartupChargePolicyOwnerFile(
      companionDataDir,
      options.seedDir,
    ),
    loadStartupIntakePolicy: () => loadStartupIntakePolicyOwnerFile(
      options.dataDir,
      options.seedDir,
    ),
  };
}
