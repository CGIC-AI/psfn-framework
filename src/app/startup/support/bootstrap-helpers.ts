import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
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
import {
  createCredentialVaultFromEnvironment,
  createEnvCredentialVault,
  resolveInlineOrEnvCredential,
} from '../../../boundary/custody/credential-vault.js';
import {
  createOwnerFileConfigStore,
  type ConfigStorePort,
} from '../../../system/config/config-store.js';
import { type ModelsLoadResult } from '../../../system/config/models-config.js';
import {
  applyProvidersRuntimeConfig,
  type ProvidersLoadResult,
} from '../../../system/config/providers-config.js';
import { type ChargePolicyConfig } from '../../../system/config/charge-policy-config.js';
import { type SchedulerRuntimeConfig } from '../../../system/config/scheduler-config.js';
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
import { validateObserverEvalSidecarStartupConfig } from '../../../system/config/observer-eval-sidecar-config.js';
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

export interface StartupConfigHydrationDiagnostics {
  legacySettingsKeys: string[];
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
  chargePolicyConfig: ChargePolicyConfig;
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

export async function hydrateSecretBearingConfig(
  config: SubstrateConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  config.credentialVault ??= await createCredentialVaultFromEnvironment(env, {
    fetchImpl: options.fetchImpl,
  });
  config.discordToken = resolveInlineOrEnvCredential(
    config.discordToken,
    config.credentialVault,
    'DISCORD_TOKEN',
    env,
  ) ?? '';
  config.discordBotId = resolveInlineOrEnvCredential(
    config.discordBotId,
    config.credentialVault,
    'DISCORD_BOT_ID',
    env,
  ) ?? '';
  config.deepgramApiKey = resolveInlineOrEnvCredential(
    config.deepgramApiKey,
    config.credentialVault,
    'DEEPGRAM_API_KEY',
    env,
  );
  config.elevenLabsApiKey = resolveInlineOrEnvCredential(
    config.elevenLabsApiKey,
    config.credentialVault,
    'ELEVENLABS_API_KEY',
    env,
  );
  config.falApiKey = resolveInlineOrEnvCredential(
    config.falApiKey,
    config.credentialVault,
    'FAL_API_KEY',
    env,
  );
  assertSecuritySensitiveStartupConfig(config);
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
  validateObserverEvalSidecarStartupConfig(config, pathSnapshot);
  if (secretAuthority === 'gateway') {
    assertSecuritySensitiveStartupConfig(config);
  }
  installPromotedToolsPersistenceHook(config, {
    configStore,
    env,
  });

  const modelsLoadResult = configStore.loadStartupModels();
  applySettings(config, modelsLoadResult.config);
  const providersLoadResult = configStore.loadStartupProviders();
  applyProvidersRuntimeConfig(config, providersLoadResult.config);

  const diagnostics: StartupConfigHydrationDiagnostics = {
    legacySettingsKeys: [],
  };

  const trustPolicyConfig = configStore.loadStartupTrustPolicy();
  setRuntimeTrustPolicy(trustPolicyConfig);

  const persistedScheduler = configStore.loadStartupScheduler();
  const schedulerConfig: SchedulerRuntimeConfig = {
    tickIntervalMs: persistedScheduler.tickIntervalMs,
    heartbeatIntervalMs: persistedScheduler.heartbeatIntervalMs,
    salienceDecayIntervalMs: persistedScheduler.salienceDecayIntervalMs,
    artifactLifecycle: { ...persistedScheduler.artifactLifecycle },
    episodicProcessing: { ...persistedScheduler.episodicProcessing },
    nearTurnMemory: {
      direct: { ...persistedScheduler.nearTurnMemory.direct },
      group: { ...persistedScheduler.nearTurnMemory.group },
    },
    episodeSynthesis: { ...persistedScheduler.episodeSynthesis },
    sleepConsolidation: { ...persistedScheduler.sleepConsolidation },
    orientationRewrite: { ...persistedScheduler.orientationRewrite },
    reflectionNovelty: { ...persistedScheduler.reflectionNovelty },
    wikiPass: { ...persistedScheduler.wikiPass },
    arcFormation: { ...persistedScheduler.arcFormation },
    socialGraphBuilder: { ...persistedScheduler.socialGraphBuilder },
    temporalWakeup: {
      enabled: persistedScheduler.temporalWakeup.enabled,
      morningWake: { ...persistedScheduler.temporalWakeup.morningWake },
      idleRefresher: { ...persistedScheduler.temporalWakeup.idleRefresher },
      wakeSummary: { ...persistedScheduler.temporalWakeup.wakeSummary },
    },
    freeTime: {
      enabled: persistedScheduler.freeTime.enabled,
      minBlockIntervalMinutes: persistedScheduler.freeTime.minBlockIntervalMinutes,
      maxBlocksPerDay: persistedScheduler.freeTime.maxBlocksPerDay,
      seedText: persistedScheduler.freeTime.seedText,
      quietHours: { ...persistedScheduler.freeTime.quietHours },
      idle: { ...persistedScheduler.freeTime.idle },
      budget: { ...persistedScheduler.freeTime.budget },
      returnNote: { ...persistedScheduler.freeTime.returnNote },
    },
    weightedThoughtOutreach: {
      enabled: persistedScheduler.weightedThoughtOutreach.enabled,
      checkIntervalMs: persistedScheduler.weightedThoughtOutreach.checkIntervalMs,
      nudgeThreshold: persistedScheduler.weightedThoughtOutreach.nudgeThreshold,
      maxNudgesPerRun: persistedScheduler.weightedThoughtOutreach.maxNudgesPerRun,
      lifecycle: {
        classes: {
          time_sensitive: { ...persistedScheduler.weightedThoughtOutreach.lifecycle.classes.time_sensitive },
          standard: { ...persistedScheduler.weightedThoughtOutreach.lifecycle.classes.standard },
          trivial: { ...persistedScheduler.weightedThoughtOutreach.lifecycle.classes.trivial },
        },
        reinforcement: { ...persistedScheduler.weightedThoughtOutreach.lifecycle.reinforcement },
        accumulatedWeightCap: persistedScheduler.weightedThoughtOutreach.lifecycle.accumulatedWeightCap,
        contradictionDampeningFactor: persistedScheduler.weightedThoughtOutreach.lifecycle.contradictionDampeningFactor,
        declineDampeningFactor: persistedScheduler.weightedThoughtOutreach.lifecycle.declineDampeningFactor,
        relevanceFloor: persistedScheduler.weightedThoughtOutreach.lifecycle.relevanceFloor,
      },
    },
  };
  config.maintenanceIntervalMs = schedulerConfig.salienceDecayIntervalMs;
  const chargePolicyConfig = configStore.loadStartupChargePolicy();
  config.chargePolicy = chargePolicyConfig;

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
    chargePolicyConfig,
    diagnostics,
  };
}
