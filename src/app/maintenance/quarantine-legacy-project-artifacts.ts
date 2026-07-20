#!/usr/bin/env tsx

// One-time, idempotent quarantine migration for pre-existing model-asserted
// personal-project artifact metadata (psfn-framework-jp36.1.2.2).
//
// Before runtime metadata authority landed (jp36.1.2.1), `project_add_artifact`
// accepted model-supplied sensitivity/audience and persisted them verbatim.
// Those stored artifacts carry no `metadataLineage` marker. Bible §9.5 forbids
// treating such unclassified artifacts as automatically shareable, so this
// migration marks each one `legacy_unverified` and contains it to
// `private`/`self`; the egress gate then fails closed on it until it is
// re-grounded in a fresh eligible context.
//
// Idempotent: artifacts that already carry a lineage marker (runtime-derived
// writes, or a prior run of this migration) are left untouched, so re-running
// quarantines nothing. Dry-run is the default (reports counts, writes nothing);
// pass --apply to write.

import '../../shared/utils/load-dotenv.js';
import { WikiStore } from '../../faculties/wiki/store.js';
import {
  PersonalProjectLibrary,
  type LegacyArtifactQuarantineReport,
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
  console.log('Usage: npm run projects:quarantine-legacy-artifacts -- [OPTIONS]');
  console.log('');
  console.log('Quarantines pre-existing model-asserted personal-project artifact metadata.');
  console.log('Each unclassified artifact is marked legacy_unverified and contained to');
  console.log('private/self so it fails closed at the egress gate until re-grounded (bible §9.5).');
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

function printReport(report: LegacyArtifactQuarantineReport, mode: string): void {
  console.log(`Mode: ${mode}`);
  console.log(`Projects scanned: ${report.scannedProjects}  Artifacts scanned: ${report.scannedArtifacts}`);
  console.log(`Already classified: ${report.alreadyClassifiedArtifacts}`);
  console.log(
    `Quarantined artifacts: ${report.quarantinedArtifacts} `
    + `across ${report.quarantinedProjects} project(s)`,
  );
  for (const entry of report.entries) {
    console.log(`  ! ${entry.projectRef} → ${entry.artifactRef}`);
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
    throw new Error('quarantine requires config.workspacePath or --workspace <dir>');
  }

  const library = new PersonalProjectLibrary(new WikiStore(workspacePath));
  const report = library.quarantineLegacyArtifacts({ dryRun: !options.apply });

  if (options.json) {
    console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', report }, null, 2));
    return;
  }
  printReport(report, options.apply ? 'apply' : 'dry-run (pass --apply to write)');
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runMaintenanceCli({
    label: 'quarantine legacy project artifacts',
    parseArgs,
    printUsage,
    run,
  });
}
