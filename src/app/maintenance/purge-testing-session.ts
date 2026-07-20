import '../../shared/utils/load-dotenv.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { isTestingSessionId } from '../../core/session/session-id.js';
import { RedisSessionTailCache } from '../../persistence/sessions/redis-session-tail-cache.js';
import {
  purgeTestingSession,
  type SessionProjectionPurgePort,
  type SessionTailPurgePort,
  TestingSessionTailPurgeError,
} from '../../persistence/sessions/testing-session-purge.js';
import {
  buildRedisClientOptions,
  createRedisClientFactoryFromPackage,
  REDIS_URL_ENV,
  resolveRedisConnectionConfigFromEnv,
} from '../../shared/cache/redis-cache.js';
import { loadOperatorConfig } from '../../system/config/load-config.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';
import {
  resolveTestingSessionPurgeTarget,
  TestingSessionPurgeCompanionResolutionError,
} from './testing-session-purge-target.js';
import { createTestingSessionPurgePostgresAdapters } from './testing-session-purge-postgres.js';

interface CliOptions {
  companionId?: string;
  dataDir?: string;
  sessionsDir?: string;
  sessionId?: string;
  forceNonTesting: boolean;
  showHelp: boolean;
}

function printUsage(): void {
  console.log(
    'Usage: npm run session:purge -- --session <exact-id> '
    + '[--companion-id <uuid>] [--data-dir <path>] [--sessions-dir <path>]',
  );
  console.log('');
  console.log('Testing sessions must use <existing-channel-prefix>:testing:<name>.');
  console.log('Multi-companion fleets require --companion-id and resolve data/schema from companions.json.');
  console.log('Non-testing sessions require --force-non-testing and an interactive exact-id confirmation.');
  console.log('Wildcards are never accepted. Stop the owning runtime workloads before purging.');
}

function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { forceNonTesting: false, showHelp: false },
    commonFlags: { dataDir: {} },
    extraFlags: {
      '--companion-id': ({ options, readValue }) => {
        options.companionId = readValue();
      },
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

async function createConfiguredTailPurgePort(input: {
  companionId: string | undefined;
  env: NodeJS.ProcessEnv;
  sessionId: string;
}): Promise<(SessionTailPurgePort & { close(): Promise<void> }) | undefined> {
  if (!input.env[REDIS_URL_ENV]?.trim()) return undefined;
  if (!input.companionId) {
    throw new TestingSessionPurgeCompanionResolutionError(
      `Configured Redis tail cache requires a companion identity for purge target ${input.sessionId}`,
    );
  }
  try {
    const redisConfig = resolveRedisConnectionConfigFromEnv(input.env);
    const clientFactory = await createRedisClientFactoryFromPackage();
    const client = clientFactory(buildRedisClientOptions(redisConfig));
    return new RedisSessionTailCache({
      client,
      maxEntriesPerChannel: 1,
      scope: input.companionId,
    });
  } catch (error) {
    throw new TestingSessionTailPurgeError(input.sessionId, error);
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
      const runtime = await bootstrapMaintenanceRuntime({
        dataDir: options.dataDir,
        hydrateSecrets: false,
        dependencies: { loadConfig: loadOperatorConfig },
      });
      const databaseUrl = runtime.config.postgresDatabaseUrl?.trim();
      if (!databaseUrl) {
        throw new Error('Session purge requires config.postgresDatabaseUrl');
      }
      const target = resolveTestingSessionPurgeTarget(runtime, options);
      const adapters = await createTestingSessionPurgePostgresAdapters({
        databaseUrl,
        multiCompanion: runtime.config.multiCompanion === true,
        postgresSchema: target.postgresSchema,
        sessionsDir: target.sessionsDir,
      });
      const projection = adapters.transcriptProjection;
      if (typeof projection.purgeChannel !== 'function') {
        throw new Error('Configured transcript projection does not support atomic channel purge');
      }

      const tailCache = await createConfiguredTailPurgePort({
        companionId: target.companionId,
        env: process.env,
        sessionId,
      });
      const report = await (async () => {
        try {
          return await purgeTestingSession({
            sessionsDir: target.sessionsDir,
            sessionId,
            projection: projection as SessionProjectionPurgePort,
            ...(tailCache ? { tailCache } : {}),
            forceNonTesting: options.forceNonTesting,
            ...(confirmedNonTestingSessionId !== undefined
              ? { confirmedNonTestingSessionId }
              : {}),
          });
        } finally {
          await tailCache?.close();
        }
      })();
      console.log(`Purged session: ${report.sessionId}`);
      console.log(`Companion: ${target.companionId ?? 'single-companion'}`);
      console.log(`PostgreSQL schema: ${target.postgresSchema}`);
      console.log(`Projection channel: ${report.channelId}`);
      console.log(`Removed journal files: ${report.removedJournalFiles.join(', ')}`);
      console.log(`Tail cache: ${report.tailCache.message}`);
      return report;
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runTestingSessionPurgeCli();
}
