import { isRecord } from '../../../shared/utils/types.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import {
  applySettings,
  type EditableSettings,
  hasModelSettings,
  MOOD_CONGRUENCE_WEIGHT_RANGE,
  normalizeEditableSettings,
  REMOVED_RUNTIME_SETTINGS_KEYS,
  splitSettingsByDomain,
  SETTINGS_VALIDATION,
} from '../../../system/settings.js';
import type { ConfigStorePort } from '../../../system/config/config-store.js';
import type { ChargePolicyConfig } from '../../../system/config/charge-policy-config.js';
import {
  applyIntakeSourceListMutation,
  type IntakePolicyConfig,
  type IntakeSourceListsConfig,
} from '../../../system/config/intake-policy-config.js';
import {
  applyProvidersRuntimeConfig,
} from '../../../system/config/providers-config.js';
import {
  buildSettingsContractData,
  IMPORT_PROCESSING_ROUTE_MODE_VALUES,
  SESSION_RESTART_BEHAVIOR_VALUES,
  SETTINGS_BOOLEAN_FIELDS,
  SETTINGS_OWNER_FILE_BY_FIELD,
  SETTINGS_STRING_ARRAY_FIELDS,
} from '../../../system/config/settings-contract.js';
import {
  COMPANION_MODEL_SELECTION_SETTINGS_OVERLAY_KEYS,
  mergeCompanionSettingsOverlayPatch,
} from '../../../system/config/settings-overlay.js';
import {
  validateCompositionalPolicyConfig,
} from '../../../system/capabilities/compositional-policy.js';
import {
  FAL_CREATE_MODELS,
  FAL_EDIT_MODELS,
  IMAGE_PROVIDER_VALUES,
  normalizeImageWorkflowSettings,
} from '../../../primitives/images/types.js';
import {
  assertModelPurposeSelectionResolvable,
  normalizeModelPurposeSelectionSetting,
} from '../../../system/config/model-selection-config.js';
import {
  normalizeMemoryRetrievalPolicy,
  resolveMemoryRetrievalPolicy,
  resolveMemorySalienceFloor,
} from '../../../system/config/memory-retrieval-policy.js';
import { normalizeMemoryDeletionPolicy } from '../../../system/config/memory-deletion-policy.js';
import { isCapabilityToken, type CapabilityToken } from '../../../system/capabilities/tokens.js';
import type { CapabilityGrantSnapshot } from '../../../system/capabilities/access.js';
import { resolveTierCapabilityTokens } from '../../../system/capabilities/tiers.js';
import {
  buildCapabilityTierChange,
  type CapabilityTierChange,
} from '../../../system/capabilities/change-notice.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import {
  getStreamingSttProviderMetadata,
  isStreamingSttProvider,
  isStreamingSttProviderConfigured,
  listStreamingSttProviders,
} from '../../../primitives/voice/connectors/stt/index.js';
import {
  getStreamingTtsProviderMetadata,
  isStreamingTtsProvider,
  isStreamingTtsProviderConfigured,
  listStreamingTtsProviders,
} from '../../../primitives/voice/connectors/tts/index.js';
import type {
  AdminChannelDemotionAcceptInput,
  AdminChannelDemotionNotice,
  AdminChannelDemotionResult,
  AdminChannelEnvelopeData,
  AdminChannelEnvelopeRow,
  AdminIntakeSourceListMutationInput,
  AdminSettingsData,
  AdminSettingsDivergence,
  AdminSettingsStatus,
  AdminSettingsService,
  AdminVoiceProviderData,
  AdminVoiceProviderOption,
  BearerApiCompanionOption,
  BearerApiCompanionPinData,
  ConfigUpdateResult,
  EffectiveBackgroundMaintenanceState,
  EffectiveChargeQuotaState,
  EffectiveIcpAutonomySettingsState,
  IcpAutonomyChargeOwnerProjection,
  SettingsValidationError,
  SettingsConfigEditors,
} from './types.js';
import { parseContextEnvelopeSection } from '../../../channels/backplane/config.js';
import {
  validateChannelEnvelopeLabel,
  DEMOTION_EPOCH_NOTICE,
  DEMOTION_EPOCH_NOTICE_VERSION,
  type ChannelClassificationEpoch,
} from '../../../system/trust/context-envelope.js';
import { resolveChannelEnvelopeClassification } from '../../../system/trust/policy.js';
import type { GatewayCredentialPresenceResult } from '../../../boundary/gateway/protocol.js';
import { buildEffectiveFleetAuthOwnerProjection } from './fleet-auth-owner-projection.js';
import type {
  GatewaySystemDataWriterPort,
  SystemOwnerWriteKey,
} from '../../../boundary/gateway/system-data-writer.js';

const IMPORT_ROUTE_MODE_VALUES = new Set(IMPORT_PROCESSING_ROUTE_MODE_VALUES);
const SESSION_RESTART_BEHAVIOR_VALUES_SET = new Set(SESSION_RESTART_BEHAVIOR_VALUES);
const IMAGE_PROVIDER_VALUES_SET = new Set<string>(IMAGE_PROVIDER_VALUES);
const FAL_CREATE_MODEL_VALUES_SET = new Set<string>(FAL_CREATE_MODELS);
const FAL_EDIT_MODEL_VALUES_SET = new Set<string>(FAL_EDIT_MODELS);
const REMOVED_RUNTIME_SETTINGS_MESSAGES: Partial<Record<string, string>> = {
  memoryBudgetPct:
    'memoryBudgetPct has been removed; use sessionHistoryBudgetPct, memoryRetrievalBudgetPct, and extractionThresholdPct instead',
  defaultContextWindow:
    'defaultContextWindow has been removed from runtime settings; set per-model context windows in models.json instead',
  sessionMessageLimit:
    'sessionMessageLimit has been removed; session history now trims by token budget only',
  memoryRetrievalLimit:
    'memoryRetrievalLimit has been removed; memory retrieval now trims by token budget only',
  discordEnabled:
    'discordEnabled has been removed from runtime settings; Discord activation is controlled by DISCORD_TOKEN and DISCORD_BOT_ID',
  discordHeartbeatChannel:
    'discordHeartbeatChannel has been removed from runtime settings; use channels.json -> discord.heartbeatChannelId instead',
};
const log = createComponentLogger('AdminSettingsService');

type SettingsMutationResult =
  | { ok: true; refreshedKeys: AdminSettingsDivergence['key'][]; divergences: AdminSettingsDivergence[] }
  | { ok: false; message: string };

export type CapabilityTierChangeHandler = (change: CapabilityTierChange) => void;

function toCapabilityGrantSnapshot(input: {
  tier: CapabilityGrantSnapshot['tier'];
  customTokens: readonly CapabilityToken[];
}): CapabilityGrantSnapshot {
  return {
    tier: input.tier,
    customTokens: [...input.customTokens],
    grantedTokens: resolveTierCapabilityTokens(input.tier, input.customTokens),
  };
}

function splitCompanionModelSelectionSettings(
  settings: EditableSettings,
): { global: EditableSettings; companion: EditableSettings } {
  const global = { ...settings };
  const companion: EditableSettings = {};
  const globalRecord = global as Record<string, unknown>;
  const companionRecord = companion as Record<string, unknown>;
  for (const key of COMPANION_MODEL_SELECTION_SETTINGS_OVERLAY_KEYS) {
    if (!Object.hasOwn(globalRecord, key)) continue;
    companionRecord[key] = globalRecord[key];
    delete globalRecord[key];
  }
  return { global, companion };
}

function refreshModels(config: SubstrateConfig): AdminSettingsDivergence | null {
  try {
    config.runtimeHooks?.refreshModels?.();
    return null;
  } catch (error) {
    const message = toErrorMessage(error);
    log.warn('Runtime model refresh hook failed after settings mutation', { error: message });
    return {
      key: 'models',
      state: 'diverged',
      detail: `models.json persisted but live model refresh failed: ${message}`,
      updatedAt: Date.now(),
    };
  }
}

function refreshCapabilities(config: SubstrateConfig): AdminSettingsDivergence | null {
  try {
    config.runtimeHooks?.refreshCapabilities?.();
    return null;
  } catch (error) {
    const message = toErrorMessage(error);
    log.warn('Runtime capability refresh hook failed after settings mutation', { error: message });
    return {
      key: 'capabilities',
      state: 'diverged',
      detail: `capability-tier.json persisted but live capability refresh failed: ${message}`,
      updatedAt: Date.now(),
    };
  }
}

function invalidatePromptCacheAfterOwnerMutation(config: SubstrateConfig, reason: string): void {
  try {
    config.runtimeHooks?.invalidatePromptPrefixCache?.(reason);
  } catch (error) {
    log.warn('Prompt cache invalidation hook failed after settings mutation', {
      reason,
      error: toErrorMessage(error),
    });
  }
}

export async function applyAdminModelsConfigMutation(options: {
  config: SubstrateConfig;
  configStore: ConfigStorePort;
  payload: unknown;
  systemDataWriter?: GatewaySystemDataWriterPort;
}): Promise<SettingsMutationResult> {
  const { config, configStore, payload, systemDataWriter } = options;
  try {
    const saved = systemDataWriter
      ? await systemDataWriter.writeSystemData({
          kind: 'owner_file',
          ownerFile: 'models',
          payload,
        }).then(() => configStore.loadModels())
      : configStore.saveModels(payload);
    applySettings(config, saved);
    const divergence = refreshModels(config);
    invalidatePromptCacheAfterOwnerMutation(config, 'owner-file:models');
    return {
      ok: true,
      refreshedKeys: ['models'],
      divergences: divergence ? [divergence] : [],
    };
  } catch (error) {
    return {
      ok: false,
      message: toErrorMessage(error),
    };
  }
}

/**
 * Reload models.json from disk into the live runtime (bead nudf). This is the
 * Garden-save mutation path minus the write: a direct on-disk edit is picked up
 * by re-reading the owner file, applying it into the shared config in place, and
 * firing the existing refreshModels hook + prompt-prefix cache invalidation. It
 * lets an operator edit models.json directly without a process restart.
 */
export function reloadOwnerModelsFromDisk(options: {
  config: SubstrateConfig;
  configStore: ConfigStorePort;
}): SettingsMutationResult {
  const { config, configStore } = options;
  try {
    const loaded = configStore.loadModels();
    applySettings(config, loaded);
    const divergence = refreshModels(config);
    invalidatePromptCacheAfterOwnerMutation(config, 'owner-file:models:disk-edit');
    return {
      ok: true,
      refreshedKeys: ['models'],
      divergences: divergence ? [divergence] : [],
    };
  } catch (error) {
    return {
      ok: false,
      message: toErrorMessage(error),
    };
  }
}

export function applyAdminCapabilityTierMutation(options: {
  config: SubstrateConfig;
  configStore: ConfigStorePort;
  payload: unknown;
  onCapabilityTierChanged?: CapabilityTierChangeHandler;
}): SettingsMutationResult {
  const { config, configStore, payload } = options;
  try {
    const previous = toCapabilityGrantSnapshot(configStore.loadCapabilityTier());
    const saved = configStore.saveCapabilityTier(payload);
    const current = toCapabilityGrantSnapshot(saved);
    config.capabilityTier = saved.tier;
    const divergences: AdminSettingsDivergence[] = [];
    const refreshDivergence = refreshCapabilities(config);
    if (refreshDivergence) divergences.push(refreshDivergence);
    invalidatePromptCacheAfterOwnerMutation(config, 'owner-file:capability-tier');
    const change = buildCapabilityTierChange(previous, current);
    if (change && options.onCapabilityTierChanged) {
      try {
        options.onCapabilityTierChanged(change);
      } catch (error) {
        const message = toErrorMessage(error);
        log.warn('Companion capability-tier change notice failed after owner mutation', {
          error: message,
        });
        const existingCapabilityDivergenceIndex = divergences.findIndex(
          divergence => divergence.key === 'capabilities',
        );
        const noticeDivergence: AdminSettingsDivergence = {
          key: 'capabilities',
          state: 'diverged',
          detail: `capability-tier.json persisted but companion notice delivery failed: ${message}`,
          updatedAt: Date.now(),
        };
        if (existingCapabilityDivergenceIndex === -1) {
          divergences.push(noticeDivergence);
        } else {
          const existing = divergences[existingCapabilityDivergenceIndex]!;
          divergences[existingCapabilityDivergenceIndex] = {
            ...existing,
            detail: `${existing.detail} ${noticeDivergence.detail}`,
            updatedAt: noticeDivergence.updatedAt,
          };
        }
      }
    }
    return {
      ok: true,
      refreshedKeys: ['capabilities'],
      divergences,
    };
  } catch (error) {
    return {
      ok: false,
      message: toErrorMessage(error),
    };
  }
}

export async function applyAdminSettingsMutation(options: {
  config: SubstrateConfig;
  configStore: ConfigStorePort;
  settings: EditableSettings;
  systemDataWriter?: GatewaySystemDataWriterPort;
  capabilityCustomTokens?: readonly CapabilityToken[];
  onCapabilityTierChanged?: CapabilityTierChangeHandler;
}): Promise<SettingsMutationResult> {
  const {
    config,
    configStore,
    settings,
    systemDataWriter,
    capabilityCustomTokens,
    onCapabilityTierChanged,
  } = options;
  const refreshedKeys = new Set<AdminSettingsDivergence['key']>();
  const divergences: AdminSettingsDivergence[] = [];

  const currentRuntimeSettings = splitSettingsByDomain(configStore.loadRuntimeSettings()).runtime;
  const domainSplit = splitSettingsByDomain(settings);
  const settingsByScope = splitCompanionModelSelectionSettings(domainSplit.runtime);

  const mergedRuntimeSettings = normalizeEditableSettings(
    { ...currentRuntimeSettings, ...settingsByScope.global },
    { defaultContextWindow: config.defaultContextWindow },
  );

  if (Object.keys(settingsByScope.global).length > 0) {
    if (systemDataWriter) {
      await systemDataWriter.writeSystemData({
        kind: 'owner_file',
        ownerFile: 'settings',
        payload: mergedRuntimeSettings,
      });
    } else {
      configStore.saveRuntimeSettings(mergedRuntimeSettings);
    }
  }
  if (Object.keys(settingsByScope.companion).length > 0) {
    const currentOverlay = configStore.loadCompanionSettingsOverlay() ?? {};
    configStore.saveCompanionSettingsOverlay(
      mergeCompanionSettingsOverlayPatch(
        currentOverlay,
        settingsByScope.companion,
      ),
    );
  }
  applySettings(config, configStore.loadEffectiveRuntimeSettings());
  invalidatePromptCacheAfterOwnerMutation(config, 'owner-file:settings');

  if (Object.hasOwn(domainSplit.runtime, 'openRouterModelsApiUrl')) {
    try {
      const currentProviders = configStore.loadProviders();
      const nextRegistry = structuredClone(currentProviders.registry);
      const openrouterProvider = nextRegistry.providers.find((entry) => entry.type === 'openrouter');
      const nextUrl = mergedRuntimeSettings.openRouterModelsApiUrl?.trim();
      if (openrouterProvider && nextUrl) {
        openrouterProvider.modelsApiUrl = nextUrl;
        const savedProviders = systemDataWriter
          ? await systemDataWriter.writeSystemData({
              kind: 'owner_file',
              ownerFile: 'providers',
              payload: nextRegistry,
            }).then(() => configStore.loadProviders())
          : configStore.saveProviders(nextRegistry);
        applyProvidersRuntimeConfig(config, savedProviders);
        invalidatePromptCacheAfterOwnerMutation(config, 'owner-file:providers');
      }
    } catch (error) {
      return {
        ok: false,
        message: `Settings saved but providers config update failed: ${toErrorMessage(error)}`,
      };
    }
  }

  if (hasModelSettings(domainSplit.models)) {
    try {
      const currentModels = configStore.loadModels();
      const modelPatch: EditableSettings = { ...domainSplit.models };
      const hasPrimaryAliasPatch = modelPatch.primaryModel !== undefined
        || modelPatch.primaryProvider !== undefined
        || modelPatch.primaryMaxTokens !== undefined;
      if (hasPrimaryAliasPatch) {
        const currentPrimary = config.modelRoster.chat ?? {
          model: config.primaryModel,
          provider: config.primaryProvider,
          maxTokens: config.primaryMaxTokens,
        };
        modelPatch.primaryModel ??= currentPrimary.model;
        modelPatch.primaryProvider ??= currentPrimary.provider;
        modelPatch.primaryMaxTokens ??= currentPrimary.maxTokens;
      }
      const hasExtractionAliasPatch = modelPatch.extractionModel !== undefined
        || modelPatch.extractionProvider !== undefined
        || modelPatch.extractionMaxTokens !== undefined;
      if (hasExtractionAliasPatch) {
        const currentExtraction = config.modelRoster.background ?? {
          model: config.extractionModel,
          provider: config.extractionProvider,
          maxTokens: config.extractionMaxTokens,
        };
        modelPatch.extractionModel ??= currentExtraction.model;
        modelPatch.extractionProvider ??= currentExtraction.provider;
        modelPatch.extractionMaxTokens ??= currentExtraction.maxTokens;
      }

      const mergedModelSettings = normalizeEditableSettings(
        {
          modelCatalog: currentModels.modelCatalog,
          modelRoleAssignments: currentModels.modelRoleAssignments,
          ...modelPatch,
        },
        { defaultContextWindow: config.defaultContextWindow },
      );
      const modelMutation = await applyAdminModelsConfigMutation({
        config,
        configStore,
        ...(systemDataWriter ? { systemDataWriter } : {}),
        payload: {
          modelCatalog: mergedModelSettings.modelCatalog ?? currentModels.modelCatalog,
          modelRoleAssignments: mergedModelSettings.modelRoleAssignments ?? currentModels.modelRoleAssignments,
        },
      });
      if (!modelMutation.ok) {
        return {
          ok: false,
          message: `Settings saved but models config update failed: ${modelMutation.message}`,
        };
      }
      for (const key of modelMutation.refreshedKeys) {
        refreshedKeys.add(key);
      }
      divergences.push(...modelMutation.divergences);
    } catch (error) {
      return {
        ok: false,
        message: `Settings saved but models config update failed: ${toErrorMessage(error)}`,
      };
    }
  }

  if (domainSplit.capabilityTier !== undefined) {
    try {
      const currentCapabilities = configStore.loadCapabilityTier();
      const capabilityMutation = applyAdminCapabilityTierMutation({
        config,
        configStore,
        payload: {
          ...currentCapabilities,
          tier: domainSplit.capabilityTier,
          customTokens: domainSplit.capabilityTier === 'custom'
            ? [...(capabilityCustomTokens ?? [])]
            : currentCapabilities.customTokens,
        },
        ...(onCapabilityTierChanged ? { onCapabilityTierChanged } : {}),
      });
      if (!capabilityMutation.ok) {
        return {
          ok: false,
          message: `Settings saved but capability tier update failed: ${capabilityMutation.message}`,
        };
      }
      for (const key of capabilityMutation.refreshedKeys) {
        refreshedKeys.add(key);
      }
      divergences.push(...capabilityMutation.divergences);
    } catch (error) {
      return {
        ok: false,
        message: `Settings saved but capability tier update failed: ${toErrorMessage(error)}`,
      };
    }
  }

  return { ok: true, refreshedKeys: [...refreshedKeys], divergences };
}

export class AdminSettingsDataService implements AdminSettingsService {
  private readonly divergences = new Map<AdminSettingsDivergence['key'], AdminSettingsDivergence>();

  constructor(private readonly deps: {
    config: SubstrateConfig;
    configStore: ConfigStorePort;
    systemDataWriter?: GatewaySystemDataWriterPort;
    getCredentialPresence?: () => Promise<GatewayCredentialPresenceResult>;
    effectiveSchedulerConfig?: import('../../../system/config/scheduler-config.js').SchedulerRuntimeConfig;
    onCapabilityTierChanged?: CapabilityTierChangeHandler;
  }) {}

  private async persistSystemOwner<T>(
    ownerFile: SystemOwnerWriteKey,
    payload: unknown,
    loadPersisted: () => T,
    saveLocally: () => T,
  ): Promise<T> {
    if (!this.deps.systemDataWriter) return saveLocally();
    await this.deps.systemDataWriter.writeSystemData({
      kind: 'owner_file',
      ownerFile,
      payload,
    });
    return loadPersisted();
  }

  private ownerWriteFailure(error: unknown): ConfigUpdateResult {
    const message = toErrorMessage(error);
    const errorCode = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
    if (errorCode === 'EROFS' || /\bEROFS\b|read-only file system/iu.test(message)) {
      return {
        ok: false,
        message:
          'This deployment does not permit direct system-scope owner-file writes. '
          + 'The authenticated gateway system-data writer is unavailable.',
      };
    }
    return {
      ok: false,
      message: this.deps.systemDataWriter
        ? `Gateway system-data write failed: ${message}`
        : message,
    };
  }

  private updateDivergences(
    refreshedKeys: readonly AdminSettingsDivergence['key'][],
    divergences: readonly AdminSettingsDivergence[],
  ): AdminSettingsStatus {
    for (const key of refreshedKeys) {
      this.divergences.delete(key);
    }
    for (const divergence of divergences) {
      this.divergences.set(divergence.key, divergence);
    }
    return this.buildSettingsStatus();
  }

  private buildSettingsStatus(): AdminSettingsStatus {
    const divergences = [...this.divergences.values()].sort((a, b) => a.key.localeCompare(b.key));
    if (divergences.length === 0) {
      return {
        status: 'healthy',
        detail: 'Persisted settings match the live Garden runtime.',
        divergences: [],
      };
    }

    return {
      status: 'degraded',
      detail: divergences.map(entry => entry.detail).join(' '),
      divergences,
    };
  }

  private buildSuccessfulSaveResult(baseMessage: string, status: AdminSettingsStatus): ConfigUpdateResult {
    return {
      ok: true,
      message: status.status === 'degraded'
        ? `${baseMessage} with divergence: ${status.detail}`
        : baseMessage,
      status,
    };
  }

  private async getEnvInfo() {
    const presence = this.deps.getCredentialPresence
      ? await this.deps.getCredentialPresence()
      : {
          discordToken: false,
          apiKey: Boolean(this.deps.config.localApiKey),
          adminToken: Boolean(this.deps.config.adminAuthToken),
          openrouterApiKey: false,
          litellmBaseUrl: Boolean(this.deps.config.litellmBaseUrl),
          litellmApiKey: false,
          importProcessingLocalApiKey: false,
          falApiKey: false,
          telegramBotToken: false,
        };
    const marker = (configured: boolean): '[set]' | '[not set]' =>
      configured ? '[set]' : '[not set]';
    return {
      salienceFloor: resolveMemorySalienceFloor(
        resolveMemoryRetrievalPolicy(this.deps.config.memoryRetrievalPolicy),
        'episodic',
        0,
      ),
      backgroundMaintenanceIntervalMs:
        this.deps.configStore.loadScheduler().backgroundMaintenance.intervalMs,
      discordToken: marker(presence.discordToken),
      apiKey: marker(presence.apiKey),
      adminToken: marker(presence.adminToken),
      openrouterApiKey: marker(presence.openrouterApiKey),
      litellmBaseUrl: marker(presence.litellmBaseUrl),
      litellmApiKey: marker(presence.litellmApiKey),
      importProcessingLocalApiKey: marker(presence.importProcessingLocalApiKey),
      falApiKey: marker(presence.falApiKey),
      telegramBotToken: marker(presence.telegramBotToken),
    };
  }

  private loadSettingsConfigEditors(): SettingsConfigEditors {
    return {
      models: this.deps.configStore.loadModels(),
      providers: this.deps.configStore.loadProviders(),
      channels: this.deps.configStore.loadChannelsOwnerFile(),
      skills: this.deps.configStore.loadSkills(),
      scheduler: this.deps.configStore.loadScheduler(),
      trustPolicy: this.deps.configStore.loadTrustPolicy(),
      capabilities: this.deps.configStore.loadCapabilityTier(),
      chargePolicy: this.deps.configStore.loadChargePolicy(),
      backup: this.deps.configStore.loadBackup(),
    };
  }

  private buildVoiceProviderOptionList(kind: 'stt' | 'tts'): AdminVoiceProviderOption[] {
    if (kind === 'stt') {
      return listStreamingSttProviders()
        .map((providerId) => {
          const metadata = getStreamingSttProviderMetadata(providerId);
          return {
            id: providerId,
            configured: isStreamingSttProviderConfigured(providerId, this.deps.config),
            requiredTokens: [...(metadata?.eligibility?.requiredTokens ?? [])],
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    return listStreamingTtsProviders()
      .map((providerId) => {
        const metadata = getStreamingTtsProviderMetadata(providerId);
        return {
          id: providerId,
          configured: isStreamingTtsProviderConfigured(providerId, this.deps.config),
          requiredTokens: [...(metadata?.eligibility?.requiredTokens ?? [])],
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private loadVoiceProviderData(): AdminVoiceProviderData {
    return {
      stt: this.buildVoiceProviderOptionList('stt'),
      tts: this.buildVoiceProviderOptionList('tts'),
    };
  }


  private buildValidationResult(errors: SettingsValidationError[]): ConfigUpdateResult {
    return {
      ok: false,
      message: errors.map(error => error.message).join('; '),
      validationErrors: errors,
    };
  }

  private pushFieldError(
    errors: SettingsValidationError[],
    field: string,
    message: string,
    code: string,
  ): void {
    errors.push({ field, message, code });
  }

  private validateBooleanField(
    payload: Record<string, unknown>,
    field: string,
    errors: SettingsValidationError[],
  ): void {
    if (!(field in payload)) return;
    if (typeof payload[field] !== 'boolean') {
      this.pushFieldError(errors, field, `${field} must be true or false`, 'invalid_type');
    }
  }

  private validateEnumField(
    payload: Record<string, unknown>,
    field: string,
    allowedValues: Set<string>,
    errors: SettingsValidationError[],
  ): void {
    if (!(field in payload)) return;
    const value = payload[field];
    if (typeof value !== 'string' || !allowedValues.has(value)) {
      this.pushFieldError(
        errors,
        field,
        `${field} must be one of: ${Array.from(allowedValues).join(', ')}`,
        'invalid_enum',
      );
    }
  }

  private validateSttProviderField(
    payload: Record<string, unknown>,
    errors: SettingsValidationError[],
  ): void {
    if (!('sttProvider' in payload)) return;
    const value = payload.sttProvider;
    if (typeof value !== 'string') {
      this.pushFieldError(errors, 'sttProvider', 'sttProvider must be a string', 'invalid_type');
      return;
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      this.pushFieldError(
        errors,
        'sttProvider',
        'sttProvider must be "disabled" or a registered STT provider id',
        'invalid_stt_provider',
      );
      return;
    }

    if (normalized !== 'disabled' && !isStreamingSttProvider(normalized)) {
      this.pushFieldError(
        errors,
        'sttProvider',
        'sttProvider must be "disabled" or a registered STT provider id',
        'invalid_stt_provider',
      );
    }
  }

  private validateTtsProviderField(
    payload: Record<string, unknown>,
    errors: SettingsValidationError[],
  ): void {
    if (!('ttsProvider' in payload)) return;
    const value = payload.ttsProvider;
    if (typeof value !== 'string') {
      this.pushFieldError(errors, 'ttsProvider', 'ttsProvider must be a string', 'invalid_type');
      return;
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      this.pushFieldError(
        errors,
        'ttsProvider',
        'ttsProvider must be "disabled" or a registered TTS provider id',
        'invalid_tts_provider',
      );
      return;
    }

    if (normalized !== 'disabled' && !isStreamingTtsProvider(normalized)) {
      this.pushFieldError(
        errors,
        'ttsProvider',
        'ttsProvider must be "disabled" or a registered TTS provider id',
        'invalid_tts_provider',
      );
    }
  }

  private validateStringArrayField(
    payload: Record<string, unknown>,
    field: string,
    errors: SettingsValidationError[],
  ): void {
    if (!(field in payload)) return;
    const value = payload[field];
    const isValidArray = Array.isArray(value)
      && value.every(entry => typeof entry === 'string');
    if (!isValidArray) {
      this.pushFieldError(errors, field, `${field} must be an array of strings`, 'invalid_type');
    }
  }

  private validateNonEmptyStringField(
    payload: Record<string, unknown>,
    field: string,
    errors: SettingsValidationError[],
  ): void {
    if (!(field in payload)) return;
    const value = payload[field];
    if (typeof value !== 'string') {
      this.pushFieldError(errors, field, `${field} must be a string`, 'invalid_type');
      return;
    }
    if (!value.trim()) {
      this.pushFieldError(errors, field, `${field} cannot be empty`, 'required');
    }
  }

  private validateHttpUrlField(
    payload: Record<string, unknown>,
    field: string,
    errors: SettingsValidationError[],
  ): void {
    if (!(field in payload)) return;
    const value = payload[field];
    if (typeof value !== 'string') {
      this.pushFieldError(errors, field, `${field} must be a string`, 'invalid_type');
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) return;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        this.pushFieldError(errors, field, `${field} must use http or https`, 'invalid_url');
      }
    } catch {
      this.pushFieldError(errors, field, `${field} must be a valid URL`, 'invalid_url');
    }
  }

  private validateCompositionalPolicyField(
    payload: Record<string, unknown>,
    errors: SettingsValidationError[],
  ): void {
    if (!('compositionalPolicy' in payload)) return;
    for (const message of validateCompositionalPolicyConfig(payload.compositionalPolicy)) {
      const separatorIndex = message.indexOf(' ');
      const field = separatorIndex > 0 ? message.slice(0, separatorIndex) : 'compositionalPolicy';
      this.pushFieldError(
        errors,
        field,
        message,
        message.includes('must be') ? 'invalid_type' : 'invalid_value',
      );
    }
  }

  private validateImageWorkflowsField(
    payload: Record<string, unknown>,
    errors: SettingsValidationError[],
  ): void {
    if (!('imageWorkflows' in payload)) return;
    try {
      normalizeImageWorkflowSettings(payload.imageWorkflows);
    } catch (error) {
      this.pushFieldError(
        errors,
        'imageWorkflows',
        error instanceof Error ? error.message : 'imageWorkflows is invalid',
        'invalid_object',
      );
    }
  }

  /**
   * 23pp: validate a `modelPurposeSelection` write fail-closed — structural
   * shape via the shared normalizer, then every slot key against the LIVE
   * models.json registry so an unknown/disabled selection is rejected at the
   * admin boundary with the valid slot ids, never persisted to break startup.
   */
  private validateModelPurposeSelectionField(
    payload: Record<string, unknown>,
    errors: SettingsValidationError[],
  ): void {
    if (!('modelPurposeSelection' in payload)) return;
    let normalized;
    try {
      normalized = normalizeModelPurposeSelectionSetting(payload.modelPurposeSelection);
    } catch (error) {
      this.pushFieldError(
        errors,
        'modelPurposeSelection',
        error instanceof Error ? error.message : 'modelPurposeSelection is invalid',
        'invalid_object',
      );
      return;
    }
    if (!normalized) return;
    try {
      assertModelPurposeSelectionResolvable({
        modelPurposeSelection: normalized,
        ...(this.deps.config.modelRegistry
          ? { modelRegistry: this.deps.config.modelRegistry }
          : {}),
      });
    } catch (error) {
      this.pushFieldError(
        errors,
        'modelPurposeSelection',
        error instanceof Error ? error.message : 'modelPurposeSelection references an unknown model slot',
        'invalid_object',
      );
    }
  }

  private validateModelCatalogRouting(
    payload: Record<string, unknown>,
    errors: SettingsValidationError[],
  ): void {
    if (!('modelCatalog' in payload)) return;
    if (!isRecord(payload.modelCatalog)) return;

    for (const [slotKey, rawEntry] of Object.entries(payload.modelCatalog)) {
      if (!isRecord(rawEntry) || !('routing' in rawEntry)) continue;
      const fieldPrefix = `modelCatalog.${slotKey}.routing`;
      if (!isRecord(rawEntry.routing)) {
        this.pushFieldError(errors, fieldPrefix, `${fieldPrefix} must be an object`, 'invalid_type');
        continue;
      }

      if (!('providerOrder' in rawEntry.routing)) continue;
      const providerOrder = rawEntry.routing.providerOrder;
      const isValid = Array.isArray(providerOrder)
        && providerOrder.every(entry => typeof entry === 'string');
      if (!isValid) {
        this.pushFieldError(
          errors,
          `${fieldPrefix}.providerOrder`,
          `${fieldPrefix}.providerOrder must be an array of strings`,
          'invalid_type',
        );
      }
    }
  }

  private validateNumberRangeField(
    payload: Record<string, unknown>,
    field: string,
    range: { min: number; max: number },
    errors: SettingsValidationError[],
  ): void {
    if (!(field in payload)) return;
    const value = payload[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.pushFieldError(errors, field, `${field} must be ${range.min}-${range.max}`, 'invalid_number');
      return;
    }
    if (value < range.min || value > range.max) {
      this.pushFieldError(errors, field, `${field} must be ${range.min}-${range.max}`, 'out_of_range');
    }
  }

  private validateSettingsPayload(
    payload: Record<string, unknown>,
    current: Partial<SubstrateConfig>,
  ): SettingsValidationError[] {
    const errors: SettingsValidationError[] = [];

    for (const [field, owner] of SETTINGS_OWNER_FILE_BY_FIELD.entries()) {
      if (!(field in payload)) continue;
      this.pushFieldError(
        errors,
        field,
        `${field} is owned by ${owner}; edit that canonical config instead`,
        'wrong_owner',
      );
    }

    for (const field of REMOVED_RUNTIME_SETTINGS_KEYS) {
      if (!(field in payload)) continue;
      this.pushFieldError(
        errors,
        field,
        REMOVED_RUNTIME_SETTINGS_MESSAGES[field]
          ?? `${field} has been removed from runtime settings`,
        'removed_field',
      );
    }

    for (const [field, range] of Object.entries(SETTINGS_VALIDATION)) {
      if (!(field in payload)) continue;
      if (SETTINGS_OWNER_FILE_BY_FIELD.has(field)) continue;
      const value = payload[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        this.pushFieldError(errors, field, `${field} must be ${range.min}-${range.max}`, 'invalid_number');
        continue;
      }
      if (value < range.min || value > range.max) {
        this.pushFieldError(errors, field, `${field} must be ${range.min}-${range.max}`, 'out_of_range');
      }
    }

    for (const field of SETTINGS_BOOLEAN_FIELDS) {
      this.validateBooleanField(payload, field, errors);
    }

    this.validateEnumField(payload, 'importProcessingRouteMode', IMPORT_ROUTE_MODE_VALUES, errors);
    this.validateEnumField(payload, 'sessionRestartBehavior', SESSION_RESTART_BEHAVIOR_VALUES_SET, errors);
    this.validateEnumField(payload, 'imageProvider', IMAGE_PROVIDER_VALUES_SET, errors);
    this.validateEnumField(payload, 'imageFalCreateModel', FAL_CREATE_MODEL_VALUES_SET, errors);
    this.validateEnumField(payload, 'imageFalEditModel', FAL_EDIT_MODEL_VALUES_SET, errors);
    this.validateEnumField(payload, 'imageSelfieEditModel', FAL_EDIT_MODEL_VALUES_SET, errors);
    this.validateTtsProviderField(payload, errors);
    this.validateSttProviderField(payload, errors);

    for (const field of SETTINGS_STRING_ARRAY_FIELDS) {
      this.validateStringArrayField(payload, field, errors);
    }

    this.validateNonEmptyStringField(payload, 'uiThemeId', errors);

    this.validateHttpUrlField(payload, 'importProcessingLocalEndpointUrl', errors);
    this.validateHttpUrlField(payload, 'chatApiBaseUrl', errors);
    this.validateHttpUrlField(payload, 'comfyUiBaseUrl', errors);
    this.validateCompositionalPolicyField(payload, errors);
    this.validateImageWorkflowsField(payload, errors);
    this.validateModelPurposeSelectionField(payload, errors);
    this.validateModelCatalogRouting(payload, errors);
    this.validateNumberRangeField(payload, 'moodCongruenceWeight', MOOD_CONGRUENCE_WEIGHT_RANGE, errors);
    if ('memoryRetrievalPolicy' in payload) {
      try {
        normalizeMemoryRetrievalPolicy(
          payload.memoryRetrievalPolicy,
          'memoryRetrievalPolicy',
        );
      } catch (error) {
        this.pushFieldError(
          errors,
          'memoryRetrievalPolicy',
          toErrorMessage(error),
          'invalid_object',
        );
      }
    }
    if ('memoryDeletionPolicy' in payload) {
      try {
        normalizeMemoryDeletionPolicy(
          payload.memoryDeletionPolicy,
          'memoryDeletionPolicy',
        );
      } catch (error) {
        this.pushFieldError(
          errors,
          'memoryDeletionPolicy',
          toErrorMessage(error),
          'invalid_object',
        );
      }
    }

    const effectiveRouteMode = typeof payload.importProcessingRouteMode === 'string'
      ? payload.importProcessingRouteMode
      : current.importProcessingRouteMode ?? 'background';
    const effectiveLocalEndpointUrl = typeof payload.importProcessingLocalEndpointUrl === 'string'
      ? payload.importProcessingLocalEndpointUrl
      : current.importProcessingLocalEndpointUrl ?? '';
    const effectiveLocalModel = typeof payload.importProcessingLocalModel === 'string'
      ? payload.importProcessingLocalModel
      : current.importProcessingLocalModel ?? '';
    if (effectiveRouteMode === 'local_endpoint') {
      if (!effectiveLocalEndpointUrl.trim()) {
        this.pushFieldError(
          errors,
          'importProcessingLocalEndpointUrl',
          'importProcessingLocalEndpointUrl is required when importProcessingRouteMode=local_endpoint',
          'required',
        );
      }
      if (!effectiveLocalModel.trim()) {
        this.pushFieldError(
          errors,
          'importProcessingLocalModel',
          'importProcessingLocalModel is required when importProcessingRouteMode=local_endpoint',
          'required',
        );
      }
    }

    return errors;
  }

  private parseCapabilityCustomTokens(payload: Record<string, unknown>): CapabilityToken[] | undefined {
    if (!Array.isArray(payload.customTokens)) return undefined;
    return payload.customTokens
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter((entry): entry is CapabilityToken => isCapabilityToken(entry));
  }

  async getSettingsData(): Promise<AdminSettingsData> {
    const runtimeConfig = splitSettingsByDomain(
      this.deps.configStore.loadEffectiveRuntimeSettings(),
    ).runtime;
    runtimeConfig.sessionRestartBehavior ??= 'reuse_latest_session';
    const editors = this.loadSettingsConfigEditors();
    return {
      config: runtimeConfig,
      env: await this.getEnvInfo(),
      editors,
      voiceProviders: this.loadVoiceProviderData(),
      status: this.buildSettingsStatus(),
      effectiveChargeQuota: this.buildEffectiveChargeQuotaState(editors.chargePolicy),
      effectiveBackgroundMaintenance: this.buildEffectiveBackgroundMaintenanceState(
        editors.scheduler,
      ),
      effectiveIcpAutonomy: this.buildEffectiveIcpAutonomyState(editors),
      fleetAuth: buildEffectiveFleetAuthOwnerProjection({
        ...(this.deps.config.fleetAuth
          ? { effectiveGatewayConfig: this.deps.config.fleetAuth }
          : {}),
        ...(this.deps.config.fleetAuthVerifier
          ? { effectiveVerifierConfig: this.deps.config.fleetAuthVerifier }
          : {}),
        loadOnDisk: () => this.deps.configStore.loadFleetAuthOwnerFile(),
        reportUnavailable: error => log.warn('Canonical fleet-auth owner projection is unavailable', {
          error: toErrorMessage(error),
        }),
      }),
      workspaceLayout: {
        mode: this.deps.config.multiCompanion === true ? 'fleet' : 'single',
        personalWorkspacePath: this.deps.config.workspacePath?.trim() || null,
        sharedWorkspacePath: this.deps.config.sharedWorkspacePath?.trim() || null,
        companionSharedAccess: this.deps.config.sharedWorkspacePath ? 'read_only' : 'none',
        executableAutoLoad: false,
        promptAutoLoad: false,
      },
    };
  }

  /**
   * Compares the on-disk charge-policy owner file against the quotas the
   * running process loaded at startup (config.chargePolicy). A divergence means
   * a restart is required before the on-disk edit takes effect — the exact
   * failure mode psfn-framework-9bgk traced. Effective is null when the runtime
   * carries no loaded charge policy.
   */
  private buildEffectiveChargeQuotaState(
    onDisk: ChargePolicyConfig,
  ): EffectiveChargeQuotaState {
    const onDiskChargeQuotaByLane = onDisk.runChargeQuotaByLane;
    const effectiveChargeQuotaByLane = this.deps.config.chargePolicy?.runChargeQuotaByLane ?? null;
    const restartRequired = effectiveChargeQuotaByLane !== null
      && JSON.stringify(effectiveChargeQuotaByLane) !== JSON.stringify(onDiskChargeQuotaByLane);
    return {
      effectiveChargeQuotaByLane,
      onDiskChargeQuotaByLane,
      restartRequired,
    };
  }

  private buildEffectiveBackgroundMaintenanceState(
    onDisk: SettingsConfigEditors['scheduler'],
  ): EffectiveBackgroundMaintenanceState {
    const effectiveIntervalMs = this.deps.effectiveSchedulerConfig
      ?.backgroundMaintenance.intervalMs ?? null;
    const onDiskIntervalMs = onDisk.backgroundMaintenance.intervalMs;
    return {
      ownerFile: 'scheduler.json',
      effectiveIntervalMs,
      onDiskIntervalMs,
      restartRequired: effectiveIntervalMs !== null && effectiveIntervalMs !== onDiskIntervalMs,
    };
  }

  private buildEffectiveIcpAutonomyState(
    onDisk: Pick<SettingsConfigEditors, 'scheduler' | 'chargePolicy'>,
  ): EffectiveIcpAutonomySettingsState {
    const projectCharge = (policy: ChargePolicyConfig): IcpAutonomyChargeOwnerProjection => ({
      companionSocialQuota: policy.runChargeQuotaByLane.companion_social,
      companionSocialContinuationCost: policy.surfaceCosts.companionSocialContinuation,
      fatigue: structuredClone(policy.fatigue),
      costBreaker: structuredClone(policy.icpCostBreaker),
    });
    const effectiveScheduler = this.deps.effectiveSchedulerConfig?.icpAutonomy ?? null;
    const onDiskScheduler = onDisk.scheduler.icpAutonomy;
    const effectiveCharge = this.deps.config.chargePolicy
      ? projectCharge(this.deps.config.chargePolicy)
      : null;
    const onDiskCharge = projectCharge(onDisk.chargePolicy);
    return {
      scheduler: {
        ownerFile: 'scheduler.json',
        effectiveValue: effectiveScheduler,
        onDiskValue: onDiskScheduler,
        restartRequired: effectiveScheduler !== null
          && JSON.stringify(effectiveScheduler) !== JSON.stringify(onDiskScheduler),
      },
      chargePolicy: {
        ownerFile: 'charge-policy.json',
        effectiveValue: effectiveCharge,
        onDiskValue: onDiskCharge,
        restartRequired: effectiveCharge !== null
          && JSON.stringify(effectiveCharge) !== JSON.stringify(onDiskCharge),
      },
    };
  }

  getSettingsContractData() {
    return buildSettingsContractData({
      sttProviderIds: listStreamingSttProviders(),
      ttsProviderIds: listStreamingTtsProviders(),
    });
  }

  async updateSettings(body: string): Promise<ConfigUpdateResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        ok: false,
        message: 'Request body must be valid JSON',
        validationErrors: [{ field: '$root', message: 'Request body must be valid JSON', code: 'invalid_json' }],
      };
    }

    if (!isRecord(parsed)) {
      return {
        ok: false,
        message: 'Settings payload must be a JSON object',
        validationErrors: [{ field: '$root', message: 'Settings payload must be a JSON object', code: 'invalid_payload' }],
      };
    }

    try {
      const current = this.deps.configStore.loadEffectiveRuntimeSettings();
      const validationErrors = this.validateSettingsPayload(parsed, current as Partial<SubstrateConfig>);
      if (validationErrors.length > 0) {
        return this.buildValidationResult(validationErrors);
      }

      const payload = parsed as EditableSettings;
      const mutationResult = await applyAdminSettingsMutation({
        config: this.deps.config,
        configStore: this.deps.configStore,
        settings: payload,
        ...(this.deps.systemDataWriter
          ? { systemDataWriter: this.deps.systemDataWriter }
          : {}),
        capabilityCustomTokens: this.parseCapabilityCustomTokens(parsed),
        ...(this.deps.onCapabilityTierChanged
          ? { onCapabilityTierChanged: this.deps.onCapabilityTierChanged }
          : {}),
      });
      if (!mutationResult.ok) {
        return this.ownerWriteFailure(new Error(mutationResult.message));
      }
      const status = this.updateDivergences(mutationResult.refreshedKeys, mutationResult.divergences);
      return this.buildSuccessfulSaveResult('Settings updated', status);
    } catch (error) {
      return this.ownerWriteFailure(error);
    }
  }

  // ── Garden channel Context Envelope view (E3.2) ──

  /**
   * Splits the channels.json root into (root, scoped) taking the optional
   * `channels` wrapper into account, mirroring loadRuntimeChannelsConfig.
   */
  private loadChannelsOwnerScopes(): {
    root: Record<string, unknown>;
    scopedRoot: Record<string, unknown>;
    hasWrapper: boolean;
  } {
    const root = this.deps.configStore.loadChannelsOwnerFile();
    const hasWrapper = isRecord(root.channels);
    const scopedRoot = hasWrapper ? root.channels as Record<string, unknown> : root;
    return { root, scopedRoot, hasWrapper };
  }

  /**
   * Channel list for the Garden CHANNELS view: every channel owning a
   * channels.json envelope label or an exact operator override, classified
   * through the contract precedence (channel-owned label > operator override
   * > derived default) against the freshly loaded owner files.
   */
  getChannelEnvelopeData(): AdminChannelEnvelopeData {
    const { scopedRoot } = this.loadChannelsOwnerScopes();
    const section = parseContextEnvelopeSection(scopedRoot);
    const labels = section.channels;
    const trustPolicy = this.deps.configStore.loadTrustPolicy();

    const channelIds = new Set<string>([
      ...Object.keys(labels),
      ...Object.keys(trustPolicy.channelClassification.visibilityOverrides.exact),
    ]);

    const channels: AdminChannelEnvelopeRow[] = [...channelIds]
      .sort((a, b) => a.localeCompare(b))
      .map((channelId) => {
        const label = Object.hasOwn(labels, channelId) ? labels[channelId] : undefined;
        const classification = resolveChannelEnvelopeClassification(channelId, undefined, {
          ...(label ? { label } : {}),
          trustPolicy,
        });
        return {
          channelId,
          privacy: classification.privacy,
          broadcast: classification.broadcast,
          contactTracking: classification.contactTracking,
          deliveryStyle: classification.deliveryStyle,
          deliveryStyleSource: classification.deliveryStyleSource,
          source: classification.source,
          needsReview: classification.needsReview,
          hasLabel: label !== undefined,
          ...(label ? { label } : {}),
        };
      });

    // Newest epoch first for the Garden audit surface.
    const epochs = [...section.classificationEpochs].sort(
      (a, b) => Date.parse(b.at) - Date.parse(a.at),
    );

    return {
      channels,
      prefixOverrides: { ...trustPolicy.channelClassification.visibilityOverrides.prefix },
      privatePrefixes: [...trustPolicy.channelClassification.privatePrefixes],
      broadcastPrefixes: [...trustPolicy.channelClassification.broadcastPrefixes],
      epochs,
    };
  }

  /**
   * Upserts (label object) or removes (null) one channel-owned envelope label
   * through the owner-file path with full fail-closed validation.
   *
   * Write-gate (jp36.6.2): this generic editor path MUST NOT set the operator
   * decision marker `classificationSource: 'operator_confirmed'` — that marker
   * is only writable through the click-to-accept demotion flow
   * (acceptChannelDemotion), which stamps it atomically with an operator-signed
   * epoch record. A label carrying it here is rejected fail-closed, and this
   * generic path cannot change any non-public channel to public/broadcast.
   */
  async saveChannelEnvelopeLabel(channelIdRaw: string, label: unknown): Promise<ConfigUpdateResult> {
    const channelId = channelIdRaw.trim();
    if (!channelId) {
      return { ok: false, message: 'channelId must be a non-empty string' };
    }

    if (
      label !== null
      && label !== undefined
      && typeof label === 'object'
      && !Array.isArray(label)
      && 'classificationSource' in (label as Record<string, unknown>)
    ) {
      return {
        ok: false,
        message: "classificationSource is set only by the invite-only → public demotion flow "
          + '(acceptChannelDemotion); it cannot be written through the channel label editor',
      };
    }

    try {
      const { root, scopedRoot, hasWrapper } = this.loadChannelsOwnerScopes();
      const section = parseContextEnvelopeSection(scopedRoot);
      const nextChannels: Record<string, unknown> = { ...section.channels };

      if (label === null || label === undefined) {
        if (!Object.prototype.hasOwnProperty.call(nextChannels, channelId)) {
          return { ok: false, message: `No channel-owned envelope label exists for '${channelId}'` };
        }
        delete nextChannels[channelId];
      } else {
        const validatedLabel = validateChannelEnvelopeLabel(
          label,
          `contextEnvelope.channels.${channelId}`,
        );
        const existingLabel = Object.hasOwn(section.channels, channelId)
          ? section.channels[channelId]
          : undefined;
        const currentClassification = resolveChannelEnvelopeClassification(
          channelId,
          undefined,
          {
            ...(existingLabel ? { label: existingLabel } : {}),
            trustPolicy: this.deps.configStore.loadTrustPolicy(),
          },
        );
        const requestedPublic = validatedLabel.privacy === 'public'
          || validatedLabel.broadcast === true;
        const currentlyPublic = currentClassification.privacy === 'public'
          || currentClassification.broadcast;
        if (requestedPublic && !currentlyPublic) {
          return {
            ok: false,
            message: `Channel '${channelId}' cannot change from ${currentClassification.privacy} `
              + 'to public through the generic label editor; use the click-to-accept '
              + 'invite-only → public demotion flow so a fresh disclosure epoch is recorded',
          };
        }

        // Editing other fields on an already confirmed public channel must not
        // silently erase the operator decision marker. The caller cannot author
        // this field, but the service preserves the existing authority fact.
        nextChannels[channelId] = existingLabel?.classificationSource === 'operator_confirmed'
          && requestedPublic
          ? { ...validatedLabel, classificationSource: 'operator_confirmed' }
          : validatedLabel;
      }

      const nextRoot = this.buildNextChannelsRoot(
        root,
        scopedRoot,
        hasWrapper,
        nextChannels,
        section.classificationEpochs,
      );
      // saveChannelsOwnerFile re-validates the contextEnvelope section fail-closed.
      await this.persistSystemOwner(
        'channels',
        nextRoot,
        () => this.deps.configStore.loadChannelsOwnerFile(),
        () => this.deps.configStore.saveChannelsOwnerFile(nextRoot),
      );
      invalidatePromptCacheAfterOwnerMutation(this.deps.config, 'owner-file:channels');
      return {
        ok: true,
        message: label === null || label === undefined
          ? `Channel envelope label removed for ${channelId}`
          : `Channel envelope label saved for ${channelId}`,
      };
    } catch (error) {
      return this.ownerWriteFailure(error);
    }
  }

  // ── Companion Cluster Bearer API pin (vknn) ──

  /**
   * Registered companions the Bearer API may be pinned to. In the multi-companion
   * runtime this is the companions.json roster; single-companion runtimes expose
   * their one configured companion. The Bearer pin must name one of these.
   */
  private bearerApiCompanionRoster(): BearerApiCompanionOption[] {
    const fleet = this.deps.config.companionFleet;
    if (fleet) {
      return fleet.companions.map(companion => ({
        companionId: companion.companionId,
        displayName: companion.displayName ?? companion.companionId,
      }));
    }
    const single = this.deps.config.companionId;
    return single ? [{ companionId: single, displayName: single }] : [];
  }

  /**
   * Read the Bearer API pinned companion (channels.json api.companionId) plus the
   * registered-companion roster the Companion Cluster control offers.
   */
  getBearerApiCompanionPin(): BearerApiCompanionPinData {
    const { scopedRoot } = this.loadChannelsOwnerScopes();
    const apiSection = isRecord(scopedRoot.api) ? scopedRoot.api : {};
    const pinnedRaw = apiSection.companionId;
    const pinnedCompanionId = typeof pinnedRaw === 'string' && pinnedRaw.trim().length > 0
      ? pinnedRaw.trim()
      : null;
    return {
      pinnedCompanionId,
      companions: this.bearerApiCompanionRoster(),
      restartRequired: true,
    };
  }

  /**
   * Pin the inbound OpenAI-compatible Bearer API to exactly one registered
   * companion. Fails closed when the id is missing or is not a Companion Cluster
   * member; the write goes through the channels.json owner-file contract, which
   * re-validates the api section (UUID format) fail-closed. This only writes
   * `api.companionId` — it never enables per-request companion selection.
   */
  async setBearerApiCompanionPin(companionId: unknown): Promise<ConfigUpdateResult> {
    if (typeof companionId !== 'string' || companionId.trim().length === 0) {
      return { ok: false, message: 'companionId must be a non-empty string' };
    }
    const requested = companionId.trim();
    if (!this.bearerApiCompanionRoster().some(option => option.companionId === requested)) {
      return {
        ok: false,
        message: `companionId ${requested} is not a registered companion; the Bearer API can only be `
          + 'pinned to a Companion Cluster member',
      };
    }
    try {
      const { root, scopedRoot, hasWrapper } = this.loadChannelsOwnerScopes();
      const existingApi = isRecord(scopedRoot.api) ? scopedRoot.api : {};
      const nextScoped = { ...scopedRoot, api: { ...existingApi, companionId: requested } };
      const nextRoot = hasWrapper ? { ...root, channels: nextScoped } : nextScoped;
      // saveChannelsOwnerFile re-validates the api section fail-closed.
      await this.persistSystemOwner(
        'channels',
        nextRoot,
        () => this.deps.configStore.loadChannelsOwnerFile(),
        () => this.deps.configStore.saveChannelsOwnerFile(nextRoot),
      );
      invalidatePromptCacheAfterOwnerMutation(this.deps.config, 'owner-file:channels');
      return {
        ok: true,
        message: `Bearer API pinned to companion ${requested}. Restart the gateway for the API `
          + 'channel to pick up the new pin.',
      };
    } catch (error) {
      return this.ownerWriteFailure(error);
    }
  }

  /**
   * Rebuild the channels owner-file root with a fresh contextEnvelope section,
   * preserving the classification-epoch audit trail. Epochs are omitted from
   * the persisted section only when empty (keeps existing files unchanged).
   */
  private buildNextChannelsRoot(
    root: Record<string, unknown>,
    scopedRoot: Record<string, unknown>,
    hasWrapper: boolean,
    nextChannels: Record<string, unknown>,
    epochs: readonly ChannelClassificationEpoch[],
  ): Record<string, unknown> {
    const contextEnvelope: Record<string, unknown> = { channels: nextChannels };
    if (epochs.length > 0) {
      contextEnvelope.classificationEpochs = epochs.map(epoch => ({ ...epoch }));
    }
    const nextScopedRoot: Record<string, unknown> = { ...scopedRoot, contextEnvelope };
    return hasWrapper ? { ...root, channels: nextScopedRoot } : nextScopedRoot;
  }

  /**
   * Resolve the current classification of a channel and the click-to-accept
   * demotion notice (jp36.6.2). `demotable` is true only when the channel
   * currently resolves to a non-broadcast invite_only classification — the only
   * state an invite-only → public demotion applies to.
   */
  getChannelDemotionNotice(channelIdRaw: string): AdminChannelDemotionNotice {
    const channelId = channelIdRaw.trim();
    const base = {
      channelId,
      from: 'invite_only' as const,
      to: 'public' as const,
      notice: DEMOTION_EPOCH_NOTICE,
      noticeVersion: DEMOTION_EPOCH_NOTICE_VERSION,
    };
    if (!channelId) {
      return { ...base, currentPrivacy: 'invite_only', demotable: false, reason: 'channelId must be a non-empty string' };
    }
    const { scopedRoot } = this.loadChannelsOwnerScopes();
    const section = parseContextEnvelopeSection(scopedRoot);
    const trustPolicy = this.deps.configStore.loadTrustPolicy();
    const label = Object.hasOwn(section.channels, channelId) ? section.channels[channelId] : undefined;
    const classification = resolveChannelEnvelopeClassification(channelId, undefined, {
      ...(label ? { label } : {}),
      trustPolicy,
    });
    const demotable = classification.privacy === 'invite_only' && !classification.broadcast;
    return {
      ...base,
      currentPrivacy: classification.privacy,
      demotable,
      ...(demotable
        ? {}
        : { reason: `Channel '${channelId}' is not invite-only (currently ${classification.privacy}); only invite-only → public demotions exist` }),
    };
  }

  /**
   * Accept an invite-only → public demotion (jp36.6.2). Blocked fail-closed
   * unless the operator acknowledges the CURRENT notice version and the channel
   * currently resolves to invite_only. On success it atomically upserts a
   * `classificationSource: 'operator_confirmed'` public label AND appends an
   * operator-signed classification-epoch record. This is the ONLY write path
   * for the operator_confirmed marker.
   */
  async acceptChannelDemotion(
    input: AdminChannelDemotionAcceptInput,
  ): Promise<AdminChannelDemotionResult> {
    const channelId = input.channelId.trim();
    if (!channelId) {
      return { ok: false, message: 'channelId must be a non-empty string' };
    }
    // Click-to-accept: the operator must acknowledge the current notice version.
    if (input.acknowledgedNoticeVersion !== DEMOTION_EPOCH_NOTICE_VERSION) {
      return {
        ok: false,
        message: 'Demotion blocked: operator must acknowledge the current demotion notice '
          + `(version ${DEMOTION_EPOCH_NOTICE_VERSION}) before invite-only → public is applied`,
      };
    }
    const actor = typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : 'operator';

    try {
      const { root, scopedRoot, hasWrapper } = this.loadChannelsOwnerScopes();
      const section = parseContextEnvelopeSection(scopedRoot);
      const trustPolicy = this.deps.configStore.loadTrustPolicy();
      const currentLabel = Object.hasOwn(section.channels, channelId)
        ? section.channels[channelId]
        : undefined;
      const classification = resolveChannelEnvelopeClassification(channelId, undefined, {
        ...(currentLabel ? { label: currentLabel } : {}),
        trustPolicy,
      });
      if (classification.privacy !== 'invite_only' || classification.broadcast) {
        return {
          ok: false,
          message: `Channel '${channelId}' is not invite-only (currently ${classification.privacy}); `
            + 'only invite-only → public demotions exist',
        };
      }

      // Confirmed public label: pin the tier-1 public classification and stamp
      // the operator decision. Preserve contactTracking/deliveryStyle overrides;
      // drop needsReview (the operator has now confirmed the classification).
      const nextLabel: Record<string, unknown> = {
        privacy: 'public',
        classificationSource: 'operator_confirmed',
      };
      if (currentLabel?.contactTracking !== undefined) nextLabel.contactTracking = currentLabel.contactTracking;
      if (currentLabel?.deliveryStyle !== undefined) nextLabel.deliveryStyle = currentLabel.deliveryStyle;

      const nextChannels: Record<string, unknown> = { ...section.channels };
      nextChannels[channelId] = validateChannelEnvelopeLabel(
        nextLabel,
        `contextEnvelope.channels.${channelId}`,
      );

      const epoch: ChannelClassificationEpoch = {
        channelId,
        from: 'invite_only',
        to: 'public',
        at: new Date().toISOString(),
        acceptedBy: actor,
        noticeVersion: DEMOTION_EPOCH_NOTICE_VERSION,
      };
      const nextEpochs = [...section.classificationEpochs, epoch];

      const nextRoot = this.buildNextChannelsRoot(root, scopedRoot, hasWrapper, nextChannels, nextEpochs);
      // saveChannelsOwnerFile re-validates fail-closed: the confirmed label is
      // now backed by the matching epoch record so the write-gate invariant holds.
      await this.persistSystemOwner(
        'channels',
        nextRoot,
        () => this.deps.configStore.loadChannelsOwnerFile(),
        () => this.deps.configStore.saveChannelsOwnerFile(nextRoot),
      );
      invalidatePromptCacheAfterOwnerMutation(this.deps.config, 'owner-file:channels');
      return {
        ok: true,
        message: `Channel '${channelId}' demoted invite-only → public; fresh disclosure epoch recorded`,
        epoch,
        data: this.getChannelEnvelopeData(),
      };
    } catch (error) {
      return this.ownerWriteFailure(error);
    }
  }

  /**
   * Returns the raw pretty-printed JSON for a named settings subsystem.
   * Returns null when the key is unknown.
   */
  getSubConfigJson(key: string): string | null {
    try {
      switch (key) {
        case 'settings':
          return JSON.stringify(this.deps.configStore.loadRuntimeSettings(), null, 2);
        case 'models':
          return JSON.stringify(this.deps.configStore.loadModels(), null, 2);
        case 'providers':
          return JSON.stringify(this.deps.configStore.loadProviders().registry, null, 2);
        case 'skills':
          return JSON.stringify(this.deps.configStore.loadSkills(), null, 2);
        case 'scheduler':
          return JSON.stringify(this.deps.configStore.loadScheduler(), null, 2);
        case 'trust-policy':
          return JSON.stringify(this.deps.configStore.loadTrustPolicy(), null, 2);
        case 'intake-policy':
          return JSON.stringify(this.deps.configStore.loadIntakePolicy(), null, 2);
        case 'partner-affect-shadow':
          return JSON.stringify(this.deps.configStore.loadPartnerAffectShadow(), null, 2);
        case 'capabilities':
          return JSON.stringify(this.deps.configStore.loadCapabilityTier(), null, 2);
        case 'charge-policy':
          return JSON.stringify(this.deps.configStore.loadChargePolicy(), null, 2);
        case 'channels':
          return JSON.stringify(this.deps.configStore.loadChannelsOwnerFile(), null, 2);
        case 'backup':
          return JSON.stringify(this.deps.configStore.loadBackup(), null, 2);
        default:
          return null;
      }
    } catch (error) {
      log.warn('Failed to load sub-config JSON', { key, error: toErrorMessage(error) });
      return JSON.stringify({
        error: `Unable to load ${key} config; owner file is missing or malformed`,
        key,
      }, null, 2);
    }
  }

  /**
   * Validates and saves a named settings subsystem from raw JSON.
   * Returns a ConfigUpdateResult.
   */
  async saveSubConfigJson(key: string, json: string): Promise<ConfigUpdateResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, message: 'configJson must be valid JSON' };
    }

    try {
      switch (key) {
        case 'fleet-auth':
          return {
            ok: false,
            message: 'fleet-auth.json is read-only in Garden; edit the canonical system owner file outside Garden',
          };
        case 'models': {
          const result = await applyAdminModelsConfigMutation({
            config: this.deps.config,
            configStore: this.deps.configStore,
            payload: parsed,
            ...(this.deps.systemDataWriter
              ? { systemDataWriter: this.deps.systemDataWriter }
              : {}),
          });
          return result.ok
            ? this.buildSuccessfulSaveResult(
              'models.json saved',
              this.updateDivergences(result.refreshedKeys, result.divergences),
            )
            : this.ownerWriteFailure(new Error(result.message));
        }
        case 'scheduler': {
          const saved = this.deps.configStore.saveScheduler(parsed);
          const effectiveSchedulerConfig = this.deps.effectiveSchedulerConfig ?? null;
          const onDiskIntervalMs = saved.backgroundMaintenance.intervalMs;
          if (effectiveSchedulerConfig === null) {
            return {
              ok: true,
              message: 'scheduler.json saved; restart required before scheduler runtime changes take effect',
            };
          }
          const effectiveIntervalMs = effectiveSchedulerConfig.backgroundMaintenance.intervalMs;
          const restartRequired = JSON.stringify(effectiveSchedulerConfig) !== JSON.stringify(saved);
          if (restartRequired && effectiveIntervalMs !== onDiskIntervalMs) {
            return {
              ok: true,
              message:
                'scheduler.json saved; restart required before scheduler changes take effect; '
                + `live background-maintenance cadence remains `
                + `${effectiveIntervalMs.toLocaleString()} ms until restart `
                + `(on disk: ${onDiskIntervalMs.toLocaleString()} ms)`,
            };
          }
          if (restartRequired) {
            return {
              ok: true,
              message:
                'scheduler.json saved; restart required before scheduler changes take effect; '
                + `background-maintenance cadence remains aligned at `
                + `${onDiskIntervalMs.toLocaleString()} ms`,
            };
          }
          return {
            ok: true,
            message:
              'scheduler.json saved; live scheduler already matches scheduler.json',
          };
        }
        case 'capabilities': {
          const result = applyAdminCapabilityTierMutation({
            config: this.deps.config,
            configStore: this.deps.configStore,
            payload: parsed,
            ...(this.deps.onCapabilityTierChanged
              ? { onCapabilityTierChanged: this.deps.onCapabilityTierChanged }
              : {}),
          });
          return result.ok
            ? this.buildSuccessfulSaveResult(
              'capability-tier.json saved',
              this.updateDivergences(result.refreshedKeys, result.divergences),
            )
            : { ok: false, message: result.message };
        }
        case 'charge-policy': {
          this.deps.configStore.saveChargePolicy(parsed);
          return { ok: true, message: 'charge-policy.json saved' };
        }
        case 'backup': {
          await this.persistSystemOwner(
            'backup',
            parsed,
            () => this.deps.configStore.loadBackup(),
            () => this.deps.configStore.saveBackup(parsed),
          );
          return { ok: true, message: 'backup.json saved' };
        }
        case 'providers': {
          const saved = await this.persistSystemOwner(
            'providers',
            parsed,
            () => this.deps.configStore.loadProviders(),
            () => this.deps.configStore.saveProviders(parsed),
          );
          applyProvidersRuntimeConfig(this.deps.config, saved);
          const refreshDivergence = refreshModels(this.deps.config);
          invalidatePromptCacheAfterOwnerMutation(this.deps.config, 'owner-file:providers');
          const status = this.updateDivergences(['models'], refreshDivergence ? [refreshDivergence] : []);
          return this.buildSuccessfulSaveResult('providers.json saved', status);
        }
        case 'channels': {
          await this.persistSystemOwner(
            'channels',
            parsed,
            () => this.deps.configStore.loadChannelsOwnerFile(),
            () => this.deps.configStore.saveChannelsOwnerFile(parsed),
          );
          invalidatePromptCacheAfterOwnerMutation(this.deps.config, 'owner-file:channels');
          return { ok: true, message: 'channels.json saved' };
        }
        case 'skills': {
          this.deps.configStore.saveSkills(parsed);
          invalidatePromptCacheAfterOwnerMutation(this.deps.config, 'owner-file:skills');
          return { ok: true, message: 'skills.json saved' };
        }
        case 'trust-policy': {
          await this.persistSystemOwner(
            'trust-policy',
            parsed,
            () => this.deps.configStore.loadTrustPolicy(),
            () => this.deps.configStore.saveTrustPolicy(parsed),
          );
          invalidatePromptCacheAfterOwnerMutation(this.deps.config, 'owner-file:trust-policy');
          return { ok: true, message: 'trust-policy.json saved' };
        }
        case 'intake-policy': {
          await this.persistSystemOwner(
            'intake-policy',
            parsed,
            () => this.deps.configStore.loadIntakePolicy(),
            () => this.deps.configStore.saveIntakePolicy(parsed),
          );
          return { ok: true, message: 'intake-policy.json saved' };
        }
        case 'partner-affect-shadow': {
          await this.persistSystemOwner(
            'partner-affect-shadow',
            parsed,
            () => this.deps.configStore.loadPartnerAffectShadow(),
            () => this.deps.configStore.savePartnerAffectShadow(parsed),
          );
          return { ok: true, message: 'partner-affect-shadow.json saved' };
        }
        default:
          return { ok: false, message: `Unknown settings subsystem: ${key}` };
      }
    } catch (error) {
      return this.ownerWriteFailure(error);
    }
  }

  // ── Intake source lists (htm9.13; the htm9.11 Garden tab builds on these) ──

  /** Current trusted/denied site and people lists from intake-policy.json. */
  getIntakeSourceLists(
    _context?: import('../garden-request-context.js').GardenRequestContext,
  ): IntakeSourceListsConfig {
    return this.deps.configStore.loadIntakePolicy().sourceLists;
  }

  /**
   * Applies one operator add/remove mutation to the source lists through the
   * owner-file path: pattern normalization, duplicate/contradiction checks,
   * and full config re-validation all fail closed before the save.
   */
  async mutateIntakeSourceList(
    input: AdminIntakeSourceListMutationInput,
    _context?: import('../garden-request-context.js').GardenRequestContext,
  ): Promise<ConfigUpdateResult> {
    try {
      const current = this.deps.configStore.loadIntakePolicy();
      const next = applyIntakeSourceListMutation(current, {
        action: input.action,
        list: input.list,
        pattern: input.pattern,
        ...(input.note !== undefined ? { note: input.note } : {}),
        addedBy: 'operator',
        atMs: Date.now(),
      });
      await this.persistSystemOwner(
        'intake-policy',
        next,
        () => this.deps.configStore.loadIntakePolicy(),
        () => this.deps.configStore.saveIntakePolicy(next),
      );
      return {
        ok: true,
        message: input.action === 'add'
          ? `intake-policy.json: added entry to sourceLists.${input.list}`
          : `intake-policy.json: removed entry from sourceLists.${input.list}`,
      };
    } catch (error) {
      return this.ownerWriteFailure(error);
    }
  }

  /** Read-only typed intake-policy view for the Garden firewall page (htm9.11). */
  getIntakePolicyOverview(): IntakePolicyConfig {
    return this.deps.configStore.loadIntakePolicy();
  }
}
