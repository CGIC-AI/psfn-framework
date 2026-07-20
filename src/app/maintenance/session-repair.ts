import '../../shared/utils/load-dotenv.js';
import { join, resolve } from 'node:path';
import { runSessionRepairScan } from '../../persistence/repair/repair.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runRepairCli,
  type MaintenanceRuntime,
} from './cli-harness.js';

interface CliOptions {
  sessionsDir?: string;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run session:repair [-- --sessions-dir <path>]');
}

function parseArgs(argv: readonly string[]): CliOptions {
  const setSessionsDir = ({ options, readValue }: {
    options: CliOptions;
    readValue: () => string;
  }): void => {
    options.sessionsDir = readValue();
  };
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { showHelp: false },
    extraFlags: {
      '--sessions-dir': setSessionsDir,
      '-d': setSessionsDir,
    },
  });
}

interface SessionRepairCliDependencies {
  bootstrap?: () => Promise<Pick<MaintenanceRuntime, 'dataDir'>>;
  exit?: (code: number) => void;
  logger?: Pick<Console, 'error' | 'log'>;
}

export function runSessionRepairCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: SessionRepairCliDependencies = {},
): Promise<unknown> {
  return runRepairCli({
    argv,
    bootstrap: dependencies.bootstrap
      ?? (() => bootstrapMaintenanceRuntime({ hydrateSecrets: false })),
    exit: dependencies.exit,
    label: 'Session repair',
    logger: dependencies.logger,
    parseArgs,
    printUsage,
    resolveKeyring: () => undefined,
    runRepair: ({ options, runtime }) => {
      const sessionsDir = resolve(options.sessionsDir ?? join(runtime.dataDir, 'sessions'));
      return {
        report: runSessionRepairScan(sessionsDir),
        sessionsDir,
      };
    },
    reportFields: ({ report, sessionsDir }) => {
      const lines = [
        `Session repair scan: ${sessionsDir}`,
        `Scanned ${report.scannedFiles} JSONL files`,
      ];

      if (report.scannedFiles === 0) {
        return [...lines, 'No JSONL files found.'];
      }
      if (report.filesWithCorruption.length === 0) {
        return [...lines, 'No corruption found.'];
      }

      lines.push('');
      for (const file of report.filesWithCorruption) {
        const channelLabel = file.channelId ?? 'unknown';
        lines.push(`- ${file.filePath}`);
        lines.push(
          `  channel=${channelLabel} quarantined=${file.quarantinedEntries} loaded=${file.loadedEntries}`,
        );
        lines.push(`  sidecar=${file.quarantinePath}`);
      }
      lines.push('');
      lines.push(
        `Detected ${report.quarantinedEntries} quarantined lines across ${report.filesWithCorruption.length} files.`,
      );
      process.exitCode = 1;
      return lines;
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runSessionRepairCli();
}
