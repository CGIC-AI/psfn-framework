import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { CapabilityTier } from '../../../system/config/runtime-config-contracts.js';
import {
  applySettings,
  type EditableSettings,
  type SettingsDomainSplit,
} from '../../../system/settings.js';
import {
  createEmbeddingDimensionMismatchWarning,
  type EmbeddingDimensionValidationResult,
} from '../../../persistence/backups/startup-checks.js';
import type { RuntimeChannelsConfigOverrides } from '../../../channels/backplane/config.js';
import { createEnvCredentialVault } from '../../../boundary/custody/credential-vault.js';
import {
  createOwnerFileConfigStore,
  type ConfigStorePort,
} from '../../../system/config/config-store.js';
import { type ModelsLoadResult } from '../../../system/config/models-config.js';
import {
  applyProvidersRuntimeConfig,
  type ProvidersLoadResult,
} from '../../../system/config/providers-config.js';
import { CAPABILITY_TIER_FILE_NAME } from '../../../system/config/capability-tier-config.js';
import { SCHEDULER_FILE_NAME, type SchedulerRuntimeConfig } from '../../../system/config/scheduler-config.js';
import { type TrustPolicyConfig } from '../../../system/config/trust-policy-config.js';
import { setRuntimeTrustPolicy } from '../../../system/trust/runtime-policy.js';
import {
  resolveRuntimePathSnapshotFromConfig,
  type RuntimePathSnapshot,
} from '../../../persistence/layout.js';
import {
  assertPersistenceCutoverReady,
  buildPersistenceCutoverOptionsFromConfig,
} from '../../../persistence/cutover.js';
export type {
  RuntimeVoiceConnectorBinding,
  RuntimeVoiceProviderGate,
  RuntimeVoiceProviderGateOptions,
  RuntimeVoiceSttConnectorOptions,
  RuntimeVoiceSttProvider,
  RuntimeVoiceTtsConnectorOptions,
  RuntimeVoiceTtsProvider,
} from './voice-provider-runtime.js';
export {
  createRuntimeVoiceSttConnector,
  createRuntimeVoiceTtsConnector,
  resolveRuntimeVoiceProviderGate,
  resolveRuntimeVoiceSttProvider,
  resolveRuntimeVoiceTtsProvider,
  resolveRuntimeVoiceTtsProviderOrder,
} from './voice-provider-runtime.js';

type LegacyMigrationState = 'none' | 'migrated' | 'drift_detected' | 'error';

export interface StartupHydrationLegacyMigrationDiagnostics {
  state: LegacyMigrationState;
  settingsValue?: number | CapabilityTier;
  storedValue?: number | CapabilityTier;
  error?: string;
}

export interface StartupConfigHydrationDiagnostics {
  modelsMigratedFromLegacySettings: boolean;
  modelsLegacyDriftDetected: boolean;
  providersMigratedFromLegacyConfig: boolean;
  providersLegacyDriftDetected: boolean;
  maintenanceIntervalMigration: StartupHydrationLegacyMigrationDiagnostics;
  capabilityTierMigration: StartupHydrationLegacyMigrationDiagnostics;
  removedLegacyKeys: string[];
  settingsRewriteError?: string;
}

export interface StartupConfigHydrationResult {
  systemDataDir: string;
  companionDataDir: string;
  runtimePathLayout: RuntimePathSnapshot['runtimePathLayout'];
  pathSnapshot: RuntimePathSnapshot;
  settingsDomains: SettingsDomainSplit;
  modelsLoadResult: ModelsLoadResult;
  providersLoadResult: ProvidersLoadResult;
  trustPolicyConfig: TrustPolicyConfig;
  schedulerConfig: SchedulerRuntimeConfig;
  diagnostics: StartupConfigHydrationDiagnostics;
}

export interface StartupConfigHydrationOptions {
  env?: NodeJS.ProcessEnv;
  secretAuthority?: 'gateway' | 'agent';
  configStore?: ConfigStorePort;
}

export function buildRuntimeChannelsConfigOverrides(
  config: SubstrateConfig,
  settings: EditableSettings,
): RuntimeChannelsConfigOverrides {
  const telegramOverride: RuntimeChannelsConfigOverrides['telegram'] = {};

  if (Object.hasOwn(settings, 'telegramEnabled')) {
    telegramOverride.enabled = config.telegramEnabled ?? false;
  }
  if (Object.hasOwn(settings, 'telegramAuthorizedUsers')) {
    telegramOverride.allowedUsers = config.telegramAuthorizedUsers
      ? [...config.telegramAuthorizedUsers]
      : [];
  }

  if (telegramOverride.enabled === undefined && telegramOverride.allowedUsers === undefined) {
    return {};
  }

  return {
    telegram: telegramOverride,
  };
}

export function createEmbeddingDimensionMismatchFatalMessage(
  result: EmbeddingDimensionValidationResult,
): string | null {
  const mismatchWarning = createEmbeddingDimensionMismatchWarning(result);
  if (!mismatchWarning) return null;
  return `${mismatchWarning.message}: configured=${mismatchWarning.configuredDims}, stored=${mismatchWarning.storedDims}. ${mismatchWarning.recommendation}`;
}

function createDefaultConfigStore(options: {
  dataDir: string;
  defaultContextWindow?: number;
  env: NodeJS.ProcessEnv;
}): ConfigStorePort {
  return createOwnerFileConfigStore({
    dataDir: options.dataDir,
    seedDir: options.env.CONFIG_DIR,
    defaultContextWindow: options.defaultContextWindow,
  });
}

export function installPromotedToolsPersistenceHook(
  config: SubstrateConfig,
  options: {
    configStore?: ConfigStorePort;
    env?: NodeJS.ProcessEnv;
  } = {},
): void {
  const existingHooks = config.runtimeHooks ?? {};
  const env = options.env ?? process.env;
  const configStore = options.configStore ?? createDefaultConfigStore({
    dataDir: config.dataDir,
    defaultContextWindow: config.defaultContextWindow,
    env,
  });
  config.runtimeHooks = {
    ...existingHooks,
    persistPromotedExtendedTools: (toolNames) => {
      const current = configStore.loadRuntimeSettings();
      configStore.saveRuntimeSettings({
        ...current,
        promotedExtendedTools: [...toolNames],
      });
    },
  };
}

function assertSecuritySensitiveStartupConfig(config: SubstrateConfig): void {
  const discordToken = config.discordToken?.trim() ?? '';
  const discordBotId = config.discordBotId?.trim() ?? '';
  const hasDiscordToken = discordToken.length > 0;
  const hasDiscordBotId = discordBotId.length > 0;

  if (hasDiscordToken !== hasDiscordBotId) {
    if (!hasDiscordToken) {
      throw new Error('DISCORD_TOKEN is required when DISCORD_BOT_ID is configured');
    }
    throw new Error('DISCORD_BOT_ID is required when DISCORD_TOKEN is configured');
  }

  if (config.voiceEnabled !== true) return;
  if (hasDiscordToken) return;

  throw new Error(
    'DISCORD_TOKEN and DISCORD_BOT_ID are required when DISCORD_VOICE_ENABLED=true',
  );
}

export function hydrateCanonicalStartupConfig(
  config: SubstrateConfig,
  options: StartupConfigHydrationOptions = {},
): StartupConfigHydrationResult {
  const env = options.env ?? process.env;
  const secretAuthority = options.secretAuthority ?? 'gateway';
  if (secretAuthority === 'gateway') {
    config.credentialVault ??= createEnvCredentialVault(env);
  }
  const pathSnapshot = resolveRuntimePathSnapshotFromConfig(config, {
    mode: env.PSFN_RUNTIME_LAYOUT_MODE,
    nodeEnv: env.NODE_ENV,
    runtimeRootDir: env.PSFN_RUNTIME_ROOT,
    legacyDataDir: env.DATA_DIR,
    workspacePath: env.WORKSPACE_PATH,
    logsDir: env.PSFN_LOGS_DIR,
    tempDir: env.PSFN_TEMP_DIR,
    backupsDir: env.BACKUP_ROOT_DIR,
  });
  const { systemDataDir, companionDataDir, runtimePathLayout } = pathSnapshot;
  const configStore = options.configStore ?? createDefaultConfigStore({
    dataDir: systemDataDir,
    defaultContextWindow: config.defaultContextWindow,
    env,
  });
  assertPersistenceCutoverReady(buildPersistenceCutoverOptionsFromConfig(config, env));
  const startupRuntimeSettings = configStore.loadStartupRuntimeSettings();
  const { settingsDomains } = startupRuntimeSettings;
  applySettings(config, settingsDomains.runtime);
  if (secretAuthority === 'gateway') {
    assertSecuritySensitiveStartupConfig(config);
  }
  installPromotedToolsPersistenceHook(config, {
    configStore,
    env,
  });

  const modelsLoadResult = configStore.loadStartupModels({
    legacySettings: settingsDomains.models,
  });
  applySettings(config, modelsLoadResult.config);
  const providersLoadResult = configStore.loadStartupProviders({
    legacyLiteLLMBaseUrl: env.LITELLM_BASE_URL,
    legacyOpenRouterModelsApiUrl: config.openRouterModelsApiUrl,
  });
  applyProvidersRuntimeConfig(config, providersLoadResult.config);

  const diagnostics: StartupConfigHydrationDiagnostics = {
    modelsMigratedFromLegacySettings: modelsLoadResult.migratedFromLegacySettings,
    modelsLegacyDriftDetected: modelsLoadResult.legacyDriftDetected,
    providersMigratedFromLegacyConfig: providersLoadResult.migratedFromLegacyConfig,
    providersLegacyDriftDetected: providersLoadResult.legacyDriftDetected,
    maintenanceIntervalMigration: { state: 'none' },
    capabilityTierMigration: { state: 'none' },
    removedLegacyKeys: [...settingsDomains.legacyKeys],
  };

  if (settingsDomains.maintenanceIntervalMs !== undefined) {
    try {
      const schedulerPath = join(systemDataDir, SCHEDULER_FILE_NAME);
      const schedulerFileExisted = existsSync(schedulerPath);
      const persistedScheduler = configStore.loadStartupScheduler();
      if (!schedulerFileExisted) {
        configStore.saveScheduler({
          ...persistedScheduler,
          salienceDecayIntervalMs: settingsDomains.maintenanceIntervalMs,
        });
        diagnostics.maintenanceIntervalMigration = {
          state: 'migrated',
          settingsValue: settingsDomains.maintenanceIntervalMs,
          storedValue: settingsDomains.maintenanceIntervalMs,
        };
      } else if (persistedScheduler.salienceDecayIntervalMs !== settingsDomains.maintenanceIntervalMs) {
        diagnostics.maintenanceIntervalMigration = {
          state: 'drift_detected',
          settingsValue: settingsDomains.maintenanceIntervalMs,
          storedValue: persistedScheduler.salienceDecayIntervalMs,
        };
      }
    } catch (error) {
      diagnostics.maintenanceIntervalMigration = {
        state: 'error',
        settingsValue: settingsDomains.maintenanceIntervalMs,
        error: String(error),
      };
    }
  }

  if (settingsDomains.capabilityTier !== undefined) {
    try {
      const capabilityPath = join(systemDataDir, CAPABILITY_TIER_FILE_NAME);
      const capabilityFileExisted = existsSync(capabilityPath);
      const persistedCapabilities = configStore.loadStartupCapabilityTier();
      if (!capabilityFileExisted) {
        configStore.saveCapabilityTier({
          ...persistedCapabilities,
          tier: settingsDomains.capabilityTier,
        });
        diagnostics.capabilityTierMigration = {
          state: 'migrated',
          settingsValue: settingsDomains.capabilityTier,
          storedValue: settingsDomains.capabilityTier,
        };
      } else if (persistedCapabilities.tier !== settingsDomains.capabilityTier) {
        diagnostics.capabilityTierMigration = {
          state: 'drift_detected',
          settingsValue: settingsDomains.capabilityTier,
          storedValue: persistedCapabilities.tier,
        };
      }
    } catch (error) {
      diagnostics.capabilityTierMigration = {
        state: 'error',
        settingsValue: settingsDomains.capabilityTier,
        error: String(error),
      };
    }
  }

  if (settingsDomains.legacyKeys.length > 0) {
    try {
      configStore.saveRuntimeSettings(settingsDomains.runtime);
    } catch (error) {
      diagnostics.settingsRewriteError = String(error);
    }
  }

  const trustPolicyConfig = configStore.loadStartupTrustPolicy();
  setRuntimeTrustPolicy(trustPolicyConfig);

  const persistedScheduler = configStore.loadStartupScheduler();
  const schedulerConfig: SchedulerRuntimeConfig = {
    tickIntervalMs: persistedScheduler.tickIntervalMs,
    heartbeatIntervalMs: persistedScheduler.heartbeatIntervalMs,
    salienceDecayIntervalMs: persistedScheduler.salienceDecayIntervalMs,
  };
  config.maintenanceIntervalMs = schedulerConfig.salienceDecayIntervalMs;

  return {
    systemDataDir,
    companionDataDir,
    runtimePathLayout,
    pathSnapshot,
    settingsDomains,
    modelsLoadResult,
    providersLoadResult,
    trustPolicyConfig,
    schedulerConfig,
    diagnostics,
  };
}
