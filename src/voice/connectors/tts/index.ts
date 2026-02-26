import { createElevenLabsStreamingTtsConnector, type ElevenLabsStreamingTtsConfig } from './elevenlabs-stream.js';
import type { StreamingTtsConnector } from './types.js';

export * from './types.js';
export * from './elevenlabs-stream.js';

export type StreamingTtsProvider = 'elevenlabs' | 'echo';

export interface EchoStreamingTtsConfig {
  url: string;
  voice: string;
  preset: string;
  model?: string;
}

export interface StreamingTtsConfigByProvider {
  elevenlabs: ElevenLabsStreamingTtsConfig;
  echo: EchoStreamingTtsConfig;
}

type StreamingTtsConnectorFactory<TProvider extends StreamingTtsProvider> = (
  config: StreamingTtsConfigByProvider[TProvider],
) => StreamingTtsConnector;

const connectorFactories: Partial<{
  [TProvider in StreamingTtsProvider]: StreamingTtsConnectorFactory<TProvider>;
}> = {
  elevenlabs: createElevenLabsStreamingTtsConnector,
};

export function registerStreamingTtsConnectorFactory<TProvider extends StreamingTtsProvider>(
  provider: TProvider,
  factory: StreamingTtsConnectorFactory<TProvider>,
): () => void {
  const previousFactory = connectorFactories[provider] as StreamingTtsConnectorFactory<TProvider> | undefined;
  connectorFactories[provider] = factory;

  return () => {
    if (previousFactory) {
      connectorFactories[provider] = previousFactory;
      return;
    }
    delete connectorFactories[provider];
  };
}

export function createStreamingTtsConnector<TProvider extends StreamingTtsProvider>(
  provider: TProvider,
  config: StreamingTtsConfigByProvider[TProvider],
): StreamingTtsConnector {
  const factory = connectorFactories[provider] as StreamingTtsConnectorFactory<TProvider> | undefined;
  if (factory) {
    return factory(config);
  }

  throw new Error(`Unsupported streaming TTS provider: ${provider}`);
}
