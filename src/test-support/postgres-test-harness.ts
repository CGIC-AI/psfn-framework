import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createPostgresPool } from '../persistence/postgres.js';

export const DEFAULT_POSTGRES_TEST_IMAGE = 'postgres:16.8-alpine';
export const PGVECTOR_POSTGRES_TEST_IMAGE = 'pgvector/pgvector:0.8.2-pg16-bookworm@sha256:6f2fedef8e4311682b3a5989a21bf527d3310ab5421258ad6e41e52955c16294';
const POSTGRES_USER = 'postgres';
const POSTGRES_PASSWORD = 'postgres';
const POSTGRES_DATABASE = 'postgres';
const POSTGRES_PORT = 5432;
const READY_RETRY_LIMIT = 120;
const READY_RETRY_DELAY_MS = 500;

export interface PostgresTestDatabase {
  databaseName: string;
  databaseUrl: string;
}

export interface PostgresTestHarness {
  readonly adminDatabaseUrl: string;
  readonly image: string;
  createDatabase(): Promise<PostgresTestDatabase>;
  stop(): Promise<void>;
}

export interface PostgresTestHarnessOptions {
  image?: string;
}

function runDocker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const stderr = result.stderr.trim() || result.stdout.trim() || 'unknown docker failure';
    throw new Error(`docker ${args.join(' ')} failed: ${stderr}`);
  }
  return result.stdout.trim();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function waitForDatabaseReady(databaseUrl: string): Promise<void> {
  for (let attempt = 1; attempt <= READY_RETRY_LIMIT; attempt += 1) {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-memory-test',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === READY_RETRY_LIMIT) {
        throw error;
      }
      await delay(READY_RETRY_DELAY_MS);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
}

function resolveDatabaseUrl(adminDatabaseUrl: string, databaseName: string): string {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function startPostgresTestHarness(options: PostgresTestHarnessOptions = {}): Promise<PostgresTestHarness> {
  const image = options.image?.trim() || PGVECTOR_POSTGRES_TEST_IMAGE;
  const containerId = runDocker([
    'run',
    '-d',
    '--rm',
    '-e',
    `POSTGRES_USER=${POSTGRES_USER}`,
    '-e',
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    '-e',
    `POSTGRES_DB=${POSTGRES_DATABASE}`,
    '-p',
    `127.0.0.1::${POSTGRES_PORT}`,
    image,
  ]);

  const mapping = runDocker(['port', containerId, `${POSTGRES_PORT}/tcp`]);
  const mappedPortText = mapping.split('\n').map(line => line.trim()).find(Boolean)?.split(':').pop();
  if (!mappedPortText) {
    throw new Error(`Unable to resolve mapped postgres port for container ${containerId}`);
  }
  const mappedPort = Number(mappedPortText);
  if (!Number.isInteger(mappedPort) || mappedPort <= 0) {
    throw new Error(`Invalid mapped postgres port "${mappedPortText}" for container ${containerId}`);
  }

  const adminDatabaseUrl = `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${mappedPort}/${POSTGRES_DATABASE}`;
  await waitForDatabaseReady(adminDatabaseUrl);

  const adminPool = createPostgresPool(adminDatabaseUrl, {
    applicationName: 'psfn-memory-test-admin',
    allowExitOnIdle: true,
    max: 1,
  });

  return {
    adminDatabaseUrl,
    image,
    async createDatabase(): Promise<PostgresTestDatabase> {
      const databaseName = `psfn_${randomUUID().replaceAll('-', '')}`;
      await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const databaseUrl = resolveDatabaseUrl(adminDatabaseUrl, databaseName);
      await waitForDatabaseReady(databaseUrl);
      return {
        databaseName,
        databaseUrl,
      };
    },
    async stop(): Promise<void> {
      await adminPool.end().catch(() => undefined);
      runDocker(['stop', containerId]);
    },
  };
}
