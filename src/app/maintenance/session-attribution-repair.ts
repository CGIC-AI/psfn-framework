import '../../shared/utils/load-dotenv.js';
import { join } from 'node:path';
import { createSessionHmacBoundaryService } from '../../persistence/journals/hmac-boundary.js';
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
    resolveKeyring: runtime => createSessionHmacBoundaryService({
      env: process.env,
      credentialVault: runtime.config.credentialVault,
    }).resolveKeyring(),
    runRepair: ({ keyring, runtime }) => runAttributionRepair({
      sessionsDir: join(runtime.dataDir, 'sessions'),
      continuityDir: join(runtime.dataDir, 'contacts', 'continuity'),
      reflectionsDir: join(runtime.dataDir, 'notes', 'reflections'),
      backupDir: runtime.backupDir,
      keyring,
      repoRoot: process.cwd(),
    }),
    reportFields: (report, { runtime }) => [
      `Attribution repair complete for ${runtime.dataDir}`,
      `Backups: ${report.backupsDir}`,
      `Journal files: scanned=${report.journal.scannedFiles} modified=${report.journal.modifiedFiles} entries=${report.journal.modifiedEntries}`,
      `Turn records: scanned=${report.turnRecords.scannedFiles} modified=${report.turnRecords.modifiedFiles} records=${report.turnRecords.modifiedEntries}`,
      `Session channel index rebuilt: ${report.rebuiltChannelIndex ? 'yes' : 'no'}`,
    ],
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runCli();
}
