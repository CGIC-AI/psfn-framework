#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
} from '../../persistence/postgres.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import {
  repairPostgresMemoryParticipantNames,
  type MemoryParticipantNameRepairReport,
} from '../../persistence/repair/memory-participant-name-repair.js';
import { resolveCompanionNameFromConfig } from '../../core/identity/companion-runtime.js';
import { loadConfig } from '../../system/config/load-config.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { hydrateSecretBearingConfig } from '../startup/support/bootstrap-helpers.js';
import { applyGatewayTlsConfig } from '../../boundary/gateway/tls.js';

type RepairBackend = 'postgres';

interface CliOptions {
  apply: boolean;
  includeArchived: boolean;
  json: boolean;
  showHelp: boolean;
  backend?: RepairBackend;
  postgresUrl?: string;
  userName?: string;
  companionName?: string;
  limit?: number;
}

function printUsage(): void {
  console.log('Usage: npm run memory:repair:participant-names [-- OPTIONS]');
  console.log('');
  console.log('Backfills generic L2 memory participant labels to resolved names.');
  console.log('Dry-run is the default. Pass --apply to update l2_memories and record patch events.');
  console.log('');
  console.log('Options:');
  console.log('  --apply                  Update matching memories. Without this, only report planned changes.');
  console.log('  --backend <postgres>');
  console.log('                           Override configured persistence backend.');
  console.log('  --postgres-url <url>     Override configured PostgreSQL URL.');
  console.log('  --user-name <name>       Resolved human participant name.');
  console.log('  --companion-name <name>  Resolved companion participant name.');
  console.log('  --limit <n>              Max SQL-prefiltered candidate memories to scan (default: 500).');
  console.log('  --include-archived       Include superseded or soft-deleted memories.');
  console.log('  --json                   Emit the full repair report as JSON.');
  console.log('  -h, --help               Show this help message.');
}

function requireNext(argv: string[], index: number, arg: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`Missing value for ${arg}`);
  return value;
}

function parseLimit(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('--limit must be a positive integer');
  }
  return parsed;
}

function parseBackend(value: string): RepairBackend {
  if (value === 'postgres') return value;
  throw new Error('--backend must be postgres');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    includeArchived: false,
    json: false,
    showHelp: false,
  };

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
    if (arg === '--include-archived') {
      options.includeArchived = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--backend') {
      options.backend = parseBackend(requireNext(argv, i, arg));
      i += 1;
      continue;
    }
    if (arg === '--postgres-url') {
      options.postgresUrl = requireNext(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--user-name') {
      options.userName = requireNext(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--companion-name') {
      options.companionName = requireNext(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--limit') {
      options.limit = parseLimit(requireNext(argv, i, arg));
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function resolveConfiguredCompanionName(
  config: Parameters<typeof resolveCompanionNameFromConfig>[0],
): string | undefined {
  try {
    return resolveCompanionNameFromConfig(config);
  } catch {
    return undefined;
  }
}

function printReport(report: MemoryParticipantNameRepairReport): void {
  console.log(`Mode: ${report.dryRun ? 'dry-run' : 'apply'}`);
  console.log(`Backend source: ${report.sourceType} (${report.sourceRef})`);
  console.log(`Names: user=${report.names.userName ?? '<unresolved>'}, companion=${report.names.companionName ?? '<unresolved>'}`);
  console.log(`Limit: ${report.limit}`);
  console.log(`Include archived: ${String(report.includeArchived)}`);
  console.log('');
  console.log(`Scanned SQL candidates: ${report.scanned}`);
  console.log(`Confirmed placeholders: ${report.candidates}`);
  console.log(`Planned updates: ${report.plannedUpdates}`);
  console.log(`Updated: ${report.updated}`);
  console.log(`Unchanged after normalization: ${report.unchanged}`);
  console.log(`Refused: ${report.refused.length}`);

  const refusalEntries = Object.entries(report.refusalCounts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  if (refusalEntries.length > 0) {
    console.log('');
    console.log('Refusal counts:');
    for (const [reason, count] of refusalEntries) {
      console.log(`  ${reason}: ${count}`);
    }
  }

  if (report.updates.length > 0) {
    console.log('');
    console.log('Planned memory ids:');
    for (const update of report.updates.slice(0, 20)) {
      console.log(`  ${update.memoryId}`);
    }
    if (report.updates.length > 20) {
      console.log(`  ... and ${report.updates.length - 20} more`);
    }
  }
}

async function runPostgresRepair(options: CliOptions, reportOptions: {
  postgresUrl: string;
  userName?: string;
  companionName?: string;
}): Promise<MemoryParticipantNameRepairReport> {
  const postgresUrl = reportOptions.postgresUrl.trim();
  if (!postgresUrl) {
    throw new Error('PostgreSQL participant-name repair requires --postgres-url or config.postgresDatabaseUrl');
  }
  const pool = createPostgresPool(postgresUrl);
  try {
    await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
    return await repairPostgresMemoryParticipantNames(pool, {
      canonicalContactName: reportOptions.userName,
      companionName: reportOptions.companionName,
      dryRun: !options.apply,
      includeArchived: options.includeArchived,
      limit: options.limit,
    });
  } finally {
    await pool.end();
  }
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

  const companionName = options.companionName ?? resolveConfiguredCompanionName(config);
  const userName = options.userName;

  const report = await runPostgresRepair(options, {
    postgresUrl: options.postgresUrl ?? config.postgresDatabaseUrl ?? '',
    userName,
    companionName,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printReport(report);
}

main().catch((error) => {
  const message = toErrorMessage(error);
  console.error(`Memory participant-name repair failed: ${message}`);
  process.exit(1);
});
