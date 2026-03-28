import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SubstrateConfig } from '../types.js';
import type { CapabilityTier } from '../types.js';
import {
  applySettings,
  type EditableSettings,
  type SettingsDomainSplit,
} from '../system/settings.js';
import type { EligibilityGate } from '../system/capabilities/eligibility.js';
import {
  createEmbeddingDimensionMismatchWarning,
  type EmbeddingDimensionValidationResult,
} from '../backup/startup-checks.js';
import type { RuntimeChannelsConfigOverrides } from '../channels/config.js';
import {
  createStreamingSttConnector,
  getStreamingSttProviderMetadata,
  isStreamingSttProvider,
  isStreamingSttProviderConfigured,
  resolveStreamingSttRuntimeConfig,
  type StreamingSttConnector,
  type StreamingSttProvider,
} from '../voice/connectors/stt/index.js';
import {
  createStreamingTtsConnector,
  getStreamingTtsProviderMetadata,
  isStreamingTtsProvider,
  isStreamingTtsProviderConfigured,
  resolveStreamingTtsRuntimeConfig,
  type StreamingTtsConnector,
  type StreamingTtsProvider,
} from '../voice/connectors/tts/index.js';
import {
  requirePluginActivationEligibility,
  wrapStreamingSttConnectorWithEligibility,
  wrapStreamingTtsConnectorWithEligibility,
} from './plugin-eligibility.js';
import { createEnvCredentialVault } from '../custody/credential-vault.js';
import { createSystemConfigRepository } from '../system/config/system-config-repository.js';
import { type ModelsLoadResult } from '../system/config/models-config.js';
import {
  applyProvidersRuntimeConfig,
  type ProvidersLoadResult,
} from '../system/config/providers-config.js';
import { CAPABILITY_TIER_FILE_NAME } from '../system/config/capability-tier-config.js';
import { SCHEDULER_FILE_NAME, type SchedulerRuntimeConfig } from '../system/config/scheduler-config.js';
import { type TrustPolicyConfig } from '../system/config/trust-policy-config.js';
import { resolveRuntimeSchedulerConfig } from '../system/config/scheduler-runtime.js';
import { setRuntimeTrustPolicy } from '../trust/runtime-policy.js';
import {
  resolveRuntimePathSnapshotFromConfig,
  type RuntimePathSnapshot,
} from '../persistence/layout.js';
import {
  assertPersistenceCutoverReady,
  buildPersistenceCutoverOptionsFromConfig,
} from '../persistence/cutover.js';
import {
  loadStartupCapabilityTierOwnerFile,
  loadStartupModelsOwnerFile,
  loadStartupProvidersOwnerFile,
  loadStartupRuntimeSettingsOwnerFile,
  loadStartupTrustPolicyOwnerFile,
  loadStartupSchedulerOwnerFile,
} from '../system/config/startup-owner-files.js';

export type RuntimeVoiceSttProvider = StreamingSttProvider | 'disabled';
export type RuntimeVoiceTtsProvider = StreamingTtsProvider | 'disabled';

export interface RuntimeVoiceProviderGateOptions {
  allowEchoDefaults?: boolean;
  requireElevenLabsVoiceId?: boolean;
}

export interface RuntimeVoiceProviderGate {
  sttProvider: RuntimeVoiceSttProvider;
  ttsProvider: RuntimeVoiceTtsProvider;
  sttEnabled: boolean;
  ttsEnabled: boolean;
}

export interface RuntimeVoiceConnectorBinding<TProvider, TConnector> {
  provider: TProvider;
  connector: TConnector;
}

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
}

function hasExplicitRuntimeProviderSelection(provider: unknown): provider is string {
  if (typeof provider !== 'string') return false;
  const normalized = provider.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'disabled';
}

export interface RuntimeVoiceSttConnectorOptions extends RuntimeVoiceProviderGateOptions {
  provider?: RuntimeVoiceSttProvider;
  eligibilityGate?: EligibilityGate;
}

export interface RuntimeVoiceTtsConnectorOptions extends RuntimeVoiceProviderGateOptions {
  provider?: RuntimeVoiceTtsProvider;
  eligibilityGate?: EligibilityGate;
  fetchImpl?: typeof fetch;
}

export function resolveRuntimeVoiceSttProvider(config: SubstrateConfig): RuntimeVoiceSttProvider {
  const configured = config.sttProvider;
  if (configured === 'disabled') return configured;
  if (typeof configured === 'string') {
    const normalized = configured.trim().toLowerCase();
    if (!normalized) {
      throw new Error('Invalid runtime voice STT provider: provider id cannot be empty');
    }
    if (!isStreamingSttProvider(normalized)) {
      throw new Error(`Unsupported runtime voice STT provider: ${configured}`);
    }
    return normalized;
  }

  return 'disabled';
}

export function resolveRuntimeVoiceTtsProvider(config: SubstrateConfig): RuntimeVoiceTtsProvider {
  const configured = config.ttsProvider;
  if (configured === 'disabled') return configured;
  if (typeof configured === 'string') {
    const normalized = configured.trim().toLowerCase();
    if (!normalized) {
      throw new Error('Invalid runtime voice TTS provider: provider id cannot be empty');
    }
    if (!isStreamingTtsProvider(normalized)) {
      throw new Error(`Unsupported runtime voice TTS provider: ${configured}`);
    }
    return normalized;
  }

  return 'disabled';
}

export function resolveRuntimeVoiceProviderGate(
  config: SubstrateConfig,
  options: RuntimeVoiceProviderGateOptions = {},
): RuntimeVoiceProviderGate {
  const sttProvider = resolveRuntimeVoiceSttProvider(config);
  const ttsProvider = resolveRuntimeVoiceTtsProvider(config);
  const sttEnabled = sttProvider !== 'disabled' && isStreamingSttProviderConfigured(sttProvider, config);
  const ttsEnabled = ttsProvider !== 'disabled'
    && isStreamingTtsProviderConfigured(ttsProvider, config, options);

  return {
    sttProvider,
    ttsProvider,
    sttEnabled,
    ttsEnabled,
  };
}

export function createRuntimeVoiceSttConnector(
  config: SubstrateConfig,
  options: RuntimeVoiceSttConnectorOptions = {},
): RuntimeVoiceConnectorBinding<StreamingSttProvider, StreamingSttConnector> | null {
  const provider = options.provider ?? resolveRuntimeVoiceSttProvider(config);
  if (provider === 'disabled') {
    return null;
  }
  const explicitlySelectedProvider = hasExplicitRuntimeProviderSelection(config.sttProvider)
    ? resolveRuntimeVoiceSttProvider(config)
    : null;
  const shouldFailClosed = explicitlySelectedProvider === provider || options.provider === provider;
  if (!isStreamingSttProviderConfigured(provider, config) && !shouldFailClosed) {
    return null;
  }

  const providerMetadata = getStreamingSttProviderMetadata(provider);
  try {
    requirePluginActivationEligibility(
      options.eligibilityGate,
      'stt',
      provider,
      providerMetadata?.eligibility,
    );
  } catch (error) {
    if (shouldFailClosed) {
      throw error;
    }
    return null;
  }

  const connectorConfig = resolveStreamingSttRuntimeConfig(provider, config);
  return {
    provider,
    connector: wrapStreamingSttConnectorWithEligibility(
      createStreamingSttConnector(provider, connectorConfig),
      provider,
      options.eligibilityGate,
      providerMetadata?.eligibility,
    ),
  };
}

export function createRuntimeVoiceTtsConnector(
  config: SubstrateConfig,
  options: RuntimeVoiceTtsConnectorOptions = {},
): RuntimeVoiceConnectorBinding<StreamingTtsProvider, StreamingTtsConnector> | null {
  const provider = options.provider ?? resolveRuntimeVoiceTtsProvider(config);
  if (provider === 'disabled') {
    return null;
  }
  const explicitlySelectedProvider = hasExplicitRuntimeProviderSelection(config.ttsProvider)
    ? resolveRuntimeVoiceTtsProvider(config)
    : null;
  if (
    !isStreamingTtsProviderConfigured(provider, config, options)
    && explicitlySelectedProvider !== provider
    && options.provider !== provider
  ) {
    return null;
  }

  const providerMetadata = getStreamingTtsProviderMetadata(provider);
  const shouldFailClosed = explicitlySelectedProvider === provider || options.provider === provider;
  try {
    requirePluginActivationEligibility(
      options.eligibilityGate,
      'tts',
      provider,
      providerMetadata?.eligibility,
    );
  } catch (error) {
    if (shouldFailClosed) {
      throw error;
    }
    return null;
  }

  const connectorConfig = resolveStreamingTtsRuntimeConfig(provider, config);
  const resolvedConnectorConfig = options.fetchImpl
    ? { ...connectorConfig, fetchImpl: options.fetchImpl }
    : connectorConfig;
  return {
    provider,
    connector: wrapStreamingTtsConnectorWithEligibility(
      createStreamingTtsConnector(provider, resolvedConnectorConfig),
      provider,
      options.eligibilityGate,
      providerMetadata?.eligibility,
    ),
  };
}

export function resolveRuntimeVoiceTtsProviderOrder(
  config: SubstrateConfig,
  preferredProvider?: StreamingTtsProvider,
  _options: RuntimeVoiceProviderGateOptions = {},
): StreamingTtsProvider[] {
  void _options;
  const resolvedPreferred = preferredProvider
    ?? (() => {
      const provider = resolveRuntimeVoiceTtsProvider(config);
      return provider === 'disabled' ? null : provider;
    })();
  return resolvedPreferred ? [resolvedPreferred] : [];
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

export function installPromotedToolsPersistenceHook(config: SubstrateConfig): void {
  const existingHooks = config.runtimeHooks ?? {};
  const repository = createSystemConfigRepository({
    dataDir: config.dataDir,
    seedDir: process.env.CONFIG_DIR,
    defaultContextWindow: config.defaultContextWindow,
  });
  config.runtimeHooks = {
    ...existingHooks,
    persistPromotedExtendedTools: (toolNames) => {
      const current = repository.loadRuntimeSettings();
      repository.saveRuntimeSettings({
        ...current,
        promotedExtendedTools: [...toolNames],
      });
    },
  };
}

function assertSecuritySensitiveStartupConfig(config: SubstrateConfig): void {
  const discordToken = config.discordToken.trim();
  const discordBotId = config.discordBotId.trim();
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
  config.credentialVault ??= createEnvCredentialVault(env);
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
  assertPersistenceCutoverReady(buildPersistenceCutoverOptionsFromConfig(config, env));
  const repository = createSystemConfigRepository({
    dataDir: systemDataDir,
    seedDir: env.CONFIG_DIR,
    defaultContextWindow: config.defaultContextWindow,
  });

  const startupRuntimeSettings = loadStartupRuntimeSettingsOwnerFile({
    dataDir: systemDataDir,
    seedDir: env.CONFIG_DIR,
  });
  const { settingsDomains } = startupRuntimeSettings;
  applySettings(config, settingsDomains.runtime);
  assertSecuritySensitiveStartupConfig(config);
  installPromotedToolsPersistenceHook(config);

  const modelsLoadResult = loadStartupModelsOwnerFile({
    dataDir: systemDataDir,
    seedDir: env.CONFIG_DIR,
    defaultContextWindow: config.defaultContextWindow,
    legacySettings: settingsDomains.models,
  });
  applySettings(config, modelsLoadResult.config);
  const providersLoadResult = loadStartupProvidersOwnerFile({
    dataDir: systemDataDir,
    seedDir: env.CONFIG_DIR,
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
      const persistedScheduler = loadStartupSchedulerOwnerFile(systemDataDir, env.CONFIG_DIR);
      if (!schedulerFileExisted) {
        repository.saveScheduler({
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
      const persistedCapabilities = loadStartupCapabilityTierOwnerFile(systemDataDir, env.CONFIG_DIR);
      if (!capabilityFileExisted) {
        repository.saveCapabilityTier({
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
      repository.saveRuntimeSettings(settingsDomains.runtime);
    } catch (error) {
      diagnostics.settingsRewriteError = String(error);
    }
  }

  const trustPolicyConfig = loadStartupTrustPolicyOwnerFile(systemDataDir, env.CONFIG_DIR);
  setRuntimeTrustPolicy(trustPolicyConfig);

  const schedulerConfig = resolveRuntimeSchedulerConfig({
    dataDir: systemDataDir,
    seedDir: env.CONFIG_DIR,
  });
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
