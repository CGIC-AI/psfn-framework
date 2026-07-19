#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import {
  buildPersistenceCutoverOptionsFromConfig,
  buildPersistenceCutoverPlan,
  executePersistenceCutover,
} from '../../persistence/cutover.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

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

function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { apply: false, showHelp: false },
    extraFlags: {
      '--apply': ({ options }) => {
        options.apply = true;
      },
      '--legacy-data-dir': ({ options, readValue }) => {
        options.legacyDataDir = readValue();
      },
      '--legacy-companion-dir': ({ options, readValue }) => {
        options.legacyCompanionDir = readValue();
      },
    },
  });
}

async function run(options: CliOptions): Promise<void> {
  const { config } = await bootstrapMaintenanceRuntime({ hydrateSecrets: false });
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

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runMaintenanceCli({
    label: 'Persistence migration',
    parseArgs,
    printUsage,
    run,
  });
}
