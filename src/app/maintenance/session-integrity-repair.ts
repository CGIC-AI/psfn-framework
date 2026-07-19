import '../../shared/utils/load-dotenv.js';
import { join } from 'node:path';
import { createSessionHmacBoundaryService } from '../../persistence/journals/hmac-boundary.js';
import { runSessionIntegrityRepair } from '../../persistence/repair/integrity-repair.js';
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
  console.log('Usage: npm run session:repair:integrity [-- --data-dir <path> --backup-dir <path>]');
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
      backupLabel: 'integrity',
    }),
    label: 'Session integrity repair',
    parseArgs,
    printUsage,
    resolveKeyring: runtime => createSessionHmacBoundaryService({
      env: process.env,
      credentialVault: runtime.config.credentialVault,
    }).requireKeyring('Session HMAC keyring is required for integrity repair'),
    runRepair: ({ keyring, runtime }) => runSessionIntegrityRepair({
      sessionsDir: join(runtime.dataDir, 'sessions'),
      backupDir: runtime.backupDir,
      keyring,
      repoRoot: process.cwd(),
    }),
    reportFields: (report, { runtime }) => [
      `Session integrity repair complete for ${runtime.dataDir}`,
      `Backups: ${report.backupsDir}`,
      `Journal files: scanned=${report.journal.scannedFiles} modified=${report.journal.modifiedFiles} entries=${report.journal.modifiedEntries}`,
      `Session channel index rebuilt: ${report.rebuiltChannelIndex ? 'yes' : 'no'}`,
    ],
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runCli();
}
