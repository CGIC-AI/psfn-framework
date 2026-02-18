import type { SubstrateConfig } from '../types.js';
import type { RetryConfig } from './retry.js';

export function llmRetryConfig(
  config: Pick<SubstrateConfig, 'retryMaxAttempts' | 'retryBaseDelayMs'>,
): RetryConfig {
  return {
    maxRetries: config.retryMaxAttempts,
    baseDelayMs: config.retryBaseDelayMs,
  };
}
