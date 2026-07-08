#!/usr/bin/env tsx

// CLI for the memory provenance backfill (psfn-framework-27ut). Reads a
// memories.jsonl journal and rebuilds empty l2_memories.provenance_json rows.
// Dry-run is the default; live data surgery follows the live-ops rules
// (agent scaled to 0, backup trio first, operator sign-off).

import '../../shared/utils/load-dotenv.js';
import { readFileSync } from 'node:fs';
import { createPostgresPool, ensurePostgresSchema } from '../../persistence/postgres.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import {
  backfillPostgresMemoryProvenance,
  type MemoryProvenanceBackfillReport,
} from '../../persistence/repair/memory-provenance-backfill.js';
import { loadConfig } from '../../system/config/load-config.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

interface CliOptions {
  apply: boolean;
  json: boolean;
  showHelp: boolean;
  journalPath?: string;
  postgresUrl?: string;
  roomMinMembers?: number;
}

function printUsage(): void {
  console.log('Usage: npm run memory:repair:provenance -- --journal <memories.jsonl> [OPTIONS]');
  console.log('');
  console.log('Backfills empty l2_memories.provenance_json/source_type from the memory journal.');
  console.log('Dry-run is the default. Pass --apply to update rows and record patch events.');
  console.log('');
  console.log('Options:');
  console.log('  --journal <path>         Path to the memories.jsonl journal (required).');
  console.log('  --apply                  Apply planned updates. Without this, only report.');
  console.log('  --postgres-url <url>     Override configured PostgreSQL URL.');
  console.log('  --room-min-members <n>   Members required to treat a channel as a room (default: 2).');
  console.log('  --json                   Emit the full report as JSON.');
  console.log('  -h, --help               Show this help message.');
}

function requireNext(argv: string[], index: number, arg: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`Missing value for ${arg}`);
  return value;
}

function parsePositiveInteger(value: string, arg: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${arg} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, json: false, showHelp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.showHelp = true;
      continue;
    }
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--journal') {
      options.journalPath = requireNext(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--postgres-url') {
      options.postgresUrl = requireNext(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--room-min-members') {
      options.roomMinMembers = parsePositiveInteger(requireNext(argv, i, arg), arg);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printReport(report: MemoryProvenanceBackfillReport): void {
  console.log(`Mode: ${report.dryRun ? 'dry-run' : 'apply'}`);
  console.log(`Journal insert events: ${report.journalInsertEvents} (${report.journalMemoriesWithProvenance} with provenance)`);
  if (report.malformedJournalLines > 0) {
    console.log(`Malformed trailing journal lines tolerated: ${report.malformedJournalLines}`);
  }
  console.log(`Scanned rows: ${report.scannedRows}`);
  console.log(`Rows with empty provenance: ${report.emptyProvenanceRows}`);
  console.log(`Planned updates: ${report.planned}`);
  console.log(`Updated: ${report.updated}`);
  console.log(`Skipped (no journal provenance): ${report.skippedNoJournalProvenance}`);
  console.log(`sourceContactId derived from routedContactId: ${report.sourceContactIdDerivedCount}`);
  console.log(`addressMode derived (multi-member room): ${report.addressModeDerivedCount}`);
  if (report.entries.length > 0) {
    console.log('');
    console.log('Planned updates (sample):');
    for (const entry of report.entries) {
      const flags = [
        entry.sourceContactIdDerived ? 'sourceContactId+' : '',
        entry.addressModeDerived ? 'addressMode+' : '',
      ].filter(Boolean).join(' ');
      console.log(`  ${entry.memoryId} channel=${entry.channelId ?? '<none>'} ${flags}`.trimEnd());
    }
    if (report.planned > report.entries.length) {
      console.log(`  ... and ${report.planned - report.entries.length} more`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) {
    printUsage();
    return;
  }
  if (!options.journalPath) {
    throw new Error('--journal <path> is required (see --help)');
  }

  const journalLines = readFileSync(options.journalPath, 'utf8').split('\n');

  let postgresUrl = options.postgresUrl?.trim();
  if (!postgresUrl) {
    const config = loadConfig();
    postgresUrl = config.postgresDatabaseUrl?.trim();
  }
  if (!postgresUrl) {
    throw new Error('Memory provenance backfill requires --postgres-url or config.postgresDatabaseUrl');
  }

  const pool = createPostgresPool(postgresUrl);
  try {
    await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
    const report = await backfillPostgresMemoryProvenance(pool, {
      journalLines,
      dryRun: !options.apply,
      ...(options.roomMinMembers !== undefined ? { roomMinMembers: options.roomMinMembers } : {}),
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printReport(report);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = toErrorMessage(error);
  console.error(`Memory provenance backfill failed: ${message}`);
  process.exit(1);
});
