#!/usr/bin/env tsx

// ── One-time channel-envelope migration (E3.2) ──
// Enumerates known channels from contact conversation-channel rows and the
// session journals, derives channel-owned Context Envelope labels, and writes
// them into channels.json `contextEnvelope.channels`. Report-first:
// dry-run is the DEFAULT; pass --apply to write. Ambiguous channels are never
// guessed — they receive fail-closed invite_only plus a visible needsReview
// flag (Garden warning badge). Contract: docs/context-envelope.md.

import '../../shared/utils/load-dotenv.js';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createPostgresPool } from '../../persistence/postgres.js';
import { loadConfig } from '../../system/config/load-config.js';
import { resolveConfiguredSystemDataDir, resolveSessionsDir } from '../../persistence/layout.js';
import { loadTrustPolicyConfig } from '../../system/config/trust-policy-config.js';
import { planChannelEnvelopeMigration } from '../../system/trust/channel-envelope-migration.js';
import {
  applyChannelEnvelopeMigrationPlan,
  collectSessionChannelObservations,
  formatChannelEnvelopeMigrationReport,
  loadExistingChannelEnvelopeLabels,
  observationsFromContactActivityRows,
  type ContactActivityRow,
} from './channel-envelope-migration-support.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { hydrateSecretBearingConfig } from '../startup/support/bootstrap-helpers.js';
import { applyGatewayTlsConfig } from '../../boundary/gateway/tls.js';

type ContactsBackend = 'postgres' | 'sqlite';

interface CliOptions {
  apply: boolean;
  json: boolean;
  showHelp: boolean;
  sessionsDir?: string;
  backend?: ContactsBackend;
  postgresUrl?: string;
  sqlitePath?: string;
  skipContacts: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run migrate:channel-envelope [-- OPTIONS]');
  console.log('');
  console.log('One-time channel-envelope migration (Context Envelope contract, E3.2).');
  console.log('Enumerates known channels from contact conversation-channel rows and');
  console.log('session journals, derives channel-owned labels, and seeds channels.json');
  console.log('contextEnvelope entries. Dry-run REPORT is the default; --apply writes.');
  console.log('Ambiguous channels are reported, not guessed: they get invite_only plus');
  console.log('a needsReview flag that surfaces as a Garden warning badge.');
  console.log('');
  console.log('Options:');
  console.log('  --apply                  Write seeded labels to channels.json (default: report only).');
  console.log('  --json                   Emit the full plan as JSON.');
  console.log('  --sessions-dir <path>    Override the session journals directory.');
  console.log('  --backend <postgres|sqlite>');
  console.log('                           Override the configured contacts persistence backend.');
  console.log('  --postgres-url <url>     Override configured PostgreSQL URL.');
  console.log('  --sqlite-path <path>     Override configured SQLite database path.');
  console.log('  --skip-contacts          Skip contact-row enumeration (sessions only).');
  console.log('  -h, --help               Show this help message.');
}

function requireNext(argv: string[], index: number, arg: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`Missing value for ${arg}`);
  return value;
}

function parseBackend(value: string): ContactsBackend {
  if (value === 'postgres' || value === 'sqlite') return value;
  throw new Error('--backend must be postgres or sqlite');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, json: false, showHelp: false, skipContacts: false };
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
    if (arg === '--dry-run') {
      options.apply = false;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--skip-contacts') {
      options.skipContacts = true;
      continue;
    }
    if (arg === '--sessions-dir') {
      options.sessionsDir = requireNext(argv, i, arg);
      i += 1;
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
    if (arg === '--sqlite-path') {
      options.sqlitePath = requireNext(argv, i, arg);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function fetchPostgresContactActivityRows(postgresUrl: string): Promise<ContactActivityRow[]> {
  const url = postgresUrl.trim();
  if (!url) {
    throw new Error('Contacts enumeration requires --postgres-url or config.postgresDatabaseUrl (or pass --skip-contacts)');
  }
  const pool = createPostgresPool(url);
  try {
    // Read-only: a store without the table simply has no rows to enumerate.
    const exists = await pool.query("SELECT to_regclass('contact_channel_activity') AS rel");
    if (!exists.rows[0]?.rel) return [];
    const result = await pool.query('SELECT channel_id, privacy_level FROM contact_channel_activity');
    return result.rows.map((row: { channel_id: unknown; privacy_level: unknown }) => ({
      channelId: row.channel_id,
      privacyLevel: row.privacy_level,
    }));
  } finally {
    await pool.end();
  }
}

function fetchSqliteContactActivityRows(sqlitePath: string): ContactActivityRow[] {
  const path = sqlitePath.trim();
  if (!path) {
    throw new Error('Contacts enumeration requires --sqlite-path or config.databasePath (or pass --skip-contacts)');
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contact_channel_activity'",
    ).get();
    if (!table) return [];
    const rows = db.prepare('SELECT channel_id, privacy_level FROM contact_channel_activity').all() as Array<{
      channel_id: unknown;
      privacy_level: unknown;
    }>;
    return rows.map(row => ({ channelId: row.channel_id, privacyLevel: row.privacy_level }));
  } finally {
    db.close();
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

  const systemDataDir = resolveConfiguredSystemDataDir(config);
  const sessionsDir = resolve(options.sessionsDir ?? resolveSessionsDir(config.dataDir));

  const sessionScan = collectSessionChannelObservations(sessionsDir);

  const contactScan = options.skipContacts
    ? undefined
    : observationsFromContactActivityRows(
      (options.backend ?? (config.persistenceBackend === 'postgres' ? 'postgres' : 'sqlite')) === 'postgres'
        ? await fetchPostgresContactActivityRows(options.postgresUrl ?? config.postgresDatabaseUrl ?? '')
        : fetchSqliteContactActivityRows(options.sqlitePath ?? config.databasePath),
    );

  const trustPolicy = loadTrustPolicyConfig(systemDataDir);
  const existingLabels = loadExistingChannelEnvelopeLabels(systemDataDir);

  const plan = planChannelEnvelopeMigration({
    observations: [...sessionScan.observations, ...(contactScan?.observations ?? [])],
    trustPolicy,
    existingLabels,
  });

  if (options.json) {
    console.log(JSON.stringify({
      dryRun: !options.apply,
      sessionsDir,
      sessionScan: { ...sessionScan, observations: undefined },
      contactScan: contactScan ? { ...contactScan, observations: undefined } : undefined,
      plan,
    }, null, 2));
  } else {
    for (const line of formatChannelEnvelopeMigrationReport(plan, {
      dryRun: !options.apply,
      sessionScan,
      contactScan,
    })) {
      console.log(line);
    }
  }

  if (!options.apply) {
    return;
  }

  const applied = applyChannelEnvelopeMigrationPlan(systemDataDir, plan);
  console.log('');
  console.log(`Wrote ${applied.writtenChannelIds.length} channel label(s) to ${applied.filePath}`);
  if (plan.counts.seed_ambiguous > 0) {
    console.log(
      `${plan.counts.seed_ambiguous} channel(s) were seeded fail-closed (invite_only + needsReview); `
      + 'review them in Garden -> Channels.',
    );
  }
}

main().catch((error) => {
  console.error(`Channel envelope migration failed: ${toErrorMessage(error)}`);
  process.exit(1);
});
