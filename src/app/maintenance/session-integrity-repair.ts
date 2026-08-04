import '../../shared/utils/load-dotenv.js';
import { join } from 'node:path';
import { createSessionHmacBoundaryService } from '../../persistence/journals/hmac-boundary.js';
import { runSessionIntegrityRepair } from '../../persistence/repair/integrity-repair.js';
import { resolveConfiguredCompanionDataDir } from '../../persistence/layout.js';
import { createSafeguardAuditTrail } from '../../system/capabilities/safeguards.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runRepairCli,
} from './cli-harness.js';

interface CliOptions {
  dataDir?: string;
  backupDir?: string;
  reason?: string;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run session:repair:integrity -- --reason <text> [--data-dir <path> --backup-dir <path>]');
  console.log('  --reason <text>  Required. Operator justification recorded in the durable safeguard audit trail.');
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options = parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { showHelp: false },
    commonFlags: {
      dataDir: { allowMissingValue: true },
      backupDir: { allowMissingValue: true },
    },
    extraFlags: {
      '--reason': ({ options: parsed, readValue }) => {
        parsed.reason = readValue();
      },
    },
  });
  // Fail closed before any secret hydration or keyring resolution: a sanctioned
  // re-sign must always carry an operator reason for the durable audit record.
  if (!options.showHelp && !options.reason?.trim()) {
    throw new Error('Session integrity repair requires --reason <text>');
  }
  return options;
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
    runRepair: ({ keyring, options, runtime }) => runSessionIntegrityRepair({
      sessionsDir: join(runtime.dataDir, 'sessions'),
      backupDir: runtime.backupDir,
      keyring,
      reason: options.reason ?? '',
      // Land the durable, content-free run record on the canonical safeguard
      // audit trail (companion-data/state/safeguards-audit.jsonl) that Garden
      // already surfaces, so a sanctioned re-sign is operator-traceable.
      audit: createSafeguardAuditTrail(resolveConfiguredCompanionDataDir(runtime.config)),
    }),
    reportFields: (report, { options, runtime }) => [
      `Session integrity repair complete for ${runtime.dataDir}`,
      `Reason: ${options.reason ?? ''}`,
      `Backups: ${report.backupsDir}`,
      `Journal files: scanned=${report.journal.scannedFiles} modified=${report.journal.modifiedFiles} entries=${report.journal.modifiedEntries} quarantinedRows=${report.journal.quarantinedRows}`,
      `Session channel index rebuilt: ${report.rebuiltChannelIndex ? 'yes' : 'no'}`,
    ],
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runCli();
}
