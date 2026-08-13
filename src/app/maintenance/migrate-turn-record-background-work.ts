#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import { resolve } from 'node:path';
import { resolveSessionsDir } from '../../persistence/layout.js';
import {
  migrateLegacyTurnRecordBackgroundWork,
  type LegacyTurnRecordBackgroundWorkMigrationReport,
} from '../../persistence/repair/legacy-turn-record-background-work.js';
import {
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

interface CliOptions {
  apply: boolean;
  backupDir?: string;
  dataDir?: string;
  sessionsDir?: string;
  showHelp: boolean;
}

interface CliDependencies {
  exit?: (code: number) => void;
  logger?: Pick<Console, 'error' | 'log'>;
}

function printUsage(): void {
  console.log(
    'Usage: npm run migrate:turn-record-background-work -- '
    + '--data-dir <companion-data-dir> [OPTIONS]',
  );
  console.log('');
  console.log('Durably retires exact pre-drift emotion-appraisal jobs in TurnRecord mirrors.');
  console.log('Dry-run is the default.');
  console.log('');
  console.log('Options:');
  console.log('  --apply                 Rewrite affected TurnRecord files');
  console.log('  --dry-run               Report affected rows without writing (default)');
  console.log('  --backup-dir <path>     Empty backup target required when applying repairs');
  console.log('  --data-dir <path>       Exact companion data directory');
  console.log('  --sessions-dir <path>   Exact sessions directory (alternative to --data-dir)');
  console.log('  -h, --help              Show this help message');
}

function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { apply: false, showHelp: false },
    commonFlags: {
      backupDir: { transform: resolve },
      dataDir: { transform: resolve },
    },
    extraFlags: {
      '--apply': ({ options }) => { options.apply = true; },
      '--dry-run': ({ options }) => { options.apply = false; },
      '--sessions-dir': ({ options, readValue }) => {
        options.sessionsDir = resolve(readValue());
      },
    },
  });
}

function resolveTargetSessionsDir(options: CliOptions): string {
  if (options.dataDir && options.sessionsDir) {
    throw new Error('Pass exactly one of --data-dir or --sessions-dir');
  }
  if (options.sessionsDir) return options.sessionsDir;
  if (options.dataDir) return resolveSessionsDir(options.dataDir);
  throw new Error('--data-dir is required (or pass the exact --sessions-dir)');
}

export function runTurnRecordBackgroundWorkMigrationCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = {},
): Promise<LegacyTurnRecordBackgroundWorkMigrationReport | undefined> {
  const logger = dependencies.logger ?? console;
  return runMaintenanceCli({
    argv,
    exit: dependencies.exit,
    label: 'TurnRecord background-work migration',
    logger,
    parseArgs,
    printUsage,
    run: options => {
      const report = migrateLegacyTurnRecordBackgroundWork({
        apply: options.apply,
        sessionsDir: resolveTargetSessionsDir(options),
        ...(options.backupDir ? { backupDir: options.backupDir } : {}),
      });
      logger.log(JSON.stringify(report, null, 2));
      return report;
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runTurnRecordBackgroundWorkMigrationCli();
}
