import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { EligibilityGate } from '../../../system/capabilities/eligibility.js';
import {
  createStreamingSttConnector,
  getStreamingSttProviderMetadata,
  isStreamingSttProvider,
  isStreamingSttProviderConfigured,
  resolveStreamingSttRuntimeConfig,
  type StreamingSttConnector,
  type StreamingSttProvider,
} from '../../../primitives/voice/connectors/stt/index.js';
import {
  createStreamingTtsConnector,
  getStreamingTtsProviderMetadata,
  isStreamingTtsProvider,
  isStreamingTtsProviderConfigured,
  resolveStreamingTtsRuntimeConfig,
  type StreamingTtsConnector,
  type StreamingTtsProvider,
} from '../../../primitives/voice/connectors/tts/index.js';
import {
  requirePluginActivationEligibility,
  wrapStreamingSttConnectorWithEligibility,
  wrapStreamingTtsConnectorWithEligibility,
} from './plugin-eligibility.js';

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

export interface RuntimeVoiceSttConnectorOptions extends RuntimeVoiceProviderGateOptions {
  provider?: RuntimeVoiceSttProvider;
  eligibilityGate?: EligibilityGate;
}

export interface RuntimeVoiceTtsConnectorOptions extends RuntimeVoiceProviderGateOptions {
  provider?: RuntimeVoiceTtsProvider;
  eligibilityGate?: EligibilityGate;
  fetchImpl?: typeof fetch;
}

function hasExplicitRuntimeProviderSelection(provider: unknown): provider is string {
  if (typeof provider !== 'string') return false;
  const normalized = provider.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'disabled';
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
