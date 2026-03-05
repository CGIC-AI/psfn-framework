import { createDeepgramStreamingSttConnector, type DeepgramStreamingSttConfig } from './deepgram-stream.js';
import type { StreamingSttConnector } from './types.js';

export * from './types.js';
export * from './deepgram-stream.js';

export function createStreamingSttConnector(
  provider: 'deepgram',
  config: DeepgramStreamingSttConfig,
): StreamingSttConnector {
  return createDeepgramStreamingSttConnector(config);
}
