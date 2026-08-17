#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import { resolve } from 'node:path';
import { migrateIntakePolicyOwner } from '../../system/config/intake-policy-owner-migration.js';
import {
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

interface CliOptions {
  apply: boolean;
  showHelp: boolean;
  dataDir?: string;
}

function printUsage(): void {
  console.log('Usage: npm run migrate:intake-policy-owner -- --data-dir <system-data-dir> [OPTIONS]');
  console.log('');
  console.log('Upgrades schema-v1/v2/v3/v4/v5 intake-policy.json owners to v6 and removes');
  console.log('retired screener model selectors and adds required posture sections to current owners.');
  console.log('Dry-run is the default.');
  console.log('');
  console.log('Options:');
  console.log('  --apply             Validate and atomically replace intake-policy.json');
  console.log('  --dry-run           Report the migration without writing (default)');
  console.log('  --data-dir <path>   Exact system owner-file directory (required)');
  console.log('  -h, --help          Show this help message');
}

function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { apply: false, showHelp: false },
    commonFlags: {
      dataDir: { transform: resolve },
    },
    extraFlags: {
      '--apply': ({ options }) => {
        options.apply = true;
      },
      '--dry-run': ({ options }) => {
        options.apply = false;
      },
    },
  });
}

export function runIntakePolicyOwnerMigrationCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<unknown> {
  return runMaintenanceCli({
    argv,
    label: 'Intake policy owner migration',
    parseArgs,
    printUsage,
    run: options => {
      if (!options.dataDir) {
        throw new Error('--data-dir is required; pass the exact system owner-file directory');
      }
      const result = migrateIntakePolicyOwner({
        dataDir: options.dataDir,
        apply: options.apply,
      });
      console.log(JSON.stringify(result, null, 2));
      return result;
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runIntakePolicyOwnerMigrationCli();
}
