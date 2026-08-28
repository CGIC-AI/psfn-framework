#!/usr/bin/env tsx

import '../../shared/utils/load-dotenv.js';
import {
  assertValidPostgresSchemaName,
  createPostgresPool,
} from '../../persistence/postgres.js';
import { migratePostgresMessageAddressing } from '../../persistence/sessions/message-addressing-migration.js';
import {
  isMaintenanceCliEntrypoint,
  runMaintenanceCli,
} from './cli-harness.js';

interface CliOptions {
  apply: boolean;
  observerId?: string;
  observerName?: string;
  postgresUrl?: string;
  schema?: string;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run migrate:message-addressing -- --postgres-url <url> --schema <tenant-schema> --observer-id <id> --observer-name <name> [--apply]');
  console.log('');
  console.log('Inventories legacy persisted message addressing in one companion namespace.');
  console.log('Dry-run is the default; --apply performs one atomic, idempotent tenant migration.');
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { apply: false, showHelp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.showHelp = true;
      continue;
    }
    if (arg === '--apply') {
      options.apply = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.apply = false;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${arg}`);
    if (arg === '--postgres-url') options.postgresUrl = value;
    else if (arg === '--schema') options.schema = assertValidPostgresSchemaName(value);
    else if (arg === '--observer-id') options.observerId = value.trim();
    else if (arg === '--observer-name') options.observerName = value.trim();
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }
  return options;
}

export function runMessageAddressingMigrationCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<unknown> {
  return runMaintenanceCli({
    argv,
    label: 'Message addressing migration',
    parseArgs,
    printUsage,
    run: async options => {
      if (!options.postgresUrl) throw new Error('--postgres-url is required');
      if (!options.schema) throw new Error('--schema is required');
      if (!options.observerId) throw new Error('--observer-id is required');
      if (!options.observerName) throw new Error('--observer-name is required');
      const pool = createPostgresPool(options.postgresUrl, {
        applicationName: 'message-addressing-migration',
        allowExitOnIdle: true,
        schema: options.schema,
      });
      try {
        const report = await migratePostgresMessageAddressing(pool, {
          mode: options.apply ? 'apply' : 'dry-run',
          observer: { authorId: options.observerId, authorName: options.observerName },
        });
        console.log(JSON.stringify({ tenantSchema: options.schema, ...report }, null, 2));
        return report;
      } finally {
        await pool.end();
      }
    },
  });
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runMessageAddressingMigrationCli();
}
