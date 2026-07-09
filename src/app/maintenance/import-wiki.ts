#!/usr/bin/env tsx

// CLI for the wiki bulk directory import (psfn-framework-vinz.27). Imports a
// directory of Markdown files into either a companion's personal wiki or a
// site's shared-world scope.
//
//   --scope shared --site <siteId>  → shared-world import. EVERY file is run
//       through the deterministic personal-fact guard; any file containing a
//       personal fact is REJECTED with a per-file reason and never written.
//       Fails closed on an unknown siteId (not in places.json).
//   --scope personal                → personal wiki import, WITHOUT the shared
//       gate (personal facts are legitimate in a companion's own wiki).
//
// Dry-run is the default (runs the guard, reports decisions, writes nothing);
// pass --apply to write. Companions never write shared_world scope directly —
// this operator surface constructs the shared store deliberately.

import '../../shared/utils/load-dotenv.js';
import {
  loadPlacesRegistryConfig,
  resolveSiteById,
} from '../../channels/backplane/places-registry.js';
import { loadConfig } from '../../system/config/load-config.js';
import { resolveConfiguredSystemDataDir } from '../../persistence/layout.js';
import {
  SharedWorldWikiStore,
  WikiStore,
  type WikiDocumentStore,
} from '../../faculties/wiki/store.js';
import {
  importMarkdownDirectory,
  type WikiImportReport,
} from '../../faculties/wiki/bulk-import.js';
import {
  runSharedWorldWikiWrite,
  type SharedWikiProjectionOutcome,
} from '../../faculties/wiki/shared-pgvector-projection.js';
import { resolveSharedWikiProjectionContext } from './shared-wiki-projection-context.js';
import { sharedWorldScope } from '../../faculties/wiki/scope.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

interface CliOptions {
  apply: boolean;
  json: boolean;
  showHelp: boolean;
  directory?: string;
  scope: 'personal' | 'shared';
  siteId?: string;
  systemDataDir?: string;
  workspacePath?: string;
}

function printUsage(): void {
  console.log('Usage: npm run wiki:import -- --dir <markdown-dir> --scope <personal|shared> [OPTIONS]');
  console.log('');
  console.log('Imports a directory of Markdown files into the wiki.');
  console.log('Shared-world imports are personal-fact-guarded per file; personal imports are not.');
  console.log('Dry-run is the default; pass --apply to write.');
  console.log('');
  console.log('Options:');
  console.log('  --dir <path>             Directory of *.md files to import (required).');
  console.log('  --scope <personal|shared> Target scope (required).');
  console.log('  --site <siteId>          Site for shared imports (required with --scope shared).');
  console.log('  --apply                  Write documents. Without this, only report.');
  console.log('  --system-data-dir <dir>  Override the resolved system-data directory (shared scope).');
  console.log('  --workspace <dir>        Override the companion workspace path (personal scope).');
  console.log('  --json                   Emit the report as JSON.');
  console.log('  -h, --help               Show this help message.');
}

function requireNext(argv: string[], index: number, arg: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`Missing value for ${arg}`);
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, json: false, showHelp: false, scope: 'personal' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.showHelp = true; continue; }
    if (arg === '--apply') { options.apply = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--dir') { options.directory = requireNext(argv, i, arg); i += 1; continue; }
    if (arg === '--scope') {
      const value = requireNext(argv, i, arg);
      if (value !== 'personal' && value !== 'shared') {
        throw new Error('--scope must be "personal" or "shared"');
      }
      options.scope = value;
      i += 1;
      continue;
    }
    if (arg === '--site') { options.siteId = requireNext(argv, i, arg); i += 1; continue; }
    if (arg === '--system-data-dir') { options.systemDataDir = requireNext(argv, i, arg); i += 1; continue; }
    if (arg === '--workspace') { options.workspacePath = requireNext(argv, i, arg); i += 1; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printReport(report: WikiImportReport, mode: string, projection?: SharedWikiProjectionOutcome): void {
  console.log(`Mode: ${mode}`);
  console.log(`Directory: ${report.directory}`);
  console.log(`Scope: ${report.scope} (personal-fact guard: ${report.personalFactGuard ? 'on' : 'off'})`);
  console.log(`Imported: ${report.imported.length}  Rejected: ${report.rejected.length}`);
  for (const entry of report.imported) console.log(`  + ${entry.file} → ${entry.id}`);
  for (const rejection of report.rejected) console.log(`  ✗ ${rejection.file}: ${rejection.reason}`);
  if (!projection) return;
  if (projection.status === 'projected') {
    console.log(`Projection: projected (reembedded=${projection.projected.length} `
      + `deleted=${projection.deleted.length} failed=${projection.failedDocuments.length})`);
    for (const failure of projection.failedDocuments) {
      console.log(`  ! ${failure.documentId}: ${failure.error}`);
    }
    return;
  }
  if (projection.status === 'skipped') {
    console.log(`Projection: SKIPPED (${projection.reason ?? 'unknown'}) — shared docs are filesystem-only until projected`);
    return;
  }
  console.log(`Projection: FAILED (${projection.error ?? 'unknown'}) — re-run once Postgres is reachable to heal`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) { printUsage(); return; }
  if (!options.directory) throw new Error('--dir <path> is required (see --help)');

  const config = loadConfig();

  let store: WikiDocumentStore;
  let sharedStore: SharedWorldWikiStore | null = null;
  let scopeLabel: 'personal' | `shared_world:${string}`;
  let personalFactGuard: boolean;

  if (options.scope === 'shared') {
    const siteId = options.siteId?.trim();
    if (!siteId) throw new Error('--site <siteId> is required with --scope shared');
    const systemDataDir = options.systemDataDir?.trim() || resolveConfiguredSystemDataDir(config);
    // Fail closed on an unknown siteId: the site must exist in places.json.
    const registry = loadPlacesRegistryConfig(systemDataDir);
    if (!resolveSiteById(registry, siteId)) {
      throw new Error(`unknown siteId "${siteId}" — not present in places.json sites (fail closed)`);
    }
    sharedStore = new SharedWorldWikiStore(systemDataDir, siteId);
    store = sharedStore;
    scopeLabel = sharedWorldScope(siteId);
    personalFactGuard = true;
  } else {
    const workspacePath = options.workspacePath?.trim() || config.workspacePath;
    if (!workspacePath) {
      throw new Error('personal import requires config.workspacePath or --workspace <dir>');
    }
    store = new WikiStore(workspacePath);
    scopeLabel = 'personal';
    personalFactGuard = false;
  }

  const runImport = (): WikiImportReport => importMarkdownDirectory({
    directory: options.directory as string,
    store,
    scope: scopeLabel,
    personalFactGuard,
    dryRun: !options.apply,
  });

  let report: WikiImportReport;
  let projection: SharedWikiProjectionOutcome | undefined;
  if (sharedStore && options.apply) {
    // s10f9: shared-world apply runs write + projection together so the
    // filesystem tree and shared.shared_wiki_chunks cannot drift silently.
    // Under multi-companion an unavailable projection fails closed BEFORE the
    // filesystem write; flag-off it is reported honestly (skipped/failed).
    const outcome = await runSharedWorldWikiWrite({
      context: resolveSharedWikiProjectionContext(config),
      store: sharedStore,
      write: runImport,
    });
    report = outcome.report;
    projection = outcome.projection;
  } else {
    report = runImport();
  }

  if (options.json) {
    console.log(JSON.stringify({
      mode: options.apply ? 'apply' : 'dry-run',
      report: { ...report, ...(projection ? { projection } : {}) },
    }, null, 2));
    return;
  }
  printReport(report, options.apply ? 'apply' : 'dry-run (pass --apply to write)', projection);
}

main().catch((error) => {
  console.error(`wiki import failed: ${toErrorMessage(error)}`);
  process.exit(1);
});
