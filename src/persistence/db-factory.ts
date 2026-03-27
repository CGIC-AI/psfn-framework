import { createComponentLogger } from '../logger.js';
import type { DatabaseAdapter, DatabaseProvider } from './db-adapter.js';

const log = createComponentLogger('DatabaseFactory');

export interface DatabaseFactoryConfig {
  provider: DatabaseProvider;
  sqlitePath?: string;
  postgresUrl?: string;
  postgresMaxConnections?: number;
}

function resolveProvider(envValue: string | undefined): DatabaseProvider {
  const normalized = envValue?.trim().toLowerCase();
  if (normalized === 'postgres' || normalized === 'postgresql') return 'postgres';
  if (normalized === 'sqlite' || !normalized) return 'sqlite';
  throw new Error(`Unknown DB_PROVIDER: "${envValue}". Expected "sqlite" or "postgres".`);
}

export function resolveDatabaseConfig(env: Record<string, string | undefined> = process.env): DatabaseFactoryConfig {
  const provider = resolveProvider(env.DB_PROVIDER);

  if (provider === 'postgres') {
    const postgresUrl = env.DATABASE_URL?.trim();
    if (!postgresUrl) {
      throw new Error('DB_PROVIDER=postgres requires DATABASE_URL to be set');
    }
    return {
      provider,
      postgresUrl,
      postgresMaxConnections: env.DB_MAX_CONNECTIONS
        ? parseInt(env.DB_MAX_CONNECTIONS, 10)
        : undefined,
    };
  }

  return {
    provider,
    sqlitePath: env.DATABASE_PATH?.trim(),
  };
}

export async function createDatabaseAdapter(
  config: DatabaseFactoryConfig,
): Promise<DatabaseAdapter> {
  if (config.provider === 'postgres') {
    if (!config.postgresUrl) {
      throw new Error('Postgres adapter requires a connection URL');
    }
    const { PostgresAdapter } = await import('./postgres-adapter.js');
    const adapter = new PostgresAdapter(config.postgresUrl, {
      max: config.postgresMaxConnections,
    });
    log.info('Postgres adapter created');
    return adapter;
  }

  if (!config.sqlitePath) {
    throw new Error('SQLite adapter requires a database path');
  }
  const { SqliteAdapter } = await import('./sqlite-adapter.js');
  const adapter = new SqliteAdapter(config.sqlitePath);
  log.info('SQLite adapter created', { path: config.sqlitePath });
  return adapter;
}
