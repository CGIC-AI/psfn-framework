import type { AppCache } from '../../../shared/cache/types.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type {
  CoreSubstrateConfig,
  SubstrateConfig,
} from '../../../system/config/runtime-config-contracts.js';
import { resolveCachedPromptRuntimeLayoutStore } from '../../identity/prompt-runtime-store-cache.js';
import {
  STATIC_PROMPT_PREFIX_CACHE_KEY_PREFIX,
  type StaticPromptPrefixCacheEvent,
} from './prompt-lifecycle.js';

interface PromptRuntimeLogger {
  debug: (message: string, payload: Record<string, unknown>) => void;
  error: (message: string, payload: Record<string, unknown>) => void;
  info: (message: string, payload: Record<string, unknown>) => void;
}

export function resolveRuntimePromptGuidanceVariables(config: SubstrateConfig): Record<string, string> {
  const store = resolveCachedPromptRuntimeLayoutStore(config);
  return {
    runtime_persona_adaptation_extra: store.getEditableBlockContent('runtime.persona_adaptation'),
    runtime_context_extra: store.getEditableBlockContent('runtime.context'),
  };
}

export function resolveConfiguredCharacterName(config: CoreSubstrateConfig): string | undefined {
  const candidate = typeof config.characterName === 'string'
    ? config.characterName.trim()
    : '';
  return candidate || undefined;
}

export function invalidateStaticPromptPrefixCache(
  cache: AppCache,
  reason: string,
  logger: PromptRuntimeLogger,
): void {
  cache.invalidatePrefix(STATIC_PROMPT_PREFIX_CACHE_KEY_PREFIX)
    .then((deleted) => {
      const stats = cache.getStats();
      logger.info('Invalidated static prompt-prefix cache', {
        reason,
        backend: cache.backend,
        deleted,
        invalidations: stats.invalidations,
      });
    })
    .catch((error: unknown) => {
      logger.error('Failed to invalidate static prompt-prefix cache', {
        reason,
        backend: cache.backend,
        error: toErrorMessage(error),
      });
    });
}

export function logStaticPromptPrefixCacheEvent(
  cache: AppCache,
  event: StaticPromptPrefixCacheEvent,
  logger: PromptRuntimeLogger,
): void {
  const stats = cache.getStats();
  logger.debug('Static prompt-prefix cache event', {
    event: event.event,
    backend: event.backend,
    cacheKeyHash: event.cacheKeyHash,
    staticHash: event.staticHash,
    settingsHash: event.settingsHash,
    hits: stats.hits,
    misses: stats.misses,
    invalidations: stats.invalidations,
  });
}
