import '../../shared/utils/load-dotenv.js';
import {
  CONVERSATIONAL_ACTIVITY_PURPOSES,
  type ConversationalActivityPurpose,
  type QuarantinedConversationalActivityWorkItem,
} from '../../core/session/conversational-activity-workset.js';
import { PostgresConversationalActivityWorkset } from '../../persistence/sessions/postgres-conversational-activity-workset.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  openMaintenanceCompanionPool,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

/**
 * Operator view and recovery for memory-pipeline sessions quarantined after
 * exhausting their bounded retries (psfn-framework-d5e0p.3). A quarantine never
 * advances the session checkpoint, so releasing one simply makes the next
 * drain retry the session's unprocessed source with a fresh attempt budget.
 */
interface CliOptions {
  command?: 'list' | 'release';
  purpose: ConversationalActivityPurpose;
  sessionIds: string[];
  apply: boolean;
  showHelp: boolean;
}

export function printMemoryWorksetQuarantineUsage(): void {
  console.log('Usage: npm run memory:workset-quarantine -- list [--purpose <purpose>]');
  console.log('       npm run memory:workset-quarantine -- release --session <logical-session-id> ... '
    + '[--purpose <purpose>] [--apply]');
  console.log('');
  console.log('Lists or releases conversational-activity sessions quarantined after their memory');
  console.log('pipeline exhausted its bounded retries (default purpose: episodic_synthesis).');
  console.log('list prints each session\'s attempt count and recorded root cause. release clears the');
  console.log('quarantine so the next drain retries the session; it is a dry run unless --apply.');
  console.log('Fix the recorded root cause first, or the session will quarantine again.');
}

export function parseMemoryWorksetQuarantineArgs(argv: readonly string[]): CliOptions {
  const [command, ...rest] = argv;
  const options = parseCommonMaintenanceArgs<CliOptions>(rest, {
    initial: {
      purpose: 'episodic_synthesis',
      sessionIds: [],
      apply: false,
      showHelp: command === '--help' || command === '-h',
    },
    extraFlags: {
      '--purpose': ({ options: parsed, readValue }) => {
        const purpose = readValue();
        if (!(CONVERSATIONAL_ACTIVITY_PURPOSES as readonly string[]).includes(purpose)) {
          throw new Error(`--purpose must be one of ${CONVERSATIONAL_ACTIVITY_PURPOSES.join(', ')}`);
        }
        parsed.purpose = purpose as ConversationalActivityPurpose;
      },
      '--session': ({ options: parsed, readValue }) => { parsed.sessionIds.push(readValue()); },
      '--apply': ({ options: parsed }) => { parsed.apply = true; },
    },
  });
  if (options.showHelp) return options;
  if (command !== 'list' && command !== 'release') {
    throw new Error('The first argument must be list or release');
  }
  if (command === 'list' && (options.apply || options.sessionIds.length > 0)) {
    throw new Error('--session and --apply apply only to release');
  }
  if (command === 'release' && options.sessionIds.length === 0) {
    throw new Error('release requires at least one --session');
  }
  return { ...options, command };
}

function printQuarantined(items: readonly QuarantinedConversationalActivityWorkItem[]): void {
  console.log(`Quarantined sessions: ${items.length}`);
  for (const item of items) {
    console.log(
      `  ${item.logicalSessionId} revision=${item.quarantinedRevision} `
      + `checkpoint=${item.checkpointRevision} attempts=${item.failureCount ?? 0} `
      + `quarantinedAt=${new Date(item.quarantinedAtMs).toISOString()} `
      + `stage=${item.lastFailure?.stage ?? '-'} cause=${item.lastFailure?.message ?? '-'}`,
    );
  }
}

export function runMemoryWorksetQuarantineCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<unknown> {
  return runMaintenanceCli({
    argv,
    label: 'Memory workset quarantine',
    parseArgs: parseMemoryWorksetQuarantineArgs,
    printUsage: printMemoryWorksetQuarantineUsage,
    run: async options => {
      const runtime = await bootstrapMaintenanceRuntime();
      const pool = openMaintenanceCompanionPool(runtime.config, 'memory-workset-quarantine');
      try {
        const workset = new PostgresConversationalActivityWorkset(pool, async () => undefined);
        const quarantined = await workset.listQuarantined(options.purpose);
        if (options.command === 'list') {
          printQuarantined(quarantined);
          return quarantined;
        }
        const known = new Set(quarantined.map(item => item.logicalSessionId));
        const unknown = options.sessionIds.filter(sessionId => !known.has(sessionId));
        if (unknown.length > 0) {
          throw new Error(`Not quarantined for ${options.purpose}: ${unknown.join(', ')}`);
        }
        if (!options.apply) {
          console.log(`Would release ${options.sessionIds.length} session(s) (dry run; add --apply)`);
          return { applied: false, sessionIds: options.sessionIds };
        }
        for (const logicalSessionId of options.sessionIds) {
          const released = await workset.releaseQuarantine({ purpose: options.purpose, logicalSessionId });
          console.log(`  ${logicalSessionId}: ${released ? 'released' : 'no longer quarantined'}`);
        }
        return { applied: true, sessionIds: options.sessionIds };
      } finally {
        await pool.end();
      }
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runMemoryWorksetQuarantineCli();
}
