import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';
import type { PostgresConnectionOptions } from './connection-options.js';

type PostgresPoolProcessKind = 'agent' | 'gateway' | 'maintenance' | 'test';

interface PostgresPoolAuthorityTelemetry {
  authorityIndex: number;
  authorityClass: 'default' | 'schema' | 'schema_role';
  readOnly: boolean;
  capacity: number;
  logicalStoreCount: number;
  applicationNames: string[];
  active: number;
  idle: number;
  waiting: number;
  highWaterActive: number;
  highWaterConnections: number;
  highWaterWaiting: number;
}

export interface PostgresPoolOwnerTelemetry {
  process: PostgresPoolProcessKind;
  physicalPoolCount: number;
  totalCapacity: number;
  active: number;
  idle: number;
  waiting: number;
  highWaterConnections: number;
  authorities: PostgresPoolAuthorityTelemetry[];
}

interface OwnedPostgresPoolEntry {
  readonly key: string;
  readonly authorityIndex: number;
  readonly authorityClass: PostgresPoolAuthorityTelemetry['authorityClass'];
  readonly readOnly: boolean;
  readonly pool: Pool;
  readonly applicationNames: Set<string>;
  logicalStoreCount: number;
  highWaterActive: number;
  highWaterConnections: number;
  highWaterWaiting: number;
  closing: Promise<void> | null;
}

type PhysicalPostgresPoolFactory = (
  connectionString: string,
  options: PostgresConnectionOptions,
) => Pool;

const postgresPoolOwnerContext = new AsyncLocalStorage<PostgresPoolOwner>();
const activePostgresPoolOwners = new Set<PostgresPoolOwner>();

/**
 * A runtime authority needs enough room for one long-held client (for example
 * an ICP reservation or concurrent ANN maintenance) without starving ordinary
 * foreground reads and writes. Three gives that work a dedicated connection
 * plus two promptly available lanes while keeping a ten-companion,
 * two-authority fleet at a deterministic 60-connection ceiling.
 */
const RUNTIME_POSTGRES_AUTHORITY_POOL_CAPACITY = 3;

/**
 * Process-lifecycle owner for physical PostgreSQL pools.
 *
 * Store factories still receive an ordinary `Pool`, but stores created inside
 * `runWithPostgresPoolOwner` receive logical leases over one physical pool for
 * each exact connection URL/schema/role/read-only authority tuple. A logical
 * store `end()` releases only its lease; the process owner closes the physical
 * pool after the final lease or at process shutdown. The bounded physical
 * capacity preserves foreground progress around a long-held client without
 * multiplying the pg driver's default ten connections by every store.
 */
export class PostgresPoolOwner {
  private readonly entries = new Map<string, OwnedPostgresPoolEntry>();
  private nextAuthorityIndex = 1;
  private closed = false;

  constructor(readonly process: PostgresPoolProcessKind) {
    activePostgresPoolOwners.add(this);
  }

  acquire(
    connectionString: string,
    options: PostgresConnectionOptions,
    createPhysicalPool: PhysicalPostgresPoolFactory,
  ): Pool {
    if (this.closed) {
      throw new Error('PostgreSQL pool owner is closed');
    }
    const key = postgresPoolAuthorityKey(connectionString, options);
    let entry = this.entries.get(key);
    if (!entry) {
      const pool = createPhysicalPool(connectionString, {
        ...options,
        applicationName: `${this.process}-persistence`,
        allowExitOnIdle: true,
        max: RUNTIME_POSTGRES_AUTHORITY_POOL_CAPACITY,
      });
      entry = {
        key,
        authorityIndex: this.nextAuthorityIndex,
        authorityClass: options.role !== undefined
          ? 'schema_role'
          : options.schema !== undefined ? 'schema' : 'default',
        readOnly: options.readOnly === true,
        pool,
        applicationNames: new Set<string>(),
        logicalStoreCount: 0,
        highWaterActive: 0,
        highWaterConnections: 0,
        highWaterWaiting: 0,
        closing: null,
      };
      this.nextAuthorityIndex += 1;
      this.entries.set(key, entry);
      for (const event of ['connect', 'acquire', 'release', 'remove'] as const) {
        pool.on(event, () => this.sample(entry!));
      }
    }
    entry.logicalStoreCount += 1;
    entry.applicationNames.add(options.applicationName ?? 'framework');
    this.sample(entry);
    return this.createLogicalLease(entry);
  }

  telemetry(): PostgresPoolOwnerTelemetry {
    const authorities = [...this.entries.values()]
      .sort((left, right) => left.authorityIndex - right.authorityIndex)
      .map((entry) => {
        this.sample(entry);
        const active = Math.max(0, entry.pool.totalCount - entry.pool.idleCount);
        return {
          authorityIndex: entry.authorityIndex,
          authorityClass: entry.authorityClass,
          readOnly: entry.readOnly,
          capacity: entry.pool.options.max,
          logicalStoreCount: entry.logicalStoreCount,
          applicationNames: [...entry.applicationNames].sort(),
          active,
          idle: entry.pool.idleCount,
          waiting: entry.pool.waitingCount,
          highWaterActive: entry.highWaterActive,
          highWaterConnections: entry.highWaterConnections,
          highWaterWaiting: entry.highWaterWaiting,
        };
      });
    return {
      process: this.process,
      physicalPoolCount: authorities.length,
      totalCapacity: authorities.reduce((sum, entry) => sum + entry.capacity, 0),
      active: authorities.reduce((sum, entry) => sum + entry.active, 0),
      idle: authorities.reduce((sum, entry) => sum + entry.idle, 0),
      waiting: authorities.reduce((sum, entry) => sum + entry.waiting, 0),
      highWaterConnections: authorities.reduce(
        (sum, entry) => sum + entry.highWaterConnections,
        0,
      ),
      authorities,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    activePostgresPoolOwners.delete(this);
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(entry => this.closeEntry(entry)));
  }

  private createLogicalLease(entry: OwnedPostgresPoolEntry): Pool {
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      entry.logicalStoreCount = Math.max(0, entry.logicalStoreCount - 1);
      if (entry.logicalStoreCount !== 0 || this.closed) return;
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key);
      }
      await this.closeEntry(entry);
    };
    return new Proxy(entry.pool, {
      get: (target, property) => {
        if (property === 'end') {
          return (callback?: (error?: Error) => void): Promise<void> => {
            const completion = release();
            if (callback) {
              void completion
                .then(() => callback())
                .catch(error => callback(error instanceof Error ? error : new Error(String(error))));
            }
            return completion;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  private async closeEntry(entry: OwnedPostgresPoolEntry): Promise<void> {
    entry.closing ??= entry.pool.end();
    await entry.closing;
  }

  private sample(entry: OwnedPostgresPoolEntry): void {
    const active = Math.max(0, entry.pool.totalCount - entry.pool.idleCount);
    entry.highWaterActive = Math.max(entry.highWaterActive, active);
    entry.highWaterConnections = Math.max(entry.highWaterConnections, entry.pool.totalCount);
    entry.highWaterWaiting = Math.max(entry.highWaterWaiting, entry.pool.waitingCount);
  }
}

export function runWithPostgresPoolOwner<T>(
  owner: PostgresPoolOwner,
  operation: () => T,
): T {
  return postgresPoolOwnerContext.run(owner, operation);
}

export function acquireOwnedPostgresPool(
  connectionString: string,
  options: PostgresConnectionOptions,
  createPhysicalPool: PhysicalPostgresPoolFactory,
): Pool | null {
  const owner = postgresPoolOwnerContext.getStore();
  return owner?.acquire(connectionString, options, createPhysicalPool) ?? null;
}

export function getPostgresPoolTelemetry(): PostgresPoolOwnerTelemetry[] {
  return [...activePostgresPoolOwners]
    .map(owner => owner.telemetry())
    .sort((left, right) => left.process.localeCompare(right.process));
}

function postgresPoolAuthorityKey(
  connectionString: string,
  options: PostgresConnectionOptions,
): string {
  return JSON.stringify([
    connectionString,
    options.schema ?? null,
    options.role ?? null,
    options.readOnly === true,
  ]);
}
