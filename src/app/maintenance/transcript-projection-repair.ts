import '../../shared/utils/load-dotenv.js';
import { resolve } from 'node:path';
import { createSessionHmacBoundaryService } from '../../persistence/journals/hmac-boundary.js';
import { resolveSessionsDir } from '../../persistence/layout.js';
import { runTranscriptProjectionRepair, type TranscriptProjectionRepairReport } from '../../persistence/repair/transcript-projection-repair.js';
import {
  createDefaultPostgresSessionAdapters,
  type PostgresSessionAdapters,
} from '../../persistence/sessions/postgres-adapters.js';
import type { SessionIntegrityProvider } from '../../persistence/sessions/store-primitives.js';
import type { TranscriptProjectionPort } from '../../persistence/sessions/transcript-projection-port.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

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
  persistenceBackend: SubstrateConfig['persistenceBackend'];
  sessionsDir: string;
}

interface TranscriptProjectionRepairTarget {
  dataDir: string;
  persistenceBackend: SubstrateConfig['persistenceBackend'];
  sessionsDir: string;
  transcriptProjection: TranscriptProjectionPort;
  integrityProvider: SessionIntegrityProvider | null;
}

function printUsage(): void {
  console.log('Usage: npm run session:repair:transcript-projection [-- --data-dir <path> --sessions-dir <path>]');
}

function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { showHelp: false },
    commonFlags: { dataDir: {} },
    extraFlags: {
      '--sessions-dir': ({ options, readValue }) => {
        options.sessionsDir = readValue();
      },
    },
  });
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

function runCli(): Promise<unknown> {
  return runMaintenanceCli({
    label: 'Transcript projection repair',
    parseArgs,
    printUsage,
    run: async options => {
      const runtime = await bootstrapMaintenanceRuntime({ dataDir: options.dataDir });
      const report = await runTranscriptProjectionRepairCommand({
        config: runtime.config,
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
      return report;
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runCli();
}
