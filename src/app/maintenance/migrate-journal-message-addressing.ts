import { RedisSessionTailCache } from '../../persistence/sessions/redis-session-tail-cache.js';
import { buildRedisClientOptions, createRedisClientFactoryFromPackage, resolveRedisConnectionConfigFromEnv } from '../../shared/cache/redis-cache.js';
import '../../shared/utils/load-dotenv.js';
import { readFileSync } from 'node:fs';
import { createSessionHmacBoundaryService } from '../../persistence/journals/hmac-boundary.js';
import { assertValidPostgresSchemaName, createPostgresPool } from '../../persistence/postgres.js';
import { createPostgresTranscriptProjection } from '../../persistence/sessions/postgres-adapters.js';
import { migrateJournalMessageAddressing } from '../../persistence/sessions/message-addressing-journal-migration.js';
import { isMaintenanceCliEntrypoint, runMaintenanceCli } from './cli-harness.js';

interface CliOptions {
  showHelp: boolean;
  apply: boolean;
  writersStopped: boolean;
  journalPath?: string;
  channelId?: string;
  observerId?: string;
  observerName?: string;
  maxJournalBytes?: number;
  maxJournalFiles?: number;
  expectedPlanDigest?: string;
  backupDir?: string;
  postgresUrlFile?: string;
  schema?: string;
  companionId?: string;
}

function printUsage(): void {
  console.log('Usage: npm run migrate:journal-message-addressing -- --journal-path <root.jsonl> --session-id <exact-id> --observer-id <id> --observer-name <name> --max-journal-bytes <bytes> --max-journal-files <count>');
  console.log('Dry-run is default. Apply additionally requires --apply --writers-stopped --expected-plan-digest <sha256> --backup-dir <existing-external-dir> --postgres-url-file <credential-file> --schema <tenant-schema> --companion-id <canonical-id>.');
  console.log('Uses the native GATEWAY_SESSION_HMAC_* environment credential contract. Stop all processes sharing this companion journal/cache before applying.');
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { showHelp: false, apply: false, writersStopped: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { options.showHelp = true; continue; }
    if (arg === '--apply') { options.apply = true; continue; }
    if (arg === '--writers-stopped') { options.writersStopped = true; continue; }
    const value = argv[++index];
    if (!value) throw new Error(`Missing value for ${arg}`);
    if (arg === '--journal-path') options.journalPath = value;
    else if (arg === '--session-id') options.channelId = value;
    else if (arg === '--observer-id') options.observerId = value;
    else if (arg === '--observer-name') options.observerName = value;
    else if (arg === '--max-journal-bytes') options.maxJournalBytes = Number(value);
    else if (arg === '--max-journal-files') options.maxJournalFiles = Number(value);
    else if (arg === '--expected-plan-digest') options.expectedPlanDigest = value;
    else if (arg === '--backup-dir') options.backupDir = value;
    else if (arg === '--postgres-url-file') options.postgresUrlFile = value;
    else if (arg === '--companion-id') options.companionId = value;
    else if (arg === '--schema') options.schema = assertValidPostgresSchemaName(value);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function runJournalAddressingMigrationCli(argv: readonly string[] = process.argv.slice(2)): Promise<unknown> {
  return runMaintenanceCli({ argv, label: 'Canonical journal addressing migration', parseArgs, printUsage,
    run: async options => {
      if (!options.journalPath || !options.channelId || !options.observerId || !options.observerName
        || !options.maxJournalBytes || !options.maxJournalFiles) throw new Error('Explicit journal, session, observer, and read bounds are required');
      const request = {
        journalPath: options.journalPath, channelId: options.channelId,
        observer: { authorId: options.observerId, authorName: options.observerName },
        maxJournalBytes: options.maxJournalBytes, maxJournalFiles: options.maxJournalFiles,
        integrityProvider: createSessionHmacBoundaryService().resolveIntegrityProvider(),
      };
      // No database connection, schema initialization, or SessionStore construction for inventory.
      const plan = await migrateJournalMessageAddressing({ ...request, mode: 'dry-run' });
      if (!options.apply) { console.log(JSON.stringify(plan)); return plan; }
      if (!options.postgresUrlFile || !options.schema || !options.companionId || !options.writersStopped || !options.backupDir
        || options.expectedPlanDigest !== plan.planDigest) throw new Error('Apply requires the exact plan digest, stopped writers, backup, and tenant database');
      const clientFactory = await createRedisClientFactoryFromPackage();
      const tailCache = new RedisSessionTailCache({
        client: clientFactory(buildRedisClientOptions(resolveRedisConnectionConfigFromEnv(process.env))),
        scope: options.companionId, maxEntriesPerChannel: 1,
      });
      const databaseUrl = readFileSync(options.postgresUrlFile, 'utf8').trim();
      const pool = createPostgresPool(databaseUrl, { schema: options.schema, applicationName: 'canonical-addressing-migration' });
      try {
        const transcriptProjection = await createPostgresTranscriptProjection(databaseUrl, { pool });
        const result = await migrateJournalMessageAddressing({ ...request, mode: 'apply', transcriptProjection, tailCache,
          writersStopped: options.writersStopped, backupDir: options.backupDir, expectedPlanDigest: options.expectedPlanDigest });
        console.log(JSON.stringify(result));
        return result;
      } finally { await Promise.all([pool.end(), tailCache.close()]); }
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) void runJournalAddressingMigrationCli();
