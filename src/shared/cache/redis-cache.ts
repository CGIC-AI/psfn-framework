import { readFileSync } from 'node:fs';
import {
  cloneAppCacheStats,
  createEmptyAppCacheStats,
  type AppCache,
  type AppCacheSetOptions,
  type AppCacheStats,
} from './types.js';

export const APP_CACHE_MODE_ENV = 'PSFN_APP_CACHE_MODE';
export const REDIS_URL_ENV = 'PSFN_REDIS_URL';
export const REDIS_USERNAME_ENV = 'PSFN_REDIS_USERNAME';
export const REDIS_PASSWORD_ENV = 'PSFN_REDIS_PASSWORD';
export const REDIS_TLS_REJECT_UNAUTHORIZED_ENV = 'PSFN_REDIS_TLS_REJECT_UNAUTHORIZED';
export const REDIS_TLS_CA_CERT_PATH_ENV = 'PSFN_REDIS_TLS_CA_CERT_PATH';

export type AppCacheMode = 'memory' | 'redis';

export interface RedisClientLike {
  isOpen?: boolean;
  connect(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set?(key: string, value: string, options?: unknown): Promise<unknown>;
  sendCommand?(args: string[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  scanIterator(options: { MATCH: string; COUNT: number }): AsyncIterable<string | readonly string[]>;
  quit?(): Promise<unknown>;
}

export interface RedisClientOptionsLike {
  url: string;
  socket?: {
    tls?: boolean;
    rejectUnauthorized?: boolean;
    ca?: string;
  };
}

export type RedisClientFactory = (options: RedisClientOptionsLike) => RedisClientLike;

export interface RedisAppCacheConfig {
  url: string;
  username?: string;
  password: string;
  tls: boolean;
  tlsRejectUnauthorized: boolean;
  tlsCaCertPath?: string;
}

export interface RedisAppCacheOptions {
  name?: string;
  keyPrefix?: string;
  client: RedisClientLike;
}

export interface AppCacheRuntimeConfig {
  mode: AppCacheMode;
  redis?: RedisAppCacheConfig;
}

function parseCacheMode(value: string | undefined): AppCacheMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'memory';
  if (normalized === 'memory' || normalized === 'redis') return normalized;
  throw new Error(`${APP_CACHE_MODE_ENV} must be "memory" or "redis"`);
}

function parseBooleanEnv(name: string, value: string | undefined, defaultValue: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`${name} must be true or false`);
}

function trimOptionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeScanIteratorKeys(item: string | readonly string[]): string[] {
  const keys = typeof item === 'string' ? [item] : item;
  for (const key of keys) {
    if (typeof key !== 'string') {
      throw new Error('Redis SCAN returned a non-string key');
    }
  }
  return keys.filter(key => key.length > 0);
}

function readUrlCredential(
  parsed: URL,
  field: 'username' | 'password',
): string | undefined {
  const value = field === 'username' ? parsed.username : parsed.password;
  return value ? decodeURIComponent(value) : undefined;
}

function resolveCredential(input: {
  name: string;
  urlValue?: string;
  envValue?: string;
  required?: boolean;
}): string | undefined {
  const envValue = trimOptionalEnv(input.envValue);
  if (input.urlValue && envValue && input.urlValue !== envValue) {
    throw new Error(`${input.name} is configured in both ${REDIS_URL_ENV} and a dedicated env var with different values`);
  }
  const resolved = envValue ?? input.urlValue;
  if (input.required && !resolved) {
    throw new Error(`${REDIS_PASSWORD_ENV} or a password-bearing ${REDIS_URL_ENV} is required when Redis cache mode is selected`);
  }
  return resolved;
}

export function resolveAppCacheRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AppCacheRuntimeConfig {
  const mode = parseCacheMode(env[APP_CACHE_MODE_ENV]);
  if (mode === 'memory') {
    return { mode };
  }

  const rawUrl = trimOptionalEnv(env[REDIS_URL_ENV]);
  if (!rawUrl) {
    throw new Error(`${REDIS_URL_ENV} is required when ${APP_CACHE_MODE_ENV}=redis`);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`${REDIS_URL_ENV} must be a valid redis:// or rediss:// URL`);
  }

  if (parsedUrl.protocol !== 'redis:' && parsedUrl.protocol !== 'rediss:') {
    throw new Error(`${REDIS_URL_ENV} must use redis:// or rediss://`);
  }

  const urlUsesTls = parsedUrl.protocol === 'rediss:';
  const tlsRejectUnauthorized = parseBooleanEnv(
    REDIS_TLS_REJECT_UNAUTHORIZED_ENV,
    env[REDIS_TLS_REJECT_UNAUTHORIZED_ENV],
    true,
  );
  const tlsCaCertPath = trimOptionalEnv(env[REDIS_TLS_CA_CERT_PATH_ENV]);
  if (tlsCaCertPath && !urlUsesTls) {
    throw new Error(`${REDIS_TLS_CA_CERT_PATH_ENV} requires a rediss:// ${REDIS_URL_ENV}`);
  }

  const username = resolveCredential({
    name: REDIS_USERNAME_ENV,
    urlValue: readUrlCredential(parsedUrl, 'username'),
    envValue: env[REDIS_USERNAME_ENV],
  });
  const password = resolveCredential({
    name: REDIS_PASSWORD_ENV,
    urlValue: readUrlCredential(parsedUrl, 'password'),
    envValue: env[REDIS_PASSWORD_ENV],
    required: true,
  });

  return {
    mode,
    redis: {
      url: rawUrl,
      ...(username ? { username } : {}),
      password: password!,
      tls: urlUsesTls,
      tlsRejectUnauthorized,
      ...(tlsCaCertPath ? { tlsCaCertPath } : {}),
    },
  };
}

export function buildRedisClientOptions(
  config: RedisAppCacheConfig,
  readFile: (path: string) => string = path => readFileSync(path, 'utf8'),
): RedisClientOptionsLike {
  const parsed = new URL(config.url);
  if (config.username) {
    parsed.username = config.username;
  }
  parsed.password = config.password;

  const socket = config.tls
    ? {
        tls: true,
        rejectUnauthorized: config.tlsRejectUnauthorized,
        ...(config.tlsCaCertPath ? { ca: readFile(config.tlsCaCertPath) } : {}),
      }
    : undefined;
  return {
    url: parsed.toString(),
    ...(socket ? { socket } : {}),
  };
}

export class RedisAppCache implements AppCache {
  readonly backend = 'redis' as const;
  readonly name: string;
  private readonly client: RedisClientLike;
  private readonly keyPrefix: string;
  private readonly stats = createEmptyAppCacheStats();
  private connectPromise: Promise<unknown> | null = null;

  constructor(options: RedisAppCacheOptions) {
    this.name = options.name ?? 'redis-app-cache';
    this.client = options.client;
    this.keyPrefix = options.keyPrefix ?? 'psfn:app-cache:';
  }

  private buildKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isOpen === true) return;
    // Single-flight while a connect is in flight, but reset after settle so a
    // failed connect does not wedge every future operation on the memoized
    // rejection.
    this.connectPromise ??= this.client.connect().finally(() => {
      this.connectPromise = null;
    });
    await this.connectPromise;
  }

  async get(key: string): Promise<string | null> {
    try {
      await this.ensureConnected();
      const value = await this.client.get(this.buildKey(key));
      if (value === null) {
        this.stats.misses += 1;
      } else {
        this.stats.hits += 1;
      }
      return value;
    } catch (error) {
      this.stats.errors += 1;
      throw error;
    }
  }

  async set(key: string, value: string, options?: AppCacheSetOptions): Promise<void> {
    if (options?.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)) {
      throw new Error('cache ttlMs must be a positive finite number');
    }

    try {
      await this.ensureConnected();
      const redisKey = this.buildKey(key);
      if (options?.ttlMs !== undefined) {
        const ttlMs = Math.ceil(options.ttlMs);
        if (this.client.sendCommand) {
          await this.client.sendCommand(['SET', redisKey, value, 'PX', String(ttlMs)]);
        } else if (this.client.set) {
          await this.client.set(redisKey, value, { PX: ttlMs });
        } else {
          throw new Error('Redis cache client does not support SET');
        }
      } else if (this.client.set) {
        await this.client.set(redisKey, value);
      } else if (this.client.sendCommand) {
        await this.client.sendCommand(['SET', redisKey, value]);
      } else {
        throw new Error('Redis cache client does not support SET');
      }
      this.stats.sets += 1;
    } catch (error) {
      this.stats.errors += 1;
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await this.ensureConnected();
      const deleted = await this.client.del(this.buildKey(key));
      if (deleted > 0) {
        this.stats.deletes += deleted;
      }
      return deleted > 0;
    } catch (error) {
      this.stats.errors += 1;
      throw error;
    }
  }

  async invalidatePrefix(prefix: string): Promise<number> {
    try {
      await this.ensureConnected();
      const match = `${this.buildKey(prefix)}*`;
      let removed = 0;
      const batch: string[] = [];
      const flushBatch = async (): Promise<void> => {
        if (batch.length === 0) return;
        removed += await this.client.del(...batch);
        batch.length = 0;
      };
      for await (const item of this.client.scanIterator({ MATCH: match, COUNT: 100 })) {
        for (const key of normalizeScanIteratorKeys(item)) {
          batch.push(key);
          if (batch.length >= 100) {
            await flushBatch();
          }
        }
      }
      await flushBatch();
      this.stats.invalidations += 1;
      this.stats.deletes += removed;
      return removed;
    } catch (error) {
      this.stats.errors += 1;
      throw error;
    }
  }

  getStats(): AppCacheStats {
    return cloneAppCacheStats(this.stats);
  }

  async close(): Promise<void> {
    if (this.client.quit && this.client.isOpen === true) {
      await this.client.quit();
    }
  }
}

export async function createRedisClientFactoryFromPackage(): Promise<RedisClientFactory> {
  const redisModule = await import('@redis/client');
  const createClient = redisModule.createClient as (options: RedisClientOptionsLike) => RedisClientLike;
  return createClient;
}

export async function createRedisAppCacheFromConfig(
  config: RedisAppCacheConfig,
  options: {
    name?: string;
    keyPrefix?: string;
    clientFactory?: RedisClientFactory;
    readFile?: (path: string) => string;
  } = {},
): Promise<RedisAppCache> {
  const clientFactory = options.clientFactory ?? await createRedisClientFactoryFromPackage();
  const client = clientFactory(buildRedisClientOptions(config, options.readFile));
  return new RedisAppCache({
    client,
    ...(options.name ? { name: options.name } : {}),
    ...(options.keyPrefix ? { keyPrefix: options.keyPrefix } : {}),
  });
}
