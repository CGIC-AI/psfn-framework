#!/usr/bin/env tsx
// ── Memory Embedding Migration CLI ──
// Re-embeds all L2 memories using the currently configured embedding provider.
// Run after switching embedding models to restore retrieval quality.
//
// Usage: npm run migrate:embeddings [-- --batch-size 64 --parallelism 4]

import '../../shared/utils/load-dotenv.js';
import { migratePostgresMemoryEmbeddings } from '../../faculties/memory/migration.js';
import type { ReembedMigrationProgress } from '../../faculties/memory/migration.js';
import { createProviderRuntimeServices } from '../../system/config/provider-runtime-factory.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

interface CliOptions {
  batchSize?: number;
  parallelism?: number;
  includeDeleted: boolean;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run migrate:embeddings [-- OPTIONS]');
  console.log('');
  console.log('Re-embeds all L2 memories with the configured embedding provider.');
  console.log('');
  console.log('Options:');
  console.log('  --batch-size <n>     Batch size for embedding calls (default: 64)');
  console.log('  --parallelism <n>    Max concurrent embedding batches (default: 4)');
  console.log('  --include-deleted    Also re-embed soft-deleted memories');
  console.log('  -h, --help           Show this help message');
}

function parsePositiveInteger(value: string, arg: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${arg} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { includeDeleted: false, showHelp: false },
    extraFlags: {
      '--batch-size': ({ arg, options, readValue }) => {
        options.batchSize = parsePositiveInteger(readValue(), arg);
      },
      '--parallelism': ({ arg, options, readValue }) => {
        options.parallelism = parsePositiveInteger(readValue(), arg);
      },
      '--include-deleted': ({ options }) => {
        options.includeDeleted = true;
      },
    },
  });
}

function formatProgress(progress: ReembedMigrationProgress): string {
  const pct = progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0;
  return `  [${pct}%] batch ${progress.batchIndex}/${progress.batchCount} — ${progress.processed}/${progress.total} processed, ${progress.updated} updated, ${progress.failed} failed`;
}

function runCli(): Promise<unknown> {
  return runMaintenanceCli({
    label: 'Embedding migration',
    parseArgs,
    printUsage,
    run: async options => {
      const { config } = await bootstrapMaintenanceRuntime();
      if (config.persistenceBackend !== 'postgres') {
        throw new Error('Embedding migration requires config.persistenceBackend=postgres');
      }
      const databaseUrl = config.postgresDatabaseUrl?.trim();
      if (!databaseUrl) {
        throw new Error('Embedding migration requires config.postgresDatabaseUrl');
      }

      console.log(`Persistence backend: ${config.persistenceBackend}`);

      const { embeddingProvider } = createProviderRuntimeServices({ config });
      console.log(`Embedding provider: ${embeddingProvider.kind} (dims=${embeddingProvider.dims})`);
      console.log('');

      const result = await migratePostgresMemoryEmbeddings(databaseUrl, embeddingProvider, {
        batchSize: options.batchSize,
        parallelism: options.parallelism,
        includeDeleted: options.includeDeleted,
        onProgress: (progress) => {
          process.stdout.write(`\r${formatProgress(progress)}`);
        },
      });

      if (result.total > 0) {
        process.stdout.write('\n');
      }

      console.log('');
      console.log(`Migration complete in ${result.durationMs}ms`);
      console.log(`  Total:     ${result.total}`);
      console.log(`  Updated:   ${result.updated}`);
      console.log(`  Failed:    ${result.failed}`);

      if (result.failures.length > 0) {
        console.log('');
        console.log('Failures:');
        for (const failure of result.failures.slice(0, 20)) {
          console.log(`  ${failure.memoryId}: ${failure.error}`);
        }
        if (result.failures.length > 20) {
          console.log(`  ... and ${result.failures.length - 20} more`);
        }
        process.exitCode = 1;
      }
      return result;
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runCli();
}
