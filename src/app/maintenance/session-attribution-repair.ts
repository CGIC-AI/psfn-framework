import 'dotenv/config';
import { join, resolve } from 'node:path';
import { loadConfig } from '../../system/config/load-config.js';
import { createSessionHmacBoundaryService } from '../../persistence/journals/hmac-boundary.js';
import { runAttributionRepair } from '../../persistence/repair/attribution-repair.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { hydrateSecretBearingConfig } from '../startup/support/bootstrap-helpers.js';
import { applyGatewayTlsConfig } from '../../boundary/gateway/tls.js';

interface CliOptions {
  dataDir?: string;
  backupDir?: string;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run session:repair:attribution [-- --data-dir <path> --backup-dir <path>]');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { showHelp: false };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.showHelp = true;
      continue;
    }
    if (arg === '--data-dir') {
      options.dataDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--backup-dir') {
      options.backupDir = argv[index + 1];
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
  applyGatewayTlsConfig({
    caPath: config.gatewayTlsCaPath,
    rejectUnauthorized: config.gatewayTlsRejectUnauthorized,
  });
  await hydrateSecretBearingConfig(config, { env: process.env });
  const repoRoot = process.cwd();
  const dataDir = resolve(options.dataDir ?? config.dataDir);
  const backupDir = resolve(
    options.backupDir
      ?? join(dataDir, 'repair-backups', `attribution-${new Date().toISOString().replace(/[:.]/g, '-')}`),
  );
  const keyring = createSessionHmacBoundaryService({
    env: process.env,
    credentialVault: config.credentialVault,
  }).resolveKeyring();

  const report = runAttributionRepair({
    sessionsDir: join(dataDir, 'sessions'),
    continuityDir: join(dataDir, 'contacts', 'continuity'),
    reflectionsDir: join(dataDir, 'notes', 'reflections'),
    backupDir,
    keyring,
    repoRoot,
  });

  console.log(`Attribution repair complete for ${dataDir}`);
  console.log(`Backups: ${report.backupsDir}`);
  console.log(
    `Journal files: scanned=${report.journal.scannedFiles} modified=${report.journal.modifiedFiles} entries=${report.journal.modifiedEntries}`,
  );
  console.log(
    `Turn records: scanned=${report.turnRecords.scannedFiles} modified=${report.turnRecords.modifiedFiles} records=${report.turnRecords.modifiedEntries}`,
  );
  console.log(`Session channel index rebuilt: ${report.rebuiltChannelIndex ? 'yes' : 'no'}`);
}

main().catch((error) => {
  console.error(`Attribution repair failed: ${toErrorMessage(error)}`);
  process.exit(1);
});
