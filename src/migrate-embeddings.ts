#!/usr/bin/env tsx
// ── Memory Embedding Migration CLI ──
// Re-embeds all L2 memories using the currently configured embedding provider.
// Run after switching embedding models to restore retrieval quality.
//
// Usage: npm run migrate:embeddings [-- --batch-size 64 --parallelism 4]

import 'dotenv/config';
import { initDatabase } from './persistence/sqlite-utils.js';
import * as sqliteVec from 'sqlite-vec';
import { createEmbeddingProviderFromEnv } from './memory/embedding.js';
import { migrateMemoryEmbeddings } from './memory/migration.js';
import type { ReembedMigrationProgress } from './memory/migration.js';
import { loadConfig } from './types.js';
import { toErrorMessage } from './shared/utils/errors.js';

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

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { includeDeleted: false, showHelp: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.showHelp = true;
      continue;
    }
    if (arg === '--batch-size') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value for --batch-size');
      options.batchSize = Number.parseInt(value, 10);
      if (!Number.isFinite(options.batchSize) || options.batchSize <= 0) {
        throw new Error('--batch-size must be a positive integer');
      }
      i++;
      continue;
    }
    if (arg === '--parallelism') {
      const value = argv[i + 1];
      if (!value) throw new Error('Missing value for --parallelism');
      options.parallelism = Number.parseInt(value, 10);
      if (!Number.isFinite(options.parallelism) || options.parallelism <= 0) {
        throw new Error('--parallelism must be a positive integer');
      }
      i++;
      continue;
    }
    if (arg === '--include-deleted') {
      options.includeDeleted = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function formatProgress(progress: ReembedMigrationProgress): string {
  const pct = progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0;
  return `  [${pct}%] batch ${progress.batchIndex}/${progress.batchCount} — ${progress.processed}/${progress.total} processed, ${progress.updated} updated, ${progress.failed} failed`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) {
    printUsage();
    return;
  }

  const config = loadConfig();
  const db = initDatabase(config.databasePath);
  sqliteVec.load(db);

  try {
    console.log(`Database: ${config.databasePath}`);

    const embeddingProvider = createEmbeddingProviderFromEnv();
    console.log(`Embedding provider: ${embeddingProvider.kind} (dims=${embeddingProvider.dims})`);
    console.log('');

    const result = await migrateMemoryEmbeddings(db, embeddingProvider, {
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
  } finally {
    db.close();
  }
}

main().catch((error) => {
  const message = toErrorMessage(error);
  console.error(`Embedding migration failed: ${message}`);
  process.exit(1);
});
