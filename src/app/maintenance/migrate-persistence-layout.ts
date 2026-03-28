#!/usr/bin/env tsx

import 'dotenv/config';
import { loadConfig } from '../../types.js';
import {
  buildPersistenceCutoverOptionsFromConfig,
  buildPersistenceCutoverPlan,
  executePersistenceCutover,
} from '../../persistence/cutover.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

interface CliOptions {
  apply: boolean;
  legacyDataDir?: string;
  legacyCompanionDir?: string;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run migrate:persistence-layout [-- OPTIONS]');
  console.log('');
  console.log('Plans or applies the split-root persistence migration from the legacy shared data root.');
  console.log('');
  console.log('Options:');
  console.log('  --apply                  Execute the migration (default is dry-run)');
  console.log(`  --legacy-data-dir <dir>  Override legacy shared data root (default: ${process.env.DATA_DIR ?? './data'})`);
  console.log('  --legacy-companion-dir <dir>  Override legacy companion root (default: ./companion)');
  console.log('  -h, --help               Show this help message');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    showHelp: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.showHelp = true;
      continue;
    }
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--legacy-data-dir') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --legacy-data-dir');
      }
      options.legacyDataDir = value;
      index += 1;
      continue;
    }
    if (arg === '--legacy-companion-dir') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --legacy-companion-dir');
      }
      options.legacyCompanionDir = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) {
    printUsage();
    return;
  }

  const config = loadConfig();
  const migrationOptions = buildPersistenceCutoverOptionsFromConfig(config);
  if (options.legacyDataDir) {
    migrationOptions.legacySharedDataDir = options.legacyDataDir;
  }
  if (options.legacyCompanionDir) {
    migrationOptions.legacyCompanionDir = options.legacyCompanionDir;
  }

  const result = options.apply
    ? executePersistenceCutover(migrationOptions)
    : buildPersistenceCutoverPlan(migrationOptions);

  console.log(JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run',
    ...result,
  }, null, 2));
}

main().catch((error) => {
  console.error(`Persistence migration failed: ${toErrorMessage(error)}`);
  process.exit(1);
});
