import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import {
  applySettings,
  type EditableSettings,
  type SettingsDomainSplit,
} from '../../../system/settings.js';
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
import type { AutomataOwnerPolicy } from '../../../faculties/automata/registry-contract.js';
import { setRuntimeTrustPolicy } from '../../../system/trust/runtime-policy.js';
import {
  resolveConfiguredCompanionDataDir,
  resolveRuntimePathSnapshotFromConfig,
  type RuntimePathSnapshot,
} from '../../../persistence/layout.js';
import {
  assertPersistenceCutoverReady,
  buildPersistenceCutoverOptionsFromConfig,
} from '../../../persistence/cutover.js';
import {
  bindCompanionObserverEvalSidecar,
  validateObserverEvalSidecarStartupConfig,
} from '../../../system/config/observer-eval-sidecar-config.js';
import { resolveEffectiveRuntimeSettings } from '../../../system/config/settings-overlay.js';
import { assertModelPurposeSelectionResolvable } from '../../../system/config/model-selection-config.js';
import type { GatewaySystemDataWriterPort } from '../../../boundary/gateway/system-data-writer.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
export {
  createRuntimeVoiceSttConnector,
  createRuntimeVoiceTtsConnector,
  resolveRuntimeVoiceProviderGate,
  resolveRuntimeVoiceSttProvider,
  resolveRuntimeVoiceTtsProvider,
  resolveRuntimeVoiceTtsProviderOrder,
} from '../../../channels/backplane/voice-provider-runtime.js';

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
  automataPolicy: AutomataOwnerPolicy;
  diagnostics: StartupConfigHydrationDiagnostics;
}

export interface StartupConfigHydrationOptions {
  env?: NodeJS.ProcessEnv;
  secretAuthority?: 'gateway' | 'agent';
  configStore?: ConfigStorePort;
}

export interface EmbeddingDimensionValidationResult {
  status: 'match' | 'mismatch' | 'unknown';
  configuredDims: number;
  storedDims: number | null;
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
  if (result.status !== 'mismatch' || result.storedDims === null) {
    return null;
  }
  return 'Embedding dimension mismatch detected at startup'
    + `: configured=${result.configuredDims}, stored=${result.storedDims}. `
    + 'Run memory embedding migration to re-embed l2_memories with the configured model before relying on retrieval quality.';
}

function createDefaultConfigStore(options: {
  dataDir: string;
  companionDataDir?: string;
  defaultContextWindow?: number;
  env: NodeJS.ProcessEnv;
}): ConfigStorePort {
  return createOwnerFileConfigStore({
    dataDir: options.dataDir,
    ...(options.companionDataDir ? { companionDataDir: options.companionDataDir } : {}),
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
    systemDataWriter?: GatewaySystemDataWriterPort;
    env?: NodeJS.ProcessEnv;
  } = {},
): void {
  const existingHooks = config.runtimeHooks ?? {};
  const env = options.env ?? process.env;
  const configStore = options.configStore ?? createDefaultConfigStore({
    dataDir: config.dataDir,
    companionDataDir: resolveConfiguredCompanionDataDir(config),
    defaultContextWindow: config.defaultContextWindow,
    env,
  });
  config.runtimeHooks = {
    ...existingHooks,
    persistPromotedExtendedTools: async (toolNames) => {
      const current = configStore.loadRuntimeSettings();
      const next = {
        ...current,
        promotedExtendedTools: [...toolNames],
      };
      if (options.systemDataWriter) {
        try {
          await options.systemDataWriter.writeSystemData({
            kind: 'owner_file',
            ownerFile: 'settings',
            payload: next,
          });
        } catch (error) {
          throw new Error(
            'The authenticated gateway system-data writer could not persist tool preferences: '
            + toErrorMessage(error),
          );
        }
      } else {
        configStore.saveRuntimeSettings(next);
      }
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
    workspacePath: config.workspacePath ?? env.WORKSPACE_PATH,
    logsDir: env.PSFN_LOGS_DIR,
    tempDir: env.PSFN_TEMP_DIR,
    backupsDir: env.BACKUP_ROOT_DIR,
  });
  const { systemDataDir, companionDataDir, runtimePathLayout } = pathSnapshot;
  const configStore = options.configStore ?? createDefaultConfigStore({
    dataDir: systemDataDir,
    companionDataDir,
    defaultContextWindow: config.defaultContextWindow,
    env,
  });
  assertPersistenceCutoverReady(buildPersistenceCutoverOptionsFromConfig(config, env));
  const startupRuntimeSettings = configStore.loadStartupRuntimeSettings();
  const { settingsDomains } = startupRuntimeSettings;
  // Per-companion overlay (dnll.1): deep-merge companion-data/settings.overlay.json
  // over the global runtime settings for the whitelisted keys. Absent overlay =
  // byte-identical to the global settings.
  const effectiveRuntimeSettings = resolveEffectiveRuntimeSettings(
    settingsDomains.runtime,
    companionDataDir,
  );
  applySettings(config, effectiveRuntimeSettings);
  bindCompanionObserverEvalSidecar(config);
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
  // 23pp: every per-companion model selection (settings.json + overlay) must
  // resolve to an enabled models.json registry entry — fail closed at startup.
  assertModelPurposeSelectionResolvable(config);
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
    backgroundMaintenance: {
      intervalMs: persistedScheduler.backgroundMaintenance.intervalMs,
      sharedWorldWikiCaretaker: {
        ...persistedScheduler.backgroundMaintenance.sharedWorldWikiCaretaker,
      },
      ambientPresence: { ...persistedScheduler.backgroundMaintenance.ambientPresence },
      concernGrooming: { ...persistedScheduler.backgroundMaintenance.concernGrooming },
    },
    backgroundWork: {
      supervisor: { ...persistedScheduler.backgroundWork.supervisor },
      postTurn: { ...persistedScheduler.backgroundWork.postTurn },
    },
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
      activeChannelLookbackHours: persistedScheduler.temporalWakeup.activeChannelLookbackHours,
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
    socialDesire: {
      enabled: persistedScheduler.socialDesire.enabled,
      lifecycle: {
        ...persistedScheduler.socialDesire.lifecycle,
        decay: { ...persistedScheduler.socialDesire.lifecycle.decay },
        coolingOff: { ...persistedScheduler.socialDesire.lifecycle.coolingOff },
        tiers: {
          acquaintance: { ...persistedScheduler.socialDesire.lifecycle.tiers.acquaintance },
          friend: { ...persistedScheduler.socialDesire.lifecycle.tiers.friend },
          family: { ...persistedScheduler.socialDesire.lifecycle.tiers.family },
          partner: { ...persistedScheduler.socialDesire.lifecycle.tiers.partner },
          ai_companion: { ...persistedScheduler.socialDesire.lifecycle.tiers.ai_companion },
        },
      },
      outreach: {
        ...persistedScheduler.socialDesire.outreach,
        budget: { ...persistedScheduler.socialDesire.outreach.budget },
      },
    },
    icpAutonomy: {
      enabled: persistedScheduler.icpAutonomy.enabled,
      candidate: { ...persistedScheduler.icpAutonomy.candidate },
      permit: { ...persistedScheduler.icpAutonomy.permit },
      policyHolds: { ...persistedScheduler.icpAutonomy.policyHolds },
      availability: { ...persistedScheduler.icpAutonomy.availability },
    },
    socialAutonomy: {
      passiveNameCandidate: { ...persistedScheduler.socialAutonomy.passiveNameCandidate },
      appraiser: { ...persistedScheduler.socialAutonomy.appraiser },
      reservationPhase: { ...persistedScheduler.socialAutonomy.reservationPhase },
      egressLease: { ...persistedScheduler.socialAutonomy.egressLease },
      freeTimeChooser: { ...persistedScheduler.socialAutonomy.freeTimeChooser },
    },
    ...(persistedScheduler.toolUsageEvaluator
      ? { toolUsageEvaluator: { ...persistedScheduler.toolUsageEvaluator } }
      : {}),
    ...(persistedScheduler.introspectionAudit
      ? { introspectionAudit: { ...persistedScheduler.introspectionAudit } }
      : {}),
    ...(persistedScheduler.backgroundWorkWelfare
      ? { backgroundWorkWelfare: { ...persistedScheduler.backgroundWorkWelfare } }
      : {}),
  };
  const chargePolicyConfig = configStore.loadStartupChargePolicy();
  config.chargePolicy = chargePolicyConfig;
  // bead 7ym.2.1: schema-owned subagent role registry (subagent-roles.json).
  config.subagentRoles = configStore.loadStartupSubagentRoles();
  const automataPolicy = configStore.loadStartupAutomataPolicy();
  config.automataPolicy = automataPolicy;

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
    automataPolicy,
    diagnostics,
  };
}
