import { createMemoryAppCache } from './memory-cache.js';
import {
  createRedisAppCacheFromConfig,
  resolveAppCacheRuntimeConfigFromEnv,
  type RedisClientFactory,
} from './redis-cache.js';
import type { AppCache } from './types.js';

export async function createAppCacheFromEnv(options: {
  env?: NodeJS.ProcessEnv;
  redisClientFactory?: RedisClientFactory;
  redisTlsCaReader?: (path: string) => string;
} = {}): Promise<AppCache> {
  const config = resolveAppCacheRuntimeConfigFromEnv(options.env ?? process.env);
  if (config.mode === 'memory') {
    return createMemoryAppCache({ name: 'app-cache' });
  }

  if (!config.redis) {
    throw new Error('Redis cache configuration is required when app cache mode is redis');
  }

  return createRedisAppCacheFromConfig(config.redis, {
    name: 'app-cache',
    ...(options.redisClientFactory ? { clientFactory: options.redisClientFactory } : {}),
    ...(options.redisTlsCaReader ? { readFile: options.redisTlsCaReader } : {}),
  });
}
