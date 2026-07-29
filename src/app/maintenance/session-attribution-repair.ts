import '../../shared/utils/load-dotenv.js';
import { join } from 'node:path';
import { runAttributionRepair } from '../../persistence/repair/attribution-repair.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runRepairCli,
} from './cli-harness.js';

interface CliOptions {
  dataDir?: string;
  backupDir?: string;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run session:repair:attribution [-- --data-dir <path> --backup-dir <path>]');
}

function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { showHelp: false },
    commonFlags: {
      dataDir: { allowMissingValue: true },
      backupDir: { allowMissingValue: true },
    },
  });
}

function runCli(): Promise<unknown> {
  return runRepairCli({
    bootstrap: options => bootstrapMaintenanceRuntime({
      dataDir: options.dataDir,
      backupDir: options.backupDir,
      backupLabel: 'attribution',
    }),
    label: 'Attribution repair',
    parseArgs,
    printUsage,
    // Canonical L0 chains are never rewritten here, so no HMAC keyring is needed;
    // only the derived `_turn_records` mirror and channel index are corrected.
    resolveKeyring: () => null,
    runRepair: ({ runtime }) => runAttributionRepair({
      sessionsDir: join(runtime.dataDir, 'sessions'),
      backupDir: runtime.backupDir,
      repoRoot: process.cwd(),
    }),
    reportFields: (report, { runtime }) => [
      `Attribution repair complete for ${runtime.dataDir}`,
      `Backups: ${report.backupsDir}`,
      'Canonical L0 chains: not rewritten (append-only; attribution normalized at read time)',
      `Turn records: scanned=${report.turnRecords.scannedFiles} modified=${report.turnRecords.modifiedFiles} records=${report.turnRecords.modifiedEntries}`,
      `Session channel index rebuilt: ${report.rebuiltChannelIndex ? 'yes' : 'no'}`,
    ],
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runCli();
}
