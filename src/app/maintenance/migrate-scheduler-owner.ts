#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import { resolve } from 'node:path';
import { resolveConfiguredCompanionDataDir } from '../../persistence/layout.js';
import { migrateLegacySchedulerOwner } from '../../system/config/scheduler-owner-migration.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

interface CliOptions {
  apply: boolean;
  showHelp: boolean;
  dataDir?: string;
}

function printUsage(): void {
  console.log('Usage: npm run migrate:scheduler-owner [-- OPTIONS]');
  console.log('');
  console.log('Migrates the retired salience/social-graph scheduler cadences into');
  console.log('scheduler.json > backgroundMaintenance. Dry-run is the default.');
  console.log('');
  console.log('Options:');
  console.log('  --apply             Validate and atomically replace scheduler.json');
  console.log('  --dry-run           Report the migration without writing (default)');
  console.log('  --data-dir <path>   Override the companion owner-file directory');
  console.log('  -h, --help          Show this help message');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, showHelp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.apply = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.showHelp = true;
      continue;
    }
    if (arg === '--data-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --data-dir');
      options.dataDir = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) {
    printUsage();
    return;
  }
  const dataDir = options.dataDir
    ?? resolveConfiguredCompanionDataDir({
      systemDataDir: process.env.SYSTEM_DATA_DIR,
      companionDataDir: process.env.COMPANION_DATA_DIR,
      dataDir: process.env.DATA_DIR,
    });
  const result = migrateLegacySchedulerOwner({
    dataDir,
    apply: options.apply,
  });
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`Scheduler owner migration failed: ${toErrorMessage(error)}`);
  process.exit(1);
}
