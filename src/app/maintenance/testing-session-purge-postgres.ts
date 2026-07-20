import { createPostgresPool } from '../../persistence/postgres.js';
import {
  assertPostgresTenantAccessProvisioned,
  derivePostgresTenantRole,
  planPostgresTenantAccess,
} from '../../persistence/postgres/tenancy.js';
import {
  createDefaultPostgresSessionAdapters,
  type PostgresSessionAdapters,
} from '../../persistence/sessions/postgres-adapters.js';

interface TestingSessionPurgePostgresDependencies {
  assertPostgresTenantAccessProvisioned: typeof assertPostgresTenantAccessProvisioned;
  createDefaultPostgresSessionAdapters: typeof createDefaultPostgresSessionAdapters;
  createPostgresPool: typeof createPostgresPool;
}

export interface CreateTestingSessionPurgePostgresAdaptersOptions {
  databaseUrl: string;
  dependencies?: Partial<TestingSessionPurgePostgresDependencies>;
  multiCompanion: boolean;
  postgresSchema: string;
  sessionsDir: string;
}

const defaultDependencies: TestingSessionPurgePostgresDependencies = {
  assertPostgresTenantAccessProvisioned,
  createDefaultPostgresSessionAdapters,
  createPostgresPool,
};

/**
 * Open the destructive session-projection boundary with the same tenant
 * authority as the live companion runtime. Fleet mode verifies the
 * provisioned tenant role before creating any adapter that can migrate or
 * delete projection rows.
 */
export async function createTestingSessionPurgePostgresAdapters(
  options: CreateTestingSessionPurgePostgresAdaptersOptions,
): Promise<PostgresSessionAdapters> {
  const dependencies = {
    ...defaultDependencies,
    ...options.dependencies,
  };
  const role = options.multiCompanion
    ? derivePostgresTenantRole(options.postgresSchema)
    : undefined;

  if (role) {
    const plan = planPostgresTenantAccess({
      schema: options.postgresSchema,
      role,
    });
    const bootstrapPool = dependencies.createPostgresPool(options.databaseUrl, {
      applicationName: 'testing-session-purge-tenant-preflight',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      await dependencies.assertPostgresTenantAccessProvisioned(bootstrapPool, plan);
    } finally {
      await bootstrapPool.end();
    }
  }

  return await dependencies.createDefaultPostgresSessionAdapters(options.databaseUrl, {
    sessionsDir: options.sessionsDir,
    schema: options.postgresSchema,
    ...(role ? { role } : {}),
  });
}
