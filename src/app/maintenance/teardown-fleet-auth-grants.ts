import '../../shared/utils/load-dotenv.js';
import { createPostgresPool } from '../../persistence/postgres.js';
import { SHARED_SCHEMA_NAME } from '../../persistence/postgres/migrations.js';
import {
  formerFleetAuthSuperuserSteps,
  teardownFormerFleetAuthGrants,
  type FormerFleetAuthGrantTeardownReport,
} from '../../persistence/postgres/fleet-auth/former-grant-teardown.js';
import { resolveCompanionDatabaseTopology } from '../../system/config/companion-database-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

interface CliOptions {
  apply: boolean;
  roles: string[];
  showHelp: boolean;
}

export function printFleetAuthGrantTeardownUsage(): void {
  console.log(
    'Usage: npm run fleet-auth:teardown -- --role <former-fleet-auth-role> '
    + '[--role <former-fleet-auth-role> ...] [--apply]',
  );
  console.log('');
  console.log('Revokes the named former fleet-auth roles\' schema, object, and owner default');
  console.log('privileges on every companion schema and the shared schema, connected as each');
  console.log('schema owner from the gateway fleet topology. Default mode is a dry run.');
  console.log('Refuses to run while fleet-auth.json is still configured, and refuses any');
  console.log('role that is a configured companion or shared-migration authority.');
  console.log('Prints the superuser-only DROP SCHEMA / DROP OWNED / DROP ROLE steps afterwards.');
}

export function parseFleetAuthGrantTeardownArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { apply: false, roles: [], showHelp: false },
    extraFlags: {
      '--role': ({ options, readValue }) => {
        options.roles.push(readValue());
      },
      '--apply': ({ options }) => {
        options.apply = true;
      },
    },
  });
}

export interface FleetAuthGrantTeardownTarget {
  schema: string;
  ownerDatabaseUrl: string;
  ownerRole: string;
}

/**
 * Every schema fleet auth granted into, with the owner credential that can
 * revoke it. Fails closed when fleet auth is still configured or the fleet
 * topology is unavailable, and when a named role is itself an authority role.
 */
export function resolveFleetAuthGrantTeardownTargets(
  config: SubstrateConfig,
  roles: readonly string[],
): FleetAuthGrantTeardownTarget[] {
  if (config.fleetAuth) {
    throw new Error(
      'Fleet auth is still configured (fleet-auth.json); remove it before tearing down its grants',
    );
  }
  if (!config.companionFleet || !config.credentialVault || !config.postgresDatabaseUrl) {
    throw new Error(
      'Fleet auth grant teardown requires the gateway fleet topology, credential vault, and '
      + 'POSTGRES_DATABASE_URL',
    );
  }
  const topology = resolveCompanionDatabaseTopology({
    fleet: config.companionFleet,
    credentialVault: config.credentialVault,
    gatewayDatabaseUrl: config.postgresDatabaseUrl,
  });
  const targets: FleetAuthGrantTeardownTarget[] = [
    ...topology.companions.map(entry => ({
      schema: entry.companion.postgresSchema,
      ownerDatabaseUrl: entry.databaseUrl,
      ownerRole: entry.role,
    })),
    {
      schema: SHARED_SCHEMA_NAME,
      ownerDatabaseUrl: topology.sharedMigration.databaseUrl,
      ownerRole: topology.sharedMigration.role,
    },
  ];
  const authorityRoles = new Set(targets.map(target => target.ownerRole));
  const refused = roles.filter(role => authorityRoles.has(role));
  if (refused.length > 0) {
    throw new Error(
      `Fleet auth grant teardown refuses configured authority roles: ${refused.join(', ')}`,
    );
  }
  return targets;
}

export async function runFleetAuthGrantTeardown(input: {
  targets: readonly FleetAuthGrantTeardownTarget[];
  roles: readonly string[];
  apply: boolean;
}): Promise<FormerFleetAuthGrantTeardownReport[]> {
  const reports: FormerFleetAuthGrantTeardownReport[] = [];
  for (const target of input.targets) {
    const pool = createPostgresPool(target.ownerDatabaseUrl, {
      applicationName: 'fleet-auth-grant-teardown',
      max: 1,
    });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const report = await teardownFormerFleetAuthGrants(client, {
          schema: target.schema,
          roles: input.roles,
          apply: input.apply,
        });
        await client.query(input.apply ? 'COMMIT' : 'ROLLBACK');
        reports.push(report);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }
  return reports;
}

function printReport(report: FormerFleetAuthGrantTeardownReport): void {
  console.log(`Schema ${report.schema} (owner ${report.owner}):`);
  if (report.absentRoles.length > 0) {
    console.log(`  roles not present: ${report.absentRoles.join(', ')}`);
  }
  if (report.before.length === 0) {
    console.log('  no residue');
    return;
  }
  for (const statement of report.statements) {
    console.log(`  ${report.applied ? 'ran' : 'would run'}: ${statement}`);
  }
  for (const residue of report.after) {
    const foreign = residue.defaultPrivileges
      .map(entry => `default privileges from ${entry.grantor} on ${entry.objectTypes.join('/')}`);
    console.log(
      `  remaining for ${residue.role}: `
      + [
        ...(residue.schemaAcl ? ['schema ACL'] : []),
        ...(residue.objectGrants > 0 ? [`${residue.objectGrants} object grant(s)`] : []),
        ...foreign,
      ].join(', '),
    );
  }
}

export function runFleetAuthGrantTeardownCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<unknown> {
  return runMaintenanceCli({
    argv,
    label: 'Fleet auth grant teardown',
    parseArgs: parseFleetAuthGrantTeardownArgs,
    printUsage: printFleetAuthGrantTeardownUsage,
    run: async options => {
      if (options.roles.length === 0) {
        throw new Error('--role <former-fleet-auth-role> is required at least once');
      }
      const runtime = await bootstrapMaintenanceRuntime();
      const targets = resolveFleetAuthGrantTeardownTargets(runtime.config, options.roles);
      const reports = await runFleetAuthGrantTeardown({
        targets,
        roles: options.roles,
        apply: options.apply,
      });
      for (const report of reports) printReport(report);
      const remaining = reports.filter(report => report.after.length > 0);
      if (options.apply && remaining.length > 0) {
        throw new Error(
          'Residue remains that the schema owners cannot revoke (default privileges granted by '
          + `another role) on: ${remaining.map(report => report.schema).join(', ')}`,
        );
      }
      console.log('');
      console.log(options.apply
        ? 'Schema grants revoked. Finish as a PostgreSQL superuser:'
        : 'Dry run only; rerun with --apply. After applying, finish as a PostgreSQL superuser:');
      for (const step of formerFleetAuthSuperuserSteps(options.roles)) console.log(`  ${step}`);
      return reports;
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runFleetAuthGrantTeardownCli();
}
