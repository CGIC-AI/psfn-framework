import '../../shared/utils/load-dotenv.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import {
  BACKGROUND_WORK_STATES,
  type BackgroundWorkState,
} from '../../core/agent/background-work/types.js';
import { createPostgresPool } from '../../persistence/postgres.js';
import {
  listBackgroundWorkJobs,
  retireBackgroundWorkJobs,
  type BackgroundWorkJobSummary,
} from '../../persistence/postgres/background-work-operator.js';
import { resolveConfigTenantPoolScope } from '../../persistence/postgres/tenant-pool-scope.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

interface CliOptions {
  command?: 'list' | 'retire';
  states: BackgroundWorkState[];
  jobIds: string[];
  channelPrefix?: string;
  limit: number;
  apply: boolean;
  showHelp: boolean;
}

/** Rows one invocation may read or retire; a narrower selector is the answer to more. */
const BACKGROUND_WORK_JOBS_CLI_DEFAULT_LIMIT = 200;

export function printBackgroundWorkJobsUsage(): void {
  console.log('Usage: npm run background-work:jobs -- list [--state <state> ...] '
    + '[--job <job-id> ... | --channel-prefix <prefix>] [--limit <n>]');
  console.log('       npm run background-work:jobs -- retire '
    + '(--job <job-id> ... | --channel-prefix <prefix>) [--limit <n>] [--apply]');
  console.log('');
  console.log('Inspects or retires the companion\'s durable post-turn jobs '
    + '(agent_background_work_jobs). retire marks the selected non-terminal jobs');
  console.log('stale_discarded (keeping the reason it got stuck on), skips any job whose lease is');
  console.log('still live, writes an audit file under <data-dir>/repair-backups, and is a');
  console.log('dry run unless --apply is given. Stop the agent first for a running job.');
}

export function parseBackgroundWorkJobsArgs(argv: readonly string[]): CliOptions {
  const [command, ...rest] = argv;
  const options = parseCommonMaintenanceArgs<CliOptions>(rest, {
    initial: {
      states: [],
      jobIds: [],
      limit: BACKGROUND_WORK_JOBS_CLI_DEFAULT_LIMIT,
      apply: false,
      showHelp: command === '--help' || command === '-h',
    },
    extraFlags: {
      '--state': ({ options: parsed, readValue }) => {
        const state = readValue();
        if (!(BACKGROUND_WORK_STATES as readonly string[]).includes(state)) {
          throw new Error(`--state must be one of ${BACKGROUND_WORK_STATES.join(', ')}`);
        }
        parsed.states.push(state as BackgroundWorkState);
      },
      '--job': ({ options: parsed, readValue }) => { parsed.jobIds.push(readValue()); },
      '--channel-prefix': ({ options: parsed, readValue }) => { parsed.channelPrefix = readValue(); },
      '--limit': ({ options: parsed, readValue }) => {
        const limit = Number(readValue());
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
        parsed.limit = limit;
      },
      '--apply': ({ options: parsed }) => { parsed.apply = true; },
    },
  });
  if (options.showHelp) return options;
  if (command !== 'list' && command !== 'retire') {
    throw new Error('The first argument must be list or retire');
  }
  if (command === 'list' && options.apply) throw new Error('--apply applies only to retire');
  return { ...options, command };
}

function openCompanionPool(config: SubstrateConfig): Pool {
  const databaseUrl = config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('Background work maintenance requires POSTGRES_DATABASE_URL');
  }
  const tenant = resolveConfigTenantPoolScope(config);
  const schema = tenant?.schema ?? (config.postgresSchema?.trim() || undefined);
  return createPostgresPool(databaseUrl, {
    applicationName: 'psfn-background-work-maintenance',
    allowExitOnIdle: true,
    max: 1,
    ...(schema ? { schema } : {}),
    ...(tenant ? { role: tenant.role } : {}),
  });
}

function printJobs(label: string, jobs: readonly BackgroundWorkJobSummary[]): void {
  console.log(`${label}: ${jobs.length}`);
  for (const job of jobs) {
    console.log(
      `  ${job.jobId} kind=${job.kind} state=${job.state} reason=${job.reasonCode} `
      + `attempts=${job.attemptCount}/${job.maxAttempts} leaseExpiries=${job.leaseExpiryCount} `
      + `leaseOwner=${job.leaseOwner ?? '-'} channel=${job.sourceChannelId} turn=${job.sourceTurnId}`,
    );
  }
}

export function runBackgroundWorkJobsCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<unknown> {
  return runMaintenanceCli({
    argv,
    label: 'Background work jobs',
    parseArgs: parseBackgroundWorkJobsArgs,
    printUsage: printBackgroundWorkJobsUsage,
    run: async options => {
      const runtime = await bootstrapMaintenanceRuntime(options.command === 'retire' && options.apply
        ? { backupLabel: 'background-work-retirement' }
        : {});
      const pool = openCompanionPool(runtime.config);
      try {
        if (options.command === 'list') {
          const jobs = await listBackgroundWorkJobs(pool, {
            ...(options.states.length > 0 ? { states: options.states } : {}),
            ...(options.jobIds.length > 0 ? { jobIds: options.jobIds } : {}),
            ...(options.channelPrefix !== undefined ? { channelPrefix: options.channelPrefix } : {}),
            limit: options.limit,
          });
          printJobs('Jobs', jobs);
          return jobs;
        }
        const nowMs = Date.now();
        const result = await retireBackgroundWorkJobs(pool, {
          ...(options.jobIds.length > 0 ? { jobIds: options.jobIds } : {}),
          ...(options.channelPrefix !== undefined ? { channelPrefix: options.channelPrefix } : {}),
          limit: options.limit,
          nowMs,
          apply: options.apply,
        });
        printJobs(result.applied ? 'Retired' : 'Would retire (dry run; add --apply)', result.retired);
        printJobs('Skipped (lease still live; stop the agent first)', result.skippedLiveLease);
        if (result.applied && runtime.backupDir) {
          mkdirSync(runtime.backupDir, { recursive: true });
          const auditPath = join(runtime.backupDir, 'background-work-retirement.json');
          writeFileSync(auditPath, `${JSON.stringify({
            schemaVersion: 1,
            retiredAtMs: nowMs,
            selector: options.jobIds.length > 0
              ? { jobIds: options.jobIds }
              : { channelPrefix: options.channelPrefix },
            retired: result.retired,
            skippedLiveLease: result.skippedLiveLease,
          }, null, 2)}\n`, { mode: 0o600 });
          console.log(`Audit: ${auditPath}`);
        }
        return result;
      } finally {
        await pool.end();
      }
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runBackgroundWorkJobsCli();
}
