#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import { createPostgresPool, ensurePostgresSchema } from '../../persistence/postgres.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import {
  recomputePostgresEpisodeThreads,
  type EpisodeThreadRecomputeReport,
} from '../../persistence/repair/episode-thread-recompute.js';
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
  maxThreadEpisodes?: number;
  postgresUrl?: string;
  role?: string;
  schema?: string;
}

function printUsage(): void {
  console.log('Usage: npm run memory:repair:episode-threads -- --max-thread-episodes <n> [OPTIONS]');
  console.log('');
  console.log('Recomputes episodic topic threads for one companion schema (d5e0p.1): every live');
  console.log('episode starts alone and only thread-forming arcs (continuation, causal,');
  console.log('resolution, contrast, operator-defined) join threads, in arc creation order,');
  console.log('never past the cap. same_theme/recurrence arcs are kept but no longer merge');
  console.log('threads. Pre-apq0 session-keyed threads are left to h4fp.7. Arcs are not');
  console.log('modified. Dry-run is the default; run --apply while episodic lanes are idle.');
  console.log('');
  console.log('Options:');
  console.log('  --max-thread-episodes <n>  Topic-thread cap (the runtime default is 500).');
  console.log('  --apply                    Write the recomputed thread ids in one transaction.');
  console.log('  --postgres-url <url>       Override configured PostgreSQL URL.');
  console.log('  --schema <schema>          Override the configured companion schema.');
  console.log('  --role <role>              Override the configured companion database role.');
  console.log('  --json                     Emit the report as JSON.');
  console.log('  -h, --help                 Show this help message.');
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
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
      '--max-thread-episodes': ({ arg, options, readValue }) => {
        options.maxThreadEpisodes = parsePositiveInteger(readValue(), arg);
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
    },
  });
}

function printReport(report: EpisodeThreadRecomputeReport, schema: string): void {
  console.log(`Mode: ${report.dryRun ? 'dry-run' : 'apply'}`);
  console.log(`Schema: ${schema}`);
  console.log(`Cap: ${report.maxThreadEpisodes}`);
  console.log(
    `Live episodes: ${report.liveEpisodeCount} `
    + `(legacy session-keyed, untouched: ${report.legacySessionThreadEpisodeCount})`,
  );
  console.log(`Thread-forming arcs: ${report.threadFormingArcCount} (refused by cap: ${report.refusedArcCount})`);
  console.log(`Before: threads=${report.before.threadCount} largest=${report.before.largestThreadSize}`);
  console.log(`After:  threads=${report.after.threadCount} largest=${report.after.largestThreadSize}`);
  console.log(`Episode updates: planned=${report.plannedEpisodeUpdates} applied=${report.updatedEpisodes}`);
}

async function run(options: CliOptions): Promise<void> {
  if (options.maxThreadEpisodes === undefined) {
    throw new Error('Episode thread recompute requires --max-thread-episodes');
  }
  const { config } = await bootstrapMaintenanceRuntime({ hydrateSecrets: false });
  const postgresUrl = options.postgresUrl?.trim() || config.postgresDatabaseUrl?.trim();
  if (!postgresUrl) {
    throw new Error('Episode thread recompute requires --postgres-url or config.postgresDatabaseUrl');
  }
  const schema = options.schema?.trim() || config.postgresSchema?.trim() || undefined;
  const role = options.role?.trim() || config.postgresRole?.trim() || undefined;
  const pool = createPostgresPool(postgresUrl, {
    applicationName: 'psfn-episode-thread-recompute',
    allowExitOnIdle: true,
    schema,
    role,
  });
  try {
    await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
    const report = await recomputePostgresEpisodeThreads(pool, {
      dryRun: !options.apply,
      maxThreadEpisodes: options.maxThreadEpisodes,
    });
    if (options.json) {
      console.log(JSON.stringify({ ...report, schema: schema ?? 'public' }, null, 2));
      return;
    }
    printReport(report, schema ?? 'public');
  } finally {
    await pool.end();
  }
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runMaintenanceCli({
    label: 'Episode thread recompute',
    parseArgs,
    printUsage,
    run,
  });
}
