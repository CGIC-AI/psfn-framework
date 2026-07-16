import { resolveConfiguredCompanionFleet } from './companion-fleet-runtime.js';
import { createPostgresPool } from '../src/persistence/postgres.js';
import { ensureSharedSchema } from '../src/persistence/postgres/shared-schema.js';
import {
  planPostgresTenantAccess,
  provisionPostgresTenantAccess,
} from '../src/persistence/postgres/tenancy.js';

const APPLY_ARGUMENT = '--apply';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(argument => argument !== APPLY_ARGUMENT) || args.length > 1) {
    throw new Error(`Usage: npm run provision:postgres-tenancy -- [${APPLY_ARGUMENT}]`);
  }
  const apply = args[0] === APPLY_ARGUMENT;
  const fleet = resolveConfiguredCompanionFleet(process.env);
  if (!fleet) {
    throw new Error('PostgreSQL tenant provisioning requires multi-companion mode');
  }
  const plans = fleet.companions
    .map(companion => planPostgresTenantAccess({
      schema: companion.postgresSchema,
      approvedSharedSchema: 'shared',
      approvedSharedAccess: 'read_write',
    }))
    .sort((left, right) => left.schema.localeCompare(right.schema));

  if (!apply) {
    process.stdout.write(`${JSON.stringify({ mode: 'dry-run', plans }, null, 2)}\n`);
    return;
  }

  const databaseUrl = process.env.POSTGRES_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('PostgreSQL tenant apply requires POSTGRES_DATABASE_URL');
  }
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-tenant-provision',
    allowExitOnIdle: true,
    max: 1,
  });
  try {
    const login = await pool.query<{ current_user: string }>('SELECT current_user');
    const runtimeLoginRole = login.rows.at(0)?.current_user;
    if (!runtimeLoginRole) {
      throw new Error('PostgreSQL tenant apply could not resolve the runtime login role');
    }
    const first = plans.at(0);
    if (!first) throw new Error('PostgreSQL tenant apply requires at least one companion');

    // Extension relocation is explicit and happens before any shared migration
    // or tenant runtime can resolve pgvector. The initial plan deliberately has
    // no shared grant because the shared schema is provisioned immediately next.
    await provisionPostgresTenantAccess(pool, {
      plan: planPostgresTenantAccess({ schema: first.schema, role: first.role }),
      runtimeLoginRole,
      relocateExtensions: ['vector'],
    });
    await ensureSharedSchema(pool);
    for (const plan of plans) {
      await provisionPostgresTenantAccess(pool, { plan, runtimeLoginRole });
    }
    process.stdout.write(`${JSON.stringify({
      mode: 'applied',
      plans,
      extensionSchema: 'extensions',
    }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[provision-postgres-tenancy] ${message}\n`);
  process.exitCode = 1;
});
