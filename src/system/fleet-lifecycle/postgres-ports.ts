import type { Pool } from 'pg';

import { createPostgresPool, queryOne } from '../../persistence/postgres.js';
import { FLEET_AUTH_SCHEMA_NAME } from '../../persistence/postgres/fleet-auth/schema.js';
import { PostgresIcpSharedAutonomyStore } from '../../persistence/postgres/icp-shared-autonomy-store.js';
import { SHARED_SCHEMA_NAME } from '../../persistence/postgres/migrations.js';
import type { FleetAuthAdmissionPort, IcpLifecycleFencePort } from './ports.js';

/**
 * Proves a tenant is provisioned: the entry's own credential authenticates as
 * its runtime role, and the schema exists owned by that role. Read-only.
 */
export async function verifyPostgresTenantSchema(input: {
  readonly databaseUrl: string;
  readonly postgresSchema: string;
  readonly postgresRole: string;
}): Promise<void> {
  const pool = createPostgresPool(input.databaseUrl, { applicationName: 'fleet-lifecycle-tenant-probe' });
  try {
    const row = await queryOne<{ current_role: string; owner: string | null }>(pool, `
      SELECT current_user::text AS current_role,
             (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1) AS owner
    `, [input.postgresSchema]);
    if (!row || row.current_role !== input.postgresRole) {
      throw new Error('Tenant credential does not authenticate as the declared runtime role');
    }
    if (row.owner !== input.postgresRole) {
      throw new Error('Tenant schema is missing or not owned by the declared runtime role');
    }
  } finally {
    await pool.end();
  }
}

/**
 * ICP lifecycle fence over the gateway-owned shared schema. The read path is a
 * plain query so planning stays side-effect free; fence/clear go through the
 * shared autonomy store's single-transaction lifecycle transitions.
 */
export function createPostgresIcpLifecycleFencePort(input: {
  readonly sharedDatabaseUrl: string;
  readonly rosterCompanionIds: readonly string[];
}): IcpLifecycleFencePort & { close(): Promise<void> } {
  let readPool: Pool | undefined;
  // The shared store admits only known participants; the lifecycle target is
  // known for this transition even while it is outside the published roster.
  const withStore = async <T>(
    companionId: string,
    run: (store: PostgresIcpSharedAutonomyStore) => Promise<T>,
  ): Promise<T> => {
    const store = await PostgresIcpSharedAutonomyStore.connect(input.sharedDatabaseUrl, {
      knownCompanionIds: [...new Set([...input.rosterCompanionIds, companionId])].sort(),
    });
    try {
      return await run(store);
    } finally {
      await store.close();
    }
  };
  return {
    async isFenced(companionId) {
      readPool ??= createPostgresPool(input.sharedDatabaseUrl, {
        applicationName: 'fleet-lifecycle-fence-read',
        schema: SHARED_SCHEMA_NAME,
      });
      const row = await queryOne<{ lifecycle_fenced: boolean }>(readPool, `
        SELECT lifecycle_fenced FROM icp_autonomy_invalidation_fences WHERE companion_id = $1
      `, [companionId]);
      return row?.lifecycle_fenced === true;
    },
    fence: async (companionId, nowMs) => await withStore(
      companionId,
      async store => await store.fenceLifecycleAdmission(companionId, nowMs),
    ),
    clear: async (companionId, nowMs) => await withStore(
      companionId,
      async store => await store.clearLifecycleAdmission(companionId, nowMs),
    ),
    async close() {
      await readPool?.end();
    },
  };
}

/** Read-only fleet-auth companion authority state for the add guard. */
export function createPostgresFleetAuthAdmissionPort(
  fleetAuthDatabaseUrl: string,
): Extract<FleetAuthAdmissionPort, { disabled: false }> & { close(): Promise<void> } {
  const pool = createPostgresPool(fleetAuthDatabaseUrl, { applicationName: 'fleet-lifecycle-auth-read' });
  return {
    disabled: false,
    async readCompanion(companionId) {
      const row = await queryOne<{ lifecycle: string; restore_state: string }>(pool, `
        SELECT lifecycle, restore_state
        FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
        WHERE companion_id = $1
      `, [companionId]);
      return row
        ? { state: 'present', lifecycle: row.lifecycle, restoreState: row.restore_state }
        : { state: 'absent' };
    },
    async close() {
      await pool.end();
    },
  };
}
