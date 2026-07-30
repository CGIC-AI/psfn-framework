import { resolveConfiguredCompanionFleet } from './companion-fleet-runtime.js';
import { provisionFleetContactTopology } from '../src/app/maintenance/fleet-contact-provisioning.js';
import { createPostgresContactStore } from '../src/core/contacts/postgres-adapter.js';
import type { ContactStorePort } from '../src/core/contacts/contact-store-port.js';
import { resolveRuntimePathLayout } from '../src/persistence/layout.js';
import { createPostgresPool } from '../src/persistence/postgres.js';
import { ensureSharedSchema } from '../src/persistence/postgres/shared-schema.js';
import {
  planPostgresTenantAccess,
  provisionPostgresTenantAccess,
} from '../src/persistence/postgres/tenancy.js';
import { resolveFleetAuthOwnerFile } from '../src/system/config/fleet-auth-config.js';

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
  const layout = resolveRuntimePathLayout({
    mode: process.env.PSFN_RUNTIME_LAYOUT_MODE,
    nodeEnv: process.env.NODE_ENV,
    runtimeRootDir: process.env.PSFN_RUNTIME_ROOT,
    systemDataDir: process.env.SYSTEM_DATA_DIR,
    companionDataDir: process.env.COMPANION_DATA_DIR,
    legacyDataDir: process.env.DATA_DIR,
    workspacePath: process.env.WORKSPACE_PATH,
    logsDir: process.env.PSFN_LOGS_DIR,
    tempDir: process.env.PSFN_TEMP_DIR,
    backupsDir: process.env.BACKUP_ROOT_DIR,
  });
  const fleetAuth = resolveFleetAuthOwnerFile({
    dataDir: layout.systemDataDir,
    processMode: 'gateway',
    env: process.env,
    ...(process.env.CONFIG_DIR?.trim() ? { seedDir: process.env.CONFIG_DIR.trim() } : {}),
  });
  if (!fleetAuth || fleetAuth.kind !== 'gateway') {
    throw new Error('PostgreSQL fleet tenant provisioning requires fleet-auth.json');
  }
  const backupRole = fleetAuth.config.databaseRoles.backupRestore;
  const accountRoster = fleetAuth.config.accountRoster ?? [];
  const plans = fleet.companions
    .map(companion => planPostgresTenantAccess({
      schema: companion.postgresSchema,
      approvedSharedSchema: 'shared',
      approvedSharedAccess: 'read_write',
    }))
    .sort((left, right) => left.schema.localeCompare(right.schema));

  if (!apply) {
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run',
      plans,
      backupRole,
      rosteredAdministrators: new Set(
        accountRoster
          .filter(entry => entry.role === 'owner' || entry.role === 'admin')
          .map(entry => entry.providerSubjectId),
      ).size,
    }, null, 2)}\n`);
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
      backupRole,
    });
    await ensureSharedSchema(pool);
    for (const plan of plans) {
      await provisionPostgresTenantAccess(pool, { plan, runtimeLoginRole, backupRole });
    }
    const stores = new Map<string, ContactStorePort>();
    for (const companion of fleet.companions) {
      const plan = plans.find(candidate => candidate.schema === companion.postgresSchema);
      if (!plan) {
        throw new Error(`PostgreSQL fleet contact provisioning lost schema ${companion.postgresSchema}`);
      }
      stores.set(
        companion.companionId,
        await createPostgresContactStore(databaseUrl, undefined, {
          applicationName: `psfn-fleet-contact-provision-${companion.companionId}`,
          schema: plan.schema,
          role: plan.role,
        }),
      );
    }
    const contacts = await provisionFleetContactTopology({
      companions: fleet.companions,
      accountRoster,
      stores,
    });
    process.stdout.write(`${JSON.stringify({
      mode: 'applied',
      plans,
      extensionSchema: 'extensions',
      backupRole,
      contacts,
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
