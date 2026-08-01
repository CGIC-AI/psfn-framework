#!/usr/bin/env node
// verify-hardcoded-settings
//
// Fail-closed gate that prevents NEW hardcoded tuning/policy values from
// accreting in production source (`src/`) without being either:
//   (a) migrated into an owned setting (settings contract + owner-file
//       validation + Garden exposure + tests — the settings ownership chain),
//   or
//   (b) explicitly recorded as intentionally code-owned in the checked-in
//       baseline (scripts/hardcoded-settings-baseline.json), reviewed like code.
//
// The gate does NOT try to prove a constant *should* be a setting — that
// judgement stays with humans/review. It only ensures the inventory of
// code-owned hardcoded tuning values cannot grow silently: anything the scan
// finds that is not already in the baseline fails CI with an actionable message.
//
// Heuristic (deliberately conservative to keep false positives low):
//   declarations and object/class/enum members whose identifier contains a
//   tuning/policy token as a whole-word segment and whose value is a literal
//   number, string, regex, string/number array or readonly tuple, or object.
//   Declarations are found at any scope and for const/let/var, including code in
//   statically embedded CHILD_SOURCE/WORKER_SOURCE templates. Direct values that
//   reference identifiers or call functions are ignored as derived, except that
//   policy-shaped RegExp constructors are unambiguously regex values; mixed
//   objects are traversed so their literal policy members remain visible.
//
// Baseline maintenance:
//   npm run verify:hardcoded-settings -- --update
// regenerates the baseline from the current tree, preserving the `note`
// justification on every entry that still exists. Review the resulting diff
// like any other code change and justify additions.

import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanHardcodedSettings } from './lib/hardcoded-settings-scanner.mjs';

export { scanHardcodedSettings } from './lib/hardcoded-settings-scanner.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const BASELINE_RELATIVE_PATH = 'scripts/hardcoded-settings-baseline.json';

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
    const key = entryKey(entry);
    const baselineEntry = baseline.get(key);
    if (!baselineEntry) {
      errors.push(
        `new hardcoded tuning/policy constant not owned by settings and not baselined: `
        + `${entry.file}:${entry.line} ${entry.name} = ${entry.value}`,
      );
      continue;
    }
    if (
      entry.form
      && (typeof baselineEntry.note !== 'string' || !baselineEntry.note.trim())
    ) {
      errors.push(
        `extended-form baseline entry requires a non-empty justification note: ${key} `
        + `(form: ${entry.form})`,
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
    'Inventory of hardcoded tuning/policy values in src/ that are intentionally',
    'code-owned or acknowledged migration debt (NOT owned by the settings contract).',
    'Generated + reviewed baseline',
    'for scripts/verify-hardcoded-settings.mjs. The gate fails when a NEW matching',
    'value appears that is not listed here, or when a listed value disappears.',
    'The gate keys on file + name identity; "value" is informational only.',
    'Entries discovered by the extended scanner carry a "form" and require a non-empty',
    'review "note"; the updater preserves notes but never invents justification.',
    'Regenerate with: npm run verify:hardcoded-settings -- --update (review the diff,',
    'and add a one-line "note" justifying why each deliberate refusal stays code-owned).',
    'To retire a constant from code, migrate it to an owned setting instead of baselining it.',
  ].join(' '),
};

export function writeBaseline(root, scanned, previousByKey) {
  const entries = scanned.map((entry) => {
    const previous = previousByKey?.get(entryKey(entry));
    const record = { file: entry.file, name: entry.name, value: entry.value };
    if (entry.form) record.form = entry.form;
    if (previous && typeof previous.note === 'string' && previous.note.trim()) {
      record.note = previous.note;
    }
    return record;
  });
  const payload = { ...BASELINE_HEADER, entries };
  writeFileSync(baselinePath(root), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return entries;
}

function runUpdate(root, output) {
  const scanned = scanHardcodedSettings(root);
  const previousByKey = new Map();
  const path = baselinePath(root);
  if (existsSync(path)) {
    const baselineErrors = [];
    const loaded = loadBaseline(root, baselineErrors);
    if (loaded === null || baselineErrors.length > 0) {
      throw new Error(
        `cannot update invalid ${BASELINE_RELATIVE_PATH}: ${baselineErrors.join('; ')}`,
      );
    }
    for (const [key, entry] of loaded) previousByKey.set(key, entry);
  }

  const scannedKeys = new Set(scanned.map(entryKey));
  const added = scanned.filter(entry => !previousByKey.has(entryKey(entry)));
  const removed = [...previousByKey.keys()].filter(key => !scannedKeys.has(key));

  writeBaseline(root, scanned, previousByKey);

  output.log(`[verify-hardcoded-settings] baseline written: ${scanned.length} values`);
  if (added.length > 0) {
    output.log(`[verify-hardcoded-settings] added ${added.length}:`);
    for (const entry of added) output.log(`  + ${entry.file} ${entry.name} = ${entry.value}`);
  }
  if (removed.length > 0) {
    output.log(`[verify-hardcoded-settings] removed ${removed.length}:`);
    for (const key of removed) output.log(`  - ${key}`);
  }
}

export function runHardcodedSettingsCommand(argv, output = console) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    output.error(
      `[verify-hardcoded-settings] ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  let errors;
  try {
    if (args.update) {
      runUpdate(args.root, output);
      return 0;
    }
    errors = verifyHardcodedSettings(args.root);
  } catch (error) {
    output.error('[verify-hardcoded-settings] failed');
    output.error(
      `- scanner error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  if (errors.length > 0) {
    output.error('[verify-hardcoded-settings] failed');
    for (const error of errors) output.error(`- ${error}`);
    output.error('');
    output.error('Remediation for each new value, choose one:');
    output.error('  1. Migrate it to an owned setting (settings contract + owner-file');
    output.error('     validation + Garden exposure + tests), then rerun this check; or');
    output.error('  2. If it is legitimately code-owned (protocol constant, safety/DoS');
    output.error('     guard, error-string-coupled limit, dead code, or deferred plumbing),');
    output.error('     record it with: npm run verify:hardcoded-settings -- --update');
    output.error('     and add a one-line "note" in the baseline justifying the refusal.');
    return 1;
  }
  output.log('[verify-hardcoded-settings] passed');
  return 0;
}

if (resolve(process.argv[1] ?? '') === resolve(SCRIPT_PATH)) {
  process.exitCode = runHardcodedSettingsCommand(process.argv.slice(2));
}
