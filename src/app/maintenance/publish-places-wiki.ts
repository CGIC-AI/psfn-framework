#!/usr/bin/env tsx

// CLI for the places→shared-world wiki publication (psfn-framework-vinz.4).
// Generates/refreshes browsable shared-world wiki pages from places.json — one
// site-overview page plus one page per place, scope `shared_world:<siteId>`.
// Idempotent: re-running with an unchanged registry is a no-op. Shared-world
// wiki markdown lives under <system-data>/shared-world/wiki/sites/<siteId>/,
// NOT in companion-data. This is an operator surface: companions never write
// shared_world scope directly (the W5b personal-store rejection stays intact).

import '../../shared/utils/load-dotenv.js';
import { loadPlacesRegistryConfig } from '../../channels/backplane/places-registry.js';
import { loadConfig } from '../../system/config/load-config.js';
import { resolveConfiguredSystemDataDir } from '../../persistence/layout.js';
import { SharedWorldWikiStore } from '../../faculties/wiki/store.js';
import {
  buildSiteWikiPages,
  publishSiteWiki,
  type PlacesWikiPublicationReport,
} from '../../faculties/wiki/places-wiki-publication.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

interface CliOptions {
  apply: boolean;
  json: boolean;
  showHelp: boolean;
  siteId?: string;
  systemDataDir?: string;
}

function printUsage(): void {
  console.log('Usage: npm run wiki:publish:places -- [--site <siteId>] [OPTIONS]');
  console.log('');
  console.log('Projects places.json into shared-world wiki pages (idempotent).');
  console.log('Dry-run is the default; pass --apply to write pages to disk.');
  console.log('');
  console.log('Options:');
  console.log('  --site <siteId>          Publish one site. Omit to publish every site in places.json.');
  console.log('  --apply                  Write pages. Without this, only report what would change.');
  console.log('  --system-data-dir <dir>  Override the resolved system-data directory.');
  console.log('  --json                   Emit the report(s) as JSON.');
  console.log('  -h, --help               Show this help message.');
}

function requireNext(argv: string[], index: number, arg: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`Missing value for ${arg}`);
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, json: false, showHelp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.showHelp = true; continue; }
    if (arg === '--apply') { options.apply = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--site') { options.siteId = requireNext(argv, i, arg); i += 1; continue; }
    if (arg === '--system-data-dir') { options.systemDataDir = requireNext(argv, i, arg); i += 1; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printReport(report: PlacesWikiPublicationReport): void {
  console.log(`Site ${report.siteId}: `
    + `created=${report.created.length} updated=${report.updated.length} `
    + `unchanged=${report.unchanged.length} deleted=${report.deleted.length}`);
  for (const id of report.created) console.log(`  + ${id}`);
  for (const id of report.updated) console.log(`  ~ ${id}`);
  for (const id of report.deleted) console.log(`  - ${id}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) { printUsage(); return; }

  const config = loadConfig();
  const systemDataDir = options.systemDataDir?.trim() || resolveConfiguredSystemDataDir(config);
  const registry = loadPlacesRegistryConfig(systemDataDir);

  const siteIds = options.siteId
    ? [options.siteId.trim()]
    : registry.sites.map(site => site.siteId);

  if (siteIds.length === 0) {
    console.log('No sites in places.json — nothing to publish.');
    return;
  }

  const reports: PlacesWikiPublicationReport[] = [];
  for (const siteId of siteIds) {
    if (!options.apply) {
      // Dry-run: build the drafts (fails closed on unknown site) and report ids.
      const drafts = buildSiteWikiPages(registry, siteId);
      const report: PlacesWikiPublicationReport = {
        siteId,
        created: drafts.map(draft => draft.id),
        updated: [],
        unchanged: [],
        deleted: [],
      };
      reports.push(report);
      continue;
    }
    const store = new SharedWorldWikiStore(systemDataDir, siteId);
    reports.push(publishSiteWiki(store, registry, siteId));
  }

  if (options.json) {
    console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', systemDataDir, reports }, null, 2));
    return;
  }
  console.log(`Mode: ${options.apply ? 'apply' : 'dry-run (pass --apply to write)'}`);
  console.log(`System data dir: ${systemDataDir}`);
  for (const report of reports) printReport(report);
}

main().catch((error) => {
  console.error(`places→wiki publication failed: ${toErrorMessage(error)}`);
  process.exit(1);
});
