#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSessionsDir } from '../../persistence/layout.js';
import type { ChannelIndexEntry } from '../../persistence/sessions/store-primitives.js';
import {
  CHANNEL_INDEX_FILENAME,
  loadChannelIndex,
  migrateLegacyFilenames,
  primeChannelIndexFromDisk,
} from '../../persistence/sessions/store/channel-index.js';
import { isLegacySessionJournalFilename } from '../../persistence/sessions/store/channel-filenames.js';
import {
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

interface CliOptions {
  apply: boolean;
  dataDir?: string;
  sessionsDir?: string;
  showHelp: boolean;
}

export interface SessionFilenameMigrationReport {
  legacyFilenames: string[];
  migratedCount: number;
  mode: 'apply' | 'dry-run';
  remainingLegacyCount: number;
  sessionsDir: string;
}

interface SessionFilenameMigrationCliDependencies {
  exit?: (code: number) => void;
  logger?: Pick<Console, 'error' | 'log'>;
}

function printUsage(): void {
  console.log('Usage: npm run migrate:session-filenames -- --data-dir <companion-data-dir> [OPTIONS]');
  console.log('');
  console.log('Migrates retired L0 session journal filenames to the readable filename format.');
  console.log('Dry-run is the default.');
  console.log('');
  console.log('Options:');
  console.log('  --apply                 Rename legacy files and update the channel index');
  console.log('  --dry-run               Report legacy files without writing (default)');
  console.log('  --data-dir <path>       Exact companion data directory');
  console.log('  --sessions-dir <path>   Exact sessions directory (alternative to --data-dir)');
  console.log('  -h, --help              Show this help message');
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
      '--sessions-dir': ({ options, readValue }) => {
        options.sessionsDir = resolve(readValue());
      },
    },
  });
}

function listLegacyFilenames(sessionsDir: string): string[] {
  return readdirSync(sessionsDir)
    .filter(isLegacySessionJournalFilename)
    .sort();
}

function resolveTargetSessionsDir(options: CliOptions): string {
  if (options.dataDir && options.sessionsDir) {
    throw new Error('Pass exactly one of --data-dir or --sessions-dir');
  }
  if (options.sessionsDir) return options.sessionsDir;
  if (options.dataDir) return resolveSessionsDir(options.dataDir);
  throw new Error('--data-dir is required (or pass the exact --sessions-dir)');
}

function runMigration(options: CliOptions): SessionFilenameMigrationReport {
  const sessionsDir = resolveTargetSessionsDir(options);
  const legacyFilenames = listLegacyFilenames(sessionsDir);

  if (options.apply && legacyFilenames.length > 0) {
    const channelIndex = new Map<string, ChannelIndexEntry>();
    const channelIndexPath = resolve(sessionsDir, CHANNEL_INDEX_FILENAME);
    const warnAboutQuarantinedEntries = (
      channelId: string,
      filePath: string,
      quarantinedCount: number,
      loadedCount: number,
    ): void => {
      console.warn(
        `Session filename migration quarantined entries for ${channelId}: `
        + `${filePath} quarantined=${quarantinedCount} loaded=${loadedCount}`,
      );
    };
    loadChannelIndex(channelIndexPath, channelIndex, { persistMigration: false });
    migrateLegacyFilenames({
      sessionsDir,
      channelIndexPath,
      channelIndex,
      warnAboutQuarantinedEntries,
    });
    primeChannelIndexFromDisk({
      sessionsDir,
      channelIndexPath,
      channelIndex,
      warnAboutQuarantinedEntries,
    });
  }

  const remainingLegacyFilenames = listLegacyFilenames(sessionsDir);
  return {
    legacyFilenames,
    migratedCount: options.apply
      ? legacyFilenames.length - remainingLegacyFilenames.length
      : 0,
    mode: options.apply ? 'apply' : 'dry-run',
    remainingLegacyCount: remainingLegacyFilenames.length,
    sessionsDir,
  };
}

export function runSessionFilenameMigrationCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: SessionFilenameMigrationCliDependencies = {},
): Promise<SessionFilenameMigrationReport | undefined> {
  const logger = dependencies.logger ?? console;
  return runMaintenanceCli({
    argv,
    exit: dependencies.exit,
    label: 'Session filename migration',
    logger,
    parseArgs,
    printUsage,
    run: options => {
      const report = runMigration(options);
      logger.log(JSON.stringify(report, null, 2));
      return report;
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runSessionFilenameMigrationCli();
}
