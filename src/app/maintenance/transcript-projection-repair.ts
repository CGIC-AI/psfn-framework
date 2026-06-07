import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSessionHmacBoundaryService } from '../../persistence/journals/hmac-boundary.js';
import { resolveSessionsDir } from '../../persistence/layout.js';
import { runTranscriptProjectionRepair, type TranscriptProjectionRepairReport } from '../../persistence/repair/transcript-projection-repair.js';
import {
  createDefaultPostgresSessionAdapters,
  type PostgresSessionAdapters,
} from '../../persistence/sessions/postgres-adapters.js';
import type { SessionIntegrityProvider } from '../../persistence/sessions/store-primitives.js';
import type { TranscriptProjectionPort } from '../../persistence/sessions/transcript-projection-port.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { loadConfig } from '../../system/config/load-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { hydrateSecretBearingConfig } from '../startup/support/bootstrap-helpers.js';
import { applyGatewayTlsConfig } from '../../boundary/gateway/tls.js';

interface CliOptions {
  dataDir?: string;
  sessionsDir?: string;
  showHelp: boolean;
}

interface TranscriptProjectionRepairCommandDependencies {
  createPostgresSessionAdapters?: (
    databaseUrl: string,
    options: { sessionsDir: string },
  ) => Promise<PostgresSessionAdapters>;
  resolveIntegrityProvider?: (config: SubstrateConfig) => SessionIntegrityProvider | null;
}

export interface TranscriptProjectionRepairCommandOptions {
  config: SubstrateConfig;
  dataDir?: string;
  sessionsDir?: string;
  dependencies?: TranscriptProjectionRepairCommandDependencies;
}

export interface TranscriptProjectionRepairCommandReport extends TranscriptProjectionRepairReport {
  dataDir: string;
  persistenceBackend: SubstrateConfig['persistenceBackend'] | 'sqlite';
  sessionsDir: string;
}

interface TranscriptProjectionRepairTarget {
  dataDir: string;
  persistenceBackend: SubstrateConfig['persistenceBackend'] | 'sqlite';
  sessionsDir: string;
  transcriptProjection: TranscriptProjectionPort;
  integrityProvider: SessionIntegrityProvider | null;
}

function printUsage(): void {
  console.log('Usage: npm run session:repair:transcript-projection [-- --data-dir <path> --sessions-dir <path>]');
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
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      options.dataDir = value;
      index += 1;
      continue;
    }
    if (arg === '--sessions-dir') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${arg}`);
      }
      options.sessionsDir = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function resolveIntegrityProvider(config: SubstrateConfig, dependencies?: TranscriptProjectionRepairCommandDependencies): SessionIntegrityProvider | null {
  if (dependencies?.resolveIntegrityProvider) {
    return dependencies.resolveIntegrityProvider(config);
  }

  return createSessionHmacBoundaryService({
    env: process.env,
    credentialVault: config.credentialVault,
  }).resolveIntegrityProvider();
}

async function resolveTranscriptProjectionRepairTarget(
  options: TranscriptProjectionRepairCommandOptions,
): Promise<TranscriptProjectionRepairTarget> {
  const dataDir = resolve(options.dataDir ?? options.config.dataDir);
  const sessionsDir = resolve(options.sessionsDir ?? resolveSessionsDir(dataDir));
  const databaseUrl = options.config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('PostgreSQL transcript projection repair requires config.postgresDatabaseUrl');
  }
  const createPostgresSessionAdapters = options.dependencies?.createPostgresSessionAdapters
    ?? createDefaultPostgresSessionAdapters;
  const adapters = await createPostgresSessionAdapters(databaseUrl, { sessionsDir });
  const transcriptProjection: TranscriptProjectionPort = adapters.transcriptProjection;

  return {
    dataDir,
    persistenceBackend: 'postgres',
    sessionsDir,
    transcriptProjection,
    integrityProvider: resolveIntegrityProvider(options.config, options.dependencies),
  };
}

export async function runTranscriptProjectionRepairCommand(
  options: TranscriptProjectionRepairCommandOptions,
): Promise<TranscriptProjectionRepairCommandReport> {
  const target = await resolveTranscriptProjectionRepairTarget(options);
  const report = runTranscriptProjectionRepair({
    sessionsDir: target.sessionsDir,
    transcriptProjection: target.transcriptProjection,
    integrityProvider: target.integrityProvider,
  });
  await target.transcriptProjection.flushPendingWrites?.();

  return {
    ...report,
    driftAfter: target.transcriptProjection.listProjectionDrift().length,
    dataDir: target.dataDir,
    persistenceBackend: target.persistenceBackend,
    sessionsDir: target.sessionsDir,
  };
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
  const report = await runTranscriptProjectionRepairCommand({
    config,
    dataDir: options.dataDir,
    sessionsDir: options.sessionsDir,
  });

  console.log(`Transcript projection repair complete for ${report.dataDir}`);
  console.log(`Backend: ${report.persistenceBackend}`);
  console.log(`Sessions dir: ${report.sessionsDir}`);
  console.log(
    `Scanned ${report.scannedFiles} JSONL files; rebuilt=${report.rebuiltChannels} clearedMissing=${report.clearedMissingChannels}`,
  );
  console.log(`Projection drift: before=${report.driftBefore} after=${report.driftAfter}`);

  if (report.failures.length > 0) {
    console.log('');
    for (const failure of report.failures) {
      console.log(`- ${failure.filePath}`);
      console.log(`  channel=${failure.channelId}`);
      console.log(`  error=${failure.error}`);
    }
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(`Transcript projection repair failed: ${toErrorMessage(error)}`);
    process.exit(1);
  });
}
