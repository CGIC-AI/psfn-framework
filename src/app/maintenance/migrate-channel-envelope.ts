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
import { createPostgresPool } from '../../persistence/postgres.js';
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
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

type ContactsBackend = 'postgres';

interface CliOptions {
  apply: boolean;
  json: boolean;
  showHelp: boolean;
  sessionsDir?: string;
  backend?: ContactsBackend;
  postgresUrl?: string;
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
  console.log('  --backend <postgres>');
  console.log('                           Override the configured contacts persistence backend.');
  console.log('  --postgres-url <url>     Override configured PostgreSQL URL.');
  console.log('  --skip-contacts          Skip contact-row enumeration (sessions only).');
  console.log('  -h, --help               Show this help message.');
}

function parseBackend(value: string): ContactsBackend {
  if (value === 'postgres') return value;
  throw new Error('--backend must be postgres');
}

function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { apply: false, json: false, showHelp: false, skipContacts: false },
    extraFlags: {
      '--apply': ({ options }) => {
        options.apply = true;
      },
      '--dry-run': ({ options }) => {
        options.apply = false;
      },
      '--json': ({ options }) => {
        options.json = true;
      },
      '--skip-contacts': ({ options }) => {
        options.skipContacts = true;
      },
      '--sessions-dir': ({ options, readValue }) => {
        options.sessionsDir = readValue();
      },
      '--backend': ({ options, readValue }) => {
        options.backend = parseBackend(readValue());
      },
      '--postgres-url': ({ options, readValue }) => {
        options.postgresUrl = readValue();
      },
    },
  });
}

async function fetchPostgresContactActivityRows(postgresUrl: string): Promise<ContactActivityRow[]> {
  const url = postgresUrl.trim();
  if (!url) {
    throw new Error('Contacts enumeration requires --postgres-url or config.postgresDatabaseUrl (or pass --skip-contacts)');
  }
  const pool = createPostgresPool(url);
  try {
    // Read-only: a store without the table simply has no rows to enumerate.
    const exists = await pool.query<{ rel: string | null }>(
      "SELECT to_regclass('contact_channel_activity') AS rel",
    );
    if (!exists.rows[0]?.rel) return [];
    const result = await pool.query<{ channel_id: unknown; privacy_level: unknown }>(
      'SELECT channel_id, privacy_level FROM contact_channel_activity',
    );
    return result.rows.map(row => ({
      channelId: row.channel_id,
      privacyLevel: row.privacy_level,
    }));
  } finally {
    await pool.end();
  }
}

async function run(options: CliOptions): Promise<void> {
  const { config } = await bootstrapMaintenanceRuntime();

  const systemDataDir = resolveConfiguredSystemDataDir(config);
  const sessionsDir = resolve(options.sessionsDir ?? resolveSessionsDir(config.dataDir));

  const sessionScan = collectSessionChannelObservations(sessionsDir);

  const contactScan = options.skipContacts
    ? undefined
    : observationsFromContactActivityRows(
      await fetchPostgresContactActivityRows(options.postgresUrl ?? config.postgresDatabaseUrl ?? ''),
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

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runMaintenanceCli({
    label: 'Channel envelope migration',
    parseArgs,
    printUsage,
    run,
  });
}
