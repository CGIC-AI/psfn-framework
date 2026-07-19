#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import { resolve } from 'node:path';
import { migrateLegacySchedulerOwner } from '../../system/config/scheduler-owner-migration.js';
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
  console.log('Usage: npm run migrate:scheduler-owner -- --data-dir <companion-data-dir> [OPTIONS]');
  console.log('');
  console.log('Migrates the retired salience/social-graph scheduler cadences into');
  console.log('scheduler.json > backgroundMaintenance. Dry-run is the default.');
  console.log('');
  console.log('Options:');
  console.log('  --apply             Validate and atomically replace scheduler.json');
  console.log('  --dry-run           Report the migration without writing (default)');
  console.log('  --data-dir <path>   Exact companion owner-file directory (required)');
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

export function runSchedulerOwnerMigrationCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<unknown> {
  return runMaintenanceCli({
    argv,
    label: 'Scheduler owner migration',
    parseArgs,
    printUsage,
    run: options => {
      if (!options.dataDir) {
        throw new Error('--data-dir is required; pass the exact companion owner-file directory');
      }
      const result = migrateLegacySchedulerOwner({
        dataDir: options.dataDir,
        apply: options.apply,
      });
      console.log(JSON.stringify(result, null, 2));
      return result;
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runSchedulerOwnerMigrationCli();
}
