import '../../shared/utils/load-dotenv.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ContactStore } from '../../core/contacts/store.js';
import type {
  SocialGraphConsistencyFinding,
  SocialGraphConsistencyReport,
} from '../../core/contacts/store/social-graph.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

// ── Social-graph edge-hygiene audit (E4.3) ──
// Report-first, fail-closed maintenance command over a sqlite contacts database.
// Scans social_relationship_edges for bidirectional-consistency violations under
// the canonical directionality classification and, only under --apply, repairs
// the UNAMBIGUOUS ones (symmetric normalization, canonical re-ordering, duplicate
// collapse, missing-mirror creation). AMBIGUOUS findings (lost direction on an
// inverse-pair edge, conflicting mirror types) are reported for operator review
// and never mutated.
//
// Runtime persistence is Postgres-only; this tool targets sqlite contacts DBs
// (legacy stores / backups / migration staging). Pass the DB path explicitly.

interface CliOptions {
  dbPath?: string;
  apply: boolean;
  json: boolean;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run audit:social-graph -- --db <path> [OPTIONS]');
  console.log('');
  console.log('Scans a sqlite contacts DB social_relationship_edges table for');
  console.log('bidirectional-consistency and edge-hygiene violations. Dry-run by');
  console.log('default: it reports findings and mutates nothing.');
  console.log('');
  console.log('Finding kinds:');
  console.log('  symmetric_marked_directional  symmetric type stored directional (auto-fix: normalize)');
  console.log('  non_canonical_undirected      undirected endpoints out of order (auto-fix: reorder)');
  console.log('  duplicate_pair                duplicate rows for a pair/type/dir (auto-fix: collapse)');
  console.log('  missing_mirror                inverse-pair edge lacks its reciprocal (auto-fix: create)');
  console.log('  inverse_marked_undirected     inverse-pair stored undirected — AMBIGUOUS (review only)');
  console.log('  conflicting_mirror            reversed endpoints carry a conflicting type — AMBIGUOUS (review only)');
  console.log('');
  console.log('Options:');
  console.log('  --db <path>   Path to the sqlite contacts database (required).');
  console.log('  --apply       Repair unambiguous findings in place. Default: dry-run.');
  console.log('  --json        Emit the full report as JSON.');
  console.log('  -h, --help    Show this help message.');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, json: false, showHelp: false };
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
    if (arg === '--db') {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      options.dbPath = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function findingLine(finding: SocialGraphConsistencyFinding): string {
  const status = finding.fixed
    ? 'FIXED'
    : (finding.ambiguous ? 'REVIEW' : 'PENDING');
  return `- [${status}] ${finding.kind} (${finding.sourceEntityId} -> ${finding.targetEntityId}, `
    + `${finding.relationshipType}, directional=${finding.directional}): ${finding.detail}`;
}

function printReport(report: SocialGraphConsistencyReport): void {
  console.log(`Scanned ${report.scannedEdges} edge(s).`);
  console.log(`Mode: ${report.applied ? 'APPLY (repairs written)' : 'DRY-RUN (no changes)'}`);
  console.log(`Findings: ${report.findings.length} (fixed: ${report.fixedCount}, ambiguous/review: ${report.ambiguousCount}).`);
  if (report.findings.length === 0) {
    console.log('No consistency violations found.');
    return;
  }
  console.log('');
  for (const finding of report.findings) {
    console.log(findingLine(finding));
  }
  if (!report.applied) {
    const fixable = report.findings.filter(f => !f.ambiguous).length;
    console.log('');
    console.log(`${fixable} unambiguous finding(s) can be repaired with --apply.`);
    if (report.ambiguousCount > 0) {
      console.log(`${report.ambiguousCount} ambiguous finding(s) require operator review and are never auto-fixed.`);
    }
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) {
    printUsage();
    return;
  }
  if (!options.dbPath) {
    throw new Error('Missing required --db <path> (sqlite contacts database).');
  }
  const dbPath = resolve(options.dbPath);
  if (!existsSync(dbPath)) {
    throw new Error(`No sqlite database at ${dbPath}.`);
  }

  const db = new Database(dbPath);
  try {
    const store = new ContactStore(db);
    const report = store.reconcileSocialGraphConsistency({ apply: options.apply });

    if (options.json) {
      console.log(JSON.stringify({ dbPath, ...report }, null, 2));
    } else {
      console.log(`Social-graph edge-hygiene audit: ${dbPath}`);
      printReport(report);
    }
    // Non-zero exit when unresolved issues remain (unfixed or ambiguous).
    const unresolved = report.findings.filter(f => !f.fixed).length;
    process.exitCode = unresolved > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`Social-graph edge-hygiene audit failed: ${toErrorMessage(error)}`);
  process.exit(1);
}
