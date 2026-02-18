import { createDeepgramStreamingSttConnector, type DeepgramStreamingSttConfig } from './deepgram-stream.js';
import type { StreamingSttConnector } from './types.js';

export * from './types.js';
export * from './deepgram-stream.js';

export function createStreamingSttConnector(
  provider: 'deepgram',
  config: DeepgramStreamingSttConfig,
): StreamingSttConnector {
  if (provider === 'deepgram') {
    return createDeepgramStreamingSttConnector(config);
  }

  throw new Error(`Unsupported streaming STT provider: ${provider}`);
}
