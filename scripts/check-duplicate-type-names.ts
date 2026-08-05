#!/usr/bin/env tsx

/**
 * Fail-closed duplicate exported-type-name gate.
 *
 * Scans src/ for exported interface/type-alias/enum names defined in more than
 * one file and compares them against config/duplicate-type-baseline.json.
 * Findings are classified as `identical` (same normalized shape; consolidation
 * candidate) or `collision` (different shapes; the dangerous case). Test files
 * and src/test-support are excluded: tests and fixtures deliberately
 * re-declare helper shapes and are not production type definitions.
 *
 * Check locally:
 *   npx tsx scripts/check-duplicate-type-names.ts
 *
 * After deliberately consolidating a duplicate, refresh the baseline with:
 *   npx tsx scripts/check-duplicate-type-names.ts --update
 *
 * Updating is reduction-only: it refuses new names, identical-to-collision
 * upgrades, and footprints that spread to new files. Accepting a new duplicate
 * requires hand-adding a baseline entry with a non-empty review note.
 */

import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import {
  buildUpdatedBaseline,
  collectExportedTypeDeclarations,
  compareFindingsToBaseline,
  findDuplicateTypeNames,
  readDuplicateTypeBaseline,
  serializeBaseline,
  type DuplicateTypeBaseline,
  type ExportedTypeDeclaration,
} from './lib/duplicate-type-names.js';
import { collectSourceFiles, toPosix } from './lib/import-graph.js';

const REPOSITORY_ROOT = process.cwd();
const SOURCE_ROOT = resolve(REPOSITORY_ROOT, 'src');
const DEFAULT_BASELINE_PATH = resolve(REPOSITORY_ROOT, 'config/duplicate-type-baseline.json');
const EXCLUDED_SOURCE_PREFIXES = ['test-support/'];

function printUsage() {
  console.log('Usage: tsx scripts/check-duplicate-type-names.ts [options]');
  console.log('');
  console.log('Checks src/ for exported type names defined in more than one file.');
  console.log('Fails on duplicates outside the baseline, worsened classifications,');
  console.log('or baseline entries that no longer match reality.');
  console.log('');
  console.log('Options:');
  console.log('  --baseline <path>   Override baseline JSON path');
  console.log('  --update            Rewrite the baseline, but only when duplicates shrink');
  console.log('  -h, --help          Show this help');
}

function parseArgs(argv: string[]) {
  let baselinePath = DEFAULT_BASELINE_PATH;
  let update = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--baseline') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --baseline');
      }
      baselinePath = resolve(REPOSITORY_ROOT, value);
      index += 1;
      continue;
    }
    if (arg === '--update') {
      update = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { baselinePath, update };
}

function collectDeclarationsByFile(files: readonly string[]) {
  const declarationsByFile = new Map<string, ExportedTypeDeclaration[]>();
  for (const filePath of files) {
    const relativePath = toPosix(relative(REPOSITORY_ROOT, filePath));
    declarationsByFile.set(relativePath, collectExportedTypeDeclarations(filePath));
  }
  return declarationsByFile;
}

function listScannableSourceFiles() {
  return collectSourceFiles(SOURCE_ROOT, false)
    .filter((filePath) => {
      const relativeToSource = toPosix(relative(SOURCE_ROOT, filePath));
      return !EXCLUDED_SOURCE_PREFIXES.some(prefix => relativeToSource.startsWith(prefix));
    });
}

function writeBaseline(baselinePath: string, baseline: DuplicateTypeBaseline) {
  const temporaryPath = `${baselinePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, serializeBaseline(baseline), 'utf8');
    renameSync(temporaryPath, baselinePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const files = listScannableSourceFiles();
    const findings = findDuplicateTypeNames(collectDeclarationsByFile(files));
    const identicalCount = findings.filter(f => f.classification === 'identical').length;
    const collisionCount = findings.length - identicalCount;
    const baselineLabel = toPosix(relative(REPOSITORY_ROOT, options.baselinePath));

    console.log(
      `Scanned ${files.length} source files; found ${findings.length} duplicate exported `
      + `type name(s): ${identicalCount} identical, ${collisionCount} collision.`,
    );
    console.log(`Duplicate-type baseline: ${baselineLabel}`);

    if (options.update) {
      if (!existsSync(options.baselinePath)) {
        throw new Error(
          `Missing ${baselineLabel}. Author the initial baseline by hand with a `
          + 'reviewed note per entry; --update only reduces an existing baseline.',
        );
      }
      const existing = readDuplicateTypeBaseline(options.baselinePath);
      const update = buildUpdatedBaseline(existing, findings);
      if (update.refusals.length > 0) {
        console.error('Refusing to update the duplicate-type baseline:');
        for (const refusal of update.refusals) {
          console.error(`- ${refusal}`);
        }
        process.exitCode = 1;
        return;
      }
      writeBaseline(options.baselinePath, update.baseline);
      console.log(
        `Wrote ${baselineLabel}: ${update.baseline.entries.length} entries `
        + `(${update.removedNames.length} removed, ${update.rewrittenNames.length} reduced).`,
      );
      if (update.removedNames.length > 0) {
        console.log(`Removed resolved duplicate(s): ${update.removedNames.join(', ')}`);
      }
      return;
    }

    if (!existsSync(options.baselinePath)) {
      throw new Error(
        `Missing ${baselineLabel}. The duplicate-type gate requires a reviewed baseline.`,
      );
    }
    const baseline = readDuplicateTypeBaseline(options.baselinePath);
    const comparison = compareFindingsToBaseline(baseline, findings);

    let failed = false;

    if (comparison.newFindings.length > 0) {
      failed = true;
      console.error(`New duplicate type name(s) outside baseline (${comparison.newFindings.length}):`);
      for (const finding of comparison.newFindings) {
        console.error(`- ${finding.name} (${finding.classification}): ${finding.files.join(', ')}`);
      }
    }

    if (comparison.kindChanges.length > 0) {
      failed = true;
      console.error(`Duplicate type name classification(s) changed (${comparison.kindChanges.length}):`);
      for (const change of comparison.kindChanges) {
        const direction = change.baselineKind === 'identical' ? 'WORSENED' : 'improved';
        console.error(`- ${change.name}: ${change.baselineKind} -> ${change.currentKind} (${direction})`);
      }
    }

    if (comparison.fileChanges.length > 0) {
      failed = true;
      console.error(`Duplicate type name footprint(s) changed (${comparison.fileChanges.length}):`);
      for (const change of comparison.fileChanges) {
        const parts = [];
        if (change.added.length > 0) parts.push(`added ${change.added.join(', ')}`);
        if (change.removed.length > 0) parts.push(`removed ${change.removed.join(', ')}`);
        console.error(`- ${change.name}: ${parts.join('; ')}`);
      }
    }

    if (comparison.staleEntries.length > 0) {
      failed = true;
      console.error(`Stale baseline entries no longer duplicated (${comparison.staleEntries.length}):`);
      for (const entry of comparison.staleEntries) {
        console.error(`- ${entry.name}`);
      }
    }

    if (failed) {
      console.error(
        'Duplicate-type-name check failed. Consolidate or rename the declarations, or '
        + 'hand-add a reviewed baseline entry with a note. Reductions land via --update.',
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `PASS: ${findings.length} duplicate type name(s), all matched by ${baseline.entries.length} `
      + 'baseline entries.',
    );
  } catch (error) {
    console.error(
      `Duplicate-type-name check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

main();
