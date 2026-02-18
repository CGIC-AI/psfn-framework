import { createElevenLabsStreamingTtsConnector, type ElevenLabsStreamingTtsConfig } from './elevenlabs-stream.js';
import type { StreamingTtsConnector } from './types.js';

export * from './types.js';
export * from './elevenlabs-stream.js';

export function createStreamingTtsConnector(
  provider: 'elevenlabs',
  config: ElevenLabsStreamingTtsConfig,
): StreamingTtsConnector {
  if (provider === 'elevenlabs') {
    return createElevenLabsStreamingTtsConnector(config);
  }

  throw new Error(`Unsupported streaming TTS provider: ${provider}`);
}
