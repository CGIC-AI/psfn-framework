#!/usr/bin/env tsx

// One-time, idempotent personal-project manifest v1 → v2 migration
// (psfn-framework-jp36.2.4, bible §10.5).
//
// v1 manifests carried no durable work context. `parsePersonalProjectDocument`
// already upgrades them in memory to a private work context on read (so resume
// works before this runs, settled decision 16 / §5.5), and this migration makes
// that upgrade durable on disk. The disclosure-relevant continuity session id
// and return policy are runtime-derived from the work context on every read, so
// migrating rewrites nothing security-sensitive — it only fixes the persisted
// schema version and adds the private work context.
//
// Idempotent: manifests already at the current schema version are left
// untouched, so re-running migrates nothing. Dry-run is the default (reports
// counts, writes nothing); pass --apply to write.

import '../../shared/utils/load-dotenv.js';
import { WikiStore } from '../../faculties/wiki/store.js';
import {
  PersonalProjectLibrary,
  type ProjectManifestV2MigrationReport,
} from '../../faculties/wiki/personal-projects.js';
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
  workspacePath?: string;
}

function printUsage(): void {
  console.log('Usage: npm run projects:migrate-manifests-v2 -- [OPTIONS]');
  console.log('');
  console.log('Migrates personal-project manifests from schema v1 to v2 (bible §10.5).');
  console.log('Each v1 manifest upgrades to a private work context with a runtime-derived');
  console.log('continuity session id and return policy. Idempotent; dry-run is the default.');
  console.log('');
  console.log('Options:');
  console.log('  --apply                 Write changes. Without this, only report.');
  console.log('  --workspace <dir>       Override the companion workspace path.');
  console.log('  --json                  Emit the report as JSON.');
  console.log('  -h, --help              Show this help message.');
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
      '--workspace': ({ options, readValue }) => {
        options.workspacePath = readValue();
      },
    },
  });
}

function printReport(report: ProjectManifestV2MigrationReport, mode: string): void {
  console.log(`Mode: ${mode}`);
  console.log(`Projects scanned: ${report.scannedProjects}  Already v2: ${report.alreadyCurrent}`);
  console.log(`Migrated projects: ${report.migratedProjects}`);
  for (const entry of report.entries) {
    console.log(`  ↑ ${entry}`);
  }
  if (report.malformedProjects.length > 0) {
    console.log(`Malformed projects (skipped, inspect by hand): ${report.malformedProjects.length}`);
    for (const malformed of report.malformedProjects) {
      console.log(`  ✗ ${malformed.id}: ${malformed.error}`);
    }
  }
}

async function run(options: CliOptions): Promise<void> {
  const { config } = await bootstrapMaintenanceRuntime({ hydrateSecrets: false });

  const workspacePath = options.workspacePath?.trim() || config.workspacePath;
  if (!workspacePath) {
    throw new Error('manifest v2 migration requires config.workspacePath or --workspace <dir>');
  }

  const library = new PersonalProjectLibrary(new WikiStore(workspacePath));
  const report = library.migrateManifestsToV2({ dryRun: !options.apply });

  if (options.json) {
    console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', report }, null, 2));
    return;
  }
  printReport(report, options.apply ? 'apply' : 'dry-run (pass --apply to write)');
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runMaintenanceCli({
    label: 'migrate personal-project manifests to v2',
    parseArgs,
    printUsage,
    run,
  });
}
