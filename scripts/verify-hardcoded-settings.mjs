#!/usr/bin/env node
// verify-hardcoded-settings
//
// Fail-closed gate that prevents NEW hardcoded tuning/policy constants from
// accreting in production source (`src/`) without being either:
//   (a) migrated into an owned setting (settings contract + owner-file
//       validation + Garden exposure + tests — the settings ownership chain),
//   or
//   (b) explicitly recorded as intentionally code-owned in the checked-in
//       baseline (scripts/hardcoded-settings-baseline.json), reviewed like code.
//
// The gate does NOT try to prove a constant *should* be a setting — that
// judgement stays with humans/review. It only ensures the inventory of
// code-owned hardcoded tuning constants cannot grow silently: anything the scan
// finds that is not already in the baseline fails CI with an actionable message.
//
// Heuristic (deliberately conservative to keep false positives low):
//   module-level `const NAME = <pure numeric-literal expression>` where NAME
//   contains a tuning/policy token (TIMEOUT, LIMIT, MAX, MIN, THRESHOLD,
//   INTERVAL, BUDGET, CAP, COOLDOWN, DELAY, BACKOFF, CONCURRENCY, CADENCE,
//   RETRY, RETRIES) as a whole word segment. Values that reference other
//   identifiers or call expressions are ignored (they are derived, not
//   hardcoded literals).
//
// Baseline maintenance:
//   npm run verify:hardcoded-settings -- --update
// regenerates the baseline from the current tree, preserving the `note`
// justification on every entry that still exists. Review the resulting diff
// like any other code change and justify additions.

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const BASELINE_RELATIVE_PATH = 'scripts/hardcoded-settings-baseline.json';

const TUNING_TOKENS = new Set([
  'TIMEOUT',
  'LIMIT',
  'MAX',
  'MIN',
  'THRESHOLD',
  'INTERVAL',
  'BUDGET',
  'CAP',
  'COOLDOWN',
  'DELAY',
  'BACKOFF',
  'CONCURRENCY',
  'CADENCE',
  'RETRY',
  'RETRIES',
]);

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '__tests__',
  '__fixtures__',
  '__mocks__',
  'fixtures',
]);

// A pure numeric-literal expression: integer/float/hex numbers combined only
// with arithmetic operators and parentheses. No identifiers, no calls.
const NUMBER = String.raw`(?:0x[0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)`;
const NUMERIC_EXPRESSION = new RegExp(
  `^\\s*\\(?\\s*-?${NUMBER}(?:\\s*(?:\\*\\*|[-+*/%])\\s*\\(?\\s*-?${NUMBER}\\s*\\)?)*\\s*\\)?\\s*$`,
  'u',
);
const CONST_DECLARATION = /^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(.+?)\s*$/u;

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  let update = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--update') {
      update = true;
    } else if (arg === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--root requires a repository path');
      }
      root = resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { root, update };
}

function normalizePath(root, path) {
  return relative(root, path).split('\\').join('/');
}

function segmentTokens(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .split(/_+/u)
    .filter(Boolean)
    .map(token => token.toUpperCase());
}

function isTuningName(name) {
  return segmentTokens(name).some(token => TUNING_TOKENS.has(token));
}

function normalizeRhs(rawRhs) {
  let value = rawRhs.replace(/\/\/.*$/u, '');
  value = value.replace(/\bas\s+const\b/u, '');
  value = value.replace(/[;,]+\s*$/u, '');
  return value.trim();
}

function collectSourceFiles(directory, files) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      collectSourceFiles(path, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!/\.tsx?$/u.test(name)) continue;
    if (/\.(test|spec)\.tsx?$/u.test(name)) continue;
    if (name.endsWith('.d.ts')) continue;
    files.push(path);
  }
}

// Scan `<root>/src` and return the sorted list of hardcoded tuning constants.
export function scanHardcodedSettings(root) {
  const sourceRoot = join(root, 'src');
  const files = [];
  collectSourceFiles(sourceRoot, files);
  files.sort((left, right) => left.localeCompare(right));

  const found = [];
  for (const file of files) {
    const relativePath = normalizePath(root, file);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(CONST_DECLARATION);
      if (!match) continue;
      const name = match[1];
      if (!isTuningName(name)) continue;
      const value = normalizeRhs(match[2]);
      if (!value || !NUMERIC_EXPRESSION.test(value)) continue;
      found.push({ file: relativePath, name, value, line: index + 1 });
    }
  }
  found.sort((left, right) => (
    left.file.localeCompare(right.file) || left.name.localeCompare(right.name)
  ));
  return found;
}

function entryKey(entry) {
  return `${entry.file}::${entry.name}`;
}

function baselinePath(root) {
  return join(root, BASELINE_RELATIVE_PATH);
}

export function loadBaseline(root, errors) {
  const path = baselinePath(root);
  if (!existsSync(path)) {
    errors.push(
      `baseline file is missing: ${BASELINE_RELATIVE_PATH} (generate it with: npm run verify:hardcoded-settings -- --update)`,
    );
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(
      `${BASELINE_RELATIVE_PATH} is unreadable or invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    errors.push(`${BASELINE_RELATIVE_PATH} must be an object with an "entries" array`);
    return null;
  }
  const byKey = new Map();
  for (const entry of parsed.entries) {
    if (!entry || typeof entry.file !== 'string' || typeof entry.name !== 'string') {
      errors.push(`${BASELINE_RELATIVE_PATH} contains an entry missing a string "file"/"name"`);
      continue;
    }
    const key = entryKey(entry);
    if (byKey.has(key)) {
      errors.push(`${BASELINE_RELATIVE_PATH} contains a duplicate entry: ${key}`);
      continue;
    }
    byKey.set(key, entry);
  }
  return byKey;
}

export function verifyHardcodedSettings(root) {
  const errors = [];
  const baseline = loadBaseline(root, errors);
  if (baseline === null) return errors.sort((left, right) => left.localeCompare(right));

  const scanned = scanHardcodedSettings(root);
  const scannedKeys = new Set(scanned.map(entryKey));

  for (const entry of scanned) {
    if (!baseline.has(entryKey(entry))) {
      errors.push(
        `new hardcoded tuning/policy constant not owned by settings and not baselined: `
        + `${entry.file}:${entry.line} ${entry.name} = ${entry.value}`,
      );
    }
  }

  for (const key of baseline.keys()) {
    if (!scannedKeys.has(key)) {
      errors.push(
        `stale baseline entry (constant no longer present): ${key} `
        + `(remove it with: npm run verify:hardcoded-settings -- --update)`,
      );
    }
  }

  return errors.sort((left, right) => left.localeCompare(right));
}

const BASELINE_HEADER = {
  $comment: [
    'Inventory of hardcoded tuning/policy constants in src/ that are intentionally',
    'code-owned (NOT owned by the settings contract). Generated + reviewed baseline',
    'for scripts/verify-hardcoded-settings.mjs. The gate fails when a NEW matching',
    'constant appears that is not listed here, or when a listed constant disappears.',
    'The gate keys on file + name identity; "value" is informational only.',
    'Regenerate with: npm run verify:hardcoded-settings -- --update (review the diff,',
    'and add a one-line "note" justifying why each deliberate refusal stays code-owned).',
    'To retire a constant from code, migrate it to an owned setting instead of baselining it.',
  ].join(' '),
};

export function writeBaseline(root, scanned, previousByKey) {
  const entries = scanned.map((entry) => {
    const previous = previousByKey?.get(entryKey(entry));
    const record = { file: entry.file, name: entry.name, value: entry.value };
    if (previous && typeof previous.note === 'string' && previous.note.trim()) {
      record.note = previous.note;
    }
    return record;
  });
  const payload = { ...BASELINE_HEADER, entries };
  writeFileSync(baselinePath(root), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return entries;
}

function runUpdate(root) {
  const scanned = scanHardcodedSettings(root);
  const previousByKey = new Map();
  const path = baselinePath(root);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && Array.isArray(parsed.entries)) {
        for (const entry of parsed.entries) {
          if (entry && typeof entry.file === 'string' && typeof entry.name === 'string') {
            previousByKey.set(entryKey(entry), entry);
          }
        }
      }
    } catch {
      // Regenerating from scratch is acceptable during --update.
    }
  }

  const scannedKeys = new Set(scanned.map(entryKey));
  const added = scanned.filter(entry => !previousByKey.has(entryKey(entry)));
  const removed = [...previousByKey.keys()].filter(key => !scannedKeys.has(key));

  writeBaseline(root, scanned, previousByKey);

  console.log(`[verify-hardcoded-settings] baseline written: ${scanned.length} constants`);
  if (added.length > 0) {
    console.log(`[verify-hardcoded-settings] added ${added.length}:`);
    for (const entry of added) console.log(`  + ${entry.file} ${entry.name} = ${entry.value}`);
  }
  if (removed.length > 0) {
    console.log(`[verify-hardcoded-settings] removed ${removed.length}:`);
    for (const key of removed) console.log(`  - ${key}`);
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[verify-hardcoded-settings] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (args.update) {
    runUpdate(args.root);
    return;
  }

  const errors = verifyHardcodedSettings(args.root);
  if (errors.length > 0) {
    console.error('[verify-hardcoded-settings] failed');
    for (const error of errors) console.error(`- ${error}`);
    console.error('');
    console.error('Remediation for each new constant, choose one:');
    console.error('  1. Migrate it to an owned setting (settings contract + owner-file');
    console.error('     validation + Garden exposure + tests), then rerun this check; or');
    console.error('  2. If it is legitimately code-owned (protocol constant, safety/DoS');
    console.error('     guard, error-string-coupled limit, dead code, or deferred plumbing),');
    console.error('     record it with: npm run verify:hardcoded-settings -- --update');
    console.error('     and add a one-line "note" in the baseline justifying the refusal.');
    process.exitCode = 1;
    return;
  }
  console.log('[verify-hardcoded-settings] passed');
}

if (resolve(process.argv[1] ?? '') === resolve(SCRIPT_PATH)) {
  main();
}
