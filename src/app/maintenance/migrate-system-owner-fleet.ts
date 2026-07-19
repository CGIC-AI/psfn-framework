#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import {
  buildSystemOwnerFleetMigrationPlan,
  executeSystemOwnerFleetMigration,
  SYSTEM_OWNER_FLEET_MIGRATION_FILES,
} from '../../persistence/system-owner-fleet-migration.js';
import { resolveSystemOwnerFleetContext } from './system-owner-fleet-context.js';
import {
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

interface CliOptions {
  apply: boolean;
  approvals: Record<string, string>;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run migrate:system-owner-fleet [-- OPTIONS]');
  console.log('');
  console.log('Plans or applies the explicit system-owner to fleet-companion fan-out migration.');
  console.log('Stop the fleet before applying. The default mode is a read-only plan.');
  console.log('');
  console.log('Options:');
  console.log('  --apply                         Execute the migration');
  console.log('  --approve <owner-file>=<sha256> Approve one exact source digest (repeat per source)');
  console.log('  -h, --help                      Show this help message');
}

function parseApproval(raw: string): [string, string] {
  const separator = raw.indexOf('=');
  if (separator <= 0) {
    throw new Error('--approve must use <owner-file>=<sha256>');
  }
  const ownerFile = raw.slice(0, separator).trim();
  const digest = raw.slice(separator + 1).trim();
  if (!SYSTEM_OWNER_FLEET_MIGRATION_FILES.has(ownerFile)) {
    throw new Error(`--approve owner file is not supported by the system-owner fleet migration: ${ownerFile}`);
  }
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(`--approve digest for ${ownerFile} must be an exact lowercase SHA-256`);
  }
  return [ownerFile, digest];
}

function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { apply: false, approvals: {}, showHelp: false },
    extraFlags: {
      '--apply': ({ options }) => {
        options.apply = true;
      },
      '--approve': ({ options, readValue }) => {
        const [ownerFile, digest] = parseApproval(readValue());
        if (options.approvals[ownerFile]) {
          throw new Error(`Duplicate --approve for ${ownerFile}`);
        }
        options.approvals[ownerFile] = digest;
      },
    },
  });
}

function run(options: CliOptions): void {
  const { layout, fleet } = resolveSystemOwnerFleetContext(process.env);
  if (options.apply) {
    const result = executeSystemOwnerFleetMigration({
      systemDataDir: layout.systemDataDir,
      fleet,
      expectedSourceDigests: options.approvals,
    });
    console.log(JSON.stringify({ mode: 'apply', ...result }, null, 2));
    return;
  }
  if (Object.keys(options.approvals).length > 0) {
    throw new Error('--approve is accepted only with --apply');
  }
  const plan = buildSystemOwnerFleetMigrationPlan({
    systemDataDir: layout.systemDataDir,
    fleet,
  });
  console.log(JSON.stringify({
    mode: 'dry-run',
    ...plan,
    approvals: plan.files
      .filter(file => file.sourceSha256)
      .map(file => `--approve ${file.ownerFile}=${file.sourceSha256}`),
  }, null, 2));
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runMaintenanceCli({
    label: 'System-owner fleet migration',
    parseArgs,
    printUsage,
    run,
  });
}
