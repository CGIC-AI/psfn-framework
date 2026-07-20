#!/usr/bin/env tsx

// One-time, idempotent free-time privacy migration (psfn-framework-jp36.2.2.2).
//
// Adjudication S11.4: existing free-time history is flipped to private, then go.
// A pre-existing `public` free-time project visibility predates the governed
// publication flow (public/broadcast reach is net-new, governed capability), so
// this migration CONTAINS each `public` project to `primary_contact` — a strict
// narrowing from public to the single highest-trust partner. The work becomes
// private (no autonomous public egress remains) while partner eligibility is
// preserved: the partner is the highest-trust contact and still receives an
// eligible return note from the work (bible §10.6/§10.8). `self` and
// `primary_contact` projects are already private and are left untouched.
//
// Idempotent: once contained, a project carries no `public` visibility, so a
// re-run contains nothing and the counts are stable. Dry-run is the default
// (reports counts + a bounded sample, writes nothing); pass --apply to write.
// Only the existing `visibility` metadata field is flipped — no turn content is
// ever moved or destroyed, and a malformed manifest is reported, not rewritten.

import '../../shared/utils/load-dotenv.js';
import { WikiStore } from '../../faculties/wiki/store.js';
import {
  PersonalProjectLibrary,
  type FreeTimeVisibilityMigrationReport,
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
  console.log('Usage: npm run projects:migrate-free-time-visibility -- [OPTIONS]');
  console.log('');
  console.log('Flips existing free-time history to private (adjudication S11.4).');
  console.log('Each `public` personal project is contained to `primary_contact` — a strict');
  console.log('narrowing from public to the highest-trust partner that removes autonomous');
  console.log('public egress while preserving eligible partner return context (bible §10.6/§10.8).');
  console.log('`self` and `primary_contact` projects are already private and are left untouched.');
  console.log('Idempotent; dry-run is the default.');
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

function printReport(report: FreeTimeVisibilityMigrationReport, mode: string): void {
  console.log(`Mode: ${mode}`);
  console.log(`Projects scanned: ${report.scannedProjects}`);
  console.log(`Already private (self/primary_contact): ${report.alreadyPrivateProjects}`);
  console.log(`Contained public -> primary_contact: ${report.containedProjects}`);
  for (const entry of report.entries) {
    console.log(`  ~ ${entry.projectRef}: ${entry.from} -> ${entry.to}`);
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
    throw new Error('free-time visibility migration requires config.workspacePath or --workspace <dir>');
  }

  const library = new PersonalProjectLibrary(new WikiStore(workspacePath));
  const report = library.migrateFreeTimeVisibility({ dryRun: !options.apply });

  if (options.json) {
    console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', report }, null, 2));
    return;
  }
  printReport(report, options.apply ? 'apply' : 'dry-run (pass --apply to write)');
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runMaintenanceCli({
    label: 'migrate free-time visibility',
    parseArgs,
    printUsage,
    run,
  });
}
