import type { Pool } from 'pg';
import { createPostgresPool } from '../../src/persistence/postgres.js';
import {
  assertPostgresTenantAccessProvisioned,
  dropPostgresTenantAccess,
  provisionPostgresTenantAccess,
  type PostgresTenantAccessPlan,
} from '../../src/persistence/postgres/tenancy.js';
import type { SupportFixtureDatabasePort } from './lifecycle.js';

class PostgresSupportFixtureDatabase implements SupportFixtureDatabasePort {
  constructor(
    private readonly pool: Pool,
    private readonly runtimeLoginRole: string,
  ) {}

  async assertRoundStopped(): Promise<void> {
    const result = await this.pool.query<{
      application_name: string;
      pid: number;
    }>(`
      SELECT pid, application_name
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'
      ORDER BY pid
    `);
    if (result.rows.length > 0) {
      const sessions = result.rows
        .map(row => `${row.application_name || 'unnamed'}:${row.pid}`)
        .join(', ');
      throw new Error(
        `The shakedown round database still has runtime sessions (${sessions}); `
        + 'stop the split runtime before support-fixture stand-up or teardown',
      );
    }
  }

  async assertProvisioned(plan: PostgresTenantAccessPlan): Promise<void> {
    await assertPostgresTenantAccessProvisioned(this.pool, plan);
  }

  async provision(plan: PostgresTenantAccessPlan): Promise<void> {
    await provisionPostgresTenantAccess(this.pool, {
      plan,
      runtimeLoginRole: this.runtimeLoginRole,
    });
  }

  async drop(plan: PostgresTenantAccessPlan): Promise<void> {
    await dropPostgresTenantAccess({
      pool: this.pool,
      plan,
      runtimeLoginRole: this.runtimeLoginRole,
      dropRole: true,
    });
  }

  async assertAbsent(plan: PostgresTenantAccessPlan): Promise<void> {
    const result = await this.pool.query<{ role_exists: boolean; schema_exists: boolean }>(`
      SELECT
        to_regnamespace($1) IS NOT NULL AS schema_exists,
        EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS role_exists
    `, [plan.schema, plan.role]);
    if (result.rows[0]?.schema_exists || result.rows[0]?.role_exists) {
      throw new Error(`Support PostgreSQL tenant ${plan.schema} still exists after teardown`);
    }
  }
}

export async function createPostgresSupportFixtureDatabase(
  databaseUrl: string,
): Promise<{ database: SupportFixtureDatabasePort; close(): Promise<void> }> {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-shakedown-support-fixtures',
    allowExitOnIdle: true,
    max: 1,
  });
  try {
    const result = await pool.query<{ current_user: string }>('SELECT current_user');
    const runtimeLoginRole = result.rows[0]?.current_user;
    if (!runtimeLoginRole) {
      throw new Error('Could not resolve the PostgreSQL runtime login role');
    }
    return {
      database: new PostgresSupportFixtureDatabase(pool, runtimeLoginRole),
      close: async () => pool.end(),
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
