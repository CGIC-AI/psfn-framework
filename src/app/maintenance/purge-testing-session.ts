import '../../shared/utils/load-dotenv.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { isTestingSessionId } from '../../core/session/session-id.js';
import { resolveSessionsDir } from '../../persistence/layout.js';
import { createDefaultPostgresSessionAdapters } from '../../persistence/sessions/postgres-adapters.js';
import {
  purgeTestingSession,
  type SessionProjectionPurgePort,
} from '../../persistence/sessions/testing-session-purge.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

interface CliOptions {
  dataDir?: string;
  sessionsDir?: string;
  sessionId?: string;
  forceNonTesting: boolean;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run session:purge -- --session <exact-id> [--data-dir <path>] [--sessions-dir <path>]');
  console.log('');
  console.log('Testing sessions must use <existing-channel-prefix>:testing:<name>.');
  console.log('Non-testing sessions require --force-non-testing and an interactive exact-id confirmation.');
  console.log('Wildcards are never accepted. Stop the owning runtime workloads before purging.');
}

function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { forceNonTesting: false, showHelp: false },
    commonFlags: { dataDir: {} },
    extraFlags: {
      '--sessions-dir': ({ options, readValue }) => {
        options.sessionsDir = readValue();
      },
      '--session': ({ options, readValue }) => {
        options.sessionId = readValue();
      },
      '--force-non-testing': ({ options }) => {
        options.forceNonTesting = true;
      },
    },
  });
}

async function confirmNonTestingSession(sessionId: string): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return await prompt.question(
      `DANGER: type the exact non-testing session id to purge "${sessionId}": `,
    );
  } finally {
    prompt.close();
  }
}

export function runTestingSessionPurgeCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<unknown> {
  return runMaintenanceCli({
    argv,
    label: 'Session purge',
    parseArgs,
    printUsage,
    run: async options => {
      const sessionId = options.sessionId;
      if (!sessionId) {
        throw new Error('--session <exact-id> is required');
      }
      let confirmedNonTestingSessionId: string | undefined;
      if (!isTestingSessionId(sessionId)) {
        if (!options.forceNonTesting) {
          throw new Error(
            `Refusing to purge non-testing session ${sessionId}; pass --force-non-testing and confirm the exact id`,
          );
        }
        confirmedNonTestingSessionId = await confirmNonTestingSession(sessionId);
      }
      const runtime = await bootstrapMaintenanceRuntime({ dataDir: options.dataDir });
      const databaseUrl = runtime.config.postgresDatabaseUrl?.trim();
      if (!databaseUrl) {
        throw new Error('Session purge requires config.postgresDatabaseUrl');
      }
      const sessionsDir = resolve(options.sessionsDir ?? resolveSessionsDir(runtime.dataDir));
      const adapters = await createDefaultPostgresSessionAdapters(databaseUrl, { sessionsDir });
      const projection = adapters.transcriptProjection;
      if (typeof projection.purgeChannel !== 'function') {
        throw new Error('Configured transcript projection does not support atomic channel purge');
      }

      const report = await purgeTestingSession({
        sessionsDir,
        sessionId,
        projection: projection as SessionProjectionPurgePort,
        forceNonTesting: options.forceNonTesting,
        ...(confirmedNonTestingSessionId !== undefined
          ? { confirmedNonTestingSessionId }
          : {}),
      });
      console.log(`Purged session: ${report.sessionId}`);
      console.log(`Projection channel: ${report.channelId}`);
      console.log(`Removed journal files: ${report.removedJournalFiles.join(', ')}`);
      return report;
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runTestingSessionPurgeCli();
}
