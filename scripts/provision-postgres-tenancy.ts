import { resolveConfiguredCompanionFleet } from './companion-fleet-runtime.js';
import { provisionFleetContactTopology } from '../src/app/maintenance/fleet-contact-provisioning.js';
import { createPostgresContactStore } from '../src/core/contacts/postgres-adapter.js';
import type { ContactStorePort } from '../src/core/contacts/contact-store-port.js';
import { resolveRuntimePathLayout } from '../src/persistence/layout.js';
import { createPostgresPool } from '../src/persistence/postgres.js';
import { PostgresBackgroundWorkStore } from '../src/persistence/postgres/background-work-store.js';
import { ensureSharedSchema } from '../src/persistence/postgres/shared-schema.js';
import {
  planPostgresTenantAccess,
  provisionPostgresTenantAccess,
} from '../src/persistence/postgres/tenancy.js';
import {
  grantWelfareVerifierReadAccessToTenantSchema,
  provisionWelfareVerifierLoginRole,
} from '../src/persistence/postgres/welfare-verifier-access.js';
import { resolveFleetAuthOwnerFile } from '../src/system/config/fleet-auth-config.js';
import { parseExactPostgresCredential } from '../src/shared/utils/postgres-credential.js';

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
      welfareVerifierRole: fleetAuth.config.welfareVerifier?.role,
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
    // Bring every fleet tenant schema to its background-work migration head,
    // then apply the welfare-verifier read grant. This script is the ONLY
    // applier: the shared tenancy primitive above also serves shard and
    // harness callers and must not escalate application-time privileges. A
    // tenant provisioned before its tables existed (a newly added follower)
    // receives the same agent_background_work_jobs SELECT as every
    // pre-existing schema in this same operator pass; both steps are
    // idempotent, so re-running this script is also the repair path for a
    // drifted fleet schema.
    //
    // psfn-framework-aqp2u: the verifier grant lands on the DEDICATED
    // gateway welfare-verifier LOGIN role declared by fleet-auth.json's
    // optional `welfareVerifier` block, never the companion runtime login — a
    // cross-schema grant on a companion runtime role reaches the agent pods
    // and breaches sibling isolation. The dedicated role legitimately holds
    // USAGE/SELECT across every fleet schema (gateway-only reader). When the
    // block is absent, no grant is applied and the gateway verifier degrades
    // honestly to FIFO; the operator adds the block + credential to enable it.
    const welfareVerifierAuthority = fleetAuth.config.welfareVerifier;
    let welfareVerifierRole: string | undefined;
    if (welfareVerifierAuthority) {
      const welfareVerifierUrl = process.env[welfareVerifierAuthority.databaseUrlRef.envName]?.trim();
      if (!welfareVerifierUrl) {
        throw new Error(
          `PostgreSQL tenant apply requires the welfare verifier credential at env ${welfareVerifierAuthority.databaseUrlRef.envName}`,
        );
      }
      const parsed = parseExactPostgresCredential(
        welfareVerifierUrl,
        'Fleet auth welfare verifier database credential',
      );
      if (parsed.username !== welfareVerifierAuthority.role) {
        throw new Error(
          `Fleet auth welfare verifier database credential must authenticate as ${welfareVerifierAuthority.role}, not ${parsed.username}`,
        );
      }
      const provisioned = await provisionWelfareVerifierLoginRole(pool, {
        role: welfareVerifierAuthority.role,
        password: decodeURIComponent(parsed.url.password),
      });
      welfareVerifierRole = provisioned.role;
    }
    for (const plan of plans) {
      const backgroundWork = await PostgresBackgroundWorkStore.connect(databaseUrl, {
        schema: plan.schema,
        role: plan.role,
      });
      await backgroundWork.close();
      if (!welfareVerifierRole) continue;
      const grant = await grantWelfareVerifierReadAccessToTenantSchema(pool, {
        schema: plan.schema,
        verifierRole: welfareVerifierRole,
      });
      if (!grant.relationGranted) {
        throw new Error(
          `PostgreSQL tenant ${plan.schema} has no agent_background_work_jobs after migrations`,
        );
      }
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
      ...(welfareVerifierRole ? { welfareVerifierRole } : {}),
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
