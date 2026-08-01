// ── Corpus coverage report generator (hrmrq.141) ──
//
// Renders the corpus coverage denominator to docs/cogsec-corpus-coverage.md:
// per-axis totals, every known-gap finding, and any uncovered upstream
// entries. Committed output — regenerate after corpus changes:
//
//   node_modules/.bin/tsx scripts/cogsec/coverage-report.ts

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeCoverage,
  loadCorpus,
  type CorpusCoverage,
} from '../../src/core/cogsec/intake/corpus/corpus.ts';

const CORPUS_DIR = join(process.cwd(), 'src/core/cogsec/intake/corpus');
const OUT_PATH = join(process.cwd(), 'docs/cogsec-corpus-coverage.md');

function render(coverage: CorpusCoverage, generatedAt: string): string {
  const lines: string[] = [];
  const t = coverage.totals;
  lines.push('# CogSec adversarial corpus — coverage report');
  lines.push('');
  lines.push(`Generated: ${generatedAt} by \`scripts/cogsec/coverage-report.ts\` (bead psfn-framework-hrmrq.141).`);
  lines.push('Upstream pins: `src/core/cogsec/intake/corpus/upstream/manifest.json` '
    + '(Arcanum PI Taxonomy v1.6.1 @ 65b8379; MITRE ATLAS 2026.07, format 6.0.0).');
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`- Upstream entries in scope (the denominator): **${String(t.upstreamEntries)}** `
    + `(172 Arcanum + ${String(t.upstreamEntries - 172)} relevant ATLAS techniques)`);
  lines.push(`- Covered (≥1 attack fixture): **${String(t.coveredEntries)}**`);
  lines.push(`- Uncovered: **${String(t.uncovered)}**`);
  lines.push(`- Fixtures: **${String(t.fixtures)}** — ${String(t.enforced)} enforced, `
    + `${String(t.knownGaps)} known-gap, ${String(t.semanticOnly)} semantic-only`);
  lines.push('');

  lines.push('## Per-axis coverage');
  lines.push('');
  lines.push('| Axis | Entries | Covered | Enforced fixtures | Known-gap | Semantic-only |');
  lines.push('|---|---|---|---|---|---|');
  const axes = [...new Set(coverage.entries.map((e) => e.axis))];
  for (const axis of axes) {
    const entries = coverage.entries.filter((e) => e.axis === axis);
    const covered = entries.filter((e) => e.attackFixtures > 0).length;
    lines.push(`| ${axis} | ${String(entries.length)} | ${String(covered)} `
      + `| ${String(entries.reduce((n, e) => n + e.enforced, 0))} `
      + `| ${String(entries.reduce((n, e) => n + e.knownGaps, 0))} `
      + `| ${String(entries.reduce((n, e) => n + e.semanticOnly, 0))} |`);
  }
  lines.push('');

  if (coverage.uncovered.length > 0) {
    lines.push('## Uncovered entries (denominator gaps)');
    lines.push('');
    for (const entry of coverage.uncovered) {
      lines.push(`- \`${entry.axis}:${entry.entryId}\` — ${entry.title}`);
    }
    lines.push('');
  }

  const withFindings = coverage.entries.filter((e) => e.findings.length > 0);
  lines.push(`## Known gaps (${String(withFindings.reduce((n, e) => n + e.knownGaps, 0))} fixtures — findings to file, not gates to relax)`);
  lines.push('');
  for (const entry of withFindings) {
    for (const finding of entry.findings) {
      lines.push(`- \`${entry.axis}:${entry.entryId}\` — ${finding}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const corpus = loadCorpus(CORPUS_DIR);
const coverage = computeCoverage(corpus);
writeFileSync(OUT_PATH, render(coverage, new Date().toISOString().slice(0, 10)), 'utf-8');
console.log(`wrote ${OUT_PATH}`);
console.log(`entries=${String(coverage.totals.upstreamEntries)} covered=${String(coverage.totals.coveredEntries)} `
  + `fixtures=${String(coverage.totals.fixtures)} knownGaps=${String(coverage.totals.knownGaps)}`);
process.exit(coverage.uncovered.length === 0 ? 0 : 1);
