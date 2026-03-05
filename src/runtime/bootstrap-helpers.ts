import type { SubstrateConfig } from '../types.js';
import { loadSettings, saveSettings, type EditableSettings } from '../settings.js';
import {
  createEmbeddingDimensionMismatchWarning,
  type EmbeddingDimensionValidationResult,
} from '../backup/startup-checks.js';
import type { RuntimeChannelsConfigOverrides } from '../channels/config.js';
import {
  createStreamingSttConnector,
  isStreamingSttProvider,
  isStreamingSttProviderConfigured,
  resolveDefaultStreamingSttProvider,
  resolveStreamingSttRuntimeConfig,
  type StreamingSttConnector,
  type StreamingSttProvider,
} from '../voice/connectors/stt/index.js';
import {
  createStreamingTtsConnector,
  isStreamingTtsProvider,
  isStreamingTtsProviderConfigured,
  listStreamingTtsProviders,
  resolveDefaultStreamingTtsProvider,
  resolveStreamingTtsRuntimeConfig,
  type StreamingTtsConnector,
  type StreamingTtsProvider,
} from '../voice/connectors/tts/index.js';

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

function hasExplicitRuntimeProviderSelection(provider: unknown): provider is string {
  if (typeof provider !== 'string') return false;
  const normalized = provider.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'disabled';
}

export interface RuntimeVoiceSttConnectorOptions extends RuntimeVoiceProviderGateOptions {
  provider?: RuntimeVoiceSttProvider;
}

export interface RuntimeVoiceTtsConnectorOptions extends RuntimeVoiceProviderGateOptions {
  provider?: RuntimeVoiceTtsProvider;
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

  return resolveDefaultStreamingSttProvider(config) ?? 'disabled';
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

  return resolveDefaultStreamingTtsProvider(config) ?? 'disabled';
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
  if (!isStreamingSttProviderConfigured(provider, config) && explicitlySelectedProvider !== provider) {
    return null;
  }

  const connectorConfig = resolveStreamingSttRuntimeConfig(provider, config);
  return {
    provider,
    connector: createStreamingSttConnector(provider, connectorConfig),
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
  ) {
    return null;
  }

  const connectorConfig = resolveStreamingTtsRuntimeConfig(provider, config);
  return {
    provider,
    connector: createStreamingTtsConnector(provider, connectorConfig),
  };
}

export function resolveRuntimeVoiceTtsProviderOrder(
  config: SubstrateConfig,
  preferredProvider?: StreamingTtsProvider,
  options: RuntimeVoiceProviderGateOptions = {},
): StreamingTtsProvider[] {
  const resolvedPreferred = preferredProvider
    ?? (() => {
      const provider = resolveRuntimeVoiceTtsProvider(config);
      return provider === 'disabled' ? null : provider;
    })();

  const orderedProviders: StreamingTtsProvider[] = [];
  if (resolvedPreferred) {
    orderedProviders.push(resolvedPreferred);
  }

  for (const provider of listStreamingTtsProviders()) {
    if (provider === resolvedPreferred) continue;
    if (!isStreamingTtsProviderConfigured(provider, config, options)) continue;
    orderedProviders.push(provider);
  }

  return orderedProviders;
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
  config.runtimeHooks = {
    ...existingHooks,
    persistPromotedExtendedTools: (toolNames) => {
      const current = loadSettings(config.dataDir);
      saveSettings(config.dataDir, {
        ...current,
        promotedExtendedTools: [...toolNames],
      });
    },
  };
}
