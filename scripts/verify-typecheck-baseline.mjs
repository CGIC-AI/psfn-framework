#!/usr/bin/env node

/**
 * Fail-closed root TypeScript baseline gate.
 *
 * Check locally:
 *   npm run verify:typecheck-baseline
 *
 * After deliberately fixing existing errors, refresh the baseline with:
 *   npm run verify:typecheck-baseline -- --update
 *
 * Updating is intentionally reduction-only when a baseline exists: new
 * (path, TS code) pairs and count increases are rejected. Review the JSON diff
 * and never land a baseline change that adds or increases errors. Deleting the
 * baseline to bypass that check is not a legitimate re-baseline.
 *
 * The baseline aggregates diagnostics by path and TS code instead of source
 * line. That keeps unrelated line movement from churning the file while still
 * detecting a new diagnostic code in a file or an increased count for an
 * existing pair.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { Worker } from 'node:worker_threads';

const REPOSITORY_ROOT = process.cwd();
const DEFAULT_BASELINE_PATH = resolve(REPOSITORY_ROOT, 'config/typecheck-baseline.json');
const DEFAULT_PROJECT_PATH = resolve(REPOSITORY_ROOT, 'tsconfig.json');
const TSC_PATH = resolve(REPOSITORY_ROOT, 'node_modules/typescript/bin/tsc');
const FILE_DIAGNOSTIC_PATTERN = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/gmu;
const GLOBAL_DIAGNOSTIC_PATTERN = /^error (TS\d+):/gmu;
const TYPESCRIPT_CODE_PATTERN = /^TS\d+$/u;

function printUsage() {
  console.log('Usage: node scripts/verify-typecheck-baseline.mjs [options]');
  console.log('');
  console.log('Runs root TypeScript diagnostics and rejects errors beyond the baseline.');
  console.log('');
  console.log('Options:');
  console.log('  --baseline <path>  Override the baseline JSON path');
  console.log('  --project <path>   Override the TypeScript project path');
  console.log('  --update           Rewrite the baseline, but only when errors shrink');
  console.log('  -h, --help         Show this help');
}

function parseArgs(argv) {
  let baselinePath = DEFAULT_BASELINE_PATH;
  let projectPath = DEFAULT_PROJECT_PATH;
  let update = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--baseline' || argument === '--project') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`Missing value for ${argument}`);
      }
      if (argument === '--baseline') {
        baselinePath = resolve(REPOSITORY_ROOT, value);
      } else {
        projectPath = resolve(REPOSITORY_ROOT, value);
      }
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

  return { baselinePath, projectPath, update };
}

function normalizePath(pathValue) {
  const absolutePath = resolve(REPOSITORY_ROOT, pathValue);
  return relative(REPOSITORY_ROOT, absolutePath).replaceAll('\\', '/');
}

function compareEntries(left, right) {
  return left.path.localeCompare(right.path) || left.code.localeCompare(right.code);
}

function diagnosticKey(path, code) {
  return `${path}\0${code}`;
}

function aggregateDiagnostics(output) {
  const counts = new Map();

  for (const match of output.matchAll(FILE_DIAGNOSTIC_PATTERN)) {
    const path = normalizePath(match[1]);
    const code = match[4];
    const key = diagnosticKey(path, code);
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { path, code, count: 1 });
    }
  }

  return [...counts.values()].sort(compareEntries);
}

function readTypeScriptVersion() {
  const packagePath = resolve(REPOSITORY_ROOT, 'node_modules/typescript/package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read installed TypeScript version: ${error.message}`);
  }
  if (
    packageJson === null
    || typeof packageJson !== 'object'
    || Array.isArray(packageJson)
    || typeof packageJson.version !== 'string'
    || packageJson.version.length === 0
  ) {
    throw new Error('Installed TypeScript package has no valid version.');
  }
  return packageJson.version;
}

function runTypeScriptCli(projectPath) {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(TSC_PATH, {
      argv: ['--noEmit', '-p', projectPath, '--pretty', 'false'],
      stderr: true,
      stdout: true,
    });
    let stdout = '';
    let stderr = '';

    worker.stdout.setEncoding('utf8');
    worker.stderr.setEncoding('utf8');
    worker.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    worker.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    worker.on('error', reject);
    worker.on('exit', (status) => {
      resolvePromise({ status, stderr, stdout });
    });
  });
}

async function runTypecheck(projectPath) {
  if (!existsSync(TSC_PATH)) {
    throw new Error('TypeScript is not installed. Run npm ci before this check.');
  }
  if (!existsSync(projectPath)) {
    throw new Error(`TypeScript project does not exist: ${normalizePath(projectPath)}`);
  }

  let result;
  try {
    result = await runTypeScriptCli(projectPath);
  } catch (error) {
    throw new Error(`Could not run TypeScript: ${error.message}`);
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const globalDiagnostics = [...output.matchAll(GLOBAL_DIAGNOSTIC_PATTERN)];
  if (globalDiagnostics.length > 0) {
    const codes = [...new Set(globalDiagnostics.map(match => match[1]))].join(', ');
    throw new Error(
      `TypeScript produced non-file diagnostic(s) ${codes}; these cannot be baselined.\n${output.trim()}`,
    );
  }

  const errors = aggregateDiagnostics(output);
  const totalErrors = errors.reduce((total, entry) => total + entry.count, 0);
  if (result.status !== 0 && totalErrors === 0) {
    throw new Error(
      `TypeScript exited ${result.status} without parseable file diagnostics.\n${output.trim()}`,
    );
  }

  return {
    errors,
    filesWithErrors: new Set(errors.map(entry => entry.path)).size,
    totalErrors,
    typescriptVersion: readTypeScriptVersion(),
  };
}

function buildBaseline(projectPath, typecheck) {
  return {
    schemaVersion: 1,
    typescriptVersion: typecheck.typescriptVersion,
    project: normalizePath(projectPath),
    aggregation: 'path-and-code-count',
    totalErrors: typecheck.totalErrors,
    filesWithErrors: typecheck.filesWithErrors,
    errors: typecheck.errors,
  };
}

function readBaseline(baselinePath) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read baseline ${normalizePath(baselinePath)}: ${error.message}`);
  }

  if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('Typecheck baseline must be a JSON object.');
  }
  if (baseline.schemaVersion !== 1) {
    throw new Error(`Unsupported typecheck baseline schemaVersion: ${baseline.schemaVersion}`);
  }
  if (baseline.aggregation !== 'path-and-code-count') {
    throw new Error(`Unsupported typecheck baseline aggregation: ${baseline.aggregation}`);
  }
  if (typeof baseline.typescriptVersion !== 'string' || baseline.typescriptVersion.length === 0) {
    throw new Error('Typecheck baseline typescriptVersion must be a non-empty string.');
  }
  if (typeof baseline.project !== 'string' || baseline.project.length === 0) {
    throw new Error('Typecheck baseline project must be a non-empty string.');
  }
  if (!Array.isArray(baseline.errors)) {
    throw new Error('Typecheck baseline errors must be an array.');
  }

  const seen = new Set();
  for (const entry of baseline.errors) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Every typecheck baseline error must be an object.');
    }
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new Error('Every typecheck baseline error path must be a non-empty string.');
    }
    if (typeof entry.code !== 'string' || !TYPESCRIPT_CODE_PATTERN.test(entry.code)) {
      throw new Error(`Invalid TypeScript diagnostic code in baseline: ${entry.code}`);
    }
    if (!Number.isInteger(entry.count) || entry.count <= 0) {
      throw new Error(`Invalid count for ${entry.path} ${entry.code}: ${entry.count}`);
    }
    const key = diagnosticKey(entry.path, entry.code);
    if (seen.has(key)) {
      throw new Error(`Duplicate typecheck baseline entry: ${entry.path} ${entry.code}`);
    }
    seen.add(key);
  }

  const sortedErrors = [...baseline.errors].sort(compareEntries);
  if (JSON.stringify(sortedErrors) !== JSON.stringify(baseline.errors)) {
    throw new Error('Typecheck baseline errors must be sorted by path and TS code.');
  }

  const totalErrors = baseline.errors.reduce((total, entry) => total + entry.count, 0);
  if (baseline.totalErrors !== totalErrors) {
    throw new Error(
      `Typecheck baseline totalErrors is ${baseline.totalErrors}, but entries sum to ${totalErrors}.`,
    );
  }
  const filesWithErrors = new Set(baseline.errors.map(entry => entry.path)).size;
  if (baseline.filesWithErrors !== filesWithErrors) {
    throw new Error(
      `Typecheck baseline filesWithErrors is ${baseline.filesWithErrors}, `
      + `but entries contain ${filesWithErrors} files.`,
    );
  }

  return baseline;
}

function findRegressions(baseline, typecheck) {
  const allowedCounts = new Map(
    baseline.errors.map(entry => [diagnosticKey(entry.path, entry.code), entry.count]),
  );

  return typecheck.errors
    .map((entry) => {
      const allowed = allowedCounts.get(diagnosticKey(entry.path, entry.code)) ?? 0;
      return { ...entry, allowed };
    })
    .filter(entry => entry.count > entry.allowed);
}

function formatRegressions(regressions) {
  return regressions
    .map((entry) => {
      if (entry.allowed === 0) {
        return `  + ${entry.path} ${entry.code}: ${entry.count} new error(s)`;
      }
      return `  + ${entry.path} ${entry.code}: ${entry.count} error(s), `
        + `baseline allows ${entry.allowed} (+${entry.count - entry.allowed})`;
    })
    .join('\n');
}

function assertMatchingProject(baseline, projectPath) {
  const project = normalizePath(projectPath);
  if (baseline.project !== project) {
    throw new Error(
      `Baseline is for ${baseline.project}, but this run requested ${project}.`,
    );
  }
}

function writeBaseline(baselinePath, baseline) {
  const temporaryPath = `${baselinePath}.${process.pid}.tmp`;
  const errorLines = baseline.errors.map((entry, index) => {
    const suffix = index === baseline.errors.length - 1 ? '' : ',';
    return `    ${JSON.stringify(entry)}${suffix}`;
  });
  const serialized = [
    '{',
    `  "schemaVersion": ${baseline.schemaVersion},`,
    `  "typescriptVersion": ${JSON.stringify(baseline.typescriptVersion)},`,
    `  "project": ${JSON.stringify(baseline.project)},`,
    `  "aggregation": ${JSON.stringify(baseline.aggregation)},`,
    `  "totalErrors": ${baseline.totalErrors},`,
    `  "filesWithErrors": ${baseline.filesWithErrors},`,
    '  "errors": [',
    ...errorLines,
    '  ]',
    '}',
    '',
  ].join('\n');
  try {
    writeFileSync(temporaryPath, serialized, 'utf8');
    renameSync(temporaryPath, baselinePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const typecheck = await runTypecheck(options.projectPath);
  const baselineExists = existsSync(options.baselinePath);

  if (options.update) {
    if (baselineExists) {
      const existingBaseline = readBaseline(options.baselinePath);
      assertMatchingProject(existingBaseline, options.projectPath);
      const regressions = findRegressions(existingBaseline, typecheck);
      if (regressions.length > 0) {
        throw new Error(
          'Refusing to update the baseline because type errors increased:\n'
          + formatRegressions(regressions),
        );
      }
    }

    const baseline = buildBaseline(options.projectPath, typecheck);
    writeBaseline(options.baselinePath, baseline);
    console.log(
      `[verify-typecheck-baseline] wrote ${normalizePath(options.baselinePath)}: `
      + `${baseline.totalErrors} error(s) across ${baseline.filesWithErrors} file(s)`,
    );
    return;
  }

  if (!baselineExists) {
    throw new Error(
      `Missing ${normalizePath(options.baselinePath)}. `
      + 'Generate the initial reviewed baseline with --update.',
    );
  }

  const baseline = readBaseline(options.baselinePath);
  assertMatchingProject(baseline, options.projectPath);
  if (baseline.typescriptVersion !== typecheck.typescriptVersion) {
    throw new Error(
      `Baseline uses TypeScript ${baseline.typescriptVersion}, `
      + `but installed TypeScript is ${typecheck.typescriptVersion}. `
      + 'Review compiler diagnostics and re-baseline deliberately.',
    );
  }

  const regressions = findRegressions(baseline, typecheck);
  if (regressions.length > 0) {
    throw new Error(
      `Typecheck regression: ${regressions.length} (path, TS code) pair(s) exceed the baseline:\n`
      + formatRegressions(regressions),
    );
  }

  const reduction = baseline.totalErrors - typecheck.totalErrors;
  console.log(
    `[verify-typecheck-baseline] PASS: ${typecheck.totalErrors} current error(s) `
    + `across ${typecheck.filesWithErrors} file(s); baseline allows ${baseline.totalErrors}.`,
  );
  if (reduction > 0) {
    console.log(
      `[verify-typecheck-baseline] Nice: ${reduction} baseline error(s) were removed. `
      + 'After reviewing the fixes, run npm run verify:typecheck-baseline -- --update.',
    );
  }
}

try {
  await main();
} catch (error) {
  console.error(`[verify-typecheck-baseline] FAIL: ${error.message}`);
  process.exitCode = 1;
}
