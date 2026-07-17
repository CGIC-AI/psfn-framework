import type { Pool } from 'pg';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import type {
  BackupPostgresOptions,
  BackupRunOptions,
  BackupRunResult,
} from '../backups/fleet-backup-contracts.js';
import { runBackupCycle } from '../backups/service.js';
import { restorePostgresSchemaSlice } from '../backups/fleet-restore.js';
import { createPostgresPool, runPostgresMigrations } from '../postgres.js';
import {
  derivePostgresShardSchema,
  derivePostgresTenantRole,
  dropPostgresShardSchema,
  planPostgresTenantAccess,
  provisionPostgresTenantAccess,
  type PostgresShardCleanupEvidence,
} from './tenancy.js';

export interface PostgresShardSchemaBinding {
  parentCompanionId: CompanionId;
  parentSchema: string;
  shardId: string;
  schema: string;
  role: string;
}

export interface PostgresShardSchemaLifecycle {
  derive(parentCompanionId: CompanionId, parentSchema: string, shardId: string): PostgresShardSchemaBinding;
  prepare(binding: PostgresShardSchemaBinding): Promise<void>;
  openPool(binding: PostgresShardSchemaBinding, applicationName: string): Pool;
  migrate(binding: PostgresShardSchemaBinding, statements: readonly string[]): Promise<void>;
  backup(
    binding: PostgresShardSchemaBinding,
    options: Omit<BackupRunOptions, 'fleetArtifactIdentity' | 'postgres'>,
  ): Promise<BackupRunResult>;
  restore(binding: PostgresShardSchemaBinding, dumpPath: string): Promise<void>;
  cleanup(binding: PostgresShardSchemaBinding): Promise<PostgresShardCleanupEvidence>;
}

function assertBinding(binding: PostgresShardSchemaBinding): PostgresShardSchemaBinding {
  const expectedSchema = derivePostgresShardSchema(binding);
  const expectedRole = derivePostgresTenantRole(expectedSchema);
  if (binding.schema !== expectedSchema || binding.role !== expectedRole) {
    throw new Error('PostgreSQL shard schema binding does not match its lineage');
  }
  return binding;
}

/**
 * One canonical shard lifecycle used by runtime preparation, migrations,
 * schema-scoped backup, and cleanup. It never falls back to the parent schema.
 */
export function createPostgresShardSchemaLifecycle(
  rawOptions: string | Pick<
    BackupPostgresOptions,
    'databaseUrl' | 'pgDumpBinary' | 'pgRestoreBinary' | 'psqlBinary'
  >,
): PostgresShardSchemaLifecycle {
  const lifecycleOptions = typeof rawOptions === 'string'
    ? { databaseUrl: rawOptions }
    : rawOptions;
  const normalizedDatabaseUrl = lifecycleOptions.databaseUrl.trim();
  if (!normalizedDatabaseUrl) {
    throw new Error('PostgreSQL shard schema lifecycle requires a database URL');
  }
  const openPool = (
    rawBinding: PostgresShardSchemaBinding,
    applicationName: string,
  ): Pool => {
    const binding = assertBinding(rawBinding);
    const normalizedApplicationName = applicationName.trim();
    if (!normalizedApplicationName) {
      throw new Error('PostgreSQL shard pool requires an application name');
    }
    return createPostgresPool(normalizedDatabaseUrl, {
      applicationName: normalizedApplicationName,
      allowExitOnIdle: true,
      schema: binding.schema,
      role: binding.role,
    });
  };
  const prepare = async (rawBinding: PostgresShardSchemaBinding): Promise<void> => {
    const binding = assertBinding(rawBinding);
    const admin = createPostgresPool(normalizedDatabaseUrl, {
      applicationName: 'shard-schema-provision',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      const login = await admin.query<{ current_user: string }>('SELECT current_user');
      const runtimeLoginRole = login.rows[0]?.current_user;
      if (!runtimeLoginRole) {
        throw new Error('PostgreSQL shard provisioning could not resolve the runtime login role');
      }
      await provisionPostgresTenantAccess(admin, {
        plan: planPostgresTenantAccess({ schema: binding.schema, role: binding.role }),
        runtimeLoginRole,
      });
    } finally {
      await admin.end();
    }
  };
  return {
    derive(parentCompanionId, parentSchema, shardId) {
      const schema = derivePostgresShardSchema({ parentCompanionId, parentSchema, shardId });
      return {
        parentCompanionId,
        parentSchema,
        shardId,
        schema,
        role: derivePostgresTenantRole(schema),
      };
    },

    prepare,

    openPool,

    async migrate(rawBinding, statements) {
      const binding = assertBinding(rawBinding);
      const pool = openPool(binding, 'shard-schema-migrate');
      try {
        await runPostgresMigrations(pool, statements, { schema: binding.schema });
      } finally {
        await pool.end();
      }
    },

    async backup(rawBinding, options) {
      const binding = assertBinding(rawBinding);
      return await runBackupCycle({
        ...options,
        fleetArtifactIdentity: {
          schemaVersion: 1,
          kind: 'companion',
          companionId: binding.shardId,
          postgresSchema: binding.schema,
        },
        postgres: {
          databaseUrl: normalizedDatabaseUrl,
          schema: binding.schema,
          ...(lifecycleOptions.pgDumpBinary
            ? { pgDumpBinary: lifecycleOptions.pgDumpBinary }
            : {}),
          ...(lifecycleOptions.pgRestoreBinary
            ? { pgRestoreBinary: lifecycleOptions.pgRestoreBinary }
            : {}),
          ...(lifecycleOptions.psqlBinary
            ? { psqlBinary: lifecycleOptions.psqlBinary }
            : {}),
        },
      });
    },

    async restore(rawBinding, dumpPath) {
      const binding = assertBinding(rawBinding);
      await restorePostgresSchemaSlice({
        dumpPath,
        schema: binding.schema,
        postgres: {
          databaseUrl: normalizedDatabaseUrl,
          ...(lifecycleOptions.pgRestoreBinary
            ? { pgRestoreBinary: lifecycleOptions.pgRestoreBinary }
            : {}),
          ...(lifecycleOptions.psqlBinary
            ? { psqlBinary: lifecycleOptions.psqlBinary }
            : {}),
        },
      });
      await prepare(binding);
    },

    async cleanup(rawBinding) {
      const binding = assertBinding(rawBinding);
      const admin = createPostgresPool(normalizedDatabaseUrl, {
        applicationName: 'shard-schema-cleanup',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        return await dropPostgresShardSchema({
          pool: admin,
          ...binding,
          dropRole: true,
        });
      } finally {
        await admin.end();
      }
    },
  };
}
