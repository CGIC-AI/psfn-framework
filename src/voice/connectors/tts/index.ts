import { createElevenLabsStreamingTtsConnector, type ElevenLabsStreamingTtsConfig } from './elevenlabs-stream.js';
import { createEchoStreamingTtsConnector } from './echo-stream.js';
import type { StreamingTtsConnector } from './types.js';

export * from './types.js';
export * from './elevenlabs-stream.js';
export * from './echo-stream.js';

export type StreamingTtsProvider = 'elevenlabs' | 'echo' | (string & {});

export interface EchoStreamingTtsConfig {
  url: string;
  voice: string;
  preset?: string;
  model?: string;
}

export interface StreamingTtsConfigByProvider {
  elevenlabs: ElevenLabsStreamingTtsConfig;
  echo: EchoStreamingTtsConfig;
  [provider: string]: unknown;
}

export interface StreamingTtsProviderRuntimeConfig {
  [key: string]: unknown;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsModelId?: string;
  echoTtsUrl?: string;
  echoTtsVoice?: string;
  echoTtsPreset?: string;
  echoTtsModel?: string;
}

export interface StreamingTtsProviderMetadataOptions {
  allowEchoDefaults?: boolean;
  requireElevenLabsVoiceId?: boolean;
}

export interface StreamingTtsProviderMetadata {
  canAutoEnable?: boolean;
  isConfigured(
    config: StreamingTtsProviderRuntimeConfig,
    options?: StreamingTtsProviderMetadataOptions,
  ): boolean;
}

export interface StreamingTtsProviderRegistration<TConfig = unknown> {
  createConnector: (config: TConfig) => StreamingTtsConnector;
  metadata: StreamingTtsProviderMetadata;
  resolveRuntimeConfig?: (config: StreamingTtsProviderRuntimeConfig) => TConfig;
}

type AnyStreamingTtsProviderRegistration = StreamingTtsProviderRegistration<any>;

const providerRegistrations = new Map<string, AnyStreamingTtsProviderRegistration>([
  ['elevenlabs', {
    createConnector: createElevenLabsStreamingTtsConnector,
    metadata: {
      canAutoEnable: true,
      isConfigured: (config, options) => (
        options?.requireElevenLabsVoiceId === true
          ? Boolean(config.elevenLabsApiKey && config.elevenLabsVoiceId)
          : Boolean(config.elevenLabsApiKey)
      ),
    },
    resolveRuntimeConfig: (config) => {
      const apiKey = typeof config.elevenLabsApiKey === 'string'
        ? config.elevenLabsApiKey.trim()
        : '';
      const voiceId = typeof config.elevenLabsVoiceId === 'string'
        ? config.elevenLabsVoiceId.trim()
        : '';
      if (!apiKey || !voiceId) {
        throw new Error(
          'ElevenLabs TTS provider selected but ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are not configured',
        );
      }

      const modelId = typeof config.elevenLabsModelId === 'string'
        ? config.elevenLabsModelId.trim()
        : '';

      return {
        apiKey,
        voiceId,
        ...(modelId ? { modelId } : {}),
      };
    },
  }],
  ['echo', {
    createConnector: (config: EchoStreamingTtsConfig) => createEchoStreamingTtsConnector({
      baseUrl: toEchoBaseUrl(config.url),
      voice: config.voice,
      preset: config.preset,
      model: config.model,
    }),
    metadata: {
      isConfigured: (config, options) => (
        options?.allowEchoDefaults === true
          || Boolean(config.echoTtsUrl && config.echoTtsVoice)
      ),
    },
    resolveRuntimeConfig: (config) => {
      const url = typeof config.echoTtsUrl === 'string'
        ? config.echoTtsUrl.trim()
        : '';
      const voice = typeof config.echoTtsVoice === 'string'
        ? config.echoTtsVoice.trim()
        : '';
      if (!url || !voice) {
        throw new Error('Echo TTS provider selected but ECHO_TTS_URL and ECHO_TTS_VOICE are not configured');
      }

      const preset = typeof config.echoTtsPreset === 'string'
        ? config.echoTtsPreset.trim()
        : '';
      const model = typeof config.echoTtsModel === 'string'
        ? config.echoTtsModel.trim()
        : '';

      return {
        url,
        voice,
        ...(preset ? { preset } : {}),
        ...(model ? { model } : {}),
      };
    },
  }],
]);

function toEchoBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  const echoSpeechPath = '/v1/audio/speech';
  if (trimmed.endsWith(echoSpeechPath)) {
    return trimmed.slice(0, -echoSpeechPath.length);
  }
  return trimmed;
}

function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Streaming TTS provider id must be a non-empty string');
  }
  if (normalized === 'disabled') {
    throw new Error('Streaming TTS provider id "disabled" is reserved');
  }
  return normalized;
}

export function listStreamingTtsProviders(): StreamingTtsProvider[] {
  return [...providerRegistrations.keys()] as StreamingTtsProvider[];
}

export function isStreamingTtsProvider(provider: string): provider is StreamingTtsProvider {
  if (provider.trim().length === 0) return false;
  return providerRegistrations.has(provider.trim().toLowerCase());
}

export function registerStreamingTtsProvider<TProvider extends StreamingTtsProvider>(
  provider: TProvider,
  registration: StreamingTtsProviderRegistration<StreamingTtsConfigByProvider[TProvider]>,
): () => void {
  const providerId = normalizeProviderId(provider);
  const previousRegistration = providerRegistrations.get(providerId);
  providerRegistrations.set(providerId, registration as AnyStreamingTtsProviderRegistration);

  return () => {
    if (previousRegistration) {
      providerRegistrations.set(providerId, previousRegistration);
      return;
    }
    providerRegistrations.delete(providerId);
  };
}

export function registerStreamingTtsConnectorFactory<TProvider extends StreamingTtsProvider>(
  provider: TProvider,
  factory: StreamingTtsProviderRegistration<StreamingTtsConfigByProvider[TProvider]>['createConnector'],
): () => void {
  const providerId = normalizeProviderId(provider);
  const previousRegistration = providerRegistrations.get(providerId);

  return registerStreamingTtsProvider(provider, {
    createConnector: factory,
    metadata: previousRegistration?.metadata ?? {
      isConfigured: () => false,
    },
    resolveRuntimeConfig: previousRegistration?.resolveRuntimeConfig,
  });
}

export function getStreamingTtsProviderMetadata(
  provider: StreamingTtsProvider,
): StreamingTtsProviderMetadata | null {
  return providerRegistrations.get(normalizeProviderId(provider))?.metadata ?? null;
}

export function isStreamingTtsProviderConfigured(
  provider: StreamingTtsProvider,
  config: StreamingTtsProviderRuntimeConfig,
  options?: StreamingTtsProviderMetadataOptions,
): boolean {
  const metadata = getStreamingTtsProviderMetadata(provider);
  return metadata?.isConfigured(config, options) ?? false;
}

export function resolveDefaultStreamingTtsProvider(
  config: StreamingTtsProviderRuntimeConfig,
): StreamingTtsProvider | null {
  for (const [provider, registration] of providerRegistrations.entries()) {
    if (registration.metadata.canAutoEnable !== true) continue;
    if (registration.metadata.isConfigured(config)) {
      return provider as StreamingTtsProvider;
    }
  }
  return null;
}

export function createStreamingTtsConnector<TProvider extends StreamingTtsProvider>(
  provider: TProvider,
  config: StreamingTtsConfigByProvider[TProvider],
): StreamingTtsConnector {
  const registration = providerRegistrations.get(normalizeProviderId(provider));
  if (registration) {
    return registration.createConnector(config);
  }

  throw new Error(`Unsupported streaming TTS provider: ${provider}`);
}

export function resolveStreamingTtsRuntimeConfig<TProvider extends StreamingTtsProvider>(
  provider: TProvider,
  config: StreamingTtsProviderRuntimeConfig,
): StreamingTtsConfigByProvider[TProvider] {
  const registration = providerRegistrations.get(normalizeProviderId(provider));
  if (!registration) {
    throw new Error(`Unsupported streaming TTS provider: ${provider}`);
  }
  if (!registration.resolveRuntimeConfig) {
    throw new Error(`Streaming TTS provider "${provider}" does not expose runtime bootstrap config`);
  }

  return registration.resolveRuntimeConfig(config);
}
