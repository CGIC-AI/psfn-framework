#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
} from '../../persistence/postgres.js';
import {
  POSTGRES_CONTACT_MIGRATIONS,
  POSTGRES_MEMORY_MIGRATIONS,
} from '../../persistence/postgres/migrations.js';
import {
  normalizeMemorySubjectContactMappings,
  reattributePostgresMemorySubjects,
  type MemorySubjectContactMapping,
  type MemorySubjectReattributionReport,
} from '../../persistence/repair/memory-subject-reattribution.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

interface CliOptions {
  apply: boolean;
  json: boolean;
  mappings: MemorySubjectContactMapping[];
  showHelp: boolean;
  embeddingDims?: number;
  postgresUrl?: string;
  role?: string;
  schema?: string;
}

function printUsage(): void {
  console.log('Usage: npm run memory:repair:subject-attribution -- --map <old-id>=<current-id> [OPTIONS]');
  console.log('');
  console.log('Re-attributes historical memory/episode contact IDs, then resets and drains');
  console.log('the subject-classification checkpoint. Dry-run is the default.');
  console.log('');
  console.log('Options:');
  console.log('  --map <old>=<current>     Contact-ID mapping; repeat for multiple old IDs.');
  console.log('  --apply                   Apply updates and re-run all subject classifications.');
  console.log('  --postgres-url <url>      Override configured PostgreSQL URL.');
  console.log('  --schema <schema>         Override the configured companion schema.');
  console.log('  --role <role>             Override the configured companion database role.');
  console.log('  --embedding-dims <n>      Override configured embedding dimensions.');
  console.log('  --json                    Emit the full report as JSON.');
  console.log('  -h, --help                Show this help message.');
}

export function parseContactMapping(value: string): MemorySubjectContactMapping {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1 || value.indexOf('=', separator + 1) !== -1) {
    throw new Error('--map must use <old-contact-id>=<current-contact-id>');
  }
  return {
    fromContactId: value.slice(0, separator),
    toContactId: value.slice(separator + 1),
  };
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: {
      apply: false,
      json: false,
      mappings: [],
      showHelp: false,
    },
    extraFlags: {
      '--apply': ({ options }) => {
        options.apply = true;
      },
      '--json': ({ options }) => {
        options.json = true;
      },
      '--map': ({ options, readValue }) => {
        options.mappings.push(parseContactMapping(readValue()));
      },
      '--postgres-url': ({ options, readValue }) => {
        options.postgresUrl = readValue();
      },
      '--schema': ({ options, readValue }) => {
        options.schema = readValue();
      },
      '--role': ({ options, readValue }) => {
        options.role = readValue();
      },
      '--embedding-dims': ({ arg, options, readValue }) => {
        options.embeddingDims = parsePositiveInteger(readValue(), arg);
      },
    },
  });
}

function printReport(report: MemorySubjectReattributionReport, schema: string | undefined): void {
  console.log(`Mode: ${report.dryRun ? 'dry-run' : 'apply'}`);
  console.log(`Schema: ${schema ?? 'public'}`);
  console.log(`Mappings: ${report.mappings.length}`);
  console.log(`Memory updates: planned=${report.plannedMemoryUpdates} applied=${report.updatedMemories}`);
  console.log(`Episode updates: planned=${report.plannedEpisodeUpdates} applied=${report.updatedEpisodes}`);
  if (report.backfill) {
    console.log(
      `Subject reclassification: state=${report.backfill.state} `
      + `processed=${report.backfill.totalProcessedCount} `
      + `classifierVersion=${report.backfill.classifierVersion}`,
    );
  } else {
    console.log('Subject reclassification: not run (dry-run)');
  }
}

async function run(options: CliOptions): Promise<void> {
  const mappings = normalizeMemorySubjectContactMappings(options.mappings);
  const { config } = await bootstrapMaintenanceRuntime({ hydrateSecrets: false });
  const postgresUrl = options.postgresUrl?.trim() || config.postgresDatabaseUrl?.trim();
  if (!postgresUrl) {
    throw new Error('Memory subject re-attribution requires --postgres-url or config.postgresDatabaseUrl');
  }
  const schema = options.schema?.trim() || config.postgresSchema?.trim() || undefined;
  const role = options.role?.trim() || config.postgresRole?.trim() || undefined;
  const embeddingDims = options.embeddingDims ?? config.embeddingDims ?? 1024;
  const pool = createPostgresPool(postgresUrl, {
    applicationName: 'psfn-memory-subject-reattribution',
    allowExitOnIdle: true,
    schema,
    role,
  });
  try {
    await ensurePostgresSchema(pool, [
      ...POSTGRES_CONTACT_MIGRATIONS,
      ...POSTGRES_MEMORY_MIGRATIONS,
    ]);
    const report = await reattributePostgresMemorySubjects(pool, {
      mappings,
      dryRun: !options.apply,
      embeddingDims,
    });
    if (options.json) {
      console.log(JSON.stringify({ ...report, schema: schema ?? 'public' }, null, 2));
      return;
    }
    printReport(report, schema);
  } finally {
    await pool.end();
  }
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runMaintenanceCli({
    label: 'Memory subject re-attribution',
    parseArgs,
    printUsage,
    run,
  });
}
