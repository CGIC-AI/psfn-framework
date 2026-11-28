#!/usr/bin/env tsx

// CLI for the missing-embedding backfill (psfn-framework-d5e0p.23). Embeds
// active L2 memories whose embedding is NULL with the configured provider, so
// semantic recall can find them again. Dry-run is the default; live data
// surgery follows the live-ops rules (backup first, operator sign-off).
// Unlike `migrate:embeddings`, it never rewrites a row that has an embedding.

import '../../shared/utils/load-dotenv.js';
import {
  migratePostgresMemoryEmbeddings,
  type EmbeddingMigrationResult,
} from '../../faculties/memory/migration.js';
import { createProviderRuntimeServices } from '../../system/config/provider-runtime-factory.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

interface CliOptions {
  apply: boolean;
  json: boolean;
  showHelp: boolean;
  limit?: number;
  afterId?: string;
  schema?: string;
  postgresUrl?: string;
  batchSize?: number;
}

function printUsage(): void {
  console.log('Usage: npm run memory:repair:embeddings -- [OPTIONS]');
  console.log('');
  console.log('Embeds active L2 memories whose embedding is NULL with the configured provider.');
  console.log('Dry-run is the default. Pass --apply to embed and store the selected rows.');
  console.log('');
  console.log('Options:');
  console.log('  --apply                  Embed and store the selected rows. Without this, only report.');
  console.log('  --limit <n>              Select at most n rows (in id order).');
  console.log('  --after-id <id>          Continue after this memory id (see nextAfterId).');
  console.log('  --schema <schema>        Override the configured companion schema.');
  console.log('  --postgres-url <url>     Override configured PostgreSQL URL.');
  console.log('  --batch-size <n>         Rows per embedding call.');
  console.log('  --json                   Emit the full report as JSON.');
  console.log('  -h, --help               Show this help message.');
}

function parsePositiveInteger(value: string, arg: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${arg} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { apply: false, json: false, showHelp: false },
    extraFlags: {
      '--apply': ({ options }) => {
        options.apply = true;
      },
      '--json': ({ options }) => {
        options.json = true;
      },
      '--limit': ({ arg, options, readValue }) => {
        options.limit = parsePositiveInteger(readValue(), arg);
      },
      '--after-id': ({ options, readValue }) => {
        options.afterId = readValue();
      },
      '--schema': ({ options, readValue }) => {
        options.schema = readValue();
      },
      '--postgres-url': ({ options, readValue }) => {
        options.postgresUrl = readValue();
      },
      '--batch-size': ({ arg, options, readValue }) => {
        options.batchSize = parsePositiveInteger(readValue(), arg);
      },
    },
  });
}

function printReport(report: EmbeddingMigrationResult, schema: string | undefined): void {
  console.log(`Mode: ${report.dryRun ? 'dry-run' : 'apply'}`);
  console.log(`Schema: ${schema ?? 'public'}`);
  console.log(`Active memories: ${report.coverageBefore.activeMemoryCount}`);
  console.log(`Active memories missing an embedding: ${report.coverageBefore.activeMissingEmbeddingCount}`);
  console.log(`Selected: ${report.total}`);
  if (!report.dryRun) {
    console.log(`Updated: ${report.updated}`);
    console.log(`Already embedded by another writer: ${report.alreadyEmbedded}`);
    console.log(`Failed: ${report.failed}`);
    console.log(`Missing after run: ${report.coverageAfter.activeMissingEmbeddingCount}`);
  }
  if (report.nextAfterId) {
    console.log(`More rows remain; continue with --after-id ${report.nextAfterId}`);
  }
  for (const failure of report.failures.slice(0, 20)) {
    console.log(`  failed ${failure.memoryId}: ${failure.error}`);
  }
  if (report.failures.length > 20) {
    console.log(`  ... and ${report.failures.length - 20} more failures`);
  }
}

async function run(options: CliOptions): Promise<EmbeddingMigrationResult> {
  const { config } = await bootstrapMaintenanceRuntime({ hydrateOwnerFiles: true });
  const postgresUrl = options.postgresUrl?.trim() || config.postgresDatabaseUrl?.trim();
  if (!postgresUrl) {
    throw new Error('Missing-embedding backfill requires --postgres-url or config.postgresDatabaseUrl');
  }
  const schema = options.schema?.trim() || config.postgresSchema?.trim() || undefined;
  const { embeddingProvider } = createProviderRuntimeServices({ config });

  const report = await migratePostgresMemoryEmbeddings(postgresUrl, embeddingProvider, {
    missingOnly: true,
    dryRun: !options.apply,
    ...(schema ? { schema } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.afterId ? { afterId: options.afterId } : {}),
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
  });
  if (options.json) {
    console.log(JSON.stringify({ ...report, schema: schema ?? 'public', provider: embeddingProvider.kind }, null, 2));
  } else {
    console.log(`Embedding provider: ${embeddingProvider.kind} (dims=${embeddingProvider.dims})`);
    printReport(report, schema);
  }
  if (report.failed > 0) process.exitCode = 1;
  return report;
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runMaintenanceCli({
    label: 'Missing-embedding backfill',
    parseArgs,
    printUsage,
    run,
  });
}
