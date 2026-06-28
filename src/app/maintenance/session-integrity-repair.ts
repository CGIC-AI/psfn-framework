import '../../shared/utils/load-dotenv.js';
import { join, resolve } from 'node:path';
import { loadConfig } from '../../system/config/load-config.js';
import { createSessionHmacBoundaryService } from '../../persistence/journals/hmac-boundary.js';
import { runSessionIntegrityRepair } from '../../persistence/repair/integrity-repair.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { hydrateSecretBearingConfig } from '../startup/support/bootstrap-helpers.js';
import { applyGatewayTlsConfig } from '../../boundary/gateway/tls.js';

interface CliOptions {
  dataDir?: string;
  backupDir?: string;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run session:repair:integrity [-- --data-dir <path> --backup-dir <path>]');
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
      ?? join(dataDir, 'repair-backups', `integrity-${new Date().toISOString().replace(/[:.]/g, '-')}`),
  );
  const keyring = createSessionHmacBoundaryService({
    env: process.env,
    credentialVault: config.credentialVault,
  }).requireKeyring('Session HMAC keyring is required for integrity repair');

  const report = runSessionIntegrityRepair({
    sessionsDir: join(dataDir, 'sessions'),
    backupDir,
    keyring,
    repoRoot,
  });

  console.log(`Session integrity repair complete for ${dataDir}`);
  console.log(`Backups: ${report.backupsDir}`);
  console.log(
    `Journal files: scanned=${report.journal.scannedFiles} modified=${report.journal.modifiedFiles} entries=${report.journal.modifiedEntries}`,
  );
  console.log(`Session channel index rebuilt: ${report.rebuiltChannelIndex ? 'yes' : 'no'}`);
}

main().catch((error) => {
  console.error(`Session integrity repair failed: ${toErrorMessage(error)}`);
  process.exit(1);
});
