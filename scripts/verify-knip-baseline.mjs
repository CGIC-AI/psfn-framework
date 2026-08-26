#!/usr/bin/env node

/**
 * Fail-closed knip dead-code baseline gate.
 *
 * Check locally:
 *   node scripts/verify-knip-baseline.mjs
 *
 * After deliberately removing dead code, refresh the baseline with:
 *   node scripts/verify-knip-baseline.mjs -- --update
 *
 * Updating is intentionally reduction-only when a baseline exists: new unused
 * files and category count increases are rejected. Review the JSON diff and
 * never land a baseline change that adds files or increases counts. Deleting
 * the baseline to bypass that check is not a legitimate re-baseline.
 *
 * Unused files are baselined as an explicit sorted path list so a new unused
 * file fails precisely. The remaining categories (exports, types, unlisted
 * dependencies, and so on) are baselined as integer counts per category,
 * because their per-symbol lists are too large to review in a config file.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { isRecord } from '../src/shared/utils/types.ts';

const REPOSITORY_ROOT = process.cwd();
const PROJECTS = Object.freeze({
  root: {
    baseline: 'config/knip-baseline.json',
    directory: '.',
  },
  'admin-ui': {
    baseline: 'config/knip-admin-ui-baseline.json',
    directory: 'admin-ui',
  },
  'companion-ui': {
    baseline: 'config/knip-companion-ui-baseline.json',
    directory: 'companion-ui',
  },
});
const KNIP_VERSION = '6.23.0';
const KNIP_PACKAGE = `knip@${KNIP_VERSION}`;
const KNIP_ERROR_PATTERN = /^\s*ERROR:/mu;
const COUNTED_CATEGORIES = [
  'binaries',
  'catalog',
  'dependencies',
  'devDependencies',
  'duplicates',
  'enumMembers',
  'exports',
  'namespaceMembers',
  'optionalPeerDependencies',
  'types',
  'unlisted',
  'unresolved',
];

function printUsage() {
  console.log('Usage: node scripts/verify-knip-baseline.mjs [options]');
  console.log('');
  console.log(`Runs ${KNIP_PACKAGE} and rejects dead-code findings beyond the baseline.`);
  console.log('');
  console.log('Options:');
  console.log('  --project <name>   Select root, admin-ui, or companion-ui (default: root)');
  console.log('  --baseline <path>  Override the baseline JSON path');
  console.log('  --update           Rewrite the baseline, but only when findings shrink');
  console.log('  -h, --help         Show this help');
}

function parseArgs(argv) {
  let baselinePath;
  let project = 'root';
  let update = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    }
    if (argument === '--project') {
      const value = argv[index + 1];
      if (!value) throw new Error('Missing value for --project');
      if (!Object.hasOwn(PROJECTS, value)) {
        throw new Error(`Unknown Knip project ${value}; expected ${Object.keys(PROJECTS).join(', ')}`);
      }
      project = value;
      index += 1;
      continue;
    }
    if (argument === '--baseline') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${argument}`);
      }
      baselinePath = resolve(REPOSITORY_ROOT, value);
      index += 1;
      continue;
    }
    if (argument === '--update') {
      update = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  const projectConfig = PROJECTS[project];
  return {
    baselinePath: baselinePath ?? resolve(REPOSITORY_ROOT, projectConfig.baseline),
    project,
    projectRoot: resolve(REPOSITORY_ROOT, projectConfig.directory),
    update,
  };
}

function normalizePath(pathValue) {
  const absolutePath = resolve(REPOSITORY_ROOT, pathValue);
  return relative(REPOSITORY_ROOT, absolutePath).replaceAll('\\', '/');
}

function runKnip(projectRoot) {
  const result = spawnSync(
    'npx',
    ['--yes', KNIP_PACKAGE, '--reporter', 'json'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new Error(`Could not run ${KNIP_PACKAGE} via npx: ${result.error.message}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `knip exited ${result.status} without producing a report.\n${String(result.stderr).trim()}`,
    );
  }
  const errorLines = String(result.stderr)
    .split('\n')
    .filter(line => KNIP_ERROR_PATTERN.test(line));
  if (errorLines.length > 0) {
    throw new Error(
      'knip reported load errors, so its findings would be incomplete:\n'
      + errorLines.join('\n'),
    );
  }

  const stdout = String(result.stdout);
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`knip produced no JSON report.\n${stdout.trim()}`);
  }
  let report;
  try {
    report = JSON.parse(stdout.slice(jsonStart));
  } catch (error) {
    throw new Error(`Could not parse the knip JSON report: ${error.message}`);
  }
  if (!isRecord(report) || !Array.isArray(report.issues)) {
    throw new Error('Knip JSON report must be an object with an issues array.');
  }
  return report;
}

function aggregateReport(report) {
  const files = new Set();
  const counts = Object.fromEntries(COUNTED_CATEGORIES.map(category => [category, 0]));

  for (const issue of report.issues) {
    if (!isRecord(issue)) {
      throw new Error('Every knip report issue must be an object.');
    }
    if (typeof issue.file !== 'string' || issue.file.length === 0) {
      throw new Error('Every knip report issue file must be a non-empty string.');
    }
    if (!Array.isArray(issue.files)) {
      throw new Error(`Knip report issue for ${issue.file} has no files array.`);
    }
    for (const entry of issue.files) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.length === 0) {
        throw new Error(`Knip report issue for ${issue.file} has an invalid files entry.`);
      }
      files.add(entry.name);
    }
    for (const category of COUNTED_CATEGORIES) {
      if (!Array.isArray(issue[category])) {
        throw new Error(`Knip report issue for ${issue.file} has no ${category} array.`);
      }
      counts[category] += issue[category].length;
    }
  }

  return { counts, files: [...files].sort() };
}

function buildBaseline(findings) {
  return {
    schemaVersion: 1,
    knipVersion: KNIP_VERSION,
    files: findings.files,
    counts: findings.counts,
  };
}

function readBaseline(baselinePath) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read baseline ${normalizePath(baselinePath)}: ${error.message}`);
  }

  if (!isRecord(baseline)) {
    throw new Error('Knip baseline must be a JSON object.');
  }
  if (baseline.schemaVersion !== 1) {
    throw new Error(`Unsupported knip baseline schemaVersion: ${baseline.schemaVersion}`);
  }
  if (typeof baseline.knipVersion !== 'string' || baseline.knipVersion.length === 0) {
    throw new Error('Knip baseline knipVersion must be a non-empty string.');
  }
  if (!Array.isArray(baseline.files)) {
    throw new Error('Knip baseline files must be an array.');
  }
  const seenFiles = new Set();
  for (const file of baseline.files) {
    if (typeof file !== 'string' || file.length === 0) {
      throw new Error('Every knip baseline file must be a non-empty string.');
    }
    if (seenFiles.has(file)) {
      throw new Error(`Duplicate knip baseline file: ${file}`);
    }
    seenFiles.add(file);
  }
  const sortedFiles = [...baseline.files].sort();
  if (JSON.stringify(sortedFiles) !== JSON.stringify(baseline.files)) {
    throw new Error('Knip baseline files must be sorted.');
  }

  if (!isRecord(baseline.counts)) {
    throw new Error('Knip baseline counts must be an object.');
  }
  const categories = Object.keys(baseline.counts).sort();
  if (JSON.stringify(categories) !== JSON.stringify(COUNTED_CATEGORIES)) {
    throw new Error(
      `Knip baseline counts must contain exactly the categories: ${COUNTED_CATEGORIES.join(', ')}.`,
    );
  }
  if (JSON.stringify(Object.keys(baseline.counts)) !== JSON.stringify(COUNTED_CATEGORIES)) {
    throw new Error('Knip baseline counts must be sorted by category.');
  }
  for (const category of COUNTED_CATEGORIES) {
    const count = baseline.counts[category];
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Invalid knip baseline count for ${category}: ${count}`);
    }
  }

  return baseline;
}

function findRegressions(baseline, findings) {
  const allowedFiles = new Set(baseline.files);
  const newFiles = findings.files.filter(file => !allowedFiles.has(file));
  const countIncreases = COUNTED_CATEGORIES
    .map(category => ({
      allowed: baseline.counts[category],
      category,
      current: findings.counts[category],
    }))
    .filter(entry => entry.current > entry.allowed);
  return { countIncreases, newFiles };
}

function formatRegressions(regressions) {
  const lines = regressions.newFiles.map(file => `  + ${file}: new unused file`);
  for (const entry of regressions.countIncreases) {
    lines.push(
      `  + ${entry.category}: ${entry.current} finding(s), `
      + `baseline allows ${entry.allowed} (+${entry.current - entry.allowed})`,
    );
  }
  return lines.join('\n');
}

function assertMatchingKnipVersion(baseline) {
  if (baseline.knipVersion !== KNIP_VERSION) {
    throw new Error(
      `Baseline uses knip ${baseline.knipVersion}, `
      + `but the pinned knip is ${KNIP_VERSION}. `
      + 'Review dead-code findings and re-baseline deliberately.',
    );
  }
}

function writeBaseline(baselinePath, baseline) {
  const temporaryPath = `${baselinePath}.${process.pid}.tmp`;
  const serialized = `${JSON.stringify(baseline, null, 2)}\n`;
  try {
    writeFileSync(temporaryPath, serialized, 'utf8');
    renameSync(temporaryPath, baselinePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function totalFindings(counts) {
  return COUNTED_CATEGORIES.reduce((total, category) => total + counts[category], 0);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baselineExists = existsSync(options.baselinePath);
  let existingBaseline;

  if (baselineExists) {
    existingBaseline = readBaseline(options.baselinePath);
  } else if (!options.update) {
    throw new Error(
      `Missing ${normalizePath(options.baselinePath)}. `
      + 'Generate the initial reviewed baseline with --update.',
    );
  }

  if (!options.update) {
    assertMatchingKnipVersion(existingBaseline);
  }

  const findings = aggregateReport(runKnip(options.projectRoot));

  if (options.update) {
    if (existingBaseline) {
      const regressions = findRegressions(existingBaseline, findings);
      if (regressions.newFiles.length > 0 || regressions.countIncreases.length > 0) {
        throw new Error(
          'Refusing to update the baseline because dead-code findings increased:\n'
          + formatRegressions(regressions),
        );
      }
    }

    const baseline = buildBaseline(findings);
    writeBaseline(options.baselinePath, baseline);
    console.log(
      `[verify-knip-baseline:${options.project}] wrote ${normalizePath(options.baselinePath)}: `
      + `${baseline.files.length} unused file(s) and ${totalFindings(baseline.counts)} counted finding(s)`,
    );
    return;
  }

  const baseline = existingBaseline;
  const regressions = findRegressions(baseline, findings);
  if (regressions.newFiles.length > 0 || regressions.countIncreases.length > 0) {
    throw new Error(
      'Knip regression: dead-code findings exceed the baseline:\n'
      + formatRegressions(regressions),
    );
  }

  const currentTotal = totalFindings(findings.counts);
  const baselineTotal = totalFindings(baseline.counts);
  console.log(
    `[verify-knip-baseline:${options.project}] PASS: ${findings.files.length} unused file(s) and `
    + `${currentTotal} counted finding(s); baseline allows `
    + `${baseline.files.length} file(s) and ${baselineTotal} finding(s).`,
  );

  const removedFiles = baseline.files.filter(file => !findings.files.includes(file));
  if (removedFiles.length > 0 || currentTotal < baselineTotal) {
    console.log(
      `[verify-knip-baseline:${options.project}] Nice: baseline findings were removed. `
      + 'After reviewing the removals, run node scripts/verify-knip-baseline.mjs -- --update.',
    );
  }
}

try {
  await main();
} catch (error) {
  console.error(`[verify-knip-baseline] FAIL: ${error.message}`);
  process.exitCode = 1;
}
